/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Firebase Web App config（Firebase Console → 專案設定 → 你的應用程式）。 */
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
  readonly VITE_FIREBASE_APP_ID?: string
  /** 舊 FastAPI 後端位址，只有 Presence 會用到，firebase-demo 預設不需要。 */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
