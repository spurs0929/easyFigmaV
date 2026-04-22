import { cloneDocumentSnapshot, parseDocumentSnapshot, type DocumentSnapshot } from '@/types/document'

// IndexedDB 資料庫名稱與版本；DB_VERSION 升版可觸發 onupgradeneeded 進行 schema 遷移。
const DB_NAME = 'easyfigmav-documents'
const DB_VERSION = 1
const STORE_NAME = 'documents'
// 固定 key 以單筆記錄儲存「當前文件」；未來若支援多專案，可改為動態 documentId。
const CURRENT_DOCUMENT_KEY = 'current'

/** IndexedDB 中實際儲存的記錄結構；id 欄位對應 objectStore 的 keyPath。 */
interface StoredDocumentRecord {
  id: string
  snapshot: DocumentSnapshot
}

export function isIndexedDbSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined'
}

/**
 * 通用的 IndexedDB 操作包裝器：開啟 DB → 建立 transaction → 執行 run → 解析結果。
 * 使用 async/await 取代 .then 鏈，讓 IDBRequest 回呼統一以 Promise 暴露給呼叫端。
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDocumentDb()
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)
    const request = run(store)

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function openDocumentDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDbSupported()) {
      reject(new Error('IndexedDB is not available in this browser'))
      return
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'))
  })
}

/** 從 IndexedDB 讀取當前文件快照；若尚無存檔或驗證失敗，返回 null。 */
export async function loadStoredDocumentSnapshot(): Promise<DocumentSnapshot | null> {
  const record = await withStore<StoredDocumentRecord | undefined>('readonly', (store) =>
    store.get(CURRENT_DOCUMENT_KEY),
  )
  if (!record) return null
  return parseDocumentSnapshot(record.snapshot)
}

/** 以 put（upsert）方式寫入 IndexedDB；structuredClone 確保存入的是獨立副本，不受後續 store 變更影響。 */
export async function saveStoredDocumentSnapshot(snapshot: DocumentSnapshot): Promise<void> {
  const record: StoredDocumentRecord = {
    id: CURRENT_DOCUMENT_KEY,
    snapshot: cloneDocumentSnapshot(snapshot),
  }
  await withStore<IDBValidKey>('readwrite', (store) => store.put(record))
}
