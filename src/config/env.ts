/**
 * 環境變數的唯一入口。
 *
 * 集中讀取 import.meta.env，統一管理型別與啟動時驗證，
 * 並避免環境變數散落於各模組。
 */

/**
 * 後端 API 位址。
 *
 * 開發環境使用空字串與相對路徑，交由 Vite proxy 轉送至本機後端。
 * 正式環境則指定完整的 API origin。
 *
 * VITE_ 前綴的變數會被編譯進前端 bundle，因此只能存放可公開資訊，
 * 不得包含密碼、API secret 或其他機密資料。
 */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? ''

export const IS_DEV: boolean = import.meta.env.DEV

/** 將 API 相對路徑轉換為完整請求位址。 */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}/api${path}`
}

// 正式環境必須明確指定 API 位址，避免錯誤地使用相對路徑。
if (!IS_DEV && !API_BASE_URL) {
  throw new Error('缺少 VITE_API_BASE_URL。正式環境必須指定後端位址，請檢查 .env.production。')
}
