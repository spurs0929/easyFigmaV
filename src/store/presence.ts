import { onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { onSessionChange } from '@/services/api'
import { presenceClient } from '@/services/presence'
import {
  PRESENCE_CURSOR_TYPE,
  type CursorPoint,
  type PresenceStatus,
  type PresenceUser,
} from '@/types/presence'

/**
 * Presence 在 application 層的狀態：目前誰在線、連線到哪一步、其他人的游標在哪。
 *
 * 這裡只是 presenceClient 的 consumer。重連、退避、seq 過濾、4401 恢復、
 * 訊息驗證與游標節流全部在 transport 完成，store 不重做任何一項——兩套狀態機
 * 各自判斷「現在是不是最新」，遲早會判斷出不同的答案。
 *
 * 這裡的一切都是 ephemeral：不進文件快照、不進 IndexedDB / localStorage、
 * 不影響 documentRevision，也沒有 undo。重新整理之後由下一條連線重建。
 */
export const usePresenceStore = defineStore('presence', () => {
  /** 目前維護中的專案。只用來判斷換專案時要不要先清空名單。 */
  const projectId = ref<string | null>(null)
  const users = ref<PresenceUser[]>([])
  const status = ref<PresenceStatus>(presenceClient.status)
  /**
   * 其他使用者的游標，world 座標，以 user_id 為 key（同一人多個分頁共用一個）。
   *
   * 不變量：key 一定在 users 裡。server 不保存游標位置，這裡沒有的就是
   * 「還沒收到」，要等對方再次移動才會出現。
   */
  const cursors = ref(new Map<string, CursorPoint>())

  // snapshot 是完整名單，不是增量事件：直接覆寫。
  // client 已經保證它屬於目前的專案、而且比上一份新。
  const stopSnapshot = presenceClient.onSnapshot((snapshot) => {
    users.value = snapshot.users
    // 離線只由 snapshot 表達，server 不會另外送游標離開：不在名單上的人，游標一起移除。
    const online = new Set(snapshot.users.map((user) => user.user_id))
    for (const userId of cursors.value.keys()) {
      if (!online.has(userId)) cursors.value.delete(userId)
    }
  })

  const stopCursor = presenceClient.onCursor((cursor) => {
    // 游標與 snapshot 的抵達順序沒有保證：某人離線之後，他最後一則游標可能才到。
    // 名單外的游標必須直接丟掉而不是先存著——存著的話，他下次上線時畫面上
    // 會先出現一個舊位置。
    if (!users.value.some((user) => user.user_id === cursor.user_id)) return

    if (cursor.type === PRESENCE_CURSOR_TYPE) {
      cursors.value.set(cursor.user_id, { x: cursor.x, y: cursor.y })
    } else {
      cursors.value.delete(cursor.user_id)
    }
  })

  const stopStatus = presenceClient.onStatusChange((next) => {
    status.value = next
    // idle / stopped 都不會再有新的 snapshot，留著名單就是在顯示過期資料。
    // reconnecting 刻意保留：同一個專案短暫斷線，名單閃掉再出現反而更吵，
    // UI 會用重連中的樣式標示它可能已經不準。
    if (next.state === 'idle' || next.state === 'stopped') users.value = []
    // 游標比名單嚴格：只要不是 connected 就清空。名單在重連期間「可能不準」還能接受，
    // 游標則是位置，停在斷線前的地方就是錯的；server 也不保存位置，重連後不會補送，
    // 留著的話它會一直停在那裡直到對方再次移動。
    if (next.state !== 'connected') cursors.value.clear()
  })

  // 登出由既有的 session 事件驅動，presence 不自己判斷登入狀態。
  // 已建立的連線不會因為 token 失效而被 server 踢掉，所以這裡必須主動斷。
  const stopSession = onSessionChange((session) => {
    if (!session) disconnect()
  })

  // store 被 $dispose（測試、HMR）時一併退訂，重建後不會累積重複的 listener。
  onScopeDispose(() => {
    stopSnapshot()
    stopCursor()
    stopStatus()
    stopSession()
  })

  function connect(id: string): void {
    // 先清空再連：換專案時 client 直接從 A 的狀態跳到 B 的 connecting，
    // 中間沒有 idle，不在這裡清的話 B 連上之前畫面上仍是 A 的成員。
    if (projectId.value !== id) {
      users.value = []
      cursors.value.clear()
    }
    projectId.value = id

    try {
      presenceClient.connect(id)
    } catch (error) {
      // 例如 WebSocket 位址無法推導、瀏覽器拒絕建立 socket。
      // presence 是輔助功能，失敗只能讓它消失，不能讓呼叫端（Editor）跟著壞掉。
      console.error('Presence connect failed', error)
      disconnect()
    }
  }

  function disconnect(): void {
    projectId.value = null
    users.value = []
    cursors.value.clear()
    // 尚未連線時 client 不會發出 idle，所以狀態也在這裡同步一次。
    presenceClient.disconnect()
    status.value = presenceClient.status
  }

  /**
   * 回報自己的游標（world 座標），null 表示離開畫布。可以在每個 mousemove 呼叫：
   * 節流、以及「沒有連線時不送」（本機草稿、重連中）都由 transport 處理。
   */
  function updateCursor(point: CursorPoint | null): void {
    presenceClient.updateCursor(point)
  }

  return { projectId, users, status, cursors, connect, disconnect, updateCursor }
})
