/**
 * 環境變數的唯一入口。
 *
 * 集中讀取 import.meta.env，統一管理型別與啟動時驗證，
 * 並避免環境變數散落於各模組。
 *
 * firebase-demo 分支：後端換成 Firebase，因此不再需要 VITE_API_BASE_URL，
 * 改為讀取 Firebase Web App 的 config。
 *
 * VITE_ 前綴的變數會被編譯進前端 bundle，因此只能存放可公開資訊。
 * Firebase Web config 本來就是公開的，安全性由 Firestore Security Rules 負責。
 */

export const IS_DEV: boolean = import.meta.env.DEV

export interface FirebaseWebConfig {
  apiKey: string
  authDomain: string
  projectId: string
  appId: string
}

export const FIREBASE_CONFIG: FirebaseWebConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
}

// 缺任何一個值都直接啟動失敗（測試環境由 vitest.config.ts 提供假值），
// 避免畫面看似正常、登入時才冒出難懂的 auth/invalid-api-key。
const missing = Object.entries(FIREBASE_CONFIG)
  .filter(([, value]) => !value)
  .map(([key]) => key)

if (missing.length > 0) {
  throw new Error(
    `缺少 Firebase 設定：${missing.join(', ')}。請在 .env.production / .env.development.local 填入 VITE_FIREBASE_*。`,
  )
}

/**
 * 舊 FastAPI 後端位址。firebase-demo 只剩 Presence（WebSocket）的程式碼還引用它，
 * 而 Presence 在這個分支預設關閉（見 config/app.ts 的 PRESENCE_ENABLED），
 * 保留是為了之後若要接回 Render 上的 presence 服務不必重寫。
 */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? ''

export function apiUrl(path: string): string {
  return `${API_BASE_URL}/api${path}`
}
