import { createRouter, createWebHistory } from 'vue-router'
import EditorView from '@/views/EditorView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      // 本機草稿：不需要登入，內容存在 IndexedDB。
      //
      // 之後的雲端專案會是另一條獨立路由 /p/:id，而不是在這條路由裡用
      // 條件切換持久化目標——兩個目的地各自單純，勝過一個路由裡兩套邏輯。
      path: '/',
      name: 'editor',
      // 首頁不做 lazy load：它是主要入口，切成獨立 chunk 只會多一次往返。
      component: EditorView,
    },
  ],
})

export default router
