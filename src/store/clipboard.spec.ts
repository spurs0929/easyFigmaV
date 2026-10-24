import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { isReactive } from 'vue'
import type { Session, User } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { CLIPBOARD_FORMAT_VERSION, useClipboardStore } from '@/store/clipboard'
import { ElementKind, type CanvasElement, type ElementStore } from '@/types/element'

// api 層換成可以手動通知 session 變化的假實作：輪替、失效、silent refresh 失敗都走 onSessionChange。
const api = vi.hoisted(() => {
  const listeners: Array<(session: Session | null) => void> = []
  return {
    listeners,
    onSessionChange: (listener: (session: Session | null) => void) => {
      listeners.push(listener)
      return () => {}
    },
    ensureBootstrapped: vi.fn<() => Promise<Session | null>>(),
    login: vi.fn<() => Promise<Session>>(),
    register: vi.fn<() => Promise<Session>>(),
    logout: vi.fn<() => Promise<void>>(),
    logoutAll: vi.fn<() => Promise<void>>(),
    // errorMessage 用 instanceof 判斷錯誤種類，假模組也要提供這個類別。
    ApiError: class ApiError extends Error {},
  }
})
vi.mock('@/services/api', () => api)

/** api 層通知 session 變化（refresh 輪替成功、失效、silent refresh 失敗）。 */
function publish(session: Session | null): void {
  for (const listener of api.listeners) listener(session)
}

function user(id: string): User {
  return { id, email: `${id}@example.com`, display_name: id, created_at: '2026-10-24T00:00:00Z' }
}

let tokenCount = 0

/** 每次都是新的物件與新的 token，模擬 refresh 輪替。 */
function session(userId: string): Session {
  tokenCount += 1
  return {
    access_token: `token-${tokenCount}`,
    token_type: 'bearer',
    expires_in: 900,
    user: user(userId),
  }
}

function rect(id: string): CanvasElement {
  return {
    id,
    kind: ElementKind.Rect,
    name: id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    fill: { type: 'solid', color: '#ffffff' },
    stroke: { type: 'solid', color: '#000000' },
    strokeWidth: 1,
    opacity: 1,
    visible: true,
    locked: false,
    parentId: undefined,
    childIds: [],
  }
}

function tree(...ids: string[]): ElementStore {
  return { byId: Object.fromEntries(ids.map((id) => [id, rect(id)])), rootIds: ids }
}

describe('useClipboardStore', () => {
  let clipboard: ReturnType<typeof useClipboardStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    clipboard = useClipboardStore()
  })

  it('一開始是空的', () => {
    expect(clipboard.read()).toBeNull()
  })

  it.each(['copy', 'cut'] as const)(
    'write（%s）之後可以讀到帶版本號與來源的內容，內容原封不動',
    (origin) => {
      const elements = tree('a', 'b')

      clipboard.write(elements, origin)

      expect(clipboard.read()).toEqual({ version: CLIPBOARD_FORMAT_VERSION, origin, elements })
      expect(clipboard.read()!.elements).toBe(elements)
    },
  )

  it('內容不會被包成 reactive proxy', () => {
    clipboard.write(tree('a'), 'copy')

    expect(isReactive(clipboard.read())).toBe(false)
    expect(isReactive(clipboard.read()!.elements)).toBe(false)
  })

  it('新的 write 取代舊內容與來源', () => {
    clipboard.write(tree('a'), 'cut')
    const second = tree('b')

    clipboard.write(second, 'copy')

    expect(clipboard.read()).toMatchObject({ origin: 'copy', elements: second })
  })

  it('nextPasteNumber 只讀取、不改變計數；recordPaste 之後才前進', () => {
    clipboard.write(tree('a'), 'copy')

    expect([clipboard.nextPasteNumber(), clipboard.nextPasteNumber()]).toEqual([1, 1])
    clipboard.recordPaste()
    expect(clipboard.nextPasteNumber()).toBe(2)
    clipboard.recordPaste()
    clipboard.recordPaste()
    expect(clipboard.nextPasteNumber()).toBe(4)
  })

  it('新的 write 讓貼上次數歸零', () => {
    clipboard.write(tree('a'), 'copy')
    clipboard.recordPaste()
    clipboard.recordPaste()

    clipboard.write(tree('b'), 'cut')

    expect(clipboard.nextPasteNumber()).toBe(1)
  })

  it('clear 清空內容；之後再 write，貼上次數從 1 開始', () => {
    clipboard.write(tree('a'), 'copy')
    clipboard.recordPaste()
    clipboard.recordPaste()

    clipboard.clear()

    expect(clipboard.read()).toBeNull()
    clipboard.write(tree('a'), 'copy')
    expect(clipboard.nextPasteNumber()).toBe(1)
  })
})

describe('useClipboardStore：登入身分改變時清空', () => {
  let auth: ReturnType<typeof useAuthStore>
  let clipboard: ReturnType<typeof useClipboardStore>

  beforeEach(() => {
    api.listeners.length = 0
    vi.clearAllMocks()
    api.logout.mockResolvedValue(undefined)
    api.logoutAll.mockResolvedValue(undefined)
    setActivePinia(createPinia())
    auth = useAuthStore()
    clipboard = useClipboardStore()
  })

  async function loginAs(userId: string): Promise<void> {
    api.login.mockResolvedValueOnce(session(userId))
    expect(await auth.login(`${userId}@example.com`, 'password')).toBe(true)
  }

  describe('清空', () => {
    it('已登入的使用者登出', async () => {
      await loginAs('A')
      clipboard.write(tree('a'), 'copy')

      await auth.logout()

      expect(clipboard.read()).toBeNull()
    })

    it('已登入的使用者登出所有裝置', async () => {
      await loginAs('A')
      clipboard.write(tree('a'), 'cut')

      await auth.logoutAll()

      expect(clipboard.read()).toBeNull()
    })

    it('伺服器端登出失敗，前端仍回到未登入：照樣清空', async () => {
      await loginAs('A')
      clipboard.write(tree('a'), 'copy')
      api.logout.mockRejectedValueOnce(new Error('network'))

      await auth.logout()

      expect(auth.user).toBeNull()
      expect(clipboard.read()).toBeNull()
    })

    it('session 失效或 silent refresh 失敗（api 層通知 null）', async () => {
      await loginAs('A')
      clipboard.write(tree('a'), 'copy')

      publish(null)

      expect(clipboard.read()).toBeNull()
    })

    it('沒有登出就換成另一位使用者（A → B）', async () => {
      await loginAs('A')
      clipboard.write(tree('a'), 'copy')

      await loginAs('B')

      expect(clipboard.read()).toBeNull()
    })

    it('api 層通知換成另一位使用者的 session', async () => {
      await loginAs('A')
      clipboard.write(tree('a'), 'copy')

      publish(session('B'))

      expect(clipboard.read()).toBeNull()
    })

    it('身分一改變就清空，不需要等下一個 tick', async () => {
      await loginAs('A')
      clipboard.write(tree('a'), 'copy')

      publish(null)
      const afterPublish = clipboard.read()

      expect(afterPublish).toBeNull()
    })

    it('Clipboard 在登入之後才建立：之後登出仍然清空', async () => {
      setActivePinia(createPinia())
      auth = useAuthStore()
      await loginAs('A')
      clipboard = useClipboardStore()
      clipboard.write(tree('a'), 'copy')

      await auth.logout()

      expect(clipboard.read()).toBeNull()
    })
  })

  describe('保留', () => {
    it('未登入時複製，之後登入：保留', async () => {
      const elements = tree('a')
      clipboard.write(elements, 'copy')

      await loginAs('A')

      expect(clipboard.read()!.elements).toBe(elements)
    })

    it('未登入時複製，啟動時恢復 session：保留', async () => {
      const elements = tree('a')
      clipboard.write(elements, 'copy')
      api.ensureBootstrapped.mockResolvedValueOnce(session('A'))

      await auth.bootstrap()

      expect(auth.user?.id).toBe('A')
      expect(clipboard.read()!.elements).toBe(elements)
    })

    it('同一位使用者 refresh token 輪替（新的 session 物件與 token）：保留', async () => {
      await loginAs('A')
      const elements = tree('a')
      clipboard.write(elements, 'copy')

      publish(session('A'))
      publish(session('A'))

      expect(clipboard.read()!.elements).toBe(elements)
    })

    it('同一位使用者重新登入（沒有登出）：保留', async () => {
      await loginAs('A')
      const elements = tree('a')
      clipboard.write(elements, 'copy')

      await loginAs('A')

      expect(clipboard.read()!.elements).toBe(elements)
    })

    it('未登入時 session 通知仍是 null：保留', () => {
      const elements = tree('a')
      clipboard.write(elements, 'copy')

      publish(null)

      expect(clipboard.read()!.elements).toBe(elements)
    })

    it('未登入時登入失敗：保留', async () => {
      const elements = tree('a')
      clipboard.write(elements, 'copy')
      api.login.mockRejectedValueOnce(new Error('401'))

      expect(await auth.login('a@example.com', 'wrong')).toBe(false)
      expect(clipboard.read()!.elements).toBe(elements)
    })
  })

  describe('清空之後', () => {
    it('A 登出後換 A 再登入：登出時已清空，重新登入後複製的內容照常保留', async () => {
      await loginAs('A')
      clipboard.write(tree('old'), 'copy')
      await auth.logout()
      await loginAs('A')
      const elements = tree('new')

      clipboard.write(elements, 'copy')
      publish(session('A'))

      expect(clipboard.read()!.elements).toBe(elements)
    })

    it('登出後 B 登入：Clipboard 仍是空的，B 複製的內容照常保留', async () => {
      await loginAs('A')
      clipboard.write(tree('a'), 'copy')
      await auth.logout()

      await loginAs('B')
      expect(clipboard.read()).toBeNull()
      const elements = tree('b')
      clipboard.write(elements, 'copy')
      publish(session('B'))

      expect(clipboard.read()!.elements).toBe(elements)
    })
  })
})
