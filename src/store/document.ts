import { computed, ref, watch, type WatchStopHandle } from 'vue'
import { defineStore } from 'pinia'
import { useCommentStore } from '@/store/comment'
import { useElementStore } from '@/store/element'
import {
  DocumentConflictError,
  localDocumentBackend,
  type DocumentBackend,
} from '@/services/documentBackend'
import {
  DOCUMENT_SNAPSHOT_VERSION,
  parseDocumentSnapshot,
  type DocumentSnapshot,
} from '@/types/document'

/**
 * 自動存檔的 UI 狀態機；toolbar 的狀態燈根據此值改變顏色。
 *
 * conflict 與 error 分開：error 是暫時性的（斷線、伺服器沒醒），重試就會好；
 * conflict 是永久的，除非使用者重新載入，否則之後每一次存檔都會再撞一次。
 */
type SaveState = 'idle' | 'loading' | 'saving' | 'saved' | 'error' | 'conflict'

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

  // 目前的持久化目標。預設本機，進入 /p/:id 時由 startPersistence 換掉。
  let _backend: DocumentBackend = localDocumentBackend

  const backendKind = ref<DocumentBackend['kind']>(localDocumentBackend.kind)
  const persistenceAvailable = ref(localDocumentBackend.available)
  const isCloud = computed(() => backendKind.value === 'cloud')

  let _watchStop: WatchStopHandle | null = null
  let _saveTimer: ReturnType<typeof setTimeout> | null = null
  let _started = false
  // 每次 start/stop 遞增。startPersistence 在 await 之後用它確認自己還是
  // 「當前」那一次啟動——否則快速切換路由時，已經被 stop 掉的那次會在
  // 載入完成後補建 watcher 與事件監聽，造成洩漏與重複自動存檔。
  let _generation = 0
  // _hydrating = true 時表示正在從 IndexedDB 還原資料；此期間 documentRevision 的變動不應觸發自動存檔。
  let _hydrating = false
  let _unbindLifecycle: (() => void) | null = null
  // 衝突後鎖住自動存檔。不停掉 watcher 而是在這裡擋，因為重新載入之後
  // 要能無縫恢復——重建 watcher 還要重新處理 _hydrating 的時序。
  let _conflicted = false

  /**
   * 從 elementStore 與 commentStore 各取深拷貝，組合成一份完整的快照物件。
   *
   * 雲端專案的快照裡 comments 永遠是空陣列（commentStore.snapshot() 在雲端來源時
   * 回傳 []）：雲端留言是後端的獨立資源，不屬於 document。欄位本身留著是因為
   * 快照格式沒有變——本機草稿仍然把留言存在這裡。
   */
  function buildSnapshot(): DocumentSnapshot {
    return {
      version: DOCUMENT_SNAPSHOT_VERSION,
      savedAt: Date.now(),
      elements: elementStore.snapshot(),
      comments: commentStore.snapshot(),
    }
  }

  /**
   * 建立新雲端專案時要送出的 document：與 buildSnapshot() 相同，但 comments 固定是空陣列。
   *
   * 「存到雲端」發生在留言來源還是本機的時候，buildSnapshot() 會帶著本機留言——
   * 那是對的，本機草稿的留言本來就屬於它的快照。但雲端專案的留言只存在後端的
   * comments 資料表，寫進 document.comments 的留言之後不會顯示，下一次存檔就被
   * 蓋成空陣列，等於無聲消失。
   *
   * 本機草稿本身不受影響：它還在 IndexedDB 裡，留言也還在。這裡只是不讓新的雲端
   * 專案繼承只屬於本機的留言。
   *
   * 欄位留著而不是拿掉：快照格式沒有變，少了 comments 就過不了 parseDocumentSnapshot。
   */
  function buildCloudSnapshot(): DocumentSnapshot {
    return { ...buildSnapshot(), comments: [] }
  }

  /**
   * 將快照資料套用至各 store；以 _hydrating 旗標包住，
   * 防止 loadSnapshot / replaceAll 觸發 documentRevision 而引發不必要的自動存檔。
   *
   * 雲端專案時 commentStore.replaceAll() 不做任何事：快照裡的 comments（舊版留下的、
   * 或匯入的 JSON 帶進來的）不會變成畫面上的留言，雲端留言只來自 commentStore.load()。
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

    // 把 backend 與 generation 在同一個 tick 內取下來，之後只用區域變數。
    // 期間若被 stopPersistence 取消或換了專案，下面的 commit 一律跳過。
    const backend = _backend
    const generation = _generation

    try {
      const snapshot = buildSnapshot()
      await backend.save(snapshot)
      if (generation !== _generation) return false

      lastSavedAt.value = snapshot.savedAt
      errorMessage.value = ''
      saveState.value = 'saved'
      return true
    } catch (error) {
      // 過期的存檔失敗更不能 commit：一個已經離開的專案回報 409，
      // 會把 _conflicted 設起來，鎖住的卻是現在這個專案的自動存檔。
      if (generation !== _generation) return false

      errorMessage.value = toErrorMessage(error)
      if (error instanceof DocumentConflictError) {
        _conflicted = true
        saveState.value = 'conflict'
      } else {
        saveState.value = 'error'
      }
      return false
    }
  }

  function scheduleAutosave(): void {
    if (_hydrating || _conflicted || !persistenceAvailable.value) return

    if (_saveTimer) clearTimeout(_saveTimer)
    saveState.value = 'saving'
    _saveTimer = setTimeout(() => {
      void persistNow()
    }, _backend.debounceMs)
  }

  /**
   * 綁定頁面生命週期事件，確保使用者切換分頁或關閉視窗前，待存的資料能立刻寫入。
   * - beforeunload：桌機關閉視窗
   * - pagehide：行動裝置切換 App / Safari BFCache 退場
   * - visibilitychange hidden：切換分頁（beforeunload 此時不觸發）
   */
  /**
   * 把待存的變更立刻送出。
   *
   * 本機模式下這相當於「保證寫入」，但雲端模式只是 best-effort：
   * beforeunload 之後瀏覽器不保證 fetch 能跑完，最多會掉一個 debounce 週期的
   * 變更。visibilitychange 那條路徑比較可靠，因為切分頁時頁面通常還活著。
   */
  function flushPendingSave(): void {
    if (_saveTimer) void persistNow()
  }

  function bindLifecycle(): void {
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

  /**
   * 載入並套用文件。
   *
   * backend 與 generation 都由呼叫端傳進來，函式內不讀 _backend——非同步流程
   * 中途去讀「全域目前值」，等於允許自己在別人的專案上做事。
   *
   * generation 檢查放在 await 之後、任何 side effect 之前。這是這個 token 的
   * 用途：它保護的是 async operation 的 **commit point**，不是 await 後面的
   * 最後幾行。晚一步檢查的話，過期的 load 仍然會把內容套進共用的 store。
   */
  async function loadPersistedDocument(
    backend: DocumentBackend,
    generation: number,
  ): Promise<boolean> {
    if (!backend.available) {
      saveState.value = 'idle'
      return false
    }

    saveState.value = 'loading'
    try {
      const snapshot = await backend.load()
      if (generation !== _generation) return false

      // 載入成功才解鎖。放在 try 之前的話，載入失敗會讓自動存檔恢復，
      // 但 backend 內部的衝突旗標還在，只是換成每次存檔都再撞一次。
      _conflicted = false
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
      if (generation !== _generation) return false

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
   *
   * 回傳是否載入成功且仍是當前這一次啟動。雲端專案回傳 true 代表專案存在、
   * 使用者有權限、內容也合法，依附在專案上的功能（presence）以此為起點。
   */
  async function startPersistence(
    backend: DocumentBackend = localDocumentBackend,
  ): Promise<boolean> {
    if (_started) return false
    _started = true
    const generation = ++_generation
    _backend = backend
    backendKind.value = backend.kind
    persistenceAvailable.value = backend.available
    // 必須在 load 之前：切到雲端會清掉 store 裡的本機留言，否則載入期間畫布上
    // 顯示的是本機草稿的留言。雲端期間任何路徑（包含直接關分頁時的 lifecycle
    // flush）也都不能把雲端留言寫進這台電腦的 localStorage。
    //
    // 這裡只切換來源。雲端留言的載入由 EditorView 在文件載入成功後觸發
    // （commentStore.load），與 presence 同一個時機——專案不存在或沒有權限時，
    // 不需要再送一個註定失敗的請求。
    commentStore.setSource(backend.kind)

    const loaded = await loadPersistedDocument(backend, generation)
    // 第二道檢查。上面那道擋的是「套用內容」，這道擋的是「註冊資源」——
    // 兩件事都要擋，但擋不掉對方。
    if (generation !== _generation) return false

    _watchStop = watch(
      [() => elementStore.documentRevision, () => commentStore.documentRevision],
      () => {
        scheduleAutosave()
      },
    )
    bindLifecycle()

    // 只在本機模式做。雲端專案一定有 document，載入失敗時畫布裡留著的是
    // 上一份草稿，把它存上去就是拿別的內容覆蓋掉這個專案。
    if (
      _backend.kind === 'local' &&
      !loaded &&
      (Object.keys(elementStore.byId).length > 0 || commentStore.comments.length > 0)
    ) {
      void persistNow()
    }
    return loaded
  }

  /** 衝突後重新載入雲端版本。本機未存的變更會被丟棄，呼叫端要先確認過。 */
  async function reloadFromBackend(): Promise<boolean> {
    if (_saveTimer) {
      clearTimeout(_saveTimer)
      _saveTimer = null
    }
    // 重新載入期間同樣可能被切走，所以一起帶上目前的 backend 與 generation。
    return loadPersistedDocument(_backend, _generation)
  }

  function stopPersistence(): void {
    // 離開前把待存的變更送出去。persistNow 進去第一件事就是清掉 timer，
    // 而它在第一個 await 之前就讀完 _backend，所以下面把 _backend 換回本機
    // 不影響這一次存檔。
    const leavingCloud = _backend.kind === 'cloud'
    _generation += 1
    flushPendingSave()
    _watchStop?.()
    _watchStop = null
    _unbindLifecycle?.()
    _unbindLifecycle = null

    // 離開雲端專案時清空畫布。element / comment store 是整個 SPA 共用的，
    // 不清的話回到 `/` 時雲端內容還在 store 裡：本機沒有草稿就會被
    // startPersistence 當成初始內容存進 IndexedDB，之後登出、甚至換人使用
    // 這台電腦都還看得到。
    //
    // 必須排在 flushPendingSave 之後：persistNow 在第一個 await 之前就已經
    // 同步 buildSnapshot 完，清空不影響那次存檔；反過來就會把空文件存回雲端。
    // watcher 也已經停掉，清空觸發的 documentRevision 不會再排程 autosave。
    if (leavingCloud) {
      elementStore.loadSnapshot({ byId: {}, rootIds: [] })
      // 留言一併換回本機來源：雲端留言從 store 清掉、飛行中的留言請求全部作廢，
      // 並從 localStorage 重新讀回本機留言，讓 SPA 內回到 `/` 的狀態與重新整理後一致。
      // 這一步不寫 localStorage，本機原有的 mirror 不會被動到。
      //
      // 同樣必須排在 flushPendingSave 之後：那次存檔的快照要在來源還是雲端時建立，
      // comments 才會是空的；先切回本機的話，本機留言會被存進雲端專案的 document。
      commentStore.setSource('local')
    }
    _started = false
    _conflicted = false
    _backend = localDocumentBackend
    backendKind.value = localDocumentBackend.kind
    persistenceAvailable.value = localDocumentBackend.available
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
    isCloud,
    buildSnapshot,
    buildCloudSnapshot,
    startPersistence,
    reloadFromBackend,
    stopPersistence,
    persistNow,
    exportJson,
    importJsonString,
    importFile,
  }
})
