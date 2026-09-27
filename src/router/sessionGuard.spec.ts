import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { logout, logoutAll, refreshSession, type Session } from '@/services/api'
import { installSessionGuard } from './sessionGuard'

/**
 * 用真的 api 層、只換掉 fetch：session 失效走的是 api.ts 實際的 publish(null)
 * 路徑，而不是測試自己發事件。這樣才能證明導航是 session 驅動，不是按鈕驅動。
 */

const PROJECT_PATH = '/p/11111111-1111-1111-1111-111111111111'
const Empty = defineComponent({ render: () => null })

const SESSION: Session = {
  access_token: 'token',
  token_type: 'bearer',
  expires_in: 900,
  user: { id: 'u1', email: 'a@example.com', display_name: 'A', created_at: '2026-01-01T00:00:00Z' },
}

let router: Router
let uninstall: () => void

function respond(status: number, body?: unknown): void {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

async function startAt(path: string): Promise<void> {
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
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    uninstall()
    vi.unstubAllGlobals()
  })

  it('主動登出：/p/:id → /login?redirect=/p/:id', async () => {
    await startAt(PROJECT_PATH)
    respond(204)

    await logout()
    await settle()

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe(PROJECT_PATH)
  })

  it('被動失效：refresh 被後端拒絕，不經過任何登出按鈕', async () => {
    await startAt(PROJECT_PATH)
    respond(401, { detail: 'refresh token 已撤銷' })

    await expect(refreshSession()).resolves.toBeNull()
    await settle()

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe(PROJECT_PATH)
  })

  it('登出所有裝置走同一套處理', async () => {
    await startAt('/projects')
    respond(204)

    await logoutAll()
    await settle()

    expect(router.currentRoute.value.name).toBe('login')
    expect(router.currentRoute.value.query.redirect).toBe('/projects')
  })

  it('用 replace 導航：上一頁不會回到已經進不去的專案頁', async () => {
    await startAt('/')
    await router.push(PROJECT_PATH)
    respond(204)

    await logout()
    await settle()
    expect(router.currentRoute.value.name).toBe('login')

    // push 的話歷史是 [/, /p/:id, /login]，上一頁會回到專案頁。
    router.back()
    await settle()

    expect(router.currentRoute.value.path).toBe('/')
  })

  it('公開頁面（本機草稿）不導航', async () => {
    await startAt('/')
    respond(204)

    await logout()
    await settle()

    expect(router.currentRoute.value.path).toBe('/')
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('session 輪替成功（非 null）不導航', async () => {
    await startAt(PROJECT_PATH)
    respond(200, SESSION)

    await expect(refreshSession()).resolves.toEqual(SESSION)
    await settle()

    expect(router.currentRoute.value.path).toBe(PROJECT_PATH)
  })

  it('refresh 暫時性失敗（5xx）不視為登出', async () => {
    await startAt(PROJECT_PATH)
    respond(503, { detail: 'Service Unavailable' })

    await expect(refreshSession()).rejects.toThrow('Service Unavailable')
    await settle()

    expect(router.currentRoute.value.path).toBe(PROJECT_PATH)
  })
})
