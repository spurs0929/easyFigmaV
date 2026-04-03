<script setup lang="ts">
import { ref, computed } from 'vue'
import { useElementStore } from '@/store/element'
import { ElementKind, type CanvasElement } from '@/types/element'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LayerRow {
  el: CanvasElement
  depth: number
  hasChildren: boolean
  isExpanded: boolean
}

// ── DFS Walk ──────────────────────────────────────────────────────────────────

/**
 * Pre-order DFS；根元素已在呼叫前 reverse，故 index 0 = 最上層（Figma 慣例）。
 * Module-level 函式：可獨立測試，且不會在每次 computed() 重算時重新建立。
 */
function walkLayerTree(
  els: CanvasElement[],
  depth: number,
  expandedIds: ReadonlySet<string>,
  byId: Readonly<Record<string, CanvasElement>>,
  rows: LayerRow[],
): void {
  for (const el of els) {
    const hasChildren = el.childIds.length > 0
    const isExpanded = expandedIds.has(el.id)
    rows.push({ el, depth, hasChildren, isExpanded })

    if (hasChildren && isExpanded) {
      // reverse：讓子元素列表同樣呈現「最上層在最前」
      const children = el.childIds
        .map((id) => byId[id])
        .filter((c): c is CanvasElement => !!c)
        .reverse()
      walkLayerTree(children, depth + 1, expandedIds, byId, rows)
    }
  }
}

// ── Store & Local State ───────────────────────────────────────────────────────

const elementStore = useElementStore()

/** 使用者主動展開的群組 id 集合。 */
const expandedIds = ref<ReadonlySet<string>>(new Set())

// ── Computed ──────────────────────────────────────────────────────────────────

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

// ── Event Handlers ────────────────────────────────────────────────────────────

function onRowClick(id: string, e: MouseEvent): void {
  elementStore.select(id, e.shiftKey)
}

function onToggleClick(id: string, e: MouseEvent): void {
  e.stopPropagation()
  const next = new Set(expandedIds.value)
  next.has(id) ? next.delete(id) : next.add(id)
  expandedIds.value = next
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
</script>

<template>
  <aside class="layer-panel">
    <div class="layer-panel__header">Layers</div>

    <div class="layer-panel__list" role="tree">
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

      <div v-if="flatLayers.length === 0" class="layer-panel__empty">沒有圖層</div>
    </div>
  </aside>
</template>

<style src="./LayerPanel.scss" lang="scss" />
