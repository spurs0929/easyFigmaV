import { useElementStore } from '@/store/element'
import { ElementKind, newElementId } from '@/types/element'
import type { CanvasElement } from '@/types/element'

export function useCanvasActions() {
  const elementStore = useElementStore()

  function deleteSelected(): void {
    const ids = [...elementStore.selectedIds]
    if (ids.length === 0) return
    for (const id of ids) elementStore.remove(id)
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

  function ungroupSelected(): void {
    const groups = elementStore.selectedElements.filter((el) => el.kind === ElementKind.Group)
    if (groups.length === 0) return
    elementStore.clearSelection()
    for (const group of groups) {
      for (const childId of elementStore.ungroup(group.id)) {
        elementStore.select(childId, true)
      }
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
