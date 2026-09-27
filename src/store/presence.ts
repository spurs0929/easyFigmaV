import { onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { onSessionChange } from '@/services/api'
import { presenceClient } from '@/services/presence'
import type { PresenceStatus, PresenceUser } from '@/types/presence'

/**
 * Presence 在 application 層的狀態：目前誰在線、連線到哪一步。
 *
 * 這裡只是 presenceClient 的 consumer。重連、退避、seq 過濾、4401 恢復與
 * snapshot 驗證全部在 transport 完成，store 不重做任何一項——兩套狀態機
 * 各自判斷「現在是不是最新」，遲早會判斷出不同的答案。
 */
export const usePresenceStore = defineStore('presence', () => {
  /** 目前維護中的專案。只用來判斷換專案時要不要先清空名單。 */
  const projectId = ref<string | null>(null)
  const users = ref<PresenceUser[]>([])
  const status = ref<PresenceStatus>(presenceClient.status)

  // snapshot 是完整名單，不是增量事件：直接覆寫。
  // client 已經保證它屬於目前的專案、而且比上一份新。
  const stopSnapshot = presenceClient.onSnapshot((snapshot) => {
    users.value = snapshot.users
  })

  const stopStatus = presenceClient.onStatusChange((next) => {
    status.value = next
    // idle / stopped 都不會再有新的 snapshot，留著名單就是在顯示過期資料。
    // reconnecting 刻意保留：同一個專案短暫斷線，名單閃掉再出現反而更吵，
    // UI 會用重連中的樣式標示它可能已經不準。
    if (next.state === 'idle' || next.state === 'stopped') users.value = []
  })

  // 登出由既有的 session 事件驅動，presence 不自己判斷登入狀態。
  // 已建立的連線不會因為 token 失效而被 server 踢掉，所以這裡必須主動斷。
  const stopSession = onSessionChange((session) => {
    if (!session) disconnect()
  })

  // store 被 $dispose（測試、HMR）時一併退訂，重建後不會累積重複的 listener。
  onScopeDispose(() => {
    stopSnapshot()
    stopStatus()
    stopSession()
  })

  function connect(id: string): void {
    // 先清空再連：換專案時 client 直接從 A 的狀態跳到 B 的 connecting，
    // 中間沒有 idle，不在這裡清的話 B 連上之前畫面上仍是 A 的成員。
    if (projectId.value !== id) users.value = []
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
    // 尚未連線時 client 不會發出 idle，所以狀態也在這裡同步一次。
    presenceClient.disconnect()
    status.value = presenceClient.status
  }

  return { projectId, users, status, connect, disconnect }
})
