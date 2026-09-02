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

/** 從 FastAPI 的 422 回應裡取出第一個出錯的欄位名稱。 */
function firstInvalidField(payload: unknown): string | null {
  const detail = (payload as { detail?: unknown })?.detail
  if (!Array.isArray(detail)) return null
  const loc = (detail[0] as { loc?: unknown })?.loc
  if (!Array.isArray(loc)) return null
  // loc 形如 ['body', 'email']，最後一段才是欄位名
  const field = loc[loc.length - 1]
  return typeof field === 'string' ? field : null
}

/** 把各種失敗轉成可以直接顯示的訊息。 */
function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    // 後端的 detail 多半已經是給使用者看的中文訊息，兩種例外要另外處理。
    if (error.status === 429) return '嘗試次數過多，請稍後再試'

    // 5xx 代表伺服器端的問題，不是使用者輸入的問題。
    // 開發時後端停掉會由 Vite proxy 回 500，正式環境則是 Render 回 502/503。
    if (error.status >= 500) return '伺服器暫時無法回應，請稍後再試'

    // 422 來自 pydantic，訊息是英文且偏技術性
    // （例如 "The part after the @-sign is not valid."），要翻成使用者看得懂的。
    if (error.status === 422) {
      switch (firstInvalidField(error.payload)) {
        case 'email':
          return 'Email 格式不正確'
        case 'password':
          return '密碼長度需為 8 到 128 個字元'
        case 'display_name':
          return '顯示名稱最多 80 個字元'
        default:
          return '輸入內容有誤，請檢查後再試'
      }
    }

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
  // 用計數而非布林：兩個動作並行時，先完成的那個不會提前解除 loading。
  const pendingCount = ref(0)
  const pending = computed(() => pendingCount.value > 0)
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
    // 只在啟動時執行一次。ensureBootstrapped() 會永久快取第一次的結果，
    // 完成後再呼叫會拿到過期的 session，把登入後的狀態蓋掉。
    if (ready.value) return

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
    pendingCount.value += 1
    error.value = null
    try {
      return await action()
    } catch (caught) {
      error.value = describeError(caught)
      return null
    } finally {
      pendingCount.value -= 1
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
      apiRegister({
        email,
        password,
        display_name: displayNameInput?.trim() || undefined,
      }),
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
