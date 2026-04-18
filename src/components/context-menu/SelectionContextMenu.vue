<script setup lang="ts">
/**
 * 右鍵選單元件：抽離自 canvas.vue，同時供畫布與圖層面板共用。
 * Teleport 至 body，避免 z-index 與 Konva DOM 堆疊衝突。
 */
import { computed } from 'vue'
import { useElementStore } from '@/store/element'
import { useCanvasActions } from '@/composables/useCanvasActions'
import type { ContextMenuState } from '@/types/canvas'

const props = defineProps<{
  /** 選單位置與可用操作狀態；null 表示選單關閉 */
  contextMenu: ContextMenuState | null
}>()

const emit = defineEmits<{
  /** 任何操作完成或點擊外部後，通知父元件關閉選單 */
  (e: 'close'): void
}>()

const elementStore = useElementStore()
const { deleteSelected, groupSelected, ungroupSelected, duplicateSelected } = useCanvasActions()

/** 快取已選取 id 陣列，避免各動作函式重複展開 Set */
const selectedIds = computed(() => [...elementStore.selectedIds])

function closeMenu(): void {
  emit('close')
}

/** 提升至最上層（z-order 最高），僅作用於第一個選取元素 */
function bringToFront(): void {
  const firstId = selectedIds.value[0]
  if (!firstId) return
  elementStore.bringToFront(firstId)
  elementStore.pushSnapshot()
  closeMenu()
}

/** 所有選取元素各自向上移動一層 */
function moveUp(): void {
  if (selectedIds.value.length === 0) return
  for (const id of selectedIds.value) elementStore.moveUp(id)
  elementStore.pushSnapshot()
  closeMenu()
}

/** 所有選取元素各自向下移動一層 */
function moveDown(): void {
  if (selectedIds.value.length === 0) return
  for (const id of selectedIds.value) elementStore.moveDown(id)
  elementStore.pushSnapshot()
  closeMenu()
}

/** 沉至最底層（z-order 最低），僅作用於第一個選取元素 */
function sendToBack(): void {
  const firstId = selectedIds.value[0]
  if (!firstId) return
  elementStore.sendToBack(firstId)
  elementStore.pushSnapshot()
  closeMenu()
}

function onGroup(): void {
  groupSelected()
  closeMenu()
}

function onUngroup(): void {
  ungroupSelected()
  closeMenu()
}

function onDuplicate(): void {
  duplicateSelected()
  closeMenu()
}

function onDelete(): void {
  deleteSelected()
  closeMenu()
}

function selectAll(): void {
  elementStore.selectAll()
  closeMenu()
}
</script>

<template>
  <Teleport to="body">
    <ul
      v-if="contextMenu"
      class="ctx-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
    >
      <template v-if="contextMenu.hasSelection">
        <li class="ctx-item" @click="bringToFront">
          Bring to Front <kbd>]</kbd>
        </li>
        <li class="ctx-item" @click="moveUp">
          Move Up
        </li>
        <li class="ctx-item" @click="moveDown">
          Move Down
        </li>
        <li class="ctx-item" @click="sendToBack">
          Send to Back <kbd>[</kbd>
        </li>
        <li class="ctx-sep" />
        <li v-if="contextMenu.canGroup" class="ctx-item" @click="onGroup">
          Group <kbd>Ctrl G</kbd>
        </li>
        <li v-if="contextMenu.canUngroup" class="ctx-item" @click="onUngroup">
          Ungroup <kbd>Ctrl Shift G</kbd>
        </li>
        <li class="ctx-sep" />
        <li class="ctx-item" @click="onDuplicate">
          Duplicate <kbd>Ctrl D</kbd>
        </li>
        <li class="ctx-sep" />
        <li class="ctx-item ctx-item--danger" @click="onDelete">
          Delete <kbd>Del</kbd>
        </li>
      </template>
      <template v-else>
        <li class="ctx-item" @click="selectAll">
          Select All <kbd>Ctrl A</kbd>
        </li>
      </template>
    </ul>
  </Teleport>
</template>

<style src="./SelectionContextMenu.scss" lang="scss" scoped />
