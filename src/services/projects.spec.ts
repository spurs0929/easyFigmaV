import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FirebaseError } from 'firebase/app'

/**
 * 樂觀鎖是 Firebase 版最容易寫錯的地方：transaction 裡讀到的版本與呼叫端帶來的
 * 版本不符時必須丟 409，而不是蓋過去。documentBackend 依賴這個 409 顯示衝突對話框。
 */

const tx = vi.hoisted(() => ({
  stored: { exists: true, version: 3 },
  update: vi.fn(),
  denied: false,
}))

vi.mock('@/services/firebase', () => ({ db: {}, firebaseAuth: {} }))
vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return { ...actual, requireUid: () => 'u1' }
})
vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore')
  return {
    ...actual,
    doc: vi.fn(() => ({ id: 'p1' })),
    collection: vi.fn(),
    serverTimestamp: vi.fn(() => 'SERVER_TS'),
    runTransaction: vi.fn(async (_db: unknown, run: (t: unknown) => Promise<unknown>) => {
      if (tx.denied) throw new FirebaseError('permission-denied', 'denied')
      return run({
        get: async () => ({
          exists: () => tx.stored.exists,
          data: () => ({ document_version: tx.stored.version }),
        }),
        update: tx.update,
      })
    }),
  }
})

vi.mock('firebase/auth', () => ({ onAuthStateChanged: vi.fn() }))

const { saveDocument } = await import('@/services/projects')
const { ApiError } = await import('@/services/api')

describe('saveDocument（Firestore transaction 樂觀鎖）', () => {
  beforeEach(() => {
    tx.stored = { exists: true, version: 3 }
    tx.update.mockReset()
    tx.denied = false
  })

  it('版本相符：寫入 JSON 字串並把版本 +1', async () => {
    const saved = await saveDocument('p1', 3, { version: 1, elements: [] })

    expect(saved.document_version).toBe(4)
    expect(tx.update).toHaveBeenCalledWith(expect.anything(), {
      document: JSON.stringify({ version: 1, elements: [] }),
      document_version: 4,
      updated_at: 'SERVER_TS',
    })
  })

  it('版本不符：丟 409，而且不寫入', async () => {
    const result = saveDocument('p1', 2, {})

    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toMatchObject({ status: 409 })
    expect(tx.update).not.toHaveBeenCalled()
  })

  it('專案不存在：404', async () => {
    tx.stored.exists = false
    await expect(saveDocument('p1', 3, {})).rejects.toMatchObject({ status: 404 })
  })

  it('rules 拒絕（不是成員）：同樣回 404，不洩漏專案是否存在', async () => {
    tx.denied = true
    await expect(saveDocument('p1', 3, {})).rejects.toMatchObject({ status: 404 })
  })
})
