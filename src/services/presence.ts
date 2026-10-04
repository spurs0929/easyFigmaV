import {
  PRESENCE_CURSOR_THROTTLE_MS,
  PRESENCE_RECONNECT_BASE_DELAY_MS,
  PRESENCE_RECONNECT_MAX_DELAY_MS,
} from '@/config/app'
import { apiUrl } from '@/config/env'
import { getAccessToken, refreshSession, type Session } from '@/services/api'
import {
  PRESENCE_CURSOR_LEAVE_TYPE,
  PRESENCE_CURSOR_TYPE,
  PRESENCE_SNAPSHOT_TYPE,
  PresenceCloseCode,
  parsePresenceCursor,
  parsePresenceSnapshot,
  presenceMessageType,
  type CursorPoint,
  type PresenceCursorMessage,
  type PresenceSnapshot,
  type PresenceStatus,
  type PresenceStopReason,
} from '@/types/presence'

// Presence WebSocket 的連線、認證、重連，以及游標訊息的收送。只負責 transport，
// 不碰 Pinia 與 UI：狀態透過 onStatusChange / onSnapshot / onCursor 往外送，
// 由上層決定怎麼呈現。
//
// 同一個 instance 同時只維護一個專案的連線。connect(B) 會先讓 A 的整個生命週期
// 失效，不存在兩條並存的 socket，重連、seq 與 auth recovery 因此都只需要處理一份。

/** 主動關閉時使用的 close code。瀏覽器的 close() 只接受 1000 與 3000–4999。 */
const NORMAL_CLOSURE = 1000

/** 瀏覽器 WebSocket 裡這個 service 用得到的部分。測試以假物件實作。 */
export interface PresenceSocket {
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string): void
  close(code?: number): void
}

export interface PresenceClientDeps {
  createSocket: (url: string) => PresenceSocket
  /** 目前記憶體中的 access token。 */
  getAccessToken: () => string | null
  /**
   * 既有的 single-flight refresh。與 REST 的 401 重試共用同一個請求，
   * 不會各自送出互相競爭的 refresh rotation。
   */
  refreshSession: () => Promise<Session | null>
}

type Listener<T> = (value: T) => void

/**
 * 把 http(s) 位址換成對應的 ws(s) 位址。
 *
 * 開發環境的 API 位址是相對路徑（走 Vite proxy），必須先以目前頁面解析成
 * 絕對位址才知道 host 與協定；正式環境是完整的 https origin。
 * 用 URL 物件換 protocol，而不是字串取代，才不會誤改到 host 或 path 裡的 "http"。
 */
export function toWebSocketUrl(httpUrl: string, pageHref: string): string {
  const url = new URL(httpUrl, pageHref)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  else throw new Error(`無法推導 WebSocket 位址：${url.protocol}`)
  return url.toString()
}

export function presenceUrl(projectId: string): string {
  // token 刻意不在 URL 裡：URL 會進到 server 與代理的存取日誌。
  return toWebSocketUrl(
    apiUrl(`/ws/projects/${encodeURIComponent(projectId)}/presence`),
    window.location.href,
  )
}

/** 第 attempt 次重連前的等待時間：1s、2s、4s … 上限 PRESENCE_RECONNECT_MAX_DELAY_MS。 */
export function reconnectDelay(attempt: number): number {
  // 指數封頂，避免 attempt 很大時 2 ** n 溢位成 Infinity。
  const exponent = Math.min(Math.max(attempt - 1, 0), 16)
  return Math.min(PRESENCE_RECONNECT_BASE_DELAY_MS * 2 ** exponent, PRESENCE_RECONNECT_MAX_DELAY_MS)
}

export class PresenceClient {
  private readonly deps: PresenceClientDeps

  private currentStatus: PresenceStatus = { state: 'idle' }
  private projectId: string | null = null
  private socket: PresenceSocket | null = null
  /**
   * 每次 connect() / disconnect() 遞增。非同步流程（refresh、重連計時器）回來時
   * 比對自己出發時的世代，不符就代表使用者已經離開或換了專案，結果直接丟棄。
   */
  private generation = 0
  /** 目前這條 socket 收過的最大 seq。每條新 socket 重新開始，見 openSocket()。 */
  private latestSeq = -1
  /** 連續失敗的重連次數。收到第一份 snapshot（真正認證成功）才歸零。 */
  private attempt = 0
  /** 這一輪是否已經用掉那唯一一次 4401 refresh。同樣在認證成功時歸零。 */
  private authRecoveryUsed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 游標節流的視窗。不是 null 代表剛送過一則，這段時間內的更新只會留在
   * pendingCursor，視窗結束時再送出。
   */
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  /** 節流視窗內最新的一次更新。undefined = 沒有；null = 游標離開畫布。 */
  private pendingCursor: CursorPoint | null | undefined = undefined

  private readonly snapshotListeners = new Set<Listener<PresenceSnapshot>>()
  private readonly cursorListeners = new Set<Listener<PresenceCursorMessage>>()
  private readonly statusListeners = new Set<Listener<PresenceStatus>>()

  constructor(deps: Partial<PresenceClientDeps> = {}) {
    this.deps = {
      createSocket: (url) => new WebSocket(url),
      getAccessToken,
      refreshSession,
      ...deps,
    }
  }

  get status(): PresenceStatus {
    return this.currentStatus
  }

  /** 訂閱在線名單。只會收到通過驗證、而且比上一份新的 snapshot。回傳取消訂閱的函式。 */
  onSnapshot(listener: Listener<PresenceSnapshot>): () => void {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  /**
   * 訂閱其他使用者的游標（移動與離開）。只會收到通過驗證、屬於目前專案、
   * 而且是在連線已認證之後抵達的訊息。回傳取消訂閱的函式。
   *
   * 不保證 user_id 在目前的在線名單裡：游標與 snapshot 的抵達順序沒有保證，
   * 名單屬於上層的狀態，由訂閱者自己比對。
   */
  onCursor(listener: Listener<PresenceCursorMessage>): () => void {
    this.cursorListeners.add(listener)
    return () => this.cursorListeners.delete(listener)
  }

  /** 訂閱連線狀態。回傳取消訂閱的函式。 */
  onStatusChange(listener: Listener<PresenceStatus>): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /**
   * 開始維護某個專案的連線。
   *
   * 已經在維護同一個專案（連線中、已連線或等待重連）時不做任何事，重複呼叫
   * 不會把好好的連線拆掉重建。換專案、或前一輪已經停止時，從頭開始新的一輪。
   */
  connect(projectId: string): void {
    const { state } = this.currentStatus
    if (this.projectId === projectId && state !== 'idle' && state !== 'stopped') return

    this.teardown()
    this.generation += 1
    this.projectId = projectId
    this.attempt = 0
    this.authRecoveryUsed = false
    this.openSocket(projectId)
  }

  /** 主動結束：關閉連線、取消待執行的重連，之後任何晚到的事件都不會再有作用。 */
  disconnect(): void {
    if (this.projectId === null) return
    this.teardown()
    this.generation += 1
    this.projectId = null
    this.setStatus({ state: 'idle' })
  }

  /**
   * 回報自己的游標：world 座標，或 null 表示游標離開了畫布。
   *
   * 可以在每個 mousemove 都呼叫。節流在這裡：第一次立刻送出，之後
   * PRESENCE_CURSOR_THROTTLE_MS 內的更新只保留最新的一個，視窗結束時補送。
   * 移動與離開共用同一格，所以最後送出的一定是最後的狀態。
   *
   * 連線尚未認證、重連中或已停止時直接丟棄，不排隊：游標是當下的狀態，
   * 等連線恢復再送出幾秒前的位置沒有意義，下一次移動自然會送出新的。
   */
  updateCursor(point: CursorPoint | null): void {
    const socket = this.socket
    if (socket === null || this.currentStatus.state !== 'connected') return
    // server 會把非有限的座標當成協定錯誤（4400）而關閉連線，那會連在線名單一起停掉。
    if (point !== null && !(Number.isFinite(point.x) && Number.isFinite(point.y))) return

    if (this.cursorTimer !== null) {
      this.pendingCursor = point
      return
    }

    socket.send(
      JSON.stringify(
        point === null ? { type: 'cursor.leave' } : { type: 'cursor.move', x: point.x, y: point.y },
      ),
    )
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null
      const pending = this.pendingCursor
      this.pendingCursor = undefined
      // 重新走一次 updateCursor：這段時間連線可能已經斷了，由它判斷還能不能送；
      // 送出的話也會開始下一個視窗，持續移動時因此維持固定的頻率。
      if (pending !== undefined) this.updateCursor(pending)
    }, PRESENCE_CURSOR_THROTTLE_MS)
  }

  // ─────────────────────────── 內部流程 ───────────────────────────

  /** 關掉目前的 socket 與計時器。先放掉 socket 的身分，它的 onclose 晚到時就會被忽略。 */
  private teardown(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.resetCursorThrottle()
    const socket = this.socket
    this.socket = null
    socket?.close(NORMAL_CLOSURE)
  }

  /** 丟掉還沒送出的游標。它屬於即將結束的那條連線，不該被帶到下一條。 */
  private resetCursorThrottle(): void {
    if (this.cursorTimer !== null) {
      clearTimeout(this.cursorTimer)
      this.cursorTimer = null
    }
    this.pendingCursor = undefined
  }

  private openSocket(projectId: string): void {
    // seq 只在同一條連線內有意義：server 重啟之後會從頭編號，沿用舊值會把
    // 重連後所有合法的 snapshot 當成過期資料丟掉。
    this.latestSeq = -1
    this.setStatus({ state: 'connecting', projectId })

    const socket = this.deps.createSocket(presenceUrl(projectId))
    this.socket = socket

    // 每個 callback 都先確認自己還是「目前那條」socket。被取代或主動關閉的舊
    // socket 事件可能晚到，它們不能改狀態、不能觸發重連、也不能觸發 refresh。
    socket.onopen = () => {
      if (socket === this.socket) this.authenticate(socket, projectId)
    }
    socket.onmessage = (event) => {
      if (socket === this.socket) this.handleMessage(projectId, event.data)
    }
    socket.onclose = (event) => {
      if (socket !== this.socket) return
      this.socket = null
      this.resetCursorThrottle()
      this.handleClose(projectId, event.code)
    }
  }

  private authenticate(socket: PresenceSocket, projectId: string): void {
    // 在 open 當下才讀 token，拿到的是最新的那一個。
    const token = this.deps.getAccessToken()
    if (!token) {
      // 沒有 token 就不送一則註定被拒的 auth，直接走 4401 同一條恢復路徑：
      // 交給既有的 refresh 決定還能不能恢復 session。
      this.socket = null
      socket.close(NORMAL_CLOSURE)
      void this.recoverAuth(projectId)
      return
    }
    socket.send(JSON.stringify({ type: 'auth', access_token: token }))
  }

  /**
   * 依 type 分派。三種情況的處理刻意不同：
   *
   * - 無法辨識成訊息（不是文字、不是 JSON、沒有字串 type）→ 停止。雙方對
   *   「訊息長什麼樣」的理解已經不一致，繼續收下去沒有任何東西可信。
   * - snapshot 不合法 → 停止。名單是權威狀態，壞掉就不能再顯示。
   * - 游標訊息不合法 → 只丟掉那一則。游標是 best-effort 的輔助顯示，
   *   一則壞掉的位置不該讓在線名單跟著消失。
   * - 不認得的 type → 忽略。server 之後新增訊息種類時，還沒更新的 client
   *   不會因此失去既有功能。
   */
  private handleMessage(projectId: string, data: unknown): void {
    const message = typeof data === 'string' ? safeJsonParse(data) : null

    switch (presenceMessageType(message)) {
      case null:
        this.stop(projectId, 'protocol_error')
        return
      case PRESENCE_SNAPSHOT_TYPE:
        this.handleSnapshot(projectId, message)
        return
      case PRESENCE_CURSOR_TYPE:
      case PRESENCE_CURSOR_LEAVE_TYPE:
        this.handleCursor(projectId, message)
        return
      default:
        return
    }
  }

  private handleCursor(projectId: string, message: unknown): void {
    // 第一份 snapshot 之前還不算連上（見 handleSnapshot）：這時上層沒有名單，
    // 游標沒有對象可以對應。游標訊息也不會讓狀態變成 connected。
    if (this.currentStatus.state !== 'connected') return

    const cursor = parsePresenceCursor(message)
    if (!cursor || cursor.project_id !== projectId) return
    this.emit(this.cursorListeners, cursor)
  }

  private handleSnapshot(projectId: string, message: unknown): void {
    const snapshot = parsePresenceSnapshot(message)

    // 這條 socket 綁定的就是這個專案，收到別的 project_id 只可能是協定或 server
    // 的 bug。不猜測、不寫入，直接停止。
    if (!snapshot || snapshot.project_id !== projectId) {
      this.stop(projectId, 'protocol_error')
      return
    }

    // 重複或亂序抵達的舊 snapshot。
    if (snapshot.seq <= this.latestSeq) return
    this.latestSeq = snapshot.seq

    const generation = this.generation
    if (this.currentStatus.state !== 'connected') {
      // 第一份 snapshot 才是真正的「連線成功」：socket open 只代表握手完成，
      // server 之後仍可能以 4401 / 4404 拒絕。重試狀態在這裡才歸零。
      this.attempt = 0
      this.authRecoveryUsed = false
      this.setStatus({ state: 'connected', projectId })
    }
    // 狀態 listener 可能在回呼裡 disconnect() 或換專案，那這份 snapshot 就不該再送出去。
    if (generation === this.generation) this.emit(this.snapshotListeners, snapshot)
  }

  private handleClose(projectId: string, code: number): void {
    switch (code) {
      case PresenceCloseCode.InvalidMessage:
        this.stop(projectId, 'protocol_error')
        return
      case PresenceCloseCode.ProjectNotFound:
        this.stop(projectId, 'project_unavailable')
        return
      case PresenceCloseCode.Unauthenticated:
        void this.recoverAuth(projectId)
        return
      default:
        // 4408、1011，以及瀏覽器端看到的 1006（沒有 close frame 的網路中斷）等：
        // 都視為暫時性，退避後重連。
        this.scheduleReconnect(projectId)
    }
  }

  /**
   * 4401 或沒有 token 時的恢復：最多一次 refresh，成功就立刻用新 token 重連。
   *
   * authRecoveryUsed 只在「收到 snapshot、真正認證成功」時歸零，所以
   * 4401 → refresh → 4401 會在第二次停下，不會形成 refresh 迴圈。
   */
  private async recoverAuth(projectId: string): Promise<void> {
    if (this.authRecoveryUsed) {
      this.stop(projectId, 'unauthenticated')
      return
    }
    this.authRecoveryUsed = true
    const generation = this.generation

    let session: Session | null
    try {
      session = await this.deps.refreshSession()
    } catch {
      // 網路或 5xx：api 層不會因此登出，這裡也不該判定 session 失效。
      // 退避後重連；recovery 額度已用掉，下一次 4401 就會停止。
      if (generation === this.generation) this.scheduleReconnect(projectId)
      return
    }

    if (generation !== this.generation) return
    if (!session) {
      // api 層已經發布 session 失效，登入狀態交給既有 auth 流程處理。
      this.stop(projectId, 'unauthenticated')
      return
    }
    this.openSocket(projectId)
  }

  private scheduleReconnect(projectId: string): void {
    this.attempt += 1
    const delayMs = reconnectDelay(this.attempt)
    const generation = this.generation
    this.setStatus({ state: 'reconnecting', projectId, attempt: this.attempt, delayMs })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (generation === this.generation) this.openSocket(projectId)
    }, delayMs)
  }

  private stop(projectId: string, reason: PresenceStopReason): void {
    this.teardown()
    this.setStatus({ state: 'stopped', projectId, reason })
  }

  private setStatus(status: PresenceStatus): void {
    this.currentStatus = status
    this.emit(this.statusListeners, status)
  }

  private emit<T>(listeners: Set<Listener<T>>, value: T): void {
    for (const listener of listeners) {
      // 一個 listener 失敗不應影響其他訂閱者，也不應打斷連線流程。
      try {
        listener(value)
      } catch (error) {
        console.error('Presence listener failed', error)
      }
    }
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** App 共用的單一 instance。socket 生命週期不綁在任何 component 上。 */
export const presenceClient = new PresenceClient()
