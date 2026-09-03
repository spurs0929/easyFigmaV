import { ApiError } from '@/services/api'

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

const FIELD_MESSAGES: Record<string, string> = {
  email: 'Email 格式不正確',
  password: '密碼長度需為 8 到 128 個字元',
  display_name: '顯示名稱最多 80 個字元',
  name: '專案名稱不可為空白，且最多 120 個字元',
}

/** 把各種失敗轉成可以直接顯示的訊息。 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return '嘗試次數過多，請稍後再試'

    // 422 來自 pydantic，訊息是英文且偏技術性，要翻成使用者看得懂的。
    if (error.status === 422) {
      const field = firstInvalidField(error.payload)
      return (field && FIELD_MESSAGES[field]) || '輸入內容有誤，請檢查後再試'
    }

    // 5xx 是伺服器端的問題，不是使用者輸入的問題。
    // 開發時後端停掉會由 Vite proxy 回 500，正式環境則是 Render 回 502/503。
    if (error.status >= 500) return '伺服器暫時無法回應，請稍後再試'

    return error.detail
  }

  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return '伺服器沒有回應，請稍後再試'
  }
  return '無法連線到伺服器，請檢查網路連線'
}
