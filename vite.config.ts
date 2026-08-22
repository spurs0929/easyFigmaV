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
  build: {
    // 目標現代瀏覽器，充分利用 Canvas API 與 ES2022+ 特性。
    target: 'esnext',
  },
})
