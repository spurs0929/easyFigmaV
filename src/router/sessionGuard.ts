import type { Router } from 'vue-router'
import { onSessionChange } from '@/services/api'

/**
 * session 在頁面上失效時，讓受保護的 route 導回登入頁。
 *
 * beforeEach 只在「導航發生時」檢查 requiresAuth。使用者停在 /p/:id 時
 * session 變成 null（登出、登出所有裝置、refresh 被後端拒絕）不會觸發任何導航，
 * 於是雲端文件繼續留在畫面上。這裡接的是 session 事件而不是登出按鈕，
 * 三條路徑才會走同一套處理。
 *
 * 只負責離開 route：EditorView 卸載時，既有的 stopPersistence 與 presence
 * disconnect 會完成其餘清理，auth 層不需要知道 Editor 的存在。
 *
 * @returns 取消訂閱的函式。
 */
export function installSessionGuard(router: Router): () => void {
  return onSessionChange((session) => {
    if (session) return

    const current = router.currentRoute.value
    if (!current.meta.requiresAuth) return

    // replace：上一頁不該再回到一個已經進不去的頁面。
    // 導航是非同步的，beforeEach 執行時 auth store 也已經收到同一個事件。
    void router.replace({ name: 'login', query: { redirect: current.fullPath } })
  })
}
