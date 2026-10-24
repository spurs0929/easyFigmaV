import { useElementStore } from '@/store/element'
import { duplicateElements } from '@/types/duplicate'
import { ElementKind } from '@/types/element'

/** Ctrl+D 的複本相對原件的位移（世界座標）。 */
const DUPLICATE_OFFSET = { x: 10, y: 10 } as const

export function useCanvasActions() {
  const elementStore = useElementStore()

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
   * 複製本身交給 duplicateElements（與之後的 Copy / Paste 共用）：
   * - 群組遞迴複製整棵子樹、全部換新 id，複本與原件不共用任何子元素；
   * - 群組內的子元素被單獨選取（圖層面板）時，複本以絕對座標放到根層級，不會變成孤兒；
   * - 祖先與子孫同時選取只複製祖先一次；複本依原件的圖層順序放到最上層。
   *
   * 頂層複本位移 (10, 10)、名稱加上「 copy」，完成後只選取這些頂層複本。
   */
  function duplicateSelected(): void {
    const { elements, rootIds } = duplicateElements(
      { byId: elementStore.byId, rootIds: elementStore.rootElements.map((el) => el.id) },
      [...elementStore.selectedIds],
      { offset: DUPLICATE_OFFSET, rename: (name) => `${name} copy` },
    )
    if (elements.length === 0) return

    elementStore.addAll(elements)
    elementStore.clearSelection()
    for (const id of rootIds) elementStore.select(id, true)
  }

  return { deleteSelected, groupSelected, ungroupSelected, duplicateSelected }
}
