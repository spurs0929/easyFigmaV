import { ref, computed, nextTick } from 'vue'
import type { Ref } from 'vue'
import { useElementStore } from '@/store/element'
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

  function _exitTextEdit(id: string): void {
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

    const el = elementStore.get(elId)
    if (!el || el.kind !== ElementKind.Text) return

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
    const newText = editingTextDraft.value
    const trimmedText = newText.trim()
    if (trimmedText.length === 0 && elementStore.get(id)) {
      _exitTextEdit(id)
      elementStore.remove(id)
      return
    }
    // 只在文字實際改變且元素仍存在時才更新 store 並推 snapshot
    if (newText !== _editOldText && elementStore.get(id)) {
      elementStore.update(id, { text: newText })
      elementStore.pushSnapshot()
    }
    _exitTextEdit(id)
  }

  /**
   * Escape 取消：不寫入 store，保持 _editOldText（進入編輯前的狀態）。
   * 前提：見 _editOldText 的 ⚠️ 說明。
   * Escape → cancelTextEdit → _exitTextEdit（清空 id）→ Vue flush → 移除 textarea
   * → blur → commitTextEdit 被守衛攔截。路徑安全，不需額外 flag。
   */
  function cancelTextEdit(): void {
    const id = editingTextId.value
    if (!id) return
    _exitTextEdit(id)
  }

  function scheduleTextEdit(elId: string): void {
    // 新建文字後若只用 nextTick，常會撞上同一次 click 的後續事件，
    // 使 textarea 剛 focus 又立刻 blur。延到下一個 macrotask 再進入編輯可避開這個焦點競爭。
    if (_pendingTextEditTimer !== null) window.clearTimeout(_pendingTextEditTimer)
    _pendingTextEditTimer = window.setTimeout(() => {
      _pendingTextEditTimer = null
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
    onTextareaBlur,
    onTextareaKeydown,
    onTextareaInput,
  }
}
