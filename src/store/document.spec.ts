import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { DocumentBackend } from '@/services/documentBackend'
import { useCommentStore } from '@/store/comment'
import { useDocumentStore } from '@/store/document'
import { DOCUMENT_SNAPSHOT_VERSION, type DocumentSnapshot } from '@/types/document'

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
