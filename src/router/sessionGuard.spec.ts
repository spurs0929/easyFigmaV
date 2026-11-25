import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

/**
 * 用真的 api 層、只換掉 Firebase SDK：session 失效走的是 api.ts 實際的 publish(null)
 * 路徑，而不是測試自己發事件。這樣才能證明導航是 session 驅動，不是按鈕驅動。
 *
 * 被動失效（其他分頁登出、帳號被停用）在 Firebase 版是 SDK 觸發 onAuthStateChanged，
 * 測試抓住那個 callback 自己呼叫。
 */

const firebase = vi.hoisted(() => {
  const signedInUser = {
    uid: 'u1',
    email: 'a@example.com',
    displayName: 'A',
    metadata: { creationTime: '2026-01-01T00:00:00Z' },
  }
  const state = {
    authCallback: null as ((user: unknown) => void) | null,
    auth: { currentUser: signedInUser as unknown, authStateReady: async () => {} },
    signedInUser,
  }
  return state
})

vi.mock('@/services/firebase', () => ({ firebaseAuth: firebase.auth, db: {} }))
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, callback: (user: unknown) => void) => {
    firebase.authCallback = callback
    return () => {}
  },
  signOut: vi.fn(async () => {
    firebase.auth.currentUser = null
  }),
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  updateProfile: vi.fn(),
}))
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), setDoc: vi.fn(), serverTimestamp: vi.fn() }))

const PROJECT_PATH = '/p/11111111-1111-1111-1111-111111111111'
const Empty = defineComponent({ render: () => null })

let router: Router
let uninstall: () => void
let api: typeof import('@/services/api')

async function startAt(path: string): Promise<void> {
  const { installSessionGuard } = await import('./sessionGuard')
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'editor', component: Empty },
      { path: '/p/:id', name: 'project', component: Empty, meta: { requiresAuth: true } },
      { path: '/projects', name: 'projects', component: Empty, meta: { requiresAuth: true } },
      { path: '/login', name: 'login', component: Empty, meta: { guestOnly: true } },
    ],
  })
  uninstall = installSessionGuard(router)
  await router.push(path)
}

/** 等 api 的非同步流程與導航都跑完。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await router.isReady()
}

describe('session 失效時離開受保護的 route', () => {
  beforeEach(async () => {
    // api.ts 有模組層級的 session 狀態，每個測試都從乾淨的模組開始。
    vi.resetModules()
    firebase.auth.currentUser = firebase.signedInUser
    api = await import('@/services/api')
    await api.ensureBootstrapped()
  })

  afterEach(() => {
    uninstall()
  })

  it('主動登出：/p/:id → /login?redirect=/p/:id', async () => {
    await startAt(PROJECT_PATH)

    await api.logout()
    await settle()

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe(PROJECT_PATH)
  })

  it('被動失效：SDK 通知已登出，不經過任何登出按鈕', async () => {
    await startAt(PROJECT_PATH)

    firebase.authCallback?.(null)
    await settle()

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe(PROJECT_PATH)
  })

  it('登出所有裝置走同一套處理', async () => {
    await startAt('/projects')

    await api.logoutAll()
    await settle()

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/projects')
  })

  it('用 replace 導航：上一頁不會回到已經進不去的專案頁', async () => {
    await startAt('/')
    await router.push(PROJECT_PATH)

    await api.logout()
    await settle()
    expect(router.currentRoute.value.name).toBe('login')

    // push 的話歷史是 [/, /p/:id, /login]，上一頁會回到專案頁。
    router.back()
    await settle()

    expect(router.currentRoute.value.path).toBe('/')
  })

  it('公開頁面（本機草稿）不導航', async () => {
    await startAt('/')

    await api.logout()
    await settle()

    expect(router.currentRoute.value.path).toBe('/')
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('同一個使用者的重複事件（例如 token 自動換新）不導航', async () => {
    await startAt(PROJECT_PATH)

    firebase.authCallback?.(firebase.signedInUser)
    await settle()

    expect(router.currentRoute.value.path).toBe(PROJECT_PATH)
  })
})
