import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api'
import { createCloudDocumentBackend, DocumentConflictError } from '@/services/documentBackend'
import { DOCUMENT_SNAPSHOT_VERSION, type DocumentSnapshot } from '@/types/document'

vi.mock('@/services/projects', () => ({
  getProject: vi.fn(),
  saveDocument: vi.fn(),
}))

const { getProject, saveDocument } = await import('@/services/projects')
const mockGetProject = vi.mocked(getProject)
const mockSaveDocument = vi.mocked(saveDocument)

const PROJECT_ID = '11111111-1111-1111-1111-111111111111'

function snapshot(savedAt: number): DocumentSnapshot {
  return {
    version: DOCUMENT_SNAPSHOT_VERSION,
    savedAt,
    elements: { byId: {}, rootIds: [] } as unknown as DocumentSnapshot['elements'],
    comments: [],
  }
}

/** 手動控制 resolve 時機，用來製造「請求還在途中」的狀態。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function savedResponse(version: number) {
  return { document_version: version, updated_at: new Date().toISOString() }
}

/** 讓已經排定的 microtask 跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function loadedBackend(startVersion = 1) {
  mockGetProject.mockResolvedValue({
    id: PROJECT_ID,
    name: '測試專案',
    document_version: startVersion,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    document: snapshot(0) as unknown as Record<string, unknown>,
  })
  const backend = createCloudDocumentBackend(PROJECT_ID)
  await backend.load()
  return backend
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createCloudDocumentBackend', () => {
  it('尚未 load 時拒絕存檔，而不是帶著無效版本送出去', async () => {
    const backend = createCloudDocumentBackend(PROJECT_ID)
    await expect(backend.save(snapshot(1))).rejects.toThrow(/尚未載入/)
    expect(mockSaveDocument).not.toHaveBeenCalled()
  })

  it('存檔後用伺服器回傳的版本，而不是自己遞增', async () => {
    const backend = await loadedBackend(1)
    mockSaveDocument.mockResolvedValueOnce(savedResponse(2))
    await backend.save(snapshot(1))

    mockSaveDocument.mockResolvedValueOnce(savedResponse(3))
    await backend.save(snapshot(2))

    expect(mockSaveDocument.mock.calls[0][1]).toBe(1)
    expect(mockSaveDocument.mock.calls[1][1]).toBe(2)
  })

  it('前一個請求在途中時合併後續存檔，只送出最後一份', async () => {
    const backend = await loadedBackend(1)
    const first = deferred<ReturnType<typeof savedResponse>>()
    mockSaveDocument.mockReturnValueOnce(first.promise)

    const a = backend.save(snapshot(1))
    // 第一個請求還沒回來，這三次應該合併成一次
    const b = backend.save(snapshot(2))
    const c = backend.save(snapshot(3))
    const d = backend.save(snapshot(4))
    expect(mockSaveDocument).toHaveBeenCalledTimes(1)

    mockSaveDocument.mockResolvedValueOnce(savedResponse(3))
    first.resolve(savedResponse(2))
    await Promise.all([a, b, c, d])

    expect(mockSaveDocument).toHaveBeenCalledTimes(2)
    // 只送最後一份，而且帶的是第一次回來之後的新版本
    expect(mockSaveDocument.mock.calls[1][1]).toBe(2)
    expect(mockSaveDocument.mock.calls[1][2]).toMatchObject({ savedAt: 4 })
  })

  it('409 轉成 DocumentConflictError，之後的存檔直接拒絕不打 API', async () => {
    const backend = await loadedBackend(1)
    mockSaveDocument.mockRejectedValueOnce(new ApiError(409, '版本不符'))

    await expect(backend.save(snapshot(1))).rejects.toBeInstanceOf(DocumentConflictError)
    await flush()

    await expect(backend.save(snapshot(2))).rejects.toBeInstanceOf(DocumentConflictError)
    expect(mockSaveDocument).toHaveBeenCalledTimes(1)
  })

  it('重新 load 之後解除衝突鎖定，並改用新的版本', async () => {
    const backend = await loadedBackend(1)
    mockSaveDocument.mockRejectedValueOnce(new ApiError(409, '版本不符'))
    await expect(backend.save(snapshot(1))).rejects.toBeInstanceOf(DocumentConflictError)
    await flush()

    mockGetProject.mockResolvedValue({
      id: PROJECT_ID,
      name: '測試專案',
      document_version: 7,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      document: snapshot(0) as unknown as Record<string, unknown>,
    })
    await backend.load()

    mockSaveDocument.mockResolvedValueOnce(savedResponse(8))
    await backend.save(snapshot(2))
    expect(mockSaveDocument.mock.calls[1][1]).toBe(7)
  })

  it('網路錯誤不鎖定，下一次存檔仍會送出', async () => {
    const backend = await loadedBackend(1)
    mockSaveDocument.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(backend.save(snapshot(1))).rejects.toBeInstanceOf(TypeError)
    await flush()

    mockSaveDocument.mockResolvedValueOnce(savedResponse(2))
    await backend.save(snapshot(2))
    expect(mockSaveDocument).toHaveBeenCalledTimes(2)
    // 上一次失敗沒有遞增版本，這次仍然帶 1
    expect(mockSaveDocument.mock.calls[1][1]).toBe(1)
  })

  it('失敗後不保留 pending，不會在恢復連線時補送舊快照', async () => {
    const backend = await loadedBackend(1)
    const first = deferred<ReturnType<typeof savedResponse>>()
    mockSaveDocument.mockReturnValueOnce(first.promise)

    const a = backend.save(snapshot(1))
    const b = backend.save(snapshot(2))
    first.reject(new TypeError('Failed to fetch'))

    await expect(a).rejects.toBeInstanceOf(TypeError)
    await expect(b).rejects.toBeInstanceOf(TypeError)
    expect(mockSaveDocument).toHaveBeenCalledTimes(1)
  })
})
