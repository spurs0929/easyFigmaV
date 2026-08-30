import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  ApiError,
  ensureBootstrapped,
  login as apiLogin,
  logout as apiLogout,
  logoutAll as apiLogoutAll,
  onSessionChange,
  register as apiRegister,
  type User,
} from '@/services/api'

/** 把各種失敗轉成可以直接顯示的訊息。 */
function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    // 後端的 detail 已經是給使用者看的中文訊息，只有限流需要補充說明。
    if (error.status === 429) return '嘗試次數過多，請稍後再試'
    return error.detail
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return '伺服器沒有回應，請稍後再試'
  }
  return '無法連線到伺服器，請檢查網路連線'
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const error = ref<string | null>(null)
  const pending = ref(false)
  /** bootstrap 是否已完成。router guard 靠它避免在恢復 session 前就判斷。 */
  const ready = ref(false)

  const isAuthenticated = computed(() => user.value !== null)
  const displayName = computed(() => user.value?.display_name ?? user.value?.email ?? '')

  // 自動輪替成功、或 session 失效時，api 層會通知，這裡跟著更新。
  onSessionChange((session) => {
    user.value = session?.user ?? null
  })

  /** 啟動時恢復 session。可重複呼叫，實際請求只會發一次。 */
  async function bootstrap(): Promise<void> {
    try {
      const session = await ensureBootstrapped()
      user.value = session?.user ?? null
    } catch {
      // 網路問題不等於未登入，但此時也無法確認身分，先以未登入處理。
      user.value = null
    } finally {
      ready.value = true
    }
  }

  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    pending.value = true
    error.value = null
    try {
      return await action()
    } catch (caught) {
      error.value = describeError(caught)
      return null
    } finally {
      pending.value = false
    }
  }

  async function login(email: string, password: string): Promise<boolean> {
    const session = await run(() => apiLogin({ email, password }))
    if (session) user.value = session.user
    return session !== null
  }

  async function register(
    email: string,
    password: string,
    displayNameInput?: string,
  ): Promise<boolean> {
    const session = await run(() =>
      apiRegister({ email, password, display_name: displayNameInput || undefined }),
    )
    if (session) user.value = session.user
    return session !== null
  }

  /**
   * 登出這個裝置。
   *
   * 即使伺服器端失敗也一定回到未登入狀態（api 層保證），但會設定 error，
   * 因為此時 refresh cookie 可能仍有效，重新載入頁面會恢復登入。
   */
  async function logout(): Promise<void> {
    await run(() => apiLogout())
    user.value = null
  }

  async function logoutAll(): Promise<void> {
    await run(() => apiLogoutAll())
    user.value = null
  }

  function clearError(): void {
    error.value = null
  }

  return {
    user,
    error,
    pending,
    ready,
    isAuthenticated,
    displayName,
    bootstrap,
    login,
    register,
    logout,
    logoutAll,
    clearError,
  }
})
