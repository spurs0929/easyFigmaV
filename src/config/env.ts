/**
 * API 位址。
 *
 * 開發時是空字串，代表用相對路徑 /api/...，由 Vite 的 proxy 轉給本機後端。
 * 這樣前後端同源，refresh cookie 屬於第一方，SameSite=Lax 才送得出去。
 *
 * 正式環境是完整網址，此時 cookie 為跨站，後端會改發 SameSite=None; Secure。
 *
 * 這個值不是機密（就是一個公開的 API 網址），所以直接寫在原始碼裡而不用
 * .env 檔——專案的 .gitignore 會忽略所有 .env*，多開例外反而容易出錯。
 * 需要指向別的後端時，用 VITE_API_BASE_URL 覆寫即可。
 */
const FALLBACK = import.meta.env.DEV ? '' : 'https://easyfigma-api.onrender.com'

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? FALLBACK

/** 打後端 API 用。傳入 '/auth/login' 會得到正確的完整路徑。 */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}/api${path}`
}
