import { ref } from 'vue'
import type Konva from 'konva'
import { useElementStore } from '@/store/element'
import { ElementKind } from '@/types/element'
import type { ContextMenuState } from '@/types/canvas'

export function useContextMenu(getStage: () => Konva.Stage | undefined) {
  const elementStore = useElementStore()
  const contextMenu = ref<ContextMenuState | null>(null)

  function rootSelectableId(id: string): string {
    let current = elementStore.get(id)
    while (current?.parentId) {
      const parent = elementStore.get(current.parentId)
      if (!parent) break
      current = parent
    }
    return current?.id ?? id
  }

  /**
   * Native DOM contextmenu handler（綁在 container div）。
   * 使用 DOM 事件而非 stage.on('contextmenu')，確保右鍵在任何子節點皆可靠觸發；
   * 再透過 stage.getIntersection 做 Konva hit-test。
   */
  function onContainerContextMenu(e: MouseEvent): void {
    const stage = getStage()
    if (!stage) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const stagePos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const hit = stage.getIntersection(stagePos) as Konva.Shape | null
    const elId = hit?.id() ?? null

    // 右鍵點擊未選取的元素 → 先選取（提升至父群組）
    // 右鍵點擊空白區域 → 保留現有選取，讓選單仍能對已選元素操作
    if (elId) {
      const selectId = rootSelectableId(elId)
      if (!elementStore.selectedIds.has(selectId)) {
        elementStore.clearSelection()
        elementStore.select(selectId)
      }
    }

    const selectedIds = elementStore.selectedIds
    const selectedEls = elementStore.selectedElements
    const rootSelected = selectedEls.filter((el) => !el.parentId)

    contextMenu.value = {
      x: e.clientX,
      y: e.clientY,
      hasSelection: selectedIds.size > 0,
      canGroup: rootSelected.length >= 2,
      canUngroup: selectedEls.some((el) => el.kind === ElementKind.Group),
    }
  }

  function closeContextMenu(): void {
    contextMenu.value = null
  }

  return { contextMenu, onContainerContextMenu, closeContextMenu }
}
