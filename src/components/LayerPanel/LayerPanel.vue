<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useElementStore } from '@/store/element'
import { ElementKind, type CanvasElement } from '@/types/element'
import type { ContextMenuState } from '@/types/canvas'
import SelectionContextMenu from '@/components/context-menu/SelectionContextMenu.vue'

interface LayerRow {
  el: CanvasElement
  depth: number
  hasChildren: boolean
  isExpanded: boolean
}

/**
 * Pre-order DFS 走訪圖層樹，產出扁平化列表。
 * roots 在呼叫前已 reverse，故 index 0 = 畫布最上層（Figma 慣例）。
 * Module-level 函式：可獨立測試，且不會在每次 computed() 重算時重新建立。
 */
function walkLayerTree(
  elements: CanvasElement[],
  depth: number,
  expandedIds: ReadonlySet<string>,
  byId: Readonly<Record<string, CanvasElement>>,
  rows: LayerRow[],
): void {
  for (const el of elements) {
    const hasChildren = el.childIds.length > 0
    const isExpanded = expandedIds.has(el.id)
    rows.push({ el, depth, hasChildren, isExpanded })

    if (!hasChildren || !isExpanded) continue

    // reverse：讓子元素列表同樣呈現「最上層在最前」
    const children = el.childIds
      .map((id) => byId[id])
      .filter((child): child is CanvasElement => !!child)
      .reverse()
    walkLayerTree(children, depth + 1, expandedIds, byId, rows)
  }
}

const elementStore = useElementStore()

/** 使用者主動展開的群組 id 集合 */
const expandedIds = ref<ReadonlySet<string>>(new Set())
/** Shift+Click 範圍選取的起始錨點 id；null 時以當前選取末項為錨點 */
const selectionAnchorId = ref<string | null>(null)
/** 右鍵選單狀態；null 表示選單關閉 */
const contextMenu = ref<ContextMenuState | null>(null)

/**
 * 扁平化的圖層列表（DFS pre-order）。
 * rootElements 已 reverse，故 index 0 = 畫布最上層的元素。
 */
const flatLayers = computed<LayerRow[]>(() => {
  const roots = [...elementStore.rootElements].reverse()
  const rows: LayerRow[] = []
  walkLayerTree(roots, 0, expandedIds.value, elementStore.byId, rows)
  return rows
})

/**
 * 目前列表中，去除子元素重複後的可選取根元素 id 序列。
 * 供 Shift+Click 範圍選取計算頭尾 index 使用。
 */
const visibleSelectableIds = computed<string[]>(() => {
  const ids: string[] = []
  const seen = new Set<string>()

  for (const row of flatLayers.value) {
    const selectableId = rootSelectableId(row.el.id)
    if (seen.has(selectableId)) continue
    seen.add(selectableId)
    ids.push(selectableId)
  }

  return ids
})

function closeContextMenu(): void {
  contextMenu.value = null
}

/** 根據目前選取狀態組裝右鍵選單的資料（位置 + 可用操作旗標） */
function buildContextMenuState(x: number, y: number): ContextMenuState {
  const selectedEls = elementStore.selectedElements
  const rootSelected = selectedEls.filter((el) => !el.parentId)

  return {
    x,
    y,
    hasSelection: elementStore.selectedIds.size > 0,
    canGroup: rootSelected.length >= 2,
    canUngroup: selectedEls.some((el) => el.kind === ElementKind.Group),
  }
}

/**
 * 向上走訪至根層級，取得可被獨立選取的根元素 id。
 * 群組內的子元素不能單獨選取，必須以群組為單位操作。
 */
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
 * 取得 Shift 範圍選取的錨點 id。
 * 優先使用明確記錄的 selectionAnchorId；
 * 若未記錄，單選時以該唯一元素為錨點，多選時以最後一個為錨點。
 */
function resolveSelectionAnchorId(): string | null {
  if (selectionAnchorId.value) return selectionAnchorId.value

  const selectedIds = [...elementStore.selectedIds]
  if (selectedIds.length === 1) return selectedIds[0]

  return selectedIds.at(-1) ?? null
}

/** 單選指定元素，並將其記為下次 Shift+Click 的錨點 */
function selectSingleLayer(id: string): void {
  elementStore.select(id)
  selectionAnchorId.value = id
}

/**
 * Shift+Click 範圍選取：從錨點到目標 id 之間的所有可見元素全選。
 * 若無有效錨點，降級為單選。
 */
function selectLayerRange(id: string): void {
  const anchorId = resolveSelectionAnchorId()
  if (!anchorId || elementStore.selectedIds.size === 0) {
    selectSingleLayer(id)
    return
  }

  const visibleIds = visibleSelectableIds.value
  const startIndex = visibleIds.indexOf(anchorId)
  const endIndex = visibleIds.indexOf(id)

  if (startIndex === -1 || endIndex === -1) {
    selectSingleLayer(id)
    return
  }

  const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex]
  elementStore.clearSelection()
  for (const selectableId of visibleIds.slice(from, to + 1)) {
    elementStore.select(selectableId, true)
  }
}

/** 點擊圖層列：Shift 觸發範圍選取，否則單選並關閉右鍵選單 */
function onRowClick(id: string, e: MouseEvent): void {
  closeContextMenu()

  const selectableId = rootSelectableId(id)
  if (e.shiftKey) {
    selectLayerRange(selectableId)
    return
  }

  selectSingleLayer(selectableId)
}

/**
 * 右鍵點擊圖層列：若點擊的元素未被選取，先單選它再開選單；
 * 若已在選取範圍內，僅更新錨點再開選單，不改變選取集合。
 */
function onRowContextMenu(id: string, e: MouseEvent): void {
  const selectableId = rootSelectableId(id)
  if (!elementStore.selectedIds.has(selectableId)) {
    selectSingleLayer(selectableId)
  } else {
    selectionAnchorId.value = selectableId
  }

  contextMenu.value = buildContextMenuState(e.clientX, e.clientY)
}

/** 右鍵點擊圖層列空白區域：直接開選單（不改變選取狀態） */
function onListContextMenu(e: MouseEvent): void {
  contextMenu.value = buildContextMenuState(e.clientX, e.clientY)
}

/** 展開／收合群組：stopPropagation 避免觸發父層的 onRowClick */
function onToggleClick(id: string, e: MouseEvent): void {
  e.stopPropagation()
  const next = new Set(expandedIds.value)
  next.has(id) ? next.delete(id) : next.add(id)
  expandedIds.value = next
}

/** 各元素種類對應的符號，顯示於圖層列左側 */
function kindIcon(kind: ElementKind): string {
  switch (kind) {
    case ElementKind.Rect:
      return '▭'
    case ElementKind.Ellipse:
      return '○'
    case ElementKind.Line:
      return '╱'
    case ElementKind.Polygon:
      return '⬡'
    case ElementKind.Vector:
      return '∿'
    case ElementKind.Text:
      return 'T'
    case ElementKind.Frame:
      return '⊡'
    case ElementKind.Group:
      return '⊞'
    case ElementKind.Component:
      return '◈'
    case ElementKind.Slice:
      return '⊘'
    default:
      return '□'
  }
}

// 點擊選單外部任意位置時關閉右鍵選單（document 層級捕捉，不影響選單內部事件）
onMounted(() => {
  document.addEventListener('click', closeContextMenu)
})

onUnmounted(() => {
  document.removeEventListener('click', closeContextMenu)
})
</script>

<template>
  <aside class="layer-panel">
    <div class="layer-panel__header">Layers</div>

    <div class="layer-panel__list" role="tree" @contextmenu.prevent="onListContextMenu">
      <div
        v-for="row in flatLayers"
        :key="row.el.id"
        class="layer-row"
        :class="{ 'layer-row--selected': elementStore.selectedIds.has(row.el.id) }"
        :style="{ paddingLeft: `${8 + row.depth * 16}px` }"
        role="treeitem"
        :aria-selected="elementStore.selectedIds.has(row.el.id)"
        :aria-expanded="row.hasChildren ? row.isExpanded : undefined"
        @click="onRowClick(row.el.id, $event)"
        @contextmenu.prevent.stop="onRowContextMenu(row.el.id, $event)"
      >
        <button
          v-if="row.hasChildren"
          class="layer-row__toggle"
          :aria-label="row.isExpanded ? '收合' : '展開'"
          tabindex="-1"
          @click="onToggleClick(row.el.id, $event)"
        >
          {{ row.isExpanded ? '▾' : '▸' }}
        </button>
        <span v-else class="layer-row__toggle layer-row__toggle--spacer" aria-hidden="true" />

        <span class="layer-row__icon" aria-hidden="true">{{ kindIcon(row.el.kind) }}</span>
        <span class="layer-row__name">{{ row.el.name }}</span>
        <span v-if="row.el.locked" class="layer-row__badge" aria-label="已鎖定">🔒</span>
        <span v-if="!row.el.visible" class="layer-row__badge" aria-label="已隱藏">👁</span>
      </div>

      <div v-if="flatLayers.length === 0" class="layer-panel__empty">
        沒有圖層
      </div>
    </div>

    <SelectionContextMenu :context-menu="contextMenu" @close="closeContextMenu" />
  </aside>
</template>

<style src="./LayerPanel.scss" lang="scss" />
