import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

export default defineConfig({
  plugins: [
    vue(),
    // 開發環境 Vue DevTools，生產環境自動停用。
    vueDevTools(),
  ],
  resolve: {
    alias: {
      // 統一使用 @/ 作為 src/ 的路徑別名。
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // 把 /api 轉給本機後端，讓開發時前後端同源。
      //
      // 這不只是省去 CORS 設定——本機的 refresh cookie 是 SameSite=Lax，
      // 而 Lax 在跨站 XHR 不會送出 cookie。若前端直接打 127.0.0.1:8000，
      // 登入看似成功，但之後每次 refresh 都會因為收不到 cookie 而失敗。
      // 走 proxy 之後 cookie 屬於第一方，這個問題不存在。
      //
      // 代價：開發時不會經過真正的跨站流程，CORS 與 SameSite=None 的設定
      // 只有在部署後才會被實際驗證。
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // 目標現代瀏覽器，充分利用 Canvas API 與 ES2022+ 特性。
    target: 'esnext',
  },
})
