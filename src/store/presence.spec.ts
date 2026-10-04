import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Session } from '@/services/api'
import type {
  PresenceCursorMessage,
  PresenceSnapshot,
  PresenceStatus,
  PresenceUser,
} from '@/types/presence'

/**
 * 只模擬 store 用得到的 presenceClient 介面。transport 本身的行為（seq、重連、
 * 4401）已由 services/presence.spec.ts 覆蓋，這裡驗證的是 store 如何消費它。
 */
const fake = vi.hoisted(() => {
  const snapshotListeners = new Set<(s: PresenceSnapshot) => void>()
  const statusListeners = new Set<(s: PresenceStatus) => void>()
  const sessionListeners = new Set<(s: Session | null) => void>()
  const cursorListeners = new Set<(c: PresenceCursorMessage) => void>()
  const client = {
    status: { state: 'idle' } as PresenceStatus,
    connect: vi.fn(),
    disconnect: vi.fn(),
    updateCursor: vi.fn(),
    onCursor(listener: (c: PresenceCursorMessage) => void) {
      cursorListeners.add(listener)
      return () => cursorListeners.delete(listener)
    },
    onSnapshot(listener: (s: PresenceSnapshot) => void) {
      snapshotListeners.add(listener)
      return () => snapshotListeners.delete(listener)
    },
    onStatusChange(listener: (s: PresenceStatus) => void) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
  }
  return { client, snapshotListeners, statusListeners, sessionListeners, cursorListeners }
})

vi.mock('@/services/presence', () => ({ presenceClient: fake.client }))
vi.mock('@/services/api', () => ({
  onSessionChange(listener: (s: Session | null) => void) {
    fake.sessionListeners.add(listener)
    return () => fake.sessionListeners.delete(listener)
  },
}))

const { usePresenceStore } = await import('@/store/presence')

const PROJECT_A = '11111111-1111-1111-1111-111111111111'
const PROJECT_B = '22222222-2222-2222-2222-222222222222'
const ALICE: PresenceUser = { user_id: 'alice', display_name: 'Alice', role: 'owner' }
const BOB: PresenceUser = { user_id: 'bob', display_name: 'Bob', role: 'member' }

function emitSnapshot(users: PresenceUser[], projectId = PROJECT_A, seq = 1): void {
  const snapshot: PresenceSnapshot = {
    type: 'presence.snapshot',
    project_id: projectId,
    seq,
    users,
  }
  for (const listener of fake.snapshotListeners) listener(snapshot)
}

function emitStatus(status: PresenceStatus): void {
  fake.client.status = status
  for (const listener of fake.statusListeners) listener(status)
}

function emitCursorMove(userId: string, x: number, y: number): void {
  const cursor: PresenceCursorMessage = {
    type: 'presence.cursor',
    project_id: PROJECT_A,
    user_id: userId,
    x,
    y,
  }
  for (const listener of fake.cursorListeners) listener(cursor)
}

function emitCursorLeave(userId: string): void {
  const cursor: PresenceCursorMessage = {
    type: 'presence.cursor.leave',
    project_id: PROJECT_A,
    user_id: userId,
  }
  for (const listener of fake.cursorListeners) listener(cursor)
}

function emitSession(session: Session | null): void {
  for (const listener of fake.sessionListeners) listener(session)
}

describe('presence store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    fake.snapshotListeners.clear()
    fake.statusListeners.clear()
    fake.sessionListeners.clear()
    fake.cursorListeners.clear()
    fake.client.status = { state: 'idle' }
    fake.client.connect.mockImplementation((id: string) =>
      emitStatus({ state: 'connecting', projectId: id }),
    )
    fake.client.disconnect.mockImplementation(() => emitStatus({ state: 'idle' }))
  })

  it('connect 交給 presenceClient', () => {
    const store = usePresenceStore()

    store.connect(PROJECT_A)

    expect(fake.client.connect).toHaveBeenCalledWith(PROJECT_A)
    expect(store.projectId).toBe(PROJECT_A)
    expect(store.status).toEqual({ state: 'connecting', projectId: PROJECT_A })
  })

  it('snapshot 覆寫名單', () => {
    const store = usePresenceStore()
    store.connect(PROJECT_A)

    emitSnapshot([ALICE, BOB])

    expect(store.users).toEqual([ALICE, BOB])
  })

  it('第二份 snapshot 是取代而不是合併', () => {
    const store = usePresenceStore()
    store.connect(PROJECT_A)

    emitSnapshot([ALICE, BOB], PROJECT_A, 1)
    emitSnapshot([ALICE], PROJECT_A, 2)

    expect(store.users).toEqual([ALICE])
  })

  it('status 與 client 同步', () => {
    const store = usePresenceStore()
    store.connect(PROJECT_A)

    emitStatus({ state: 'connected', projectId: PROJECT_A })
    expect(store.status.state).toBe('connected')

    const reconnecting: PresenceStatus = {
      state: 'reconnecting',
      projectId: PROJECT_A,
      attempt: 1,
      delayMs: 1000,
    }
    emitStatus(reconnecting)
    expect(store.status).toEqual(reconnecting)
  })

  it('重連中保留最後一份名單', () => {
    const store = usePresenceStore()
    store.connect(PROJECT_A)
    emitSnapshot([ALICE, BOB])

    emitStatus({ state: 'reconnecting', projectId: PROJECT_A, attempt: 1, delayMs: 1000 })

    expect(store.users).toEqual([ALICE, BOB])
  })

  it('disconnect 清空名單並停止 client', () => {
    const store = usePresenceStore()
    store.connect(PROJECT_A)
    emitSnapshot([ALICE])

    store.disconnect()

    expect(fake.client.disconnect).toHaveBeenCalledOnce()
    expect(store.users).toEqual([])
    expect(store.projectId).toBeNull()
    expect(store.status).toEqual({ state: 'idle' })
  })

  it('stopped 不留下過期名單', () => {
    const store = usePresenceStore()
    store.connect(PROJECT_A)
    emitSnapshot([ALICE, BOB])

    emitStatus({ state: 'stopped', projectId: PROJECT_A, reason: 'project_unavailable' })

    expect(store.users).toEqual([])
    expect(store.status.state).toBe('stopped')
  })

  it('換專案時 B 連上之前不會顯示 A 的成員', () => {
    const store = usePresenceStore()
    store.connect(PROJECT_A)
    emitSnapshot([ALICE, BOB])

    // client 從 A 直接跳到 B 的 connecting，中間沒有 idle。
    store.connect(PROJECT_B)

    expect(store.users).toEqual([])
    expect(store.status).toEqual({ state: 'connecting', projectId: PROJECT_B })

    emitSnapshot([BOB], PROJECT_B)
    expect(store.users).toEqual([BOB])
  })

  it('同一個專案重複 connect 不清空名單', () => {
    const store = usePresenceStore()
    store.connect(PROJECT_A)
    emitSnapshot([ALICE])

    store.connect(PROJECT_A)

    expect(store.users).toEqual([ALICE])
  })

  it('session 變成 null（登出）時斷線並清空', () => {
    const store = usePresenceStore()
    store.connect(PROJECT_A)
    emitSnapshot([ALICE])

    emitSession(null)

    expect(fake.client.disconnect).toHaveBeenCalledOnce()
    expect(store.users).toEqual([])
    expect(store.status).toEqual({ state: 'idle' })
  })

  it('session 輪替（仍是登入狀態）不影響連線', () => {
    const store = usePresenceStore()
    store.connect(PROJECT_A)
    emitSnapshot([ALICE])

    emitSession({} as Session)

    expect(fake.client.disconnect).not.toHaveBeenCalled()
    expect(store.users).toEqual([ALICE])
  })

  it('client 建立連線失敗時不拋給呼叫端', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.client.connect.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = usePresenceStore()

    expect(() => store.connect(PROJECT_A)).not.toThrow()
    expect(fake.client.disconnect).toHaveBeenCalledOnce()
    expect(store.projectId).toBeNull()
    expect(store.status).toEqual({ state: 'idle' })
    consoleError.mockRestore()
  })

  it('$dispose 之後退訂所有 listener', () => {
    const store = usePresenceStore()
    expect(fake.snapshotListeners.size).toBe(1)
    expect(fake.statusListeners.size).toBe(1)
    expect(fake.sessionListeners.size).toBe(1)

    store.$dispose()

    expect(fake.snapshotListeners.size).toBe(0)
    expect(fake.statusListeners.size).toBe(0)
    expect(fake.sessionListeners.size).toBe(0)
  })

  it('重複取得與重建 store 不累積 listener', () => {
    const first = usePresenceStore()
    usePresenceStore()
    expect(fake.snapshotListeners.size).toBe(1)

    // 模擬 HMR：舊 store 被 dispose，新的 pinia 重新建立。
    first.$dispose()
    setActivePinia(createPinia())
    usePresenceStore()

    expect(fake.snapshotListeners.size).toBe(1)
    expect(fake.statusListeners.size).toBe(1)
    expect(fake.sessionListeners.size).toBe(1)
  })
})

describe('presence store：游標', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    fake.snapshotListeners.clear()
    fake.statusListeners.clear()
    fake.sessionListeners.clear()
    fake.cursorListeners.clear()
    fake.client.status = { state: 'idle' }
    fake.client.connect.mockImplementation((id: string) =>
      emitStatus({ state: 'connecting', projectId: id }),
    )
    fake.client.disconnect.mockImplementation(() => emitStatus({ state: 'idle' }))
  })

  /** 連上 PROJECT_A，名單是 Alice 與 Bob。 */
  function connected() {
    const store = usePresenceStore()
    store.connect(PROJECT_A)
    emitStatus({ state: 'connected', projectId: PROJECT_A })
    emitSnapshot([ALICE, BOB])
    return store
  }

  const entries = (store: ReturnType<typeof usePresenceStore>) => [...store.cursors.entries()]

  it('在線成員的游標以 user_id 為 key 保存，後到的位置覆蓋前一個', () => {
    const store = connected()

    emitCursorMove('bob', 1, 2)
    emitCursorMove('bob', 3, 4)

    expect(entries(store)).toEqual([['bob', { x: 3, y: 4 }]])
  })

  it('游標離開就移除，之後再移動會重新出現', () => {
    const store = connected()
    emitCursorMove('bob', 1, 2)

    emitCursorLeave('bob')
    expect(entries(store)).toEqual([])

    emitCursorMove('bob', 5, 6)
    expect(entries(store)).toEqual([['bob', { x: 5, y: 6 }]])
  })

  it('名單外的人的游標直接丟棄，不先存起來', () => {
    const store = connected()

    emitCursorMove('stranger', 1, 2)
    expect(entries(store)).toEqual([])

    // 他之後上線時，畫面上不會出現那個舊位置
    emitSnapshot([ALICE, BOB, { user_id: 'stranger', display_name: null, role: 'member' }])
    expect(entries(store)).toEqual([])
  })

  it('成員離線（新的 snapshot 不含他）時，游標一起移除', () => {
    const store = connected()
    emitCursorMove('alice', 1, 1)
    emitCursorMove('bob', 2, 2)

    emitSnapshot([ALICE], PROJECT_A, 2)

    expect(entries(store)).toEqual([['alice', { x: 1, y: 1 }]])
  })

  it('離線之後才到的游標（順序沒有保證）被丟棄；重新上線也不會帶回舊位置', () => {
    const store = connected()
    emitCursorMove('bob', 2, 2)
    emitSnapshot([ALICE], PROJECT_A, 2)

    emitCursorMove('bob', 9, 9)
    emitSnapshot([ALICE, BOB], PROJECT_A, 3)

    expect(entries(store)).toEqual([])
  })

  it('名單沒變的 snapshot 不影響現有游標', () => {
    const store = connected()
    emitCursorMove('bob', 2, 2)

    emitSnapshot([ALICE, BOB], PROJECT_A, 2)

    expect(entries(store)).toEqual([['bob', { x: 2, y: 2 }]])
  })

  it.each<[string, PresenceStatus]>([
    ['reconnecting', { state: 'reconnecting', projectId: PROJECT_A, attempt: 1, delayMs: 1000 }],
    ['connecting', { state: 'connecting', projectId: PROJECT_A }],
    ['stopped', { state: 'stopped', projectId: PROJECT_A, reason: 'protocol_error' }],
    ['idle', { state: 'idle' }],
  ])('離開 connected（%s）就清空游標', (_label, status) => {
    const store = connected()
    emitCursorMove('bob', 2, 2)

    emitStatus(status)

    expect(entries(store)).toEqual([])
  })

  it('重連中保留名單但不保留游標；重連後要等對方再次移動', () => {
    const store = connected()
    emitCursorMove('bob', 2, 2)

    emitStatus({ state: 'reconnecting', projectId: PROJECT_A, attempt: 1, delayMs: 1000 })
    expect(store.users).toEqual([ALICE, BOB])
    expect(entries(store)).toEqual([])

    emitStatus({ state: 'connected', projectId: PROJECT_A })
    emitSnapshot([ALICE, BOB], PROJECT_A, 1)
    expect(entries(store)).toEqual([])

    emitCursorMove('bob', 7, 7)
    expect(entries(store)).toEqual([['bob', { x: 7, y: 7 }]])
  })

  it('disconnect 清空游標', () => {
    const store = connected()
    emitCursorMove('bob', 2, 2)

    store.disconnect()

    expect(entries(store)).toEqual([])
  })

  it('session 失效（登出）時清空游標', () => {
    const store = connected()
    emitCursorMove('bob', 2, 2)

    emitSession(null)

    expect(entries(store)).toEqual([])
  })

  it('換專案時清空前一個專案的游標', () => {
    const store = connected()
    emitCursorMove('bob', 2, 2)

    store.connect(PROJECT_B)

    expect(entries(store)).toEqual([])
  })

  it('updateCursor 原樣交給 presenceClient（節流在 transport）', () => {
    const store = connected()

    store.updateCursor({ x: 1, y: 2 })
    store.updateCursor(null)

    expect(fake.client.updateCursor.mock.calls).toEqual([[{ x: 1, y: 2 }], [null]])
  })

  it('$dispose 之後不再收游標', () => {
    const store = connected()
    store.$dispose()

    expect(fake.cursorListeners.size).toBe(0)
  })
})
