import { useElementStore } from '@/store/element'
import { ElementKind, newElementId } from '@/types/element'
import type { CanvasElement } from '@/types/element'

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

  function duplicateSelected(): void {
    const selected = elementStore.selectedElements
    if (selected.length === 0) return

    const allCopies: CanvasElement[] = []
    const rootCopyIds: string[] = []

    for (const el of selected) {
      if (el.kind === ElementKind.Group) {
        const newGroupId = newElementId()
        const childIdRemap = new Map(el.childIds.map((cid) => [cid, newElementId()]))

        allCopies.push({
          ...el,
          id: newGroupId,
          name: `${el.name} copy`,
          x: el.x + 10,
          y: el.y + 10,
          childIds: el.childIds.map((cid) => childIdRemap.get(cid)!),
        })
        rootCopyIds.push(newGroupId)

        for (const childId of el.childIds) {
          const child = elementStore.get(childId)
          if (child) {
            allCopies.push({ ...child, id: childIdRemap.get(childId)!, parentId: newGroupId })
          }
        }
      } else {
        const copy = {
          ...el,
          id: newElementId(),
          name: `${el.name} copy`,
          x: el.x + 10,
          y: el.y + 10,
        }
        allCopies.push(copy)
        rootCopyIds.push(copy.id)
      }
    }

    elementStore.addAll(allCopies)
    elementStore.clearSelection()
    for (const id of rootCopyIds) elementStore.select(id, true)
  }

  return { deleteSelected, groupSelected, ungroupSelected, duplicateSelected }
}
