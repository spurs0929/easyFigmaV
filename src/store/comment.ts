import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { isCanvasComment, type CanvasComment, newCommentId } from '@/types/comment'
import { cloneCommentSnapshots } from '@/types/document'

/** localStorage 中儲存評論陣列的鍵名。 */
const STORAGE_KEY = 'easyfigma_comments'

/**
 * 從 localStorage 載入評論資料，失敗時安全返回空陣列。
 * JSON.parse 失敗（資料損壞）或根值不是陣列時均不拋出。
 */
function loadFromStorage(): CanvasComment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isCanvasComment)
  } catch {
    return []
  }
}

/**
 * 將評論陣列序列化並寫入 localStorage。
 * - 評論為空時改用 removeItem 釋放空間，避免留下空陣列字串 "[]"。
 * - 儲存失敗（私密模式容量限制、QuotaExceededError）只記錄 error，不中斷業務流程。
 */
function writeToStorage(comments: readonly CanvasComment[]): void {
  try {
    if (comments.length === 0) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(comments))
  } catch (e) {
    console.error('[CommentStore] localStorage write failed', e)
  }
}

/**
 * 模組級生命週期綁定旗標，確保跨熱重載（HMR）只綁定一次瀏覽器事件。
 * Pinia store 在 HMR 時可能重建，_lifecycleBound 防止重複綁定。
 */
let _lifecycleBound = false
/** 目前有效 store 的 flush 函式參照；HMR 重建 store 時由新 flush 覆寫。 */
let _flushComments: (() => void) | null = null

/**
 * 綁定頁面卸載相關事件，於瀏覽器關閉 / 切換頁籤 / 進入背景時強制持久化。
 * 使用間接呼叫（_flushComments?.()）而非直接閉包，以支援 HMR 時無縫替換 flush 參照。
 */
function bindLifecycle(flush: () => void): void {
  _flushComments = flush
  if (_lifecycleBound) return

  const flushCurrent = (): void => _flushComments?.()

  window.addEventListener('beforeunload', flushCurrent)
  // pagehide 處理 iOS Safari / bfcache 場景（beforeunload 不一定觸發）
  window.addEventListener('pagehide', flushCurrent)
  // visibilitychange 處理行動裝置切換 App、桌面最小化等場景
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushCurrent()
  })

  _lifecycleBound = true
}

export const useCommentStore = defineStore('comment', () => {
  /** 評論的私有響應式陣列；外部透過 computed `comments` 存取唯讀快照。 */
  const _comments = ref<CanvasComment[]>(loadFromStorage())
  const _documentRevision = ref(0)
  /**
   * 是否把評論鏡像到 localStorage。只是一個開關，store 不知道開關的理由；
   * 由 documentStore 依持久化目標決定（雲端專案期間關閉）。
   * 刻意放在 store 內而非模組層級：重新建立的 store（HMR、新的 Pinia）一律從開啟開始。
   */
  let _storageMirrorEnabled = true

  /**
   * 對外公開的唯讀評論列表。
   * .slice() 建立淺拷貝，防止外部直接操作內部陣列，同時保持 Vue 響應追蹤。
   */
  const comments = computed<readonly CanvasComment[]>(() => _comments.value.slice())
  const documentRevision = computed(() => _documentRevision.value)

  function touchDocument(): void {
    _documentRevision.value++
  }

  /**
   * 立即將當前評論陣列寫入 localStorage。
   * 這是唯一的寫入閘門：persist、頁面 lifecycle、CanvasArea unmount 都經過這裡。
   */
  function flush(): void {
    if (!_storageMirrorEnabled) return
    writeToStorage(_comments.value)
  }

  /**
   * 開關 localStorage mirror。
   *
   * 關閉 → 開啟時從 localStorage 重新讀回評論：關閉期間 store 內容與 mirror 已經分岔，
   * 只恢復開關的話，下一次 flush（切個分頁就會觸發）會拿 store 的內容覆蓋、甚至刪掉 mirror。
   * 重新讀取不寫回 localStorage，也不 touchDocument——這是還原，不是一次編輯。
   */
  function setStorageMirror(enabled: boolean): void {
    if (enabled === _storageMirrorEnabled) return
    _storageMirrorEnabled = enabled
    if (enabled) _comments.value = loadFromStorage()
  }

  /** 每次狀態變更後呼叫，確保資料同步持久化。 */
  function persist(): void {
    flush()
  }

  bindLifecycle(flush)

  /**
   * 在世界座標新增一則評論，立即持久化並返回新建物件。
   * @param worldX 世界座標 X（未經 viewport 縮放）
   * @param worldY 世界座標 Y（未經 viewport 縮放）
   */
  function add(worldX: number, worldY: number): CanvasComment {
    const comment: CanvasComment = {
      id: newCommentId(),
      worldX,
      worldY,
      text: '',
      resolved: false,
      createdAt: Date.now(),
    }
    _comments.value.push(comment)
    persist()
    touchDocument()
    return comment
  }

  /**
   * 更新指定 id 的評論文字內容。
   * @returns 更新成功返回 true；id 不存在返回 false（開發模式下輸出警告）。
   */
  function updateText(id: string, text: string): boolean {
    const target = _comments.value.find((c) => c.id === id)
    if (!target) {
      if (import.meta.env.DEV) console.warn(`[CommentStore] updateText: id "${id}" does not exist`)
      return false
    }
    target.text = text
    persist()
    touchDocument()
    return true
  }

  /**
   * 切換指定評論的已解決狀態（resolved ↔ unresolved）。
   * @returns 切換成功返回 true；id 不存在返回 false。
   */
  function toggleResolved(id: string): boolean {
    const target = _comments.value.find((c) => c.id === id)
    if (!target) {
      if (import.meta.env.DEV)
        console.warn(`[CommentStore] toggleResolved: id "${id}" does not exist`)
      return false
    }
    target.resolved = !target.resolved
    persist()
    touchDocument()
    return true
  }

  /**
   * 刪除指定 id 的評論。
   * 使用 splice 而非 filter，避免重建整個陣列參照（保持 Vue 響應性最小化）。
   * @returns 刪除成功返回 true；id 不存在返回 false。
   */
  function remove(id: string): boolean {
    const idx = _comments.value.findIndex((c) => c.id === id)
    if (idx === -1) {
      if (import.meta.env.DEV) console.warn(`[CommentStore] remove: id "${id}" does not exist`)
      return false
    }
    _comments.value.splice(idx, 1)
    persist()
    touchDocument()
    return true
  }

  /** 以外部快照完整取代評論陣列（載入存檔 / 匯入 JSON 時使用）；structuredClone 確保資料隔離。 */
  function replaceAll(comments: readonly CanvasComment[]): void {
    _comments.value = cloneCommentSnapshots(comments)
    persist()
    touchDocument()
  }

  /** 取得當前評論陣列的深拷貝，供 documentStore 建立快照使用。 */
  function snapshot(): CanvasComment[] {
    return cloneCommentSnapshots(_comments.value)
  }

  return {
    comments,
    documentRevision,
    add,
    updateText,
    toggleResolved,
    remove,
    replaceAll,
    snapshot,
    flush,
    setStorageMirror,
  }
})
