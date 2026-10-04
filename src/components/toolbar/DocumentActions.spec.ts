import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, type DirectiveBinding } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { DocumentBackend } from '@/services/documentBackend'
import { useAuthStore } from '@/store/auth'
import { useCommentStore } from '@/store/comment'
import { useDocumentStore } from '@/store/document'
import { useElementStore } from '@/store/element'
import {
  DOCUMENT_SNAPSHOT_VERSION,
  parseDocumentSnapshot,
  type DocumentSnapshot,
} from '@/types/document'
import { ElementKind, type CanvasElement } from '@/types/element'
import DocumentActions from './DocumentActions.vue'
import DocumentImportDialog from './DocumentImportDialog.vue'

// 這個檔案測的是 DocumentActions 把什麼交給下游，不是下游本身：
//   - 專案 API 只換掉 createProject，才看得到「存到雲端」實際送出去的 document。
//     projects store 用真的——斷言的對象是送到 API 的內容，不是元件呼叫了哪個函式。
//   - 留言 API 一律用假的，避免測試不小心真的送出 fetch。
vi.mock('@/services/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/projects')>()),
  createProject: vi.fn(),
}))

vi.mock('@/services/comments', () => ({
  listComments: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}))

const router = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ fullPath: '/' }),
  useRouter: () => router,
}))

const { createProject } = await import('@/services/projects')
const { listComments, createComment } = await import('@/services/comments')
const mockCreateProject = vi.mocked(createProject)
const mockListComments = vi.mocked(listComments)
const mockCreateComment = vi.mocked(createComment)

function rect(id: string, name: string): CanvasElement {
  return {
    id,
    kind: ElementKind.Rect,
    name,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    fill: { type: 'solid', color: '#ffffff' },
    stroke: { type: 'solid', color: '#6366f1' },
    strokeWidth: 1,
    opacity: 1,
    visible: true,
    locked: false,
    childIds: [],
  }
}

function emptySnapshot(): DocumentSnapshot {
  return {
    version: DOCUMENT_SNAPSHOT_VERSION,
    savedAt: 1000,
    elements: { byId: {}, rootIds: [] },
    comments: [],
  }
}

function fakeCloudBackend(): DocumentBackend {
  return {
    kind: 'cloud',
    available: true,
    debounceMs: 0,
    load: () => Promise.resolve(emptySnapshot()),
    save: () => Promise.resolve(),
  }
}

/**
 * tooltip 的內容不在 DOM 裡。這裡不測 PrimeVue 的 tooltip，只把元件交給它的文字
 * 寫到 data-tooltip，讓測試讀得到。
 */
function writeTooltip(el: HTMLElement, binding: DirectiveBinding<{ value: string }>): void {
  el.dataset.tooltip = binding.value.value
}

let pinia: Pinia
let wrapper: VueWrapper | null = null

function mountActions(): VueWrapper {
  wrapper = mount(DocumentActions, {
    global: {
      plugins: [pinia],
      directives: { tooltip: { mounted: writeTooltip, updated: writeTooltip } },
      // 對話框有自己的 spec。這裡只需要知道 DocumentActions 傳了什麼 prop 給它。
      stubs: { DocumentImportDialog: true },
    },
  })
  return wrapper
}

function button(label: string) {
  return wrapper!.get(`button[aria-label="${label}"]`)
}

function signIn(): void {
  useAuthStore().user = {
    id: 'u-alice',
    email: 'alice@example.com',
    display_name: 'Alice',
    created_at: '2026-10-01T00:00:00Z',
  }
}

/** 本機草稿：一個 rect 加一則本機留言。 */
async function seedLocalDraft(): Promise<void> {
  useElementStore().add(rect('r-local', 'Local Rect'))
  const commentStore = useCommentStore()
  commentStore.startDraft(10, 20)
  await commentStore.submitDraft('只屬於本機的留言')
}

async function enterCloudProject(): Promise<void> {
  await useDocumentStore().startPersistence(fakeCloudBackend())
  await nextTick()
}

beforeEach(() => {
  // comment store 建立時會讀 localStorage mirror，不清掉的話上一個測試的留言會留下來。
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  vi.resetAllMocks()
  mockListComments.mockResolvedValue([])
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('DocumentActions 存到雲端', () => {
  it('本機草稿有留言時，送去建立雲端專案的 document 不帶留言', async () => {
    signIn()
    await seedLocalDraft()
    const commentStore = useCommentStore()
    // 前提：一般的快照確實帶著這則留言。少了這個前提，下面的 [] 什麼都沒證明。
    expect(useDocumentStore().buildSnapshot().comments).toHaveLength(1)
    mockCreateProject.mockResolvedValue({
      id: 'p-new',
      name: '未命名專案',
      document_version: 1,
      created_at: '2026-10-04T00:00:00Z',
      updated_at: '2026-10-04T00:00:00Z',
      role: 'owner',
      document: {},
    })
    mountActions()

    await button('存到雲端').trigger('click')
    await flushPromises()

    expect(mockCreateProject).toHaveBeenCalledTimes(1)
    const sent = mockCreateProject.mock.calls[0]![0].document
    expect(sent.comments).toEqual([])
    // 畫布內容照常帶上，而且仍是合法的快照——不是靠送出一份壞掉的文件來「不帶留言」。
    const parsed = parseDocumentSnapshot(sent)
    expect(parsed).not.toBeNull()
    expect(Object.keys(parsed!.elements.byId)).toEqual(['r-local'])
    expect(parsed!.version).toBe(DOCUMENT_SNAPSHOT_VERSION)

    // 本機留言沒有被搬到雲端留言 API，也沒有從本機草稿消失
    expect(mockCreateComment).not.toHaveBeenCalled()
    expect(commentStore.comments.map((c) => c.text)).toEqual(['只屬於本機的留言'])
    expect(router.push).toHaveBeenCalledWith('/p/p-new')
  })

  it('未登入時導向登入頁，不建立專案', async () => {
    await seedLocalDraft()
    mountActions()

    await button('存到雲端').trigger('click')
    await flushPromises()

    expect(mockCreateProject).not.toHaveBeenCalled()
    expect(router.push).toHaveBeenCalledWith({ name: 'login', query: { redirect: '/' } })
  })

  it('tooltip 說明複製的是畫布、不含留言', () => {
    mountActions()
    expect(button('存到雲端').attributes('data-tooltip')).toBe(
      '把目前的畫布複製一份到雲端專案（不含留言）',
    )
  })
})

describe('DocumentActions 匯出與匯入的說明', () => {
  it('本機草稿：匯出維持原本的說明，匯入對話框是本機的說明', () => {
    mountActions()

    expect(button('匯出文件 JSON').attributes('data-tooltip')).toBe('匯出目前文件為 JSON')
    expect(wrapper!.getComponent(DocumentImportDialog).props('cloud')).toBe(false)
  })

  it('雲端專案：匯出說明不含雲端留言，匯入對話框收到 cloud', async () => {
    await enterCloudProject()
    mountActions()

    expect(button('匯出文件 JSON').attributes('data-tooltip')).toBe(
      '匯出畫布為 JSON（不含雲端留言）',
    )
    expect(wrapper!.getComponent(DocumentImportDialog).props('cloud')).toBe(true)
    // 雲端專案沒有「存到雲端」
    expect(wrapper!.find('button[aria-label="存到雲端"]').exists()).toBe(false)
  })
})
