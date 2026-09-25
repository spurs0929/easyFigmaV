import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { DocumentBackend } from '@/services/documentBackend'
import { useCommentStore } from '@/store/comment'
import { useDocumentStore } from '@/store/document'
import { useElementStore } from '@/store/element'
import { DOCUMENT_SNAPSHOT_VERSION, type DocumentSnapshot } from '@/types/document'
import { ElementKind, type CanvasElement } from '@/types/element'

/**
 * 用留言當作「這份文件是誰」的標記：CanvasComment 結構簡單，
 * 而且 elements 留空就能通過 assertStoreIntegrity。
 */
function snapshotFor(tag: string, savedAt: number): DocumentSnapshot {
  return {
    version: DOCUMENT_SNAPSHOT_VERSION,
    savedAt,
    elements: { byId: {}, rootIds: [] },
    comments: [
      { id: `c-${tag}`, worldX: 0, worldY: 0, text: tag, resolved: false, createdAt: savedAt },
    ],
  }
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
})

describe('documentStore 生命週期競態', () => {
  it('過期的 load 不得套用到目前的文件（A 慢、B 快）', async () => {
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()

    const a = fakeBackend('A', 1000)
    void documentStore.startPersistence(a.backend)
    documentStore.stopPersistence()

    const b = fakeBackend('B', 2000)
    void documentStore.startPersistence(b.backend)

    b.resolve()
    await flush()
    expect(commentStore.comments[0]?.text).toBe('B')
    expect(documentStore.lastSavedAt).toBe(2000)

    // A 這時才回來，必須整份被丟棄
    a.resolve()
    await flush()

    expect(commentStore.comments[0]?.text).toBe('B')
    expect(documentStore.lastSavedAt).toBe(2000)
    // 最危險的部分：A 的內容若被套進去，B 的 watcher 會被 documentRevision
    // 觸發，然後把 A 的內容存到 B 的專案。
    expect(b.save).not.toHaveBeenCalled()
  })

  it('過期的 load 不得套用到目前的文件（A 先回來）', async () => {
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()

    const a = fakeBackend('A', 1000)
    void documentStore.startPersistence(a.backend)
    documentStore.stopPersistence()

    const b = fakeBackend('B', 2000)
    void documentStore.startPersistence(b.backend)

    a.resolve()
    await flush()
    // A 全程不得 commit：此時還沒有任何文件被套用
    expect(commentStore.comments).toHaveLength(0)
    expect(documentStore.lastSavedAt).toBeNull()

    b.resolve()
    await flush()

    expect(commentStore.comments[0]?.text).toBe('B')
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

    // 沒有任何持久化在運作，改動文件不該觸發存檔
    commentStore.replaceAll(snapshotFor('X', 3000).comments)
    await flush()
    expect(a.save).not.toHaveBeenCalled()

    // 而且下一次 startPersistence 必須能正常啟動（_started 沒有卡住）
    const b = fakeBackend('B', 2000)
    void documentStore.startPersistence(b.backend)
    b.resolve()
    await flush()
    expect(commentStore.comments[0]?.text).toBe('B')
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
    const commentStore = useCommentStore()

    const cloud = fakeCloudBackend()
    await documentStore.startPersistence(cloud.backend)
    documentStore.stopPersistence()

    const local = fakeLocalBackend(null)
    await documentStore.startPersistence(local.backend)

    commentStore.add(10, 10)
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
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()

    // debounce 拉長，確保 stopPersistence 時計時器還沒觸發
    const cloud = fakeCloudBackend(60_000)
    await documentStore.startPersistence(cloud.backend)

    commentStore.add(20, 20)
    // watcher 在下一個 tick 才排程 autosave；真實操作中編輯與換頁不會在同一個 tick
    await nextTick()
    documentStore.stopPersistence()
    await flush()

    expect(cloud.save).toHaveBeenCalledTimes(1)
    const saved = cloud.save.mock.calls[0]![0]
    // 送出的是完整的雲端文件加上新留言，不是清空後的空文件
    expect(saved.elements.byId['r-cloud']?.name).toBe('Cloud Rect')
    expect(saved.comments).toHaveLength(2)
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

    const added = commentStore.add(30, 30)
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
    commentStore.updateText('c-cloud', 'edited')
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
    commentStore.toggleResolved('c-cloud')
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
    commentStore.remove(added.id)
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
  })

  it('雲端 load 不把雲端留言寫進 localStorage', async () => {
    const seeded = seedLocalMirror()
    const documentStore = useDocumentStore()
    const commentStore = useCommentStore()

    await documentStore.startPersistence(fakeCloudBackend().backend)

    expect(commentStore.comments.map((c) => c.id)).toEqual(['c-cloud'])
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
    useCommentStore().add(40, 40)
    fireUnloadLifecycle()

    // 關分頁：stopPersistence 不會執行。新的 Pinia 模擬重新整理後開 `/`
    setActivePinia(createPinia())
    const nextComments = useCommentStore()
    expect(nextComments.comments.some((c) => c.id === 'c-cloud')).toBe(false)

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
    const added = commentStore.add(50, 50)

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

    const added = commentStore.add(60, 60)

    expect(mirrorIds()).toEqual(['c-local', added.id])
  })
})
