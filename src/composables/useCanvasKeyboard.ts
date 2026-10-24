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
   * 手勢進行中不可執行任何會改文件的快捷鍵（Undo / Redo、刪除、複製、群組、圖層順序）。
   *
   * 拖曳、縮放進行到一半時，store 已經被改動但還沒推快照；繪製、Pen、Pencil 的草稿
   * 則還在 store 之外。這時再改文件，手勢卻會繼續：
   * - Undo / Redo：store 被換回上一筆，結束時再推的那一筆快照會截斷 redo，被 undo
   *   掉的那一步就永遠拿不回來。
   * - Ctrl+G：子元素改用相對於群組的座標，拖曳卻繼續寫入拖曳開始時的絕對座標加位移，
   *   元素跳到錯誤的位置，而且會被自動存檔存下來。
   * - Ctrl+D：複本以拖到一半的位置建立並推一筆快照，放開時再推一筆，Undo 一次會停在
   *   使用者從沒做出來的中間狀態。
   *
   * 所以只要不是 idle 就整個忽略，包含 Pen：Pen 繪製中的 Ctrl+Z 不做「退回上一個
   * 錨點」，要刪錨點用 Backspace / Delete（那兩個鍵在 Pen 中由 onKeydown 先處理）。
   *
   * 被忽略時仍然要 preventDefault：不能讓瀏覽器執行它自己的復原、加入書籤、尋找下一個。
   */
  function canModifyDocument(): boolean {
    return opts.getGesture().kind === 'idle'
  }

  function keyCombo(e: KeyboardEvent): string {
    const parts: string[] = []
    if (e.ctrlKey || e.metaKey) parts.push('ctrl')
    if (e.shiftKey) parts.push('shift')
    parts.push(e.key.toLowerCase())
    return parts.join('+')
  }

  interface KeyCommand {
    /** true：會改文件，手勢進行中忽略（見 canModifyDocument）。新增快捷鍵時必須表態。 */
    modifiesDocument: boolean
    run: () => void
  }

  // 每一個快捷鍵都會 preventDefault（由 onKeydown 統一處理），包含被忽略的時候。
  const _keyCommands = new Map<string, KeyCommand>([
    ['delete', { modifiesDocument: true, run: () => opts.deleteSelected() }],
    ['backspace', { modifiesDocument: true, run: () => opts.deleteSelected() }],
    ['ctrl+z', { modifiesDocument: true, run: () => elementStore.undo() }],
    ['ctrl+y', { modifiesDocument: true, run: () => elementStore.redo() }],
    ['ctrl+shift+z', { modifiesDocument: true, run: () => elementStore.redo() }],
    ['ctrl+d', { modifiesDocument: true, run: () => opts.duplicateSelected() }],
    ['ctrl+g', { modifiesDocument: true, run: () => opts.groupSelected() }],
    ['ctrl+shift+g', { modifiesDocument: true, run: () => opts.ungroupSelected() }],
    // 只改選取，不改文件：手勢中照常可用。
    ['ctrl+a', { modifiesDocument: false, run: () => elementStore.selectAll() }],
    [
      ']',
      {
        modifiesDocument: true,
        run: () => {
          ;[...elementStore.selectedIds].forEach((id) => elementStore.bringToFront(id))
          elementStore.pushSnapshot()
        },
      },
    ],
    [
      '[',
      {
        modifiesDocument: true,
        run: () => {
          ;[...elementStore.selectedIds].forEach((id) => elementStore.sendToBack(id))
          elementStore.pushSnapshot()
        },
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
    const command = _keyCommands.get(keyCombo(e))
    if (!command) return
    e.preventDefault()
    if (command.modifiesDocument && !canModifyDocument()) return
    command.run()
  }

  function onKeyup(e: KeyboardEvent): void {
    if (e.key !== 'Alt') return
    _altHeld = false
    opts.onAltRelease()
  }

  return { onKeydown, onKeyup, isAltHeld }
}
