import { FirebaseError } from 'firebase/app'
import { ApiError } from '@/services/api'

/**
 * Firebase Auth / Firestore 的錯誤代碼 → 使用者看得懂的訊息。
 *
 * auth/invalid-credential 刻意不區分「帳號不存在」與「密碼錯誤」，
 * 跟 FastAPI 版登入失敗的訊息一致，避免被用來列舉已註冊的 email。
 */
const FIREBASE_MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'Email 或密碼錯誤',
  'auth/wrong-password': 'Email 或密碼錯誤',
  'auth/user-not-found': 'Email 或密碼錯誤',
  'auth/invalid-email': 'Email 格式不正確',
  'auth/email-already-in-use': '這個 Email 已經註冊過',
  'auth/weak-password': '密碼強度不足',
  'auth/too-many-requests': '嘗試次數過多，請稍後再試',
  'auth/user-disabled': '這個帳號已被停用',
  'auth/popup-closed-by-user': '已取消 Google 登入',
  'auth/cancelled-popup-request': '已取消 Google 登入',
  'auth/popup-blocked': '瀏覽器擋住了登入視窗，請允許這個網站開啟彈出式視窗',
  'auth/unauthorized-domain': '這個網域尚未加入 Firebase 的授權網域',
  'auth/account-exists-with-different-credential': '這個 Email 已經用其他方式註冊過',
  'auth/network-request-failed': '無法連線到伺服器，請檢查網路連線',
  'permission-denied': '你沒有權限執行這個動作',
  'not-found': '找不到這筆資料',
  unavailable: '無法連線到伺服器，請檢查網路連線',
  'deadline-exceeded': '伺服器沒有回應，請稍後再試',
  'resource-exhausted': '使用量已達上限，請稍後再試',
}

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
  content: '留言內容不可為空白，且最多 2000 個字元',
}

/** 把各種失敗轉成可以直接顯示的訊息。 */
export function describeError(error: unknown): string {
  if (error instanceof FirebaseError) {
    return FIREBASE_MESSAGES[error.code] ?? `操作失敗（${error.code}）`
  }

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
