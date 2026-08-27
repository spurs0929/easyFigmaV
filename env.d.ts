/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 覆寫後端位址。留空時使用 src/config/env.ts 的預設值。 */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
