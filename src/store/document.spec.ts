import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CommentDto } from '@/services/comments'
import type { DocumentBackend } from '@/services/documentBackend'
import { useCommentStore } from '@/store/comment'
import { useDocumentStore } from '@/store/document'
import { useElementStore } from '@/store/element'
import { DOCUMENT_SNAPSHOT_VERSION, type DocumentSnapshot } from '@/types/document'
import { ElementKind, type CanvasElement } from '@/types/element'

// 雲端留言走自己的 API。這個檔案測的是 document 的持久化，留言的請求一律用假的，
// 才不會有測試不小心真的送出 fetch。
vi.mock('@/services/comments', () => ({
  listComments: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}))

const { listComments, createComment, updateComment, deleteComment } =
  await import('@/services/comments')
const mockListComments = vi.mocked(listComments)
const mockCreateComment = vi.mocked(createComment)
const mockUpdateComment = vi.mocked(updateComment)
const mockDeleteComment = vi.mocked(deleteComment)

function commentDto(id: string, content = id): CommentDto {
  return {
    id,
    world_x: 0,
    world_y: 0,
    content,
    resolved: false,
    created_at: '2026-10-02T03:00:00Z',
    updated_at: '2026-10-02T03:00:00Z',
    author: { user_id: 'u-alice', display_name: 'Alice', email: 'alice@example.com' },
    can_edit: true,
    can_delete: true,
  }
}

/**
 * 一份可以辨認「這是誰的文件」的快照：一個名字是 tag 的 rect，加上一則內容是 tag 的留言。
 *
 * 兩個標記各有用途。rect 是文件本身——雲端與本機都會被套用。留言則只有本機草稿
 * 會被套用；雲端專案的快照裡即使有 comments（舊版寫進去的），也不該出現在畫面上。
 */
function snapshotFor(tag: string, savedAt: number): DocumentSnapshot {
  return {
    version: DOCUMENT_SNAPSHOT_VERSION,
    savedAt,
    elements: { byId: { [`r-${tag}`]: rect(`r-${tag}`, tag) }, rootIds: [`r-${tag}`] },
    comments: [
      { id: `c-${tag}`, worldX: 0, worldY: 0, text: tag, resolved: false, createdAt: savedAt },
    ],
  }
}

/** 本機草稿新增一則留言：開始草稿 → 送出。本機來源不送任何請求。 */
async function addLocalComment(x: number, y: number, text = '本機留言') {
  const commentStore = useCommentStore()
  commentStore.startDraft(x, y)
  await commentStore.submitDraft(text)
  return commentStore.comments.at(-1)!
}

/** 目前畫布上的文件是誰的（rect 的名字）。 */
function documentTags(): string[] {
  return Object.values(useElementStore().byId).map((element) => element.name)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** 可控制 load 完成時機的假 backend。 */
function fakeBackend(tag: string, savedAt: number) {
  const gate = deferred<DocumentSnapshot>()
  const save = vi.fn().mockResolvedValue(undefined)
  const backend: DocumentBackend = {
    kind: 'cloud',
    available: true,
    debounceMs: 0,
    load: () => gate.promise,
    save,
  }
  return { backend, save, resolve: () => gate.resolve(snapshotFor(tag, savedAt)) }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  // commentStore 建立時會從 localStorage 取初始值（`easyfigma_comments`），
  // 而 replaceAll 也會寫回去。jsdom 的 localStorage 在同一個檔案的測試之間
  // 是共用的，不清掉的話上一個測試的留言會變成下一個測試的初始狀態。
  localStorage.clear()
  setActivePinia(createPinia())
  vi.resetAllMocks()
  mockListComments.mockResolvedValue([])
})

describe('documentStore 生命週期競態', () => {
  it('過期的 load 不得套用到目前的文件（A 慢、B 快）', async () => {
    const documentStore = useDocumentStore()

    const a = fakeBackend('A', 1000)
    void documentStore.startPersistence(a.backend)
    documentStore.stopPersistence()

    const b = fakeBackend('B', 2000)
    void documentStore.startPersistence(b.backend)

    b.resolve()
    await flush()
    expect(documentTags()).toEqual(['B'])
    expect(documentStore.lastSavedAt).toBe(2000)

    // A 這時才回來，必須整份被丟棄
    a.resolve()
    await flush()

    expect(documentTags()).toEqual(['B'])
    expect(documentStore.lastSavedAt).toBe(2000)
    // 最危險的部分：A 的內容若被套進去，B 的 watcher 會被 documentRevision
    // 觸發，然後把 A 的內容存到 B 的專案。
    expect(b.save).not.toHaveBeenCalled()
  })

  it('過期的 load 不得套用到目前的文件（A 先回來）', async () => {
    const documentStore = useDocumentStore()

    const a = fakeBackend('A', 1000)
    void documentStore.startPersistence(a.backend)
    documentStore.stopPersistence()

    const b = fakeBackend('B', 2000)
    void documentStore.startPersistence(b.backend)

    a.resolve()
    await flush()
    // A 全程不得 commit：此時還沒有任何文件被套用
    expect(documentTags()).toEqual([])
    expect(documentStore.lastSavedAt).toBeNull()

    b.resolve()
    await flush()

    expect(documentTags()).toEqual(['B'])
    expect(documentStore.lastSavedAt).toBe(2000)
    expect(a.save).not.toHaveBeenCalled()
  })

  it('過期的 load 失敗不得覆寫目前的狀態', async () => {
    const documentStore = useDocumentStore()

    let rejectA!: (reason: unknown) => void
    const failing: DocumentBackend = {
      kind: 'cloud',
      available: true,
      debounceMs: 0,
      load: () =>
        new Promise((_resolve, reject) => {
          rejectA = reject
        }),
      save: vi.fn(),
    }

    void documentStore.startPersistence(failing)
    documentStore.stopPersistence()

    const b = fakeBackend('B', 2000)
    void documentStore.startPersistence(b.backend)
    b.resolve()
    await flush()
    expect(documentStore.saveState).toBe('saved')

    rejectA(new Error('GET 失敗'))
    await flush()

    // 已經離開的專案載入失敗，不該把現在這個專案的狀態燈變紅
    expect(documentStore.saveState).toBe('saved')
    expect(documentStore.errorMessage).toBe('')
  })

  it('取消後的 start 不得補建 watcher 與事件監聽', async () => {
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()

    const a = fakeBackend('A', 1000)
    void documentStore.startPersistence(a.backend)
    documentStore.stopPersistence()
    a.resolve()
    await flush()

    // 沒有任何持久化在運作，改動文件不該觸發存檔。
    // 此時已經離開雲端，comment store 回到本機來源，replaceAll 是有效的修改。
    commentStore.replaceAll(snapshotFor('X', 3000).comments)
    await flush()
    expect(a.save).not.toHaveBeenCalled()

    // 而且下一次 startPersistence 必須能正常啟動（_started 沒有卡住）
    const b = fakeBackend('B', 2000)
    void documentStore.startPersistence(b.backend)
    b.resolve()
    await flush()
    expect(documentTags()).toEqual(['B'])
  })
})

/** 最小但合法的 rect，名稱當作「這是雲端專案的內容」的標記。 */
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

/** 雲端專案的內容：一個 rect 加一則留言，兩個 store 都有東西才能確認兩邊都被清掉。 */
function cloudSnapshot(): DocumentSnapshot {
  return {
    version: DOCUMENT_SNAPSHOT_VERSION,
    savedAt: 1000,
    elements: { byId: { 'r-cloud': rect('r-cloud', 'Cloud Rect') }, rootIds: ['r-cloud'] },
    comments: [
      { id: 'c-cloud', worldX: 0, worldY: 0, text: 'cloud', resolved: false, createdAt: 1000 },
    ],
  }
}

/**
 * 模擬 IndexedDB 的本機 backend。save 收到的快照就是會被寫進本機草稿的內容，
 * 所以斷言對象是 save 的參數，而不是 store 有沒有被清掉。
 */
function fakeLocalBackend(draft: DocumentSnapshot | null) {
  const save = vi.fn<(snapshot: DocumentSnapshot) => Promise<void>>().mockResolvedValue(undefined)
  const backend: DocumentBackend = {
    kind: 'local',
    available: true,
    debounceMs: 0,
    load: () => Promise.resolve(draft),
    save,
  }
  return { backend, save }
}

function fakeCloudBackend(debounceMs = 0) {
  const save = vi.fn<(snapshot: DocumentSnapshot) => Promise<void>>().mockResolvedValue(undefined)
  const backend: DocumentBackend = {
    kind: 'cloud',
    available: true,
    debounceMs,
    load: () => Promise.resolve(cloudSnapshot()),
    save,
  }
  return { backend, save }
}

/** 快照裡是否含有任何雲端專案的內容。 */
function containsCloudContent(snapshot: DocumentSnapshot): boolean {
  return 'r-cloud' in snapshot.elements.byId || snapshot.comments.some((c) => c.id === 'c-cloud')
}

describe('cloud → local 切換不得把雲端文件寫進本機草稿', () => {
  it('本機沒有草稿時，雲端內容不會被當成初始內容存進本機', async () => {
    const documentStore = useDocumentStore()
    const elementStore = useElementStore()

    const cloud = fakeCloudBackend()
    await documentStore.startPersistence(cloud.backend)
    expect(elementStore.byId['r-cloud']?.name).toBe('Cloud Rect')

    // /p/:id → /projects → 「回到編輯器」：同一個 SPA，store 不會重建
    documentStore.stopPersistence()
    const local = fakeLocalBackend(null)
    await documentStore.startPersistence(local.backend)
    await flush()

    // E2E 看到的 bug：這裡原本會立刻把 Cloud Rect 存進 IndexedDB
    for (const [snapshot] of local.save.mock.calls) {
      expect(containsCloudContent(snapshot)).toBe(false)
    }
    // 畫布上也不該再看到雲端內容，否則下一次本機 autosave 還是會寫進去
    expect(elementStore.byId['r-cloud']).toBeUndefined()
  })

  it('回到本機後的編輯只會存本機自己的內容', async () => {
    const documentStore = useDocumentStore()

    const cloud = fakeCloudBackend()
    await documentStore.startPersistence(cloud.backend)
    documentStore.stopPersistence()

    const local = fakeLocalBackend(null)
    await documentStore.startPersistence(local.backend)

    await addLocalComment(10, 10)
    await nextTick() // 讓 watcher 排程 autosave
    await flush() // 讓 debounce 0 的計時器觸發

    expect(local.save).toHaveBeenCalled()
    const saved = local.save.mock.calls.at(-1)![0]
    expect(containsCloudContent(saved)).toBe(false)
    expect(saved.comments).toHaveLength(1)
    // undo 也不能把雲端內容叫回來再存一次
    useElementStore().undo()
    await nextTick()
    await flush()
    for (const [snapshot] of local.save.mock.calls) {
      expect(containsCloudContent(snapshot)).toBe(false)
    }
  })

  it('雲端留言不會殘留在 comment store 自己的 localStorage 裡', async () => {
    const documentStore = useDocumentStore()

    await documentStore.startPersistence(fakeCloudBackend().backend)
    documentStore.stopPersistence()

    // commentStore 每次變動都寫 easyfigma_comments，而且建立時會從這裡取初始值。
    // 離開雲端專案後若還留著，重新整理 / 之後就會被當成本機留言再存一次。
    expect(localStorage.getItem('easyfigma_comments') ?? '').not.toContain('c-cloud')
  })

  it('本機已有草稿時，載入的是本機草稿而不是雲端內容', async () => {
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()
    const elementStore = useElementStore()

    await documentStore.startPersistence(fakeCloudBackend().backend)
    documentStore.stopPersistence()

    const local = fakeLocalBackend(snapshotFor('LOCAL', 500))
    await documentStore.startPersistence(local.backend)

    expect(commentStore.comments.map((c) => c.text)).toEqual(['LOCAL'])
    expect(elementStore.byId['r-cloud']).toBeUndefined()
    expect(local.save).not.toHaveBeenCalled()
  })

  it('離開前尚未送出的雲端變更仍然會存回雲端，而且是在清空之前', async () => {
    // 本機草稿有自己的留言：離開雲端時 comment store 會把它讀回來
    seedLocalMirror()
    setActivePinia(createPinia())
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()
    const elementStore = useElementStore()

    // debounce 拉長，確保 stopPersistence 時計時器還沒觸發
    const cloud = fakeCloudBackend(60_000)
    await documentStore.startPersistence(cloud.backend)
    mockListComments.mockResolvedValue([commentDto('c-server')])
    await commentStore.load('project-id')

    elementStore.add(rect('r-new', 'New Rect'))
    // watcher 在下一個 tick 才排程 autosave；真實操作中編輯與換頁不會在同一個 tick
    await nextTick()
    documentStore.stopPersistence()
    await flush()

    expect(cloud.save).toHaveBeenCalledTimes(1)
    const saved = cloud.save.mock.calls[0]![0]
    // 送出的是完整的雲端文件加上新的圖形，不是清空後的空文件
    expect(Object.keys(saved.elements.byId).sort()).toEqual(['r-cloud', 'r-new'])
    // 這次存檔的快照必須在留言來源還是雲端時建立：雲端留言不屬於 document，
    // 而離開之後才讀回來的本機留言更不該被存進雲端專案。
    expect(saved.comments).toEqual([])
    // 離開之後，畫面上是本機自己的留言
    expect(commentStore.comments.map((c) => c.id)).toEqual(['c-local'])
  })
})

const MIRROR_KEY = 'easyfigma_comments'

/** 本機草稿原有的留言；進出雲端前後 localStorage mirror 都應該是它。 */
const LOCAL_COMMENT = {
  id: 'c-local',
  worldX: 5,
  worldY: 5,
  text: 'local',
  resolved: false,
  createdAt: 100,
}

function seedLocalMirror(): string {
  const raw = JSON.stringify([LOCAL_COMMENT])
  localStorage.setItem(MIRROR_KEY, raw)
  return raw
}

/** 雲端專案的留言來自自己的 API：EditorView 在文件載入成功後呼叫 commentStore.load。 */
async function loadServerComments(rows: CommentDto[]): Promise<void> {
  mockListComments.mockResolvedValue(rows)
  await useCommentStore().load('project-id')
}

function mirrorIds(): string[] {
  const raw = localStorage.getItem(MIRROR_KEY)
  if (!raw) return []
  return (JSON.parse(raw) as { id: string }[]).map((c) => c.id)
}

/** 模擬頁面卸載 / 切到背景：comment store 綁定的三個 lifecycle 事件都觸發一次。 */
function fireUnloadLifecycle(): void {
  window.dispatchEvent(new Event('beforeunload'))
  window.dispatchEvent(new Event('pagehide'))
  fireVisibilityHidden()
}

function fireVisibilityHidden(): void {
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  try {
    document.dispatchEvent(new Event('visibilitychange'))
  } finally {
    if (original) Object.defineProperty(document, 'visibilityState', original)
    else delete (document as { visibilityState?: unknown }).visibilityState
  }
}

describe('雲端專案的留言不得寫入 comment store 的 localStorage mirror', () => {
  it('雲端期間的留言變動不寫入 localStorage', async () => {
    const seeded = seedLocalMirror()
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()

    await documentStore.startPersistence(fakeCloudBackend().backend)
    await loadServerComments([commentDto('c-server')])
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)

    mockCreateComment.mockResolvedValue(commentDto('c-added'))
    commentStore.startDraft(30, 30)
    await commentStore.submitDraft('新留言')
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
    mockUpdateComment.mockResolvedValue(commentDto('c-server', 'edited'))
    await commentStore.updateText('c-server', 'edited')
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
    await commentStore.toggleResolved('c-server')
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
    mockDeleteComment.mockResolvedValue(undefined)
    await commentStore.remove('c-added')
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
  })

  it('雲端文件載入不動 localStorage，快照裡殘留的 comments 也不會被寫進去', async () => {
    const seeded = seedLocalMirror()
    const documentStore = useDocumentStore()

    // cloudSnapshot() 的 document 裡有一則 c-cloud——舊版把留言存在 document 裡的樣子
    await documentStore.startPersistence(fakeCloudBackend().backend)

    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
  })

  it('雲端期間觸發卸載事件（直接關分頁）不把雲端留言寫進 localStorage', async () => {
    const seeded = seedLocalMirror()
    const documentStore = useDocumentStore()

    await documentStore.startPersistence(fakeCloudBackend().backend)
    // 只驗證 lifecycle 這條寫入路徑：先把 mirror 還原成進入前的內容
    localStorage.setItem(MIRROR_KEY, seeded)

    fireUnloadLifecycle()

    expect(mirrorIds()).not.toContain('c-cloud')
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
  })

  it('雲端 session 未經 stopPersistence 結束時，下一個 session 不會把雲端留言存進本機', async () => {
    const documentStore = useDocumentStore()
    await documentStore.startPersistence(fakeCloudBackend().backend)
    await loadServerComments([commentDto('c-server')])
    fireUnloadLifecycle()

    // 關分頁：stopPersistence 不會執行。新的 Pinia 模擬重新整理後開 `/`
    setActivePinia(createPinia())
    const nextComments = useCommentStore()
    expect(nextComments.comments).toEqual([])

    const local = fakeLocalBackend(null)
    await useDocumentStore().startPersistence(local.backend)
    await flush()

    for (const [snapshot] of local.save.mock.calls) {
      expect(containsCloudContent(snapshot)).toBe(false)
      expect(snapshot.comments).toHaveLength(0)
    }
  })

  it('本機模式仍然寫入 localStorage mirror', async () => {
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()

    await documentStore.startPersistence(fakeLocalBackend(null).backend)
    const added = await addLocalComment(50, 50)

    expect(commentStore.comments.map((c) => c.id)).toEqual([added.id])
    expect(mirrorIds()).toEqual([added.id])
  })

  it('進出雲端後，store 恢復本機 mirror，之後的 lifecycle flush 不會刪掉它', async () => {
    seedLocalMirror()
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()

    await documentStore.startPersistence(fakeCloudBackend().backend)
    documentStore.stopPersistence()

    // 本機沒有 IndexedDB 草稿：store 的內容只能來自 localStorage mirror
    await documentStore.startPersistence(fakeLocalBackend(null).backend)
    expect(commentStore.comments.map((c) => c.id)).toEqual(['c-local'])

    fireVisibilityHidden()

    expect(mirrorIds()).toEqual(['c-local'])
  })

  it('回到本機後 mirror 恢復寫入', async () => {
    seedLocalMirror()
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()

    await documentStore.startPersistence(fakeCloudBackend().backend)
    documentStore.stopPersistence()
    await documentStore.startPersistence(fakeLocalBackend(null).backend)

    const added = await addLocalComment(60, 60)

    expect(commentStore.comments.map((c) => c.id)).toEqual(['c-local', added.id])
    expect(mirrorIds()).toEqual(['c-local', added.id])
  })
})

describe('雲端專案的留言與 document 解耦', () => {
  it('進入雲端專案時本機留言立刻從畫面消失，文件還在載入也一樣', async () => {
    seedLocalMirror()
    setActivePinia(createPinia())
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()
    expect(commentStore.comments.map((c) => c.id)).toEqual(['c-local'])

    const a = fakeBackend('A', 1000)
    const started = documentStore.startPersistence(a.backend)

    // load 還沒完成。不在這之前切換來源的話，雲端專案的畫布上會先看到本機草稿的留言。
    expect(commentStore.comments).toEqual([])
    expect(commentStore.source).toBe('cloud')

    a.resolve()
    await started
  })

  it('雲端文件的快照裡即使有 comments，也不會變成畫面上的留言', async () => {
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()

    // cloudSnapshot() 帶著一則 c-cloud：Comment V2 之前，雲端留言就存在 document 裡
    await documentStore.startPersistence(fakeCloudBackend().backend)

    expect(useElementStore().byId['r-cloud']?.name).toBe('Cloud Rect')
    expect(commentStore.comments).toEqual([])

    // 留言只來自留言自己的 API
    await loadServerComments([commentDto('c-server')])
    expect(commentStore.comments.map((c) => c.id)).toEqual(['c-server'])
  })

  it('雲端留言的新增、修改、切換、刪除都不會觸發 document 存檔', async () => {
    // Comment V2 的第一個成功條件：留言不再跟畫布共用 document_version。
    // 留言若還會觸發存檔，A 留言就會讓正在畫圖的 B 下一次存檔收到 409。
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()
    const cloud = fakeCloudBackend()
    await documentStore.startPersistence(cloud.backend)
    await loadServerComments([commentDto('c-server')])

    mockCreateComment.mockResolvedValue(commentDto('c-added'))
    commentStore.startDraft(10, 10)
    await commentStore.submitDraft('新留言')
    mockUpdateComment.mockResolvedValue(commentDto('c-server', 'edited'))
    await commentStore.updateText('c-server', 'edited')
    await commentStore.toggleResolved('c-server')
    mockDeleteComment.mockResolvedValue(undefined)
    await commentStore.remove('c-added')
    await nextTick() // 若有 watcher 被觸發，這裡會排程 autosave
    await flush() // debounce 0 的計時器

    expect(cloud.save).not.toHaveBeenCalled()
    expect(documentStore.saveState).toBe('saved')
  })

  it('雲端存檔的快照不帶留言', async () => {
    const documentStore = useDocumentStore()
    const cloud = fakeCloudBackend()
    await documentStore.startPersistence(cloud.backend)
    await loadServerComments([commentDto('c-server'), commentDto('c-other')])

    useElementStore().add(rect('r-new', 'New Rect'))
    await nextTick()
    await flush()

    expect(cloud.save).toHaveBeenCalledTimes(1)
    const saved = cloud.save.mock.calls[0]![0]
    expect(saved.elements.byId['r-new']?.name).toBe('New Rect')
    // 格式沒變（comments 欄位還在），只是雲端專案永遠是空陣列
    expect(saved.comments).toEqual([])
    expect(documentStore.buildSnapshot().comments).toEqual([])
  })

  it('雲端專案匯入 JSON：畫布被取代，檔案裡的留言被忽略', async () => {
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()
    const cloud = fakeCloudBackend()
    await documentStore.startPersistence(cloud.backend)
    await loadServerComments([commentDto('c-server')])

    const imported = await documentStore.importJsonString(
      JSON.stringify(snapshotFor('IMPORTED', 5000)),
    )

    expect(imported).toBe(true)
    expect(documentTags()).toEqual(['IMPORTED'])
    // 匯入不會在後端建立留言，也不會動到既有的雲端留言
    expect(commentStore.comments.map((c) => c.id)).toEqual(['c-server'])
    expect(mockCreateComment).not.toHaveBeenCalled()
    expect(cloud.save.mock.calls.at(-1)![0].comments).toEqual([])
  })

  it('本機草稿匯入 JSON 仍然帶入檔案裡的留言', async () => {
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()
    const local = fakeLocalBackend(null)
    await documentStore.startPersistence(local.backend)

    await documentStore.importJsonString(JSON.stringify(snapshotFor('IMPORTED', 5000)))

    expect(commentStore.comments.map((c) => c.text)).toEqual(['IMPORTED'])
    expect(local.save.mock.calls.at(-1)![0].comments.map((c) => c.id)).toEqual(['c-IMPORTED'])
  })

  it('本機草稿的留言仍然跟著快照存檔與載入', async () => {
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()
    const local = fakeLocalBackend(snapshotFor('LOCAL', 500))
    await documentStore.startPersistence(local.backend)
    expect(commentStore.comments.map((c) => c.text)).toEqual(['LOCAL'])

    await addLocalComment(10, 10, '新的本機留言')
    await nextTick()
    await flush()

    expect(local.save).toHaveBeenCalled()
    expect(local.save.mock.calls.at(-1)![0].comments.map((c) => c.text)).toEqual([
      'LOCAL',
      '新的本機留言',
    ])
  })

  it('離開雲端專案時，飛行中的留言載入不會寫進之後的畫面', async () => {
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()
    await documentStore.startPersistence(fakeCloudBackend().backend)
    const slow = deferred<CommentDto[]>()
    mockListComments.mockReturnValue(slow.promise)
    const loading = commentStore.load('project-id')

    documentStore.stopPersistence()
    slow.resolve([commentDto('c-server')])
    await loading

    expect(commentStore.source).toBe('local')
    expect(commentStore.comments).toEqual([])
  })
})

describe('startPersistence 的回傳值（presence 以此決定是否連線）', () => {
  it('載入成功回傳 true', async () => {
    const documentStore = useDocumentStore()
    const a = fakeBackend('A', 1000)

    const started = documentStore.startPersistence(a.backend)
    a.resolve()

    await expect(started).resolves.toBe(true)
  })

  it('載入失敗（404、無權限、內容不合法）回傳 false', async () => {
    const documentStore = useDocumentStore()
    const failing: DocumentBackend = {
      kind: 'cloud',
      available: true,
      debounceMs: 0,
      load: () => Promise.reject(new Error('找不到專案')),
      save: vi.fn(),
    }

    await expect(documentStore.startPersistence(failing)).resolves.toBe(false)
  })

  it('載入期間已被 stop（離開或換專案）回傳 false', async () => {
    const documentStore = useDocumentStore()
    const a = fakeBackend('A', 1000)

    const started = documentStore.startPersistence(a.backend)
    documentStore.stopPersistence()
    a.resolve()

    await expect(started).resolves.toBe(false)
  })

  it('已經啟動時重複呼叫回傳 false', async () => {
    const documentStore = useDocumentStore()
    const a = fakeBackend('A', 1000)
    const first = documentStore.startPersistence(a.backend)

    await expect(documentStore.startPersistence(a.backend)).resolves.toBe(false)

    a.resolve()
    await first
  })
})
