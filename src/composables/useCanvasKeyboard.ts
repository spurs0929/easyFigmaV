import { useElementStore } from '@/store/element'
import { isTypingTarget, getDeepActiveElement } from '@/constants/canvas'
import type { GestureState } from '@/types/canvas'
import type { Point } from '@/components/canvas/strategies/ShapeRendererStrategy'

export interface CanvasKeyboardOptions {
  /** 讀取當前 gesture 物件（非響應式，直接回傳可變參考）。 */
  getGesture: () => GestureState
  cancelPenGesture: () => void
  cancelPencilGesture: () => void
  finishPenGesture: (close: boolean) => void
  refreshPenGesture: (g: Extract<GestureState, { kind: 'pen' }>) => void
  pointerWorld: () => Point
  deleteSelected: () => void
  duplicateSelected: () => void
  groupSelected: () => void
  ungroupSelected: () => void
  /** Alt 放開後需要重繪 measurement overlay，由 CanvasArea.vue 提供。 */
  onAltRelease: () => void
}

export function useCanvasKeyboard(opts: CanvasKeyboardOptions) {
  const elementStore = useElementStore()

  let _altHeld = false

  function isAltHeld(): boolean {
    return _altHeld
  }

  /**
   * 手勢進行中不可 Undo / Redo。
   *
   * 拖曳、縮放進行到一半時，store 已經被改動但還沒推快照；繪製、Pen、Pencil 的草稿
   * 則還在 store 之外。這時把 store 換回上一筆，手勢卻會繼續，結束時再推的那一筆
   * 快照會截斷 redo——被 undo 掉的那一步就永遠拿不回來。
   *
   * 所以只要不是 idle 就整個忽略，包含 Pen：Pen 繪製中的 Ctrl+Z 不做「退回上一個
   * 錨點」，要刪錨點用 Backspace / Delete。
   *
   * 呼叫端仍然要先 preventDefault：被忽略時也不能讓瀏覽器執行它自己的復原 / 重做。
   */
  function canUseHistory(): boolean {
    return opts.getGesture().kind === 'idle'
  }

  function keyCombo(e: KeyboardEvent): string {
    const parts: string[] = []
    if (e.ctrlKey || e.metaKey) parts.push('ctrl')
    if (e.shiftKey) parts.push('shift')
    parts.push(e.key.toLowerCase())
    return parts.join('+')
  }

  const _keyCommands = new Map<string, (e: KeyboardEvent) => void>([
    [
      'delete',
      (e) => {
        e.preventDefault()
        opts.deleteSelected()
      },
    ],
    [
      'backspace',
      (e) => {
        e.preventDefault()
        opts.deleteSelected()
      },
    ],
    [
      'ctrl+z',
      (e) => {
        e.preventDefault()
        if (!canUseHistory()) return
        elementStore.undo()
      },
    ],
    [
      'ctrl+y',
      (e) => {
        e.preventDefault()
        if (!canUseHistory()) return
        elementStore.redo()
      },
    ],
    [
      'ctrl+shift+z',
      (e) => {
        e.preventDefault()
        if (!canUseHistory()) return
        elementStore.redo()
      },
    ],
    [
      'ctrl+d',
      (e) => {
        e.preventDefault()
        opts.duplicateSelected()
      },
    ],
    [
      'ctrl+g',
      (e) => {
        e.preventDefault()
        opts.groupSelected()
      },
    ],
    [
      'ctrl+shift+g',
      (e) => {
        e.preventDefault()
        opts.ungroupSelected()
      },
    ],
    [
      'ctrl+a',
      (e) => {
        e.preventDefault()
        elementStore.selectAll()
      },
    ],
    [
      ']',
      (e) => {
        e.preventDefault()
        ;[...elementStore.selectedIds].forEach((id) => elementStore.bringToFront(id))
        elementStore.pushSnapshot()
      },
    ],
    [
      '[',
      (e) => {
        e.preventDefault()
        ;[...elementStore.selectedIds].forEach((id) => elementStore.sendToBack(id))
        elementStore.pushSnapshot()
      },
    ],
  ])

  function onKeydown(e: KeyboardEvent): void {
    const g = opts.getGesture()

    if (g.kind === 'pen') {
      if (e.key === 'Escape') {
        e.preventDefault()
        opts.cancelPenGesture()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        opts.finishPenGesture(false)
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        if (g.points.length <= 1) {
          opts.cancelPenGesture()
        } else {
          g.points = g.points.slice(0, -1)
          g.activeIndex = g.points.length - 1
          g.pointerDown = false
          g.hoverPoint = opts.pointerWorld()
          g.closing = false
          opts.refreshPenGesture(g)
        }
        return
      }
    }

    if (g.kind === 'pencil' && e.key === 'Escape') {
      e.preventDefault()
      opts.cancelPencilGesture()
      return
    }

    if (e.key === 'Alt') {
      e.preventDefault()
      _altHeld = true
      return
    }
    if (isTypingTarget(getDeepActiveElement())) return
    _keyCommands.get(keyCombo(e))?.(e)
  }

  function onKeyup(e: KeyboardEvent): void {
    if (e.key !== 'Alt') return
    _altHeld = false
    opts.onAltRelease()
  }

  return { onKeydown, onKeyup, isAltHeld }
}
