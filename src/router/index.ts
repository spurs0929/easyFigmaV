import { createRouter, createWebHistory } from 'vue-router'
import EditorView from '@/views/EditorView.vue'
import { useAuthStore } from '@/store/auth'

declare module 'vue-router' {
  interface RouteMeta {
    /** 需要登入才能進入。 */
    requiresAuth?: boolean
    /** 已登入時不該停留（登入、註冊頁）。 */
    guestOnly?: boolean
  }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      // 本機草稿：不需要登入，內容存在 IndexedDB。
      // 雲端專案之後會是獨立的 /p/:id，而不是在這裡用條件切換持久化目標。
      path: '/',
      name: 'editor',
      component: EditorView,
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { guestOnly: true },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/RegisterView.vue'),
      meta: { guestOnly: true },
    },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  // 必須等 silent refresh 完成再判斷，否則使用者重新整理時會因為 session
  // 尚未恢復而被導向登入頁。bootstrap 內建單次保證，重複呼叫不會重複請求。
  await auth.bootstrap()

  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (to.meta.guestOnly && auth.isAuthenticated) {
    return { name: 'editor' }
  }

  return true
})

export default router
