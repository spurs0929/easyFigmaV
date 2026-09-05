import { ApiError } from '@/services/api'
import {
  isIndexedDbSupported,
  loadStoredDocumentSnapshot,
  saveStoredDocumentSnapshot,
} from '@/services/documentStorage'
import { getProject, saveDocument } from '@/services/projects'
import { parseDocumentSnapshot, type DocumentSnapshot } from '@/types/document'

/**
 * 樂觀鎖衝突。與一般網路錯誤分開，因為處理方式相反：網路錯誤可以重試，
 * 衝突不行——重試只會再撞一次，而且若改成強制覆蓋就等於把樂觀鎖關掉。
 */
export class DocumentConflictError extends Error {
  constructor() {
    super('這個專案已在其他視窗被修改')
    this.name = 'DocumentConflictError'
  }
}

/**
 * 文件持久化的後端介面。
 *
 * documentStore 只認這個介面，不認 IndexedDB 也不認 HTTP。序列化、debounce、
 * 狀態機、生命週期 flush 全部沿用，換的只是背後的讀寫。
 */
export interface DocumentBackend {
  readonly kind: 'local' | 'cloud'
  /** 這個環境能不能持久化。本機模式取決於瀏覽器是否支援 IndexedDB。 */
  readonly available: boolean
  /**
   * 自動存檔的 debounce 長度。
   *
   * 寫 IndexedDB 是本機操作，800ms 綽綽有餘。雲端每一次都是一趟網路，而且
   * Render 免費方案冷啟動時可能要好幾秒，沿用同樣的值只會製造大量無謂請求。
   */
  readonly debounceMs: number
  /** 回傳 null 代表「還沒有存檔」，呼叫端應保留目前畫布。 */
  load(): Promise<DocumentSnapshot | null>
  /** 衝突時丟 DocumentConflictError。 */
  save(snapshot: DocumentSnapshot): Promise<void>
}

const LOCAL_DEBOUNCE_MS = 800
const CLOUD_DEBOUNCE_MS = 1500

/** 本機草稿（`/`）。完全沿用原本的 IndexedDB 實作。 */
export const localDocumentBackend: DocumentBackend = {
  kind: 'local',
  // getter 而非固定值：isIndexedDbSupported 依賴 window，模組載入時求值
  // 在 SSR 或測試環境會拿到錯的結果。
  get available() {
    return isIndexedDbSupported()
  },
  debounceMs: LOCAL_DEBOUNCE_MS,
  load: loadStoredDocumentSnapshot,
  save: saveStoredDocumentSnapshot,
}

/**
 * 雲端專案（`/p/:id`）。
 *
 * 這裡唯一複雜的地方是**存檔必須序列化**，而且 debounce 取代不了它。
 *
 * debounce 保證的是「停止操作 N 毫秒後才送出」，不保證「上一次已經送完」。
 * 一趟 PUT 若花了三秒（冷啟動時很正常），使用者在這三秒內繼續畫，第二次
 * 存檔就會帶著還沒遞增的 document_version 出去，後端照規則回 409。
 *
 * 那是自己跟自己衝突，跟其他視窗無關，但畫面會顯示「已在其他視窗被修改」，
 * 除錯時極度誤導。所以同時只允許一個請求在途中，期間進來的快照合併成一份
 * pending——中間那些狀態本來就不需要送，使用者要的是最後那一份。
 */
export function createCloudDocumentBackend(projectId: string): DocumentBackend {
  // -1 代表尚未 load。若 save 先於 load 發生，帶 0 出去會固定收到 409，
  // 那是前端的時序 bug，不該被誤報成使用者的衝突。
  let version = -1
  let inFlight: Promise<void> | null = null
  let pending: DocumentSnapshot | null = null
  let conflicted = false

  async function drain(): Promise<void> {
    while (pending) {
      const snapshot = pending
      // 先清空再送出。送出期間新進來的快照會重新設定 pending，
      // 迴圈下一圈就會撈到——這是合併的關鍵。
      pending = null

      try {
        const saved = await saveDocument(projectId, version, snapshot)
        version = saved.document_version
      } catch (error) {
        // 失敗就丟掉 pending：衝突時繼續送等於拿舊版本硬蓋，
        // 斷線時繼續送則會在離線期間無限堆積。
        pending = null
        if (error instanceof ApiError && error.status === 409) {
          conflicted = true
          throw new DocumentConflictError()
        }
        throw error
      }
    }
  }

  return {
    kind: 'cloud',
    available: true,
    debounceMs: CLOUD_DEBOUNCE_MS,

    async load() {
      const detail = await getProject(projectId)
      const snapshot = parseDocumentSnapshot(detail.document)
      // 這裡刻意不回 null。null 的意思是「還沒有存檔，保留目前畫布」，
      // 但雲端專案一定有 document，parse 失敗代表資料真的不合法——
      // 這時若當成空白繼續，下一次自動存檔就會把它覆蓋掉。
      if (!snapshot) {
        throw new Error('雲端文件格式無法辨識，可能由不相容的版本建立')
      }

      version = detail.document_version
      conflicted = false
      pending = null
      return snapshot
    },

    save(snapshot) {
      if (version < 0) {
        return Promise.reject(new Error('專案尚未載入完成，無法存檔'))
      }
      if (conflicted) {
        return Promise.reject(new DocumentConflictError())
      }

      pending = snapshot
      if (!inFlight) {
        inFlight = drain().finally(() => {
          inFlight = null
        })
      }
      // 回傳同一個 promise：等待中的呼叫端會在整批送完後一起收到結果。
      return inFlight
    },
  }
}
