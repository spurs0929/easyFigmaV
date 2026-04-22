import { computed, ref, watch, type WatchStopHandle } from 'vue'
import { defineStore } from 'pinia'
import { useCommentStore } from '@/store/comment'
import { useElementStore } from '@/store/element'
import {
  isIndexedDbSupported,
  loadStoredDocumentSnapshot,
  saveStoredDocumentSnapshot,
} from '@/services/documentStorage'
import { DOCUMENT_SNAPSHOT_VERSION, parseDocumentSnapshot, type DocumentSnapshot } from '@/types/document'

/** 自動存檔的 UI 狀態機；toolbar 的狀態燈根據此值改變顏色。 */
type SaveState = 'idle' | 'loading' | 'saving' | 'saved' | 'error'

// 防抖延遲：使用者操作停止 800ms 後才寫 IndexedDB，避免每次滑鼠移動都觸發 I/O。
const AUTOSAVE_DEBOUNCE_MS = 800

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown persistence error'
}

function makeDownloadFilename(savedAt: number): string {
  const timestamp = new Date(savedAt).toISOString().replace(/[:.]/g, '-')
  return `easyfigma-document-${timestamp}.json`
}

export const useDocumentStore = defineStore('document', () => {
  const elementStore = useElementStore()
  const commentStore = useCommentStore()

  const saveState = ref<SaveState>('idle')
  const lastSavedAt = ref<number | null>(null)
  const errorMessage = ref('')
  const persistenceAvailable = computed(() => isIndexedDbSupported())

  let _watchStop: WatchStopHandle | null = null
  let _saveTimer: ReturnType<typeof setTimeout> | null = null
  let _started = false
  // _hydrating = true 時表示正在從 IndexedDB 還原資料；此期間 documentRevision 的變動不應觸發自動存檔。
  let _hydrating = false
  let _unbindLifecycle: (() => void) | null = null

  /** 從 elementStore 與 commentStore 各取深拷貝，組合成一份完整的快照物件。 */
  function buildSnapshot(): DocumentSnapshot {
    return {
      version: DOCUMENT_SNAPSHOT_VERSION,
      savedAt: Date.now(),
      elements: elementStore.snapshot(),
      comments: commentStore.snapshot(),
    }
  }

  /**
   * 將快照資料套用至各 store；以 _hydrating 旗標包住，
   * 防止 loadSnapshot / replaceAll 觸發 documentRevision 而引發不必要的自動存檔。
   */
  async function applySnapshot(snapshot: DocumentSnapshot): Promise<void> {
    _hydrating = true
    try {
      elementStore.loadSnapshot(snapshot.elements)
      commentStore.replaceAll(snapshot.comments)
    } finally {
      _hydrating = false
    }
  }

  async function persistNow(): Promise<boolean> {
    if (_saveTimer) {
      clearTimeout(_saveTimer)
      _saveTimer = null
    }

    if (_hydrating || !persistenceAvailable.value) {
      if (!persistenceAvailable.value) saveState.value = 'idle'
      return false
    }

    try {
      const snapshot = buildSnapshot()
      await saveStoredDocumentSnapshot(snapshot)
      lastSavedAt.value = snapshot.savedAt
      errorMessage.value = ''
      saveState.value = 'saved'
      return true
    } catch (error) {
      errorMessage.value = toErrorMessage(error)
      saveState.value = 'error'
      return false
    }
  }

  function scheduleAutosave(): void {
    if (_hydrating || !persistenceAvailable.value) return

    if (_saveTimer) clearTimeout(_saveTimer)
    saveState.value = 'saving'
    _saveTimer = setTimeout(() => {
      void persistNow()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  /**
   * 綁定頁面生命週期事件，確保使用者切換分頁或關閉視窗前，待存的資料能立刻寫入。
   * - beforeunload：桌機關閉視窗
   * - pagehide：行動裝置切換 App / Safari BFCache 退場
   * - visibilitychange hidden：切換分頁（beforeunload 此時不觸發）
   */
  function bindLifecycle(): void {
    const flushPendingSave = (): void => {
      if (_saveTimer) void persistNow()
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flushPendingSave()
    }

    window.addEventListener('beforeunload', flushPendingSave)
    window.addEventListener('pagehide', flushPendingSave)
    document.addEventListener('visibilitychange', onVisibilityChange)

    _unbindLifecycle = () => {
      window.removeEventListener('beforeunload', flushPendingSave)
      window.removeEventListener('pagehide', flushPendingSave)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }

  async function loadPersistedDocument(): Promise<boolean> {
    if (!persistenceAvailable.value) {
      saveState.value = 'idle'
      return false
    }

    saveState.value = 'loading'
    try {
      const snapshot = await loadStoredDocumentSnapshot()
      if (!snapshot) {
        saveState.value = 'idle'
        return false
      }

      await applySnapshot(snapshot)
      lastSavedAt.value = snapshot.savedAt
      errorMessage.value = ''
      saveState.value = 'saved'
      return true
    } catch (error) {
      errorMessage.value = toErrorMessage(error)
      saveState.value = 'error'
      return false
    }
  }

  /**
   * 應用程式啟動時呼叫一次（App.vue onMounted）。
   * 1. 先嘗試從 IndexedDB 載入上次存檔
   * 2. 開始監聽 documentRevision 變化以觸發自動存檔
   * 3. 若無存檔但 store 已有資料（e.g. 預設 mock），立刻存一份
   */
  async function startPersistence(): Promise<void> {
    if (_started) return
    _started = true

    const loaded = await loadPersistedDocument()
    _watchStop = watch(
      [() => elementStore.documentRevision, () => commentStore.documentRevision],
      () => {
        scheduleAutosave()
      },
    )
    bindLifecycle()

    if (!loaded && (Object.keys(elementStore.byId).length > 0 || commentStore.comments.length > 0)) {
      void persistNow()
    }
  }

  function stopPersistence(): void {
    if (_saveTimer) {
      clearTimeout(_saveTimer)
      _saveTimer = null
    }
    _watchStop?.()
    _watchStop = null
    _unbindLifecycle?.()
    _unbindLifecycle = null
    _started = false
  }

  /** 將當前快照序列化為 JSON 並以動態 <a> 觸發瀏覽器下載，不依賴後端。 */
  async function exportJson(): Promise<void> {
    const snapshot = buildSnapshot()
    const json = JSON.stringify(snapshot, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = makeDownloadFilename(snapshot.savedAt)
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  /** 解析 JSON 字串並套用至 store；驗證失敗時設 error 狀態並返回 false，不改動現有資料。 */
  async function importJsonString(json: string): Promise<boolean> {
    try {
      const snapshot = parseDocumentSnapshot(JSON.parse(json))
      if (!snapshot) throw new Error('Invalid DocumentSnapshot JSON schema')
      await applySnapshot(snapshot)
      await persistNow()
      errorMessage.value = ''
      return true
    } catch (error) {
      errorMessage.value = toErrorMessage(error)
      saveState.value = 'error'
      return false
    }
  }

  async function importFile(file: File): Promise<boolean> {
    return importJsonString(await file.text())
  }

  return {
    saveState,
    lastSavedAt,
    errorMessage,
    persistenceAvailable,
    startPersistence,
    stopPersistence,
    persistNow,
    exportJson,
    importJsonString,
    importFile,
  }
})
