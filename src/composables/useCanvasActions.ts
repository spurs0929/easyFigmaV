import { useClipboardStore, type ClipboardOrigin } from '@/store/clipboard'
import { useElementStore } from '@/store/element'
import { duplicateElements, type DuplicateResult } from '@/types/duplicate'
import { ElementKind, type ElementStore } from '@/types/element'

/** Ctrl+D 的複本相對原件的位移（世界座標）；貼上時每貼一次再錯開同樣的距離。 */
const DUPLICATE_OFFSET = { x: 10, y: 10 } as const

/** 複本與貼上的名稱：原名加「 copy」。 */
function copyName(name: string): string {
  return `${name} copy`
}

export function useCanvasActions() {
  const elementStore = useElementStore()
  const clipboardStore = useClipboardStore()

  /** 目前的文件，交給複製核心讀取（不會被修改）。 */
  function currentDocument(): ElementStore {
    return { byId: elementStore.byId, rootIds: elementStore.rootElements.map((el) => el.id) }
  }

  /**
   * 刪除目前選取的所有元素，整批是一筆 undo。
   *
   * 鍵盤的 Delete / Backspace、畫布與圖層面板的右鍵選單都走這裡。
   * 不能逐一呼叫 remove()：那樣每個元素各佔一筆 undo，還原一次多選刪除要按 N 次，
   * 中間每一步都是只刪了一部分的狀態。
   */
  function deleteSelected(): void {
    const ids = [...elementStore.selectedIds]
    if (ids.length === 0) return
    elementStore.removeMany(ids)
  }

  function rootLevelSelectedIds(): string[] {
    return [...elementStore.selectedIds].filter((id) => {
      const el = elementStore.get(id)
      return el && !el.parentId
    })
  }

  function groupSelected(): void {
    const ids = rootLevelSelectedIds()
    if (ids.length < 2) return
    const groupId = elementStore.group(ids)
    if (!groupId) return
    elementStore.clearSelection()
    elementStore.select(groupId)
  }

  /**
   * 解散目前選取的所有群組，整批是一筆 undo。
   *
   * 鍵盤的 Ctrl/Cmd+Shift+G、畫布與圖層面板的右鍵選單都走這裡。
   * 不能逐一呼叫 ungroup()：那樣每個群組各佔一筆 undo，還原一次多選解散要按 N 次，
   * 中間每一步都是只解散了一部分的狀態。
   *
   * 選取裡的非群組元素不受影響，但會被取消選取；解散後選取的是所有被還原的子元素。
   */
  function ungroupSelected(): void {
    const groups = elementStore.selectedElements.filter((el) => el.kind === ElementKind.Group)
    if (groups.length === 0) return
    elementStore.clearSelection()
    for (const childId of elementStore.ungroupMany(groups.map((group) => group.id))) {
      elementStore.select(childId, true)
    }
  }

  /**
   * 複製目前選取的元素（Ctrl/Cmd+D、右鍵選單 Duplicate），整批是一筆 undo。
   *
   * 複製本身交給 duplicateElements（與 Copy / Paste 共用）：
   * - 群組遞迴複製整棵子樹、全部換新 id，複本與原件不共用任何子元素；
   * - 群組內的子元素若被傳入（目前的 UI 只能選取根元素），複本以絕對座標放到根層級；
   * - 祖先與子孫同時選取只複製祖先一次；複本依原件的圖層順序放到最上層。
   *
   * 頂層複本位移 (10, 10)、名稱加上「 copy」，完成後只選取這些頂層複本。
   */
  function duplicateSelected(): void {
    insertCopies(
      duplicateElements(currentDocument(), [...elementStore.selectedIds], {
        offset: DUPLICATE_OFFSET,
        rename: copyName,
      }),
    )
  }

  /**
   * 把目前選取的元素放進 Clipboard（Ctrl/Cmd+C）。不改文件，不產生 history。
   *
   * 內容由複製核心整理成一棵自成一體的樹（見 ClipboardPayload）：之後原件被修改、刪除、
   * 或切換到別的專案，都不影響貼上的結果。沒有任何可複製的元素時保留 Clipboard 原本的內容。
   */
  function copySelected(): void {
    writeSelectionToClipboard('copy')
  }

  /**
   * 剪下目前選取的元素（Ctrl/Cmd+X）：先把完整內容寫進 Clipboard，成功後才刪除原件。
   *
   * 刪除用 removeMany，整批是一筆 undo；Undo 剪下會完整恢復原件，Clipboard 不變。
   * 剪下的內容貼上時保留原名（見 pasteClipboard）。沒有任何可剪下的元素時，
   * 不改 Clipboard、文件與 history。
   */
  function cutSelected(): void {
    const ids = [...elementStore.selectedIds]
    if (!writeSelectionToClipboard('cut')) return
    elementStore.removeMany(ids)
  }

  /**
   * 用複製核心把目前的選取整理成一棵自成一體的樹寫進 Clipboard（見 ClipboardPayload）。
   * 沒有任何可複製的元素時不寫入、保留原本的內容，回傳 false。
   */
  function writeSelectionToClipboard(origin: ClipboardOrigin): boolean {
    const { elements, rootIds } = duplicateElements(
      currentDocument(),
      [...elementStore.selectedIds],
      { offset: { x: 0, y: 0 }, rename: (name) => name },
    )
    if (elements.length === 0) return false
    clipboardStore.write(
      { byId: Object.fromEntries(elements.map((el) => [el.id, el])), rootIds },
      origin,
    )
    return true
  }

  /**
   * 貼上 Clipboard 的內容（Ctrl/Cmd+V），整批是一筆 undo。
   *
   * 每次貼上都重新產生全新的 id，所以同一份內容可以重複貼上，而且與原件、與之前貼上的
   * 都不共用任何元素。複製來的內容頂層名稱加上「 copy」（與 Ctrl+D 一致），剪下來的
   * 內容保留原名；位置是複製或剪下時的絕對座標，第 n 次貼上往右下錯開 n × (10, 10)。
   * 完成後只選取貼上的頂層元素。
   *
   * 真的加進文件之後才記下貼上次數。Clipboard 是空的時候什麼都不做。
   * Undo / Redo 不會改變 Clipboard。
   */
  function pasteClipboard(): void {
    const payload = clipboardStore.read()
    if (!payload) return
    const n = clipboardStore.nextPasteNumber()
    const inserted = insertCopies(
      duplicateElements(payload.elements, payload.elements.rootIds, {
        offset: { x: DUPLICATE_OFFSET.x * n, y: DUPLICATE_OFFSET.y * n },
        rename: payload.origin === 'cut' ? (name) => name : copyName,
      }),
    )
    if (inserted) clipboardStore.recordPaste()
  }

  /**
   * 把複製核心的結果一次加入文件（一筆 undo），並只選取頂層的新元素。
   * 結果是空的時候不動文件，回傳 false。
   */
  function insertCopies({ elements, rootIds }: DuplicateResult): boolean {
    if (elements.length === 0) return false
    elementStore.addAll(elements)
    elementStore.clearSelection()
    for (const id of rootIds) elementStore.select(id, true)
    return true
  }

  return {
    deleteSelected,
    groupSelected,
    ungroupSelected,
    duplicateSelected,
    copySelected,
    cutSelected,
    pasteClipboard,
  }
}
