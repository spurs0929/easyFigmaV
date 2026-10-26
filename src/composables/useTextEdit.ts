import { ref, computed, nextTick } from 'vue'
import type { Ref } from 'vue'
import { useElementStore, type ElementStoreCheckpoint } from '@/store/element'
import { useViewportStore } from '@/store/viewport'
import {
  type CanvasElement,
  ElementKind,
  newElementId,
  ELEMENT_DEFAULT_FONT_SIZE,
  ELEMENT_DEFAULT_FONT_FAMILY,
  ELEMENT_DEFAULT_FILL,
  ELEMENT_DEFAULT_FONT_WEIGHT,
  ELEMENT_DEFAULT_LINE_HEIGHT,
  ELEMENT_DEFAULT_LETTER_SPACING,
  ELEMENT_DEFAULT_TEXT_ALIGN,
  ELEMENT_DEFAULT_STROKE,
} from '@/types/element'
import type { Point } from '@/components/canvas/strategies/ShapeRendererStrategy'

const TEXT_ELEMENT_DEFAULT_WIDTH = 200
const TEXT_ELEMENT_DEFAULT_HEIGHT_RATIO = 1.5
const TEXT_OVERLAY_MIN_WIDTH_RATIO = 2
const TEXT_OVERLAY_MIN_HEIGHT_RATIO = 1.5

export function useTextEdit(
  commentOverlayRect: Ref<{ left: number; top: number; width: number; height: number }>,
  onBatchDraw: () => void,
  onSuppressNextClick: () => void,
  defaultElementName: (kind: ElementKind) => string,
) {
  const elementStore = useElementStore()
  const viewportStore = useViewportStore()

  const editingTextId = ref<string | null>(null)
  const textareaRef = ref<HTMLTextAreaElement | null>(null)
  /**
   * 進入編輯前的原始文字，供 cancelTextEdit 還原用。
   * ⚠️ 假設：編輯期間不會有任何中間寫入 store 的操作（onTextareaInput 只調整高度）。
   */
  let _editOldText = ''
  const editingTextDraft = ref('')
  let _pendingTextEditTimer: number | null = null
  /**
   * 新建、還沒進 History 的文字元素 id → 放進 store 之前記下的 checkpoint。
   *
   * 新建文字的「建立 + 第一次編輯」是使用者的一次操作：建立時不推 History，
   * 編輯結束時有內容才推一筆；留空離開或按 Escape 就連元素一起取消，不留下任何 History。
   */
  const _pendingCreations = new Map<string, ElementStoreCheckpoint>()
  /**
   * 這次編輯開始時的 checkpoint，用來發現編輯期間文件被整份換掉（loadSnapshot）。
   * 結束編輯不清空：只有編輯中（editingTextId 有值）才會讀它，而每次開始編輯都會重新記下。
   */
  let _editCheckpoint: ElementStoreCheckpoint | null = null

  function absoluteCoords(el: CanvasElement): CanvasElement {
    if (!el.parentId) return el
    const parent = elementStore.get(el.parentId)
    if (!parent) return el
    const absParent = absoluteCoords(parent)
    return { ...el, x: el.x + absParent.x, y: el.y + absParent.y }
  }

  function rootSelectableId(id: string): string {
    let current = elementStore.get(id)
    while (current?.parentId) {
      const parent = elementStore.get(current.parentId)
      if (!parent) break
      current = parent
    }
    return current?.id ?? id
  }

  const editingTextStyle = computed(() => {
    const id = editingTextId.value
    if (!id) return {}
    const el = elementStore.get(id)
    if (!el) return {}
    const vp = viewportStore.viewport
    const absEl = absoluteCoords(el)
    const fontPx = (el.fontSize ?? ELEMENT_DEFAULT_FONT_SIZE) * vp.scale
    const style: Record<string, string> = {
      left: `${commentOverlayRect.value.left + absEl.x * vp.scale + vp.x}px`,
      top: `${commentOverlayRect.value.top + absEl.y * vp.scale + vp.y}px`,
      minHeight: `${fontPx * TEXT_OVERLAY_MIN_HEIGHT_RATIO}px`,
      width: `${Math.max(absEl.width * vp.scale, fontPx * TEXT_OVERLAY_MIN_WIDTH_RATIO)}px`,
      fontSize: `${fontPx}px`,
      fontFamily: el.fontFamily ?? ELEMENT_DEFAULT_FONT_FAMILY,
      fontWeight: String(el.fontWeight ?? ELEMENT_DEFAULT_FONT_WEIGHT),
      lineHeight: String(el.lineHeight ?? ELEMENT_DEFAULT_LINE_HEIGHT),
      letterSpacing: `${el.letterSpacing ?? ELEMENT_DEFAULT_LETTER_SPACING}px`,
      textAlign: el.textAlign ?? ELEMENT_DEFAULT_TEXT_ALIGN,
      position: 'fixed',
      zIndex: '2000',
    }
    if (el.rotation) {
      style.transform = `rotate(${el.rotation}deg)`
      style.transformOrigin = 'top left'
    }
    return style
  })

  function _exitTextEdit(): void {
    if (_pendingTextEditTimer !== null) {
      window.clearTimeout(_pendingTextEditTimer)
      _pendingTextEditTimer = null
    }
    // editingTextId 先清空，再執行 DOM 副作用。
    // Vue ref 賦值同步，_exitTextEdit 返回後才 flush DOM 並移除 textarea。
    // 若移除 textarea 觸發 blur → commitTextEdit，此時 editingTextId 已為 null，
    // commitTextEdit 開頭守衛 `if (!id) return` 立即截斷，不重複執行。
    editingTextId.value = null
    editingTextDraft.value = ''
    _editOldText = ''
    onBatchDraw()
  }

  /**
   * 取消一個還沒進 History 的新建文字。
   *
   * 只拿掉這個元素，不把整份文件換回 checkpoint，期間若有其他還沒記錄的修改也會保留。
   * 依 checkpoint 之後 History 的變化處理：
   * - 'none'：沒有任何一筆 History 包含它，安靜拿掉；再試著換回建立前的 store 物件，
   *   讓之後的 pushSnapshot 能以參考去重（內容不同就不換，其他修改照樣保留）。
   * - 'moved'：期間有其他 History 寫入，它可能已經被一起記進去；刪除也要記成一筆，
   *   否則 Undo / Redo 會讓它回來而且無法再撤銷。被 Undo 換掉的話它已不存在，remove 不做事。
   * - 'reset'：文件已經整份換掉，不能動新文件。
   */
  function _discardCreation(id: string, cp: ElementStoreCheckpoint): void {
    const change = elementStore.historyChangeSince(cp)
    if (change === 'reset') return
    if (change === 'moved') {
      elementStore.remove(id)
      return
    }
    elementStore.removeWithoutHistory(id)
    elementStore.restoreIfUnchanged(cp)
  }

  /** 取消所有還沒開始編輯就被取代的新建文字；keepId 是接著要編輯的那一個。 */
  function _discardPendingCreations(keepId: string): void {
    for (const [id, cp] of _pendingCreations) {
      if (id === keepId) continue
      _pendingCreations.delete(id)
      _discardCreation(id, cp)
    }
  }

  function _takePendingCreation(id: string): ElementStoreCheckpoint | undefined {
    const cp = _pendingCreations.get(id)
    _pendingCreations.delete(id)
    return cp
  }

  function startTextEdit(elId: string): void {
    if (_pendingTextEditTimer !== null) {
      window.clearTimeout(_pendingTextEditTimer)
      _pendingTextEditTimer = null
    }

    if (editingTextId.value === elId) {
      nextTick(() => {
        textareaRef.value?.focus()
        textareaRef.value?.select()
      })
      return
    }

    // 若有正在進行的編輯，先 commit 避免靜默丟棄。
    // 切換到另一個 Text 時必須強制結束當前 session，不能被初始 blur 保護擋下。
    if (editingTextId.value !== null) commitTextEdit()
    _discardPendingCreations(elId)

    const el = elementStore.get(elId)
    if (!el || el.kind !== ElementKind.Text) {
      // 這次編輯沒有開始，它的新建登記也要一起清掉：之後同一個 id 若再出現（例如 Redo），
      // 它是文件裡的既有文字，不能再被當成新建來取消。
      _pendingCreations.delete(elId)
      return
    }
    _editCheckpoint = elementStore.checkpoint()

    // 對使用者來說，畫布上看到的是 renderer 的顯示值；編輯框也要以相同內容開啟，
    // 否則新建 Text 會顯示為空白、甚至在焦點抖動時像是直接消失。
    _editOldText = el.text ?? ''
    editingTextDraft.value = _editOldText
    editingTextId.value = elId
    // 新建文字與雙擊進入編輯時，瀏覽器可能還在處理同一串 click/dblclick 焦點事件；
    // 短時間內的 blur 視為雜訊，不應立刻結束編輯。
    onBatchDraw()

    nextTick(() => {
      const ta = textareaRef.value
      if (!ta) return
      ta.value = editingTextDraft.value
      _autoResizeTextarea(ta)
      window.requestAnimationFrame(() => {
        ta.focus()
        ta.select()
      })
    })
  }

  function commitTextEdit(): void {
    const id = editingTextId.value
    if (!id) return
    const creation = _takePendingCreation(id)
    // 編輯期間文件被整份換掉（重新載入）：草稿屬於舊文件，不寫進新文件。
    if (_editCheckpoint && elementStore.historyChangeSince(_editCheckpoint) === 'reset') {
      _exitTextEdit()
      return
    }
    const newText = editingTextDraft.value
    const trimmedText = newText.trim()
    if (trimmedText.length === 0 && elementStore.get(id)) {
      _exitTextEdit()
      // 新建文字留空：取消整個建立，不留 History；既有文字清空：刪除，記一筆。
      if (creation) _discardCreation(id, creation)
      else elementStore.remove(id)
      return
    }
    // 只在文字實際改變且元素仍存在時才更新 store 並推 snapshot
    if (newText !== _editOldText && elementStore.get(id)) {
      elementStore.update(id, { text: newText })
      elementStore.pushSnapshot()
    }
    _exitTextEdit()
  }

  /**
   * Escape 取消：不寫入 store，保持 _editOldText（進入編輯前的狀態）。
   * 新建文字進入編輯前還不存在，所以取消的是整個建立：元素一併拿掉，不留 History。
   * 前提：見 _editOldText 的 ⚠️ 說明。
   * Escape → cancelTextEdit → _exitTextEdit（清空 id）→ Vue flush → 移除 textarea
   * → blur → commitTextEdit 被守衛攔截。路徑安全，不需額外 flag。
   */
  function cancelTextEdit(): void {
    const id = editingTextId.value
    if (!id) return
    const creation = _takePendingCreation(id)
    _exitTextEdit()
    if (creation) _discardCreation(id, creation)
  }

  function scheduleTextEdit(elId: string): void {
    // 新建文字後若只用 nextTick，常會撞上同一次 click 的後續事件，
    // 使 textarea 剛 focus 又立刻 blur。延到下一個 macrotask 再進入編輯可避開這個焦點競爭。
    if (_pendingTextEditTimer !== null) window.clearTimeout(_pendingTextEditTimer)
    const cp = elementStore.checkpoint()
    _pendingTextEditTimer = window.setTimeout(() => {
      _pendingTextEditTimer = null
      // 排程之後文件被整份換掉：這個 id 屬於舊文件，不能在新文件上開始編輯。
      // 新建登記也屬於舊文件，一併清掉；新文件裡同一個 id 的元素是既有文字。
      if (elementStore.historyChangeSince(cp) === 'reset') {
        _pendingCreations.delete(elId)
        return
      }
      startTextEdit(elId)
    }, 0)
  }

  function beginTextEdit(elId: string): void {
    const selectId = rootSelectableId(elId)
    elementStore.clearSelection()
    elementStore.select(selectId)
    onSuppressNextClick()
    scheduleTextEdit(elId)
  }

  /**
   * 放入新建的文字元素，但先不記 History（見 _pendingCreations）。
   * 之後要接著 beginTextEdit / scheduleTextEdit 進入編輯，由編輯結束決定記一筆或整個取消。
   */
  function insertNewText(el: CanvasElement): void {
    const cp = elementStore.checkpoint()
    elementStore.insertWithoutHistory(el)
    _pendingCreations.set(el.id, cp)
  }

  function createTextElementAt(world: Point): CanvasElement {
    return {
      id: newElementId(),
      name: defaultElementName(ElementKind.Text),
      kind: ElementKind.Text,
      x: world.x,
      y: world.y,
      width: TEXT_ELEMENT_DEFAULT_WIDTH,
      height: ELEMENT_DEFAULT_FONT_SIZE * TEXT_ELEMENT_DEFAULT_HEIGHT_RATIO,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      visible: true,
      locked: false,
      childIds: [],
      parentId: undefined,
      text: '',
      fontSize: ELEMENT_DEFAULT_FONT_SIZE,
      fontFamily: ELEMENT_DEFAULT_FONT_FAMILY,
      fontWeight: ELEMENT_DEFAULT_FONT_WEIGHT,
      lineHeight: ELEMENT_DEFAULT_LINE_HEIGHT,
      letterSpacing: ELEMENT_DEFAULT_LETTER_SPACING,
      textAlign: ELEMENT_DEFAULT_TEXT_ALIGN,
      fill: ELEMENT_DEFAULT_FILL,
      stroke: ELEMENT_DEFAULT_STROKE,
      strokeWidth: 0,
    }
  }

  function onTextareaBlur(): void {
    commitTextEdit()
  }

  function onTextareaKeydown(e: KeyboardEvent): void {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelTextEdit()
    }
  }

  function onTextareaInput(e: Event): void {
    const ta = e.target as HTMLTextAreaElement
    editingTextDraft.value = ta.value
    _autoResizeTextarea(ta)
  }

  function _autoResizeTextarea(ta: HTMLTextAreaElement): void {
    // 先歸零再讀 scrollHeight，確保縮小也能反映（部分瀏覽器在非零高度時 scrollHeight 不縮小）
    ta.style.height = '0'
    ta.style.height = `${ta.scrollHeight}px`
  }

  return {
    editingTextId,
    textareaRef,
    editingTextDraft,
    editingTextStyle,
    commitTextEdit,
    cancelTextEdit,
    startTextEdit,
    scheduleTextEdit,
    beginTextEdit,
    createTextElementAt,
    insertNewText,
    onTextareaBlur,
    onTextareaKeydown,
    onTextareaInput,
  }
}
