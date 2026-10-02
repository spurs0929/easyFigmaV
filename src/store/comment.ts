import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ApiError } from '@/services/api'
import {
  createComment,
  deleteComment,
  listComments,
  updateComment,
  type CommentDto,
} from '@/services/comments'
import { describeError } from '@/services/errorMessage'
import {
  COMMENT_MAX_LENGTH,
  isCanvasComment,
  newCommentId,
  type CanvasComment,
  type CommentDraft,
  type CommentView,
} from '@/types/comment'
import { cloneCommentSnapshots } from '@/types/document'

/**
 * 留言的權威來源。
 *
 *   local：本機草稿（`/`）。留言跟著 DocumentSnapshot 存進 IndexedDB，
 *          另有一份 localStorage mirror。
 *   cloud：雲端專案（`/p/:id`）。權威來源是後端的 comments 資料表，這個 store 只是
 *          「最近一次 GET 的結果，加上之後成功的修改」。不進快照、不寫 localStorage。
 *
 * 兩種來源共用同一組 action，元件不需要知道現在是哪一種。
 */
export type CommentSource = 'local' | 'cloud'

/** 修改或刪除時留言已經不在了：多半是作者在另一個視窗刪掉的。 */
const COMMENT_GONE = '這則留言已經被刪除'

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

/** 本機留言沒有作者，也沒有權限的概念：這台電腦上的人什麼都能改。 */
function toLocalView(comment: CanvasComment): CommentView {
  return {
    id: comment.id,
    worldX: comment.worldX,
    worldY: comment.worldY,
    text: comment.text,
    resolved: comment.resolved,
    createdAt: comment.createdAt,
    author: null,
    canEdit: true,
    canDelete: true,
  }
}

function toCloudView(dto: CommentDto): CommentView {
  return {
    id: dto.id,
    worldX: dto.world_x,
    worldY: dto.world_y,
    text: dto.content,
    resolved: dto.resolved,
    createdAt: Date.parse(dto.created_at),
    author: {
      userId: dto.author.user_id,
      displayName: dto.author.display_name,
      email: dto.author.email,
    },
    canEdit: dto.can_edit,
    canDelete: dto.can_delete,
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
  const _comments = ref<CommentView[]>(loadFromStorage().map(toLocalView))
  const _documentRevision = ref(0)

  /**
   * 目前的來源。store 不知道切換的理由；由 documentStore 依持久化目標決定。
   * 刻意放在 store 內而非模組層級：重新建立的 store（HMR、新的 Pinia）一律從 local 開始。
   */
  const source = ref<CommentSource>('local')

  /**
   * 是否把評論鏡像到 localStorage。只是一個開關，store 不知道開關的理由；
   * 由 documentStore 依持久化目標決定（雲端專案期間關閉）。
   * 刻意放在 store 內而非模組層級：重新建立的 store（HMR、新的 Pinia）一律從開啟開始。
   */
  let _storageMirrorEnabled = true

  /** 雲端來源目前對應的專案。load() 設定，離開雲端時清掉。 */
  let _projectId: string | null = null

  /**
   * 每次來源切換就遞增。所有請求在送出時記下當時的值，回來後、寫入 state 之前比對——
   * 不符就整個丟棄。
   *
   * 不用專案 id 比對：A → B → A 會回到同一個 id，而第一次進 A 時送出的請求
   * 這時才回來的話，id 相同也已經是過期的結果。
   */
  let _generation = 0
  /** 只給 load 用：連按兩次重試時，只有最後一次的結果算數。 */
  let _loadSequence = 0

  // ── 互動狀態 ───────────────────────────────────────────────────────────────
  //
  // 「目前開著哪一則」放在 store，不放在每個 pin 裡：同一時間只能有一個留言框，
  // 這件事需要一個所有 pin 都看得到的地方來決定。

  /** 還沒送出的留言。null 代表沒有正在新增。 */
  const draft = ref<CommentDraft | null>(null)
  /** 目前開啟的既有留言。與 draft 互斥。 */
  const activeId = ref<string | null>(null)
  /**
   * 留言框裡有沒有尚未送出的文字。文字本身留在元件裡，這裡只需要知道「有沒有」——
   * 用來擋掉會讓文字無聲消失的操作（點畫布、點另一個 pin）。
   */
  const dirty = ref(false)
  /** 每次有操作因為 dirty 被擋下就遞增，留言框看著它來提醒使用者。 */
  const nudge = ref(0)

  /** 是否已至少載入過一次。本機來源一律為 true。 */
  const loaded = ref(true)
  /** 載入失敗的訊息。與 error 分開，因為它需要一個「重試」的入口。 */
  const loadError = ref<string | null>(null)
  /** 最近一次新增 / 修改 / 刪除失敗的訊息。 */
  const error = ref<string | null>(null)
  // 用計數而非布林：兩個請求並行時，先完成的那個不會提前解除 pending。
  const pendingCount = ref(0)

  /**
   * 對外公開的唯讀評論列表。
   * .slice() 建立淺拷貝，防止外部直接操作內部陣列，同時保持 Vue 響應追蹤。
   */
  const comments = computed<readonly CommentView[]>(() => _comments.value.slice())
  const documentRevision = computed(() => _documentRevision.value)
  const pending = computed(() => pendingCount.value > 0)
  const isCloud = computed(() => source.value === 'cloud')
  const activeComment = computed<CommentView | null>(
    () => _comments.value.find((c) => c.id === activeId.value) ?? null,
  )
  /** 畫面上是否有留言框（新增中或檢視既有留言）。 */
  const hasOpenPopover = computed(() => draft.value !== null || activeId.value !== null)

  // ── 本機持久化 ─────────────────────────────────────────────────────────────

  /**
   * 立即將當前評論陣列寫入 localStorage。
   * 這是唯一的寫入閘門：本機修改、頁面 lifecycle、CanvasArea unmount 都經過這裡。
   * 雲端來源一律不寫：雲端留言不能留在這台電腦上。
   */
  function flush(): void {
    if (source.value !== 'local' || !_storageMirrorEnabled) return
    writeToStorage(cloneCommentSnapshots(_comments.value))
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
    if (enabled) _comments.value = loadFromStorage().map(toLocalView)
  }

  /**
   * 本機留言變動之後：寫入 mirror，並通知 documentStore 排程存檔。
   *
   * 只有本機來源會呼叫。雲端留言的變動刻意不遞增 documentRevision——
   * 留言不屬於 document，不該觸發整份文件的 autosave。
   */
  function commitLocalChange(): void {
    flush()
    _documentRevision.value++
  }

  bindLifecycle(flush)

  // ── 來源切換 ───────────────────────────────────────────────────────────────

  function resetInteraction(): void {
    draft.value = null
    activeId.value = null
    dirty.value = false
    error.value = null
  }

  /**
   * 切換留言的來源。由 documentStore 在開始 / 結束持久化時呼叫。
   *
   * 切換一律清掉前一個來源留下的所有東西，並讓飛行中的請求失效：
   *   → cloud：清空列表，等 load()。本機留言還在 localStorage 裡，沒有被動到。
   *   → local：從 localStorage 重新讀回本機留言。不寫回、也不遞增 documentRevision——
   *            這是還原，不是一次編輯。
   *
   * local → local 是 no-op：本機草稿載入後 store 裡的內容來自 IndexedDB，
   * 再從 mirror 讀一次反而可能蓋掉它。
   */
  function setSource(next: CommentSource): void {
    if (next === 'local' && source.value === 'local') return

    _generation += 1
    _projectId = null
    source.value = next
    resetInteraction()
    loadError.value = null
    pendingCount.value = 0

    if (next === 'local') {
      _comments.value = loadFromStorage().map(toLocalView)
      loaded.value = true
    } else {
      _comments.value = []
      loaded.value = false
    }
  }

  // ── 雲端載入 ───────────────────────────────────────────────────────────────

  function upsert(comment: CommentView): void {
    const index = _comments.value.findIndex((c) => c.id === comment.id)
    // 以 id 取代而不是一律 push：重新載入與新增並行時，新留言可能已經跟著列表回來了。
    if (index === -1) _comments.value.push(comment)
    else _comments.value[index] = comment
  }

  /**
   * 載入雲端專案的留言。來源必須已經是 cloud（documentStore 在載入文件前就切好了）。
   *
   * @returns 載入成功且結果仍然有效時為 true。
   */
  async function load(projectId: string): Promise<boolean> {
    if (source.value !== 'cloud') return false

    _projectId = projectId
    const generation = _generation
    const sequence = ++_loadSequence
    loadError.value = null

    try {
      const rows = await listComments(projectId)
      // 等待期間離開了專案（或又按了一次重試），這份結果已經不屬於現在的畫面。
      if (generation !== _generation || sequence !== _loadSequence) return false

      _comments.value = rows.map(toCloudView)
      loaded.value = true
      // 開著的那一則可能已經被別人刪掉
      if (activeId.value && !activeComment.value) {
        activeId.value = null
        dirty.value = false
      }
      return true
    } catch (caught) {
      if (generation !== _generation || sequence !== _loadSequence) return false

      loadError.value = describeError(caught)
      // 載入失敗也算載入過，否則畫面會永遠停在「載入中」。
      loaded.value = true
      return false
    }
  }

  /** 重新載入目前專案的留言（載入失敗後的重試、留言被別人刪掉之後的同步）。 */
  function reload(): Promise<boolean> {
    return _projectId ? load(_projectId) : Promise.resolve(false)
  }

  /**
   * 送出一個雲端修改，成功後才更新 state。
   *
   * 不做樂觀更新：先送請求、成功才改列表，與 members store 一致。失敗時畫面上的
   * 內容沒有動過，不需要還原。
   *
   * generation 的檢查放在 await 之後、任何寫入之前——包含失敗的那條路徑：
   * 已經離開的專案回報的錯誤，不該出現在現在這個專案的畫面上。
   */
  async function mutate<T>(
    request: () => Promise<T>,
    commit: (value: T) => void,
    /** 404 時顯示的訊息。後端只會說「找不到留言」，對使用者來說少了「為什麼」。 */
    goneMessage?: string,
  ): Promise<boolean> {
    const generation = _generation
    pendingCount.value += 1
    error.value = null

    try {
      const value = await request()
      if (generation !== _generation) return false
      commit(value)
      return true
    } catch (caught) {
      if (generation !== _generation) return false

      const gone = caught instanceof ApiError && caught.status === 404
      error.value = gone && goneMessage ? goneMessage : describeError(caught)
      // 404：這則留言（或整個專案的存取權）已經不在了。畫面上的列表是舊的，
      // 重新載入讓它跟後端一致，而不是留著一個每按一次就失敗一次的 pin。
      // 若是整個專案都進不去了，重新載入會失敗，loadError 會說明真正的原因。
      if (gone) void reload()
      return false
    } finally {
      // setSource 已經把計數歸零的話，這裡不能再減一次。
      if (generation === _generation) pendingCount.value -= 1
    }
  }

  // ── 留言框的開關 ───────────────────────────────────────────────────────────

  /** 無條件關掉留言框。只給「使用者明確取消」與成功送出之後使用。 */
  function close(): void {
    resetInteraction()
  }

  /**
   * 請求關掉留言框（點畫布、點留言框外面）。
   *
   * 有尚未送出的文字、或請求還在途中時不關：文字不能無聲消失，使用者必須明確
   * 按取消或送出。被擋下時遞增 nudge，讓留言框提醒使用者。
   *
   * @returns 留言框是否已經關閉（本來就沒開也算）。
   */
  function requestClose(): boolean {
    if (!hasOpenPopover.value) return true
    if (pending.value) return false
    if (dirty.value) {
      nudge.value += 1
      return false
    }
    close()
    return true
  }

  /**
   * 在世界座標開始一則新留言。只建立草稿，不建立留言——送出成功之前畫布上
   * 不會多出任何正式的 pin。
   *
   * 已經有留言框開著時不做任何事：那一次點擊的意思是「關掉它」，不是「再放一個」。
   *
   * @returns 是否真的開始了新的草稿。
   */
  function startDraft(worldX: number, worldY: number): boolean {
    if (hasOpenPopover.value) return false
    error.value = null
    draft.value = { worldX, worldY }
    return true
  }

  /** 開啟一則既有留言。先前開著的留言框有未送出的文字時不切換。 */
  function open(id: string): boolean {
    if (activeId.value === id) return true
    if (!_comments.value.some((c) => c.id === id)) return false
    if (!requestClose()) return false
    activeId.value = id
    return true
  }

  function setDirty(value: boolean): void {
    dirty.value = value
  }

  function clearError(): void {
    error.value = null
  }

  // ── 新增 / 修改 / 刪除 ─────────────────────────────────────────────────────

  /** 與後端相同的規則：去掉前後空白之後 1 到 COMMENT_MAX_LENGTH 個字元。 */
  function normalize(text: string): string | null {
    const content = text.trim()
    if (!content || content.length > COMMENT_MAX_LENGTH) return null
    return content
  }

  /**
   * 在世界座標新增一則評論，立即持久化並返回新建物件。
   * @param worldX 世界座標 X（未經 viewport 縮放）
   * @param worldY 世界座標 Y（未經 viewport 縮放）
   */
  function add(worldX: number, worldY: number): CommentView {
    const comment = toLocalView({
      id: newCommentId(),
      worldX,
      worldY,
      text: '',
      resolved: false,
      createdAt: Date.now(),
    })
    _comments.value.push(comment)
    commitLocalChange()
    return comment
  }

  /**
   * 送出草稿。成功後草稿消失、留言出現在列表裡；失敗時草稿原樣保留，
   * 輸入框的文字也還在，錯誤訊息在 error。
   */
  async function submitDraft(text: string): Promise<boolean> {
    const position = draft.value
    const content = normalize(text)
    if (!position || !content || pending.value) return false

    if (source.value === 'local') {
      _comments.value.push(
        toLocalView({
          id: newCommentId(),
          worldX: position.worldX,
          worldY: position.worldY,
          text: content,
          resolved: false,
          createdAt: Date.now(),
        }),
      )
      close()
      commitLocalChange()
      return true
    }

    const projectId = _projectId
    if (!projectId) return false
    return mutate(
      () =>
        createComment(projectId, {
          world_x: position.worldX,
          world_y: position.worldY,
          content,
        }),
      (dto) => {
        upsert(toCloudView(dto))
        close()
      },
    )
  }

  /** 修改留言內容。成功後 dirty 歸零，留言框留著（回到檢視狀態由元件決定）。 */
  async function updateText(id: string, text: string): Promise<boolean> {
    const content = normalize(text)
    const target = _comments.value.find((c) => c.id === id)
    if (!target || !content || pending.value) return false

    if (source.value === 'local') {
      target.text = content
      dirty.value = false
      commitLocalChange()
      return true
    }

    const projectId = _projectId
    if (!projectId) return false
    return mutate(
      () => updateComment(projectId, id, { content }),
      (dto) => {
        upsert(toCloudView(dto))
        dirty.value = false
      },
      COMMENT_GONE,
    )
  }

  /** 切換已解決狀態。雲端專案裡任何成員都可以切換，不限作者。 */
  async function toggleResolved(id: string): Promise<boolean> {
    const target = _comments.value.find((c) => c.id === id)
    if (!target || pending.value) return false

    if (source.value === 'local') {
      target.resolved = !target.resolved
      commitLocalChange()
      return true
    }

    const projectId = _projectId
    if (!projectId) return false
    const resolved = !target.resolved
    return mutate(
      () => updateComment(projectId, id, { resolved }),
      (dto) => upsert(toCloudView(dto)),
      COMMENT_GONE,
    )
  }

  /** 刪除留言。開著的正是這一則時，留言框一起關掉。 */
  async function remove(id: string): Promise<boolean> {
    if (!_comments.value.some((c) => c.id === id) || pending.value) return false

    const dropLocally = (): void => {
      const index = _comments.value.findIndex((c) => c.id === id)
      if (index !== -1) _comments.value.splice(index, 1)
      if (activeId.value === id) close()
    }

    if (source.value === 'local') {
      dropLocally()
      commitLocalChange()
      return true
    }

    const projectId = _projectId
    if (!projectId) return false
    return mutate(() => deleteComment(projectId, id), dropLocally, COMMENT_GONE)
  }

  // ── 與 DocumentSnapshot 的介面（只有本機來源使用） ─────────────────────────

  /**
   * 以外部快照完整取代評論陣列（載入本機草稿 / 匯入 JSON 時使用）。
   *
   * 雲端來源時忽略：雲端專案的 document 裡即使還留著舊版寫進去的 comments，
   * 或使用者在雲端專案匯入一份帶留言的 JSON，都不能變成畫面上的留言——
   * 雲端留言只能來自後端的 comments 資料表。
   */
  function replaceAll(next: readonly CanvasComment[]): void {
    if (source.value !== 'local') return
    _comments.value = cloneCommentSnapshots(next).map(toLocalView)
    resetInteraction()
    commitLocalChange()
  }

  /**
   * 取得要放進 DocumentSnapshot 的留言（深拷貝，只含持久化欄位）。
   *
   * 雲端來源一律是空陣列：雲端留言不屬於 document。把它們放進快照，等於又讓
   * 留言跟著整份文件存檔、共用同一個 document_version。
   */
  function snapshot(): CanvasComment[] {
    if (source.value !== 'local') return []
    return cloneCommentSnapshots(_comments.value)
  }

  return {
    comments,
    documentRevision,
    source,
    isCloud,
    draft,
    activeId,
    activeComment,
    hasOpenPopover,
    dirty,
    nudge,
    loaded,
    loadError,
    error,
    pending,
    setSource,
    setStorageMirror,
    load,
    reload,
    add,
    startDraft,
    open,
    close,
    requestClose,
    setDirty,
    clearError,
    submitDraft,
    updateText,
    toggleResolved,
    remove,
    replaceAll,
    snapshot,
    flush,
  }
})
