import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import type { PresenceStatus } from '@/types/presence'

/**
 * 驗證 EditorView 什麼時候連 / 斷 presence。
 *
 * document store 以假物件取代，由測試決定載入成功與否、何時完成；
 * presence store 用真的，底下的 presenceClient 則換成只記錄呼叫的假物件。
 */
const fake = vi.hoisted(() => {
  const client = {
    status: { state: 'idle' } as PresenceStatus,
    connect: vi.fn(),
    disconnect: vi.fn(),
    onSnapshot: () => () => {},
    onStatusChange: () => () => {},
  }
  const documentStore = {
    saveState: 'idle',
    startPersistence: vi.fn<(backend: { kind: string }) => Promise<boolean>>(),
    stopPersistence: vi.fn(),
    reloadFromBackend: vi.fn(),
  }
  const route = { params: {} as Record<string, string> }
  return { client, documentStore, route }
})

vi.mock('@/services/presence', () => ({ presenceClient: fake.client }))
vi.mock('@/services/api', () => ({ onSessionChange: () => () => {} }))
vi.mock('@/store/document', () => ({ useDocumentStore: () => fake.documentStore }))
vi.mock('@/services/documentBackend', () => ({
  localDocumentBackend: { kind: 'local' },
  createCloudDocumentBackend: (id: string) => ({ kind: 'cloud', id }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => fake.route,
  useRouter: () => ({ push: vi.fn() }),
}))

// 子元件與 presence 無關，而且會拖進 Konva 等重依賴，一律換成空元件。
const Empty = defineComponent({ render: () => h('div') })
vi.mock('@/components/toolbar/EditorToolbar.vue', () => ({ default: Empty }))
vi.mock('@/components/LayerPanel/LayerPanel.vue', () => ({ default: Empty }))
vi.mock('@/components/canvas/CanvasArea.vue', () => ({ default: Empty }))
vi.mock('@/components/properties/PropertiesPanel.vue', () => ({ default: Empty }))

const { default: EditorView } = await import('@/views/EditorView.vue')
const { usePresenceStore } = await import('@/store/presence')

const PROJECT_A = '11111111-1111-1111-1111-111111111111'
const PROJECT_B = '22222222-2222-2222-2222-222222222222'

let pinia: Pinia
const wrappers: VueWrapper[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function mountEditor(projectId: string | null): VueWrapper {
  fake.route.params = projectId ? { id: projectId } : {}
  const wrapper = shallowMount(EditorView, { global: { plugins: [pinia] } })
  wrappers.push(wrapper)
  return wrapper
}

describe('EditorView presence 生命週期', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.clearAllMocks()
    fake.client.status = { state: 'idle' }
    fake.documentStore.startPersistence.mockResolvedValue(true)
    // 讓編輯器版面真的渲染出來，才能確認 presence 失敗時它仍在。
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
  })

  afterEach(() => {
    while (wrappers.length) wrappers.pop()?.unmount()
    vi.unstubAllGlobals()
  })

  it('雲端專案載入成功後才連線', async () => {
    const load = deferred<boolean>()
    fake.documentStore.startPersistence.mockReturnValue(load.promise)

    mountEditor(PROJECT_A)
    await flushPromises()
    expect(fake.client.connect).not.toHaveBeenCalled()

    load.resolve(true)
    await flushPromises()
    expect(fake.client.connect).toHaveBeenCalledWith(PROJECT_A)
    expect(fake.documentStore.startPersistence).toHaveBeenCalledWith({
      kind: 'cloud',
      id: PROJECT_A,
    })
  })

  it('本機草稿不建立 presence 連線', async () => {
    const wrapper = mountEditor(null)
    await flushPromises()

    expect(fake.documentStore.startPersistence).toHaveBeenCalledWith({ kind: 'local' })
    expect(fake.client.connect).not.toHaveBeenCalled()

    wrapper.unmount()
    // 本機草稿離開時也不去碰 presence。
    expect(fake.client.disconnect).not.toHaveBeenCalled()
  })

  it('離開編輯器時斷線並清空名單', async () => {
    const wrapper = mountEditor(PROJECT_A)
    await flushPromises()
    const presence = usePresenceStore()
    presence.users = [{ user_id: 'u1', display_name: 'Alice', role: 'owner' }]

    wrapper.unmount()

    expect(fake.documentStore.stopPersistence).toHaveBeenCalledOnce()
    expect(fake.client.disconnect).toHaveBeenCalledOnce()
    expect(presence.users).toEqual([])
    expect(presence.projectId).toBeNull()
  })

  it('A → B：先斷 A，B 載入完成後才連 B', async () => {
    const a = mountEditor(PROJECT_A)
    await flushPromises()
    expect(fake.client.connect).toHaveBeenLastCalledWith(PROJECT_A)

    // App.vue 以專案 id 當 key，換專案是卸載 A、掛載新的 B。
    a.unmount()
    expect(fake.client.disconnect).toHaveBeenCalledOnce()

    mountEditor(PROJECT_B)
    await flushPromises()

    expect(fake.client.connect).toHaveBeenLastCalledWith(PROJECT_B)
    expect(fake.client.connect).toHaveBeenCalledTimes(2)
  })

  it('載入完成前就離開，晚到的結果不會補連線', async () => {
    const load = deferred<boolean>()
    fake.documentStore.startPersistence.mockReturnValue(load.promise)

    const wrapper = mountEditor(PROJECT_A)
    wrapper.unmount()
    load.resolve(true)
    await flushPromises()

    expect(fake.client.connect).not.toHaveBeenCalled()
  })

  it('專案載入失敗（404、無權限）不建立 presence', async () => {
    fake.documentStore.startPersistence.mockResolvedValue(false)

    mountEditor(PROJECT_A)
    await flushPromises()

    expect(fake.client.connect).not.toHaveBeenCalled()
  })

  it('presence 建立連線失敗不影響編輯器', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.client.connect.mockImplementation(() => {
      throw new Error('WebSocket 無法建立')
    })

    const wrapper = mountEditor(PROJECT_A)
    await flushPromises()

    expect(wrapper.find('.app-layout').exists()).toBe(true)
    expect(usePresenceStore().projectId).toBeNull()

    wrapper.unmount()
    expect(fake.documentStore.stopPersistence).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })
})
