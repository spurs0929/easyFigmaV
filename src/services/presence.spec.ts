import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PRESENCE_CURSOR_THROTTLE_MS,
  PRESENCE_RECONNECT_BASE_DELAY_MS,
  PRESENCE_RECONNECT_MAX_DELAY_MS,
} from '@/config/app'
import type { Session } from '@/services/api'
import {
  PresenceClient,
  reconnectDelay,
  toWebSocketUrl,
  type PresenceSocket,
} from '@/services/presence'
import type { PresenceCursorMessage, PresenceSnapshot, PresenceStatus } from '@/types/presence'

const PROJECT_A = '11111111-1111-1111-1111-111111111111'
const PROJECT_B = '22222222-2222-2222-2222-222222222222'
const USER = '33333333-3333-3333-3333-333333333333'
const OTHER = '44444444-4444-4444-4444-444444444444'
const TOKEN = 'token-one'
const NEW_TOKEN = 'token-two'

/** 可以由測試決定何時 open、收到什麼、以什麼 code 關閉的假 socket。 */
class FakeSocket implements PresenceSocket {
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  readonly sent: string[] = []
  closedWith: number | null = null
  closedByServer = false

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number): void {
    this.closedWith = code ?? 1005
  }

  open(): void {
    this.onopen?.(new Event('open'))
  }

  receive(data: unknown): void {
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    this.onmessage?.(new MessageEvent('message', { data: text }))
  }

  serverClose(code: number): void {
    this.closedByServer = true
    this.onclose?.(new CloseEvent('close', { code }))
  }
}

function snapshot(seq: number, projectId = PROJECT_A): PresenceSnapshot {
  return {
    type: 'presence.snapshot',
    project_id: projectId,
    seq,
    users: [{ user_id: USER, display_name: 'Alice', role: 'owner' }],
  }
}

function cursorMove(x: number, y: number, projectId = PROJECT_A) {
  return { type: 'presence.cursor', project_id: projectId, user_id: OTHER, x, y }
}

function cursorLeave(projectId = PROJECT_A) {
  return { type: 'presence.cursor.leave', project_id: projectId, user_id: OTHER }
}

function fakeSession(token: string): Session {
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 900,
    user: { id: USER, email: 'a@example.com', display_name: null, created_at: '' },
  }
}

function setup(options: { token?: string | null } = {}) {
  const sockets: FakeSocket[] = []
  let token: string | null = options.token === undefined ? TOKEN : options.token
  const refreshSession = vi.fn<() => Promise<Session | null>>()
  const client = new PresenceClient({
    createSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    getAccessToken: () => token,
    refreshSession,
  })

  const snapshots: PresenceSnapshot[] = []
  const statuses: PresenceStatus[] = []
  const cursors: PresenceCursorMessage[] = []
  client.onSnapshot((s) => snapshots.push(s))
  client.onCursor((c) => cursors.push(c))
  client.onStatusChange((s) => statuses.push(s))

  return {
    client,
    sockets,
    snapshots,
    statuses,
    cursors,
    refreshSession,
    setToken: (value: string | null) => {
      token = value
    },
    /** 目前最新的那條 socket。 */
    last: () => sockets[sockets.length - 1]!,
    /** 開啟並完成認證（收到第一份 snapshot）。 */
    authenticate: (socket: FakeSocket, seq = 1, projectId = PROJECT_A) => {
      socket.open()
      socket.receive(snapshot(seq, projectId))
    },
  }
}

/** 讓 refresh 的 promise 與它後面的流程跑完。 */
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ─────────────────────────── URL ───────────────────────────

describe('toWebSocketUrl', () => {
  it('開發環境的相對路徑以目前頁面解析，http → ws', () => {
    expect(toWebSocketUrl('/api/ws/x', 'http://localhost:5173/p/1')).toBe(
      'ws://localhost:5173/api/ws/x',
    )
  })

  it('https 頁面上的相對路徑 → wss', () => {
    expect(toWebSocketUrl('/api/ws/x', 'https://app.example.com/p/1')).toBe(
      'wss://app.example.com/api/ws/x',
    )
  })

  it('正式環境的完整 API origin 優先於頁面位址', () => {
    expect(toWebSocketUrl('https://api.example.com/api/ws/x', 'https://app.example.com/')).toBe(
      'wss://api.example.com/api/ws/x',
    )
  })

  it('只換協定，不會誤改 host 或 path 裡的 http 字樣', () => {
    expect(toWebSocketUrl('http://http.example.com/api/http/x', 'http://a/')).toBe(
      'ws://http.example.com/api/http/x',
    )
  })
})

// ─────────────────────────── 連線與認證 ───────────────────────────

describe('connect', () => {
  it('連到目前頁面推導出的 presence 位址，URL 不含 token', () => {
    const t = setup()
    t.client.connect(PROJECT_A)

    expect(t.last().url).toBe(`ws://${window.location.host}/api/ws/projects/${PROJECT_A}/presence`)
    expect(t.last().url).not.toContain(TOKEN)
    expect(t.client.status).toEqual({ state: 'connecting', projectId: PROJECT_A })
  })

  it('open 之後送出 auth，這是唯一送出的訊息', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().open()

    expect(t.last().sent).toEqual([JSON.stringify({ type: 'auth', access_token: TOKEN })])
  })

  it('open 不算連線成功，收到第一份 snapshot 才是', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().open()
    expect(t.client.status.state).toBe('connecting')

    t.last().receive(snapshot(1))
    expect(t.client.status).toEqual({ state: 'connected', projectId: PROJECT_A })
  })

  it('open 時沒有 token：不送 auth，改走一次 refresh', async () => {
    const t = setup({ token: null })
    t.refreshSession.mockImplementation(async () => {
      t.setToken(NEW_TOKEN)
      return fakeSession(NEW_TOKEN)
    })
    t.client.connect(PROJECT_A)
    const first = t.last()
    first.open()

    expect(first.sent).toEqual([])
    expect(first.closedWith).toBe(1000)
    await flush()

    expect(t.refreshSession).toHaveBeenCalledTimes(1)
    t.last().open()
    expect(t.last().sent).toEqual([JSON.stringify({ type: 'auth', access_token: NEW_TOKEN })])
  })

  it('沒有 token 且 refresh 判定未登入：停止，不重連', async () => {
    const t = setup({ token: null })
    t.refreshSession.mockResolvedValue(null)
    t.client.connect(PROJECT_A)
    t.last().open()
    await flush()

    expect(t.client.status).toEqual({
      state: 'stopped',
      projectId: PROJECT_A,
      reason: 'unauthenticated',
    })
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_MAX_DELAY_MS * 2)
    expect(t.sockets).toHaveLength(1)
  })

  it('對同一個進行中的專案重複 connect 不會重建連線', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.authenticate(t.last())

    t.client.connect(PROJECT_A)

    expect(t.sockets).toHaveLength(1)
    expect(t.last().closedWith).toBeNull()
  })

  it('停止之後再 connect 同一個專案會重新開始', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().serverClose(4404)

    t.client.connect(PROJECT_A)

    expect(t.sockets).toHaveLength(2)
    expect(t.client.status.state).toBe('connecting')
  })
})

describe('disconnect', () => {
  it('關閉 socket、回到 idle，之後的 onclose 不會重連', async () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const socket = t.last()
    t.authenticate(socket)

    t.client.disconnect()
    expect(socket.closedWith).toBe(1000)
    expect(t.client.status).toEqual({ state: 'idle' })

    // 瀏覽器在 close() 之後才會非同步送來 onclose
    socket.serverClose(1000)
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_MAX_DELAY_MS * 2)
    expect(t.sockets).toHaveLength(1)
    expect(t.client.status).toEqual({ state: 'idle' })
  })

  it('取消等待中的重連計時器', async () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().serverClose(1006)
    expect(t.client.status.state).toBe('reconnecting')

    t.client.disconnect()
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_MAX_DELAY_MS * 2)

    expect(t.sockets).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('沒有連線時呼叫不會發出狀態通知', () => {
    const t = setup()
    t.client.disconnect()
    expect(t.statuses).toEqual([])
  })
})

// ─────────────────────────── snapshot ───────────────────────────

describe('snapshot', () => {
  it('合法的 snapshot 被接受並轉發', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.authenticate(t.last(), 5)

    expect(t.snapshots).toEqual([snapshot(5)])
  })

  it('較新的 seq 被接受，重複與較舊的被忽略', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.authenticate(t.last(), 5)

    t.last().receive(snapshot(5)) // 重複
    t.last().receive(snapshot(3)) // 亂序抵達的舊資料
    t.last().receive(snapshot(8)) // 較新

    expect(t.snapshots.map((s) => s.seq)).toEqual([5, 8])
  })

  it('不轉發未知欄位', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().open()
    t.last().receive({
      ...snapshot(1),
      extra: 'x',
      users: [{ user_id: USER, display_name: null, role: 'member', email: 'leak@example.com' }],
    })

    expect(t.snapshots[0]).toEqual({
      type: 'presence.snapshot',
      project_id: PROJECT_A,
      seq: 1,
      users: [{ user_id: USER, display_name: null, role: 'member' }],
    })
  })

  it.each([
    ['非 JSON', 'not json'],
    ['陣列', '[]'],
    ['物件但沒有 type', { project_id: PROJECT_A, seq: 1, users: [] }],
    ['type 不是字串', { ...snapshot(1), type: 1 }],
    ['缺 project_id', { ...snapshot(1), project_id: undefined }],
    ['seq 不是整數', { ...snapshot(1), seq: 1.5 }],
    ['seq 是字串', { ...snapshot(1), seq: '1' }],
    ['seq 為負', { ...snapshot(1), seq: -1 }],
    ['users 不是陣列', { ...snapshot(1), users: {} }],
    ['user 缺 user_id', { ...snapshot(1), users: [{ display_name: null, role: 'owner' }] }],
    [
      'role 不合法',
      { ...snapshot(1), users: [{ user_id: USER, display_name: null, role: 'admin' }] },
    ],
    [
      'display_name 型別錯誤',
      { ...snapshot(1), users: [{ user_id: USER, display_name: 1, role: 'owner' }] },
    ],
    ['別的專案的 snapshot', snapshot(1, PROJECT_B)],
  ])('%s：不寫入，視為協定錯誤停止', (_label, payload) => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const socket = t.last()
    socket.open()

    socket.receive(payload)

    expect(t.snapshots).toEqual([])
    expect(t.client.status).toEqual({
      state: 'stopped',
      projectId: PROJECT_A,
      reason: 'protocol_error',
    })
    expect(socket.closedWith).toBe(1000)
  })

  it('壞資料之後同一條 socket 再來的訊息也不會被接受', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const socket = t.last()
    socket.open()
    socket.receive('garbage')

    socket.receive(snapshot(1))

    expect(t.snapshots).toEqual([])
  })

  it('重連後的新連線重新計算 seq（server 重啟會從頭編號）', async () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.authenticate(t.last(), 50)
    t.last().serverClose(1006)
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_BASE_DELAY_MS)

    t.authenticate(t.last(), 1)

    expect(t.snapshots.map((s) => s.seq)).toEqual([50, 1])
  })

  it('切換專案時 seq 重新開始', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.authenticate(t.last(), 50)

    t.client.connect(PROJECT_B)
    t.authenticate(t.last(), 2, PROJECT_B)

    expect(t.snapshots.map((s) => [s.project_id, s.seq])).toEqual([
      [PROJECT_A, 50],
      [PROJECT_B, 2],
    ])
  })

  it('狀態 listener 在「已連線」通知裡 disconnect，這份 snapshot 就不再送出', () => {
    const t = setup()
    t.client.onStatusChange((s) => {
      if (s.state === 'connected') t.client.disconnect()
    })
    t.client.connect(PROJECT_A)
    t.authenticate(t.last())

    expect(t.snapshots).toEqual([])
    expect(t.client.status).toEqual({ state: 'idle' })
  })
})

// ─────────────────────────── close code ───────────────────────────

describe('close code', () => {
  it.each([
    [4400, 'protocol_error'],
    [4404, 'project_unavailable'],
  ] as const)('%i → 停止（%s），不重連', async (code, reason) => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().open()
    t.last().serverClose(code)

    expect(t.client.status).toEqual({ state: 'stopped', projectId: PROJECT_A, reason })
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_MAX_DELAY_MS * 2)
    expect(t.sockets).toHaveLength(1)
    expect(t.refreshSession).not.toHaveBeenCalled()
  })

  it.each([
    [4408, 'auth timeout'],
    [1011, 'server error'],
    [1006, '沒有 close frame 的網路中斷'],
    [1001, 'server 關機'],
    [1000, 'server 端非預期的正常關閉'],
  ])('%i（%s）→ 退避後重連', async (code) => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().open()
    t.last().serverClose(code)

    expect(t.client.status).toEqual({
      state: 'reconnecting',
      projectId: PROJECT_A,
      attempt: 1,
      delayMs: PRESENCE_RECONNECT_BASE_DELAY_MS,
    })
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_BASE_DELAY_MS - 1)
    expect(t.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.sockets).toHaveLength(2)
    expect(t.refreshSession).not.toHaveBeenCalled()
  })
})

// ─────────────────────────── 4401 ───────────────────────────

describe('4401 auth recovery', () => {
  function withRefreshToNewToken(t: ReturnType<typeof setup>) {
    t.refreshSession.mockImplementation(async () => {
      t.setToken(NEW_TOKEN)
      return fakeSession(NEW_TOKEN)
    })
  }

  it('第一次 4401 → 呼叫既有 refresh 一次 → 立刻用新 token 開新連線', async () => {
    const t = setup()
    withRefreshToNewToken(t)
    t.client.connect(PROJECT_A)
    t.last().open()
    t.last().serverClose(4401)
    await flush()

    expect(t.refreshSession).toHaveBeenCalledTimes(1)
    expect(t.sockets).toHaveLength(2)
    t.last().open()
    expect(t.last().sent).toEqual([JSON.stringify({ type: 'auth', access_token: NEW_TOKEN })])
    t.last().receive(snapshot(1))
    expect(t.client.status.state).toBe('connected')
  })

  it('refresh 判定 session 失效 → 停止', async () => {
    const t = setup()
    t.refreshSession.mockResolvedValue(null)
    t.client.connect(PROJECT_A)
    t.last().open()
    t.last().serverClose(4401)
    await flush()

    expect(t.client.status).toEqual({
      state: 'stopped',
      projectId: PROJECT_A,
      reason: 'unauthenticated',
    })
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_MAX_DELAY_MS * 2)
    expect(t.sockets).toHaveLength(1)
  })

  it('refresh 本身網路失敗 → 退避重連，但 recovery 額度已用掉', async () => {
    const t = setup()
    t.refreshSession.mockRejectedValue(new Error('network'))
    t.client.connect(PROJECT_A)
    t.last().open()
    t.last().serverClose(4401)
    await flush()

    expect(t.client.status.state).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_BASE_DELAY_MS)
    t.last().open()
    t.last().serverClose(4401)
    await flush()

    expect(t.refreshSession).toHaveBeenCalledTimes(1)
    expect(t.client.status).toMatchObject({ state: 'stopped', reason: 'unauthenticated' })
  })

  it('refresh 成功後新連線又 4401 → 停止，不再 refresh', async () => {
    const t = setup()
    withRefreshToNewToken(t)
    t.client.connect(PROJECT_A)
    t.last().open()
    t.last().serverClose(4401)
    await flush()

    t.last().open()
    t.last().serverClose(4401)
    await flush()

    expect(t.refreshSession).toHaveBeenCalledTimes(1)
    expect(t.client.status).toEqual({
      state: 'stopped',
      projectId: PROJECT_A,
      reason: 'unauthenticated',
    })
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_MAX_DELAY_MS * 2)
    expect(t.sockets).toHaveLength(2)
  })

  it('一直回 4401 也不會形成迴圈', async () => {
    const t = setup()
    withRefreshToNewToken(t)
    t.client.connect(PROJECT_A)
    for (let i = 0; i < 10; i += 1) {
      t.last().open()
      t.last().serverClose(4401)
      await flush()
      await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_MAX_DELAY_MS)
    }

    expect(t.refreshSession).toHaveBeenCalledTimes(1)
    expect(t.sockets).toHaveLength(2)
  })

  it('認證成功過之後，額度重新可用（例如數小時後 server 重啟、token 已過期）', async () => {
    const t = setup()
    withRefreshToNewToken(t)
    t.client.connect(PROJECT_A)
    t.last().open()
    t.last().serverClose(4401)
    await flush()
    t.authenticate(t.last())

    t.last().serverClose(1012)
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_BASE_DELAY_MS)
    t.last().open()
    t.last().serverClose(4401)
    await flush()

    expect(t.refreshSession).toHaveBeenCalledTimes(2)
    expect(t.client.status.state).toBe('connecting')
  })

  it('refresh 進行中切換專案：refresh 回來後不會替舊專案開連線', async () => {
    const t = setup()
    let resolveRefresh: (session: Session | null) => void = () => {}
    t.refreshSession.mockReturnValue(new Promise((resolve) => (resolveRefresh = resolve)))
    t.client.connect(PROJECT_A)
    t.last().open()
    t.last().serverClose(4401)

    t.client.connect(PROJECT_B)
    resolveRefresh(fakeSession(NEW_TOKEN))
    await flush()

    expect(t.sockets.map((s) => s.url.includes(PROJECT_B))).toEqual([false, true])
    expect(t.client.status).toEqual({ state: 'connecting', projectId: PROJECT_B })
  })
})

// ─────────────────────────── backoff ───────────────────────────

describe('backoff', () => {
  it('延遲逐次加倍並封頂', () => {
    const delays = Array.from({ length: 8 }, (_, i) => reconnectDelay(i + 1))
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
    expect(reconnectDelay(10_000)).toBe(PRESENCE_RECONNECT_MAX_DELAY_MS)
  })

  it('連續失敗時 attempt 與 delay 遞增', async () => {
    const t = setup()
    t.client.connect(PROJECT_A)

    const seen: number[] = []
    for (let i = 0; i < 4; i += 1) {
      t.last().serverClose(1006)
      const status = t.client.status
      if (status.state !== 'reconnecting') throw new Error('expected reconnecting')
      seen.push(status.delayMs)
      await vi.advanceTimersByTimeAsync(status.delayMs)
    }

    expect(seen).toEqual([1_000, 2_000, 4_000, 8_000])
  })

  it('socket open 但認證前就斷線，不歸零', async () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().serverClose(1006)
    await vi.advanceTimersByTimeAsync(1_000)

    t.last().open()
    t.last().serverClose(1006)

    expect(t.client.status).toMatchObject({ state: 'reconnecting', attempt: 2, delayMs: 2_000 })
  })

  it('收到 snapshot（認證成功）之後才歸零', async () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().serverClose(1006)
    await vi.advanceTimersByTimeAsync(1_000)
    t.last().serverClose(1006)
    await vi.advanceTimersByTimeAsync(2_000)

    t.authenticate(t.last())
    t.last().serverClose(1006)

    expect(t.client.status).toMatchObject({ state: 'reconnecting', attempt: 1, delayMs: 1_000 })
  })
})

// ─────────────────────────── 舊 socket 與競態 ───────────────────────────

describe('stale socket', () => {
  it('舊 socket 的 onclose 不會替新專案觸發重連', async () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const oldSocket = t.last()
    t.client.connect(PROJECT_B)
    t.authenticate(t.last(), 1, PROJECT_B)

    oldSocket.serverClose(1006)
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_MAX_DELAY_MS * 2)

    expect(t.sockets).toHaveLength(2)
    expect(t.client.status).toEqual({ state: 'connected', projectId: PROJECT_B })
  })

  it('舊 socket 晚到的 snapshot 不會覆蓋新專案', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const oldSocket = t.last()
    oldSocket.open()
    t.client.connect(PROJECT_B)
    t.authenticate(t.last(), 1, PROJECT_B)

    oldSocket.receive(snapshot(999, PROJECT_A))

    expect(t.snapshots.map((s) => s.project_id)).toEqual([PROJECT_B])
    expect(t.client.status).toEqual({ state: 'connected', projectId: PROJECT_B })
  })

  it('舊 socket 的 onopen 不會送出 auth', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const oldSocket = t.last()
    t.client.connect(PROJECT_B)

    oldSocket.open()

    expect(oldSocket.sent).toEqual([])
  })

  it('舊 socket 的 4401 不會觸發 refresh', async () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const oldSocket = t.last()
    oldSocket.open()
    t.client.connect(PROJECT_B)

    oldSocket.serverClose(4401)
    await flush()

    expect(t.refreshSession).not.toHaveBeenCalled()
  })

  it('同一專案重連之後，被取代的舊 socket 事件同樣被忽略', async () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const first = t.last()
    first.serverClose(1006)
    await vi.advanceTimersByTimeAsync(1_000)
    t.authenticate(t.last(), 1)

    first.receive(snapshot(999))
    first.serverClose(4404)

    expect(t.snapshots.map((s) => s.seq)).toEqual([1])
    expect(t.client.status.state).toBe('connected')
  })

  it('快速切換專案：最後只剩目前專案的生命週期', async () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().serverClose(1006) // A 進入等待重連
    t.client.connect(PROJECT_B)
    t.client.connect(PROJECT_A)
    t.client.connect(PROJECT_B)

    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_MAX_DELAY_MS * 2)

    const live = t.sockets.filter((s) => s.closedWith === null && !s.closedByServer)
    expect(live).toHaveLength(1)
    expect(live[0]!.url).toContain(PROJECT_B)
    expect(t.sockets.at(-1)).toBe(live[0])
    expect(vi.getTimerCount()).toBe(0)
  })
})

// ─────────────────────────── 訊息分派 ───────────────────────────

describe('message routing', () => {
  it.each([
    ['server 之後才新增的訊息', { type: 'presence.typing', project_id: PROJECT_A }],
    ['client → server 的 type', { type: 'cursor.move', x: 1, y: 2 }],
    ['只有 type', { type: 'whatever' }],
  ])('不認得的 type（%s）被忽略，連線與名單不受影響', (_label, payload) => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const socket = t.last()
    t.authenticate(socket)

    socket.receive(payload)
    socket.receive(snapshot(2))

    expect(t.client.status).toEqual({ state: 'connected', projectId: PROJECT_A })
    expect(t.snapshots.map((s) => s.seq)).toEqual([1, 2])
    expect(t.cursors).toEqual([])
    expect(socket.closedWith).toBeNull()
  })

  it('認證前收到不認得的 type：不算連線成功，也不是錯誤', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().open()

    t.last().receive({ type: 'presence.typing' })

    expect(t.client.status).toEqual({ state: 'connecting', projectId: PROJECT_A })
  })
})

// ─────────────────────────── 游標：接收 ───────────────────────────

describe('cursor：接收', () => {
  it('移動與離開依序轉發，只帶已知欄位', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.authenticate(t.last())

    t.last().receive({ ...cursorMove(12.5, -340), extra: 'x' })
    t.last().receive(cursorLeave())

    expect(t.cursors).toEqual([
      { type: 'presence.cursor', project_id: PROJECT_A, user_id: OTHER, x: 12.5, y: -340 },
      { type: 'presence.cursor.leave', project_id: PROJECT_A, user_id: OTHER },
    ])
  })

  it.each([
    ['缺 x', { ...cursorMove(1, 2), x: undefined }],
    ['缺 y', { ...cursorMove(1, 2), y: undefined }],
    ['座標是字串', { ...cursorMove(1, 2), x: '1' }],
    ['座標是 null', { ...cursorMove(1, 2), y: null }],
    ['缺 user_id', { ...cursorMove(1, 2), user_id: undefined }],
    ['user_id 是空字串', { ...cursorMove(1, 2), user_id: '' }],
    ['缺 project_id', { ...cursorMove(1, 2), project_id: undefined }],
    ['別的專案的游標', cursorMove(1, 2, PROJECT_B)],
    ['leave 缺 user_id', { ...cursorLeave(), user_id: undefined }],
    ['別的專案的 leave', cursorLeave(PROJECT_B)],
  ])('壞掉的游標訊息（%s）只丟掉那一則，presence 繼續', (_label, payload) => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const socket = t.last()
    t.authenticate(socket)

    socket.receive(payload)
    socket.receive(cursorMove(3, 4))
    socket.receive(snapshot(2))

    expect(t.cursors).toEqual([cursorMove(3, 4)])
    expect(t.snapshots.map((s) => s.seq)).toEqual([1, 2])
    expect(t.client.status).toEqual({ state: 'connected', projectId: PROJECT_A })
    expect(socket.closedWith).toBeNull()
  })

  it.each([
    [
      'NaN',
      '{"type":"presence.cursor","project_id":"' + PROJECT_A + '","user_id":"u","x":NaN,"y":1}',
    ],
    [
      '溢位成 Infinity',
      '{"type":"presence.cursor","project_id":"' + PROJECT_A + '","user_id":"u","x":1e999,"y":1}',
    ],
  ])('非有限的座標（%s）不會進到 listener', (_label, raw) => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.authenticate(t.last())

    t.last().receive(raw)

    expect(t.cursors).toEqual([])
  })

  it('第一份 snapshot 之前的游標被丟棄，也不會讓連線變成已連線', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().open()

    t.last().receive(cursorMove(1, 2))

    expect(t.cursors).toEqual([])
    expect(t.client.status).toEqual({ state: 'connecting', projectId: PROJECT_A })
  })

  it('游標不影響 seq：之後較新的 snapshot 照常接受', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.authenticate(t.last(), 5)

    t.last().receive(cursorMove(1, 2))
    t.last().receive(snapshot(4))
    t.last().receive(snapshot(6))

    expect(t.snapshots.map((s) => s.seq)).toEqual([5, 6])
  })

  it('舊 socket 晚到的游標不會進到新專案', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const socketA = t.last()
    t.authenticate(socketA)
    t.client.connect(PROJECT_B)
    t.authenticate(t.last(), 1, PROJECT_B)

    socketA.receive(cursorMove(1, 2))

    expect(t.cursors).toEqual([])
  })

  it('斷線重連期間收不到游標；重連後照常', async () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    const first = t.last()
    t.authenticate(first)
    first.serverClose(1006)

    first.receive(cursorMove(1, 2))
    expect(t.cursors).toEqual([])

    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_BASE_DELAY_MS)
    t.authenticate(t.last())
    t.last().receive(cursorMove(3, 4))

    expect(t.cursors).toEqual([cursorMove(3, 4)])
  })
})

// ─────────────────────────── 游標：送出 ───────────────────────────

describe('cursor：送出與節流', () => {
  /** auth 是第一則，之後的才是游標。 */
  const sentCursors = (socket: FakeSocket) => socket.sent.slice(1).map((raw) => JSON.parse(raw))

  function connected() {
    const t = setup()
    t.client.connect(PROJECT_A)
    const socket = t.last()
    t.authenticate(socket)
    return { ...t, socket }
  }

  it('第一次立刻送出（leading）', () => {
    const t = connected()

    t.client.updateCursor({ x: 1.5, y: -2 })

    expect(sentCursors(t.socket)).toEqual([{ type: 'cursor.move', x: 1.5, y: -2 }])
  })

  it('視窗內的更新不送，結束時只補送最新的一個（trailing）', () => {
    const t = connected()

    t.client.updateCursor({ x: 1, y: 1 })
    t.client.updateCursor({ x: 2, y: 2 })
    t.client.updateCursor({ x: 3, y: 3 })
    expect(sentCursors(t.socket)).toHaveLength(1)

    vi.advanceTimersByTime(PRESENCE_CURSOR_THROTTLE_MS - 1)
    expect(sentCursors(t.socket)).toHaveLength(1)

    vi.advanceTimersByTime(1)
    expect(sentCursors(t.socket)).toEqual([
      { type: 'cursor.move', x: 1, y: 1 },
      { type: 'cursor.move', x: 3, y: 3 },
    ])
  })

  it('持續移動時每個視窗最多一則', () => {
    const t = connected()

    // 每 5ms 一次 mousemove，持續 1 秒
    for (let i = 0; i < 200; i += 1) {
      t.client.updateCursor({ x: i, y: 0 })
      vi.advanceTimersByTime(5)
    }
    vi.advanceTimersByTime(PRESENCE_CURSOR_THROTTLE_MS)

    const sent = sentCursors(t.socket)
    expect(sent.length).toBeLessThanOrEqual(1000 / PRESENCE_CURSOR_THROTTLE_MS + 1)
    // 最後的位置沒有被丟掉
    expect(sent[sent.length - 1]).toEqual({ type: 'cursor.move', x: 199, y: 0 })
  })

  it('停下來之後不會再送任何東西', () => {
    const t = connected()
    t.client.updateCursor({ x: 1, y: 1 })

    vi.advanceTimersByTime(PRESENCE_CURSOR_THROTTLE_MS * 10)

    expect(sentCursors(t.socket)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('離開畫布送 cursor.leave；與移動共用同一格，最後的狀態勝出', () => {
    const t = connected()

    t.client.updateCursor({ x: 1, y: 1 })
    t.client.updateCursor({ x: 2, y: 2 })
    t.client.updateCursor(null)
    vi.advanceTimersByTime(PRESENCE_CURSOR_THROTTLE_MS)

    expect(sentCursors(t.socket)).toEqual([
      { type: 'cursor.move', x: 1, y: 1 },
      { type: 'cursor.leave' },
    ])
  })

  it('離開之後又回來：補送的是回來後的位置', () => {
    const t = connected()

    t.client.updateCursor(null)
    t.client.updateCursor({ x: 5, y: 5 })
    vi.advanceTimersByTime(PRESENCE_CURSOR_THROTTLE_MS)

    expect(sentCursors(t.socket)).toEqual([
      { type: 'cursor.leave' },
      { type: 'cursor.move', x: 5, y: 5 },
    ])
  })

  it.each([
    ['NaN', { x: Number.NaN, y: 1 }],
    ['Infinity', { x: 1, y: Number.POSITIVE_INFINITY }],
  ])('非有限的座標（%s）不送出：server 會以 4400 關閉整條連線', (_label, point) => {
    const t = connected()

    t.client.updateCursor(point)

    expect(sentCursors(t.socket)).toEqual([])
  })

  it('尚未連線（idle）時不送、不啟動計時器', () => {
    const t = setup()

    t.client.updateCursor({ x: 1, y: 1 })

    expect(t.sockets).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('socket open 但還沒收到第一份 snapshot 時不送', () => {
    const t = setup()
    t.client.connect(PROJECT_A)
    t.last().open()

    t.client.updateCursor({ x: 1, y: 1 })

    expect(t.last().sent).toHaveLength(1) // 只有 auth
  })

  it('重連等待中不送，也不排隊到重連之後', async () => {
    const t = connected()
    t.socket.serverClose(1006)

    t.client.updateCursor({ x: 1, y: 1 })
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_BASE_DELAY_MS)
    t.authenticate(t.last())
    vi.advanceTimersByTime(PRESENCE_CURSOR_THROTTLE_MS)

    expect(sentCursors(t.socket)).toEqual([])
    expect(sentCursors(t.last())).toEqual([])
  })

  it('斷線時丟掉還沒送出的位置，不會在新連線上補送舊座標', async () => {
    const t = connected()
    t.client.updateCursor({ x: 1, y: 1 })
    t.client.updateCursor({ x: 2, y: 2 }) // 等待 trailing

    t.socket.serverClose(1006)
    await vi.advanceTimersByTimeAsync(PRESENCE_RECONNECT_BASE_DELAY_MS)
    t.authenticate(t.last())
    vi.advanceTimersByTime(PRESENCE_CURSOR_THROTTLE_MS)

    expect(sentCursors(t.socket)).toHaveLength(1)
    expect(sentCursors(t.last())).toEqual([])
  })

  it('disconnect 取消等待中的 trailing', () => {
    const t = connected()
    t.client.updateCursor({ x: 1, y: 1 })
    t.client.updateCursor({ x: 2, y: 2 })

    t.client.disconnect()
    vi.advanceTimersByTime(PRESENCE_CURSOR_THROTTLE_MS)

    expect(sentCursors(t.socket)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('換專案後，舊專案等待中的位置不會送到新專案', () => {
    const t = connected()
    t.client.updateCursor({ x: 1, y: 1 })
    t.client.updateCursor({ x: 2, y: 2 })

    t.client.connect(PROJECT_B)
    const socketB = t.last()
    t.authenticate(socketB, 1, PROJECT_B)
    vi.advanceTimersByTime(PRESENCE_CURSOR_THROTTLE_MS)

    expect(sentCursors(t.socket)).toHaveLength(1)
    expect(sentCursors(socketB)).toEqual([])
  })

  it('換專案後節流重新開始：新專案的第一次移動立刻送出', () => {
    const t = connected()
    t.client.updateCursor({ x: 1, y: 1 })

    t.client.connect(PROJECT_B)
    const socketB = t.last()
    t.authenticate(socketB, 1, PROJECT_B)
    t.client.updateCursor({ x: 9, y: 9 })

    expect(sentCursors(socketB)).toEqual([{ type: 'cursor.move', x: 9, y: 9 }])
  })

  it('協定錯誤停止之後不送', () => {
    const t = connected()
    t.socket.receive('garbage')

    t.client.updateCursor({ x: 1, y: 1 })

    expect(sentCursors(t.socket)).toEqual([])
  })
})
