<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import Toolbar from '@/components/toolbar/Toolbar.vue'
import LayerPanel from '@/components/LayerPanel/LayerPanel.vue'
import CanvasArea from '@/components/canvas/canvas.vue'
import PropertiesPanel from '@/components/properties/PropertiesPanel.vue'
import DesktopOnlyNotice from '@/components/editor/DesktopOnlyNotice.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { useDocumentStore } from '@/store/document'

const documentStore = useDocumentStore()

// 900px 是三個側邊面板加上可用畫布的下限。低於這個寬度不是「版面擠一點」，
// 而是根本沒有空間；觸控裝置還多了縮放手勢與畫布縮放衝突的問題。
// 顯示明確的說明，而不是讓版面破掉。
const isEditorSupported = useMediaQuery('(min-width: 900px)')

// 不論尺寸都啟動持久化：使用者可能從窄視窗拉寬，若在這裡加條件，
// 就要處理「拉寬之後才補啟動」的時序，徒增出錯機會。
// 未渲染畫布時這些 watcher 幾乎沒有成本。
onMounted(() => {
  void documentStore.startPersistence()
})

onUnmounted(() => {
  documentStore.stopPersistence()
})
</script>

<template>
  <div v-if="isEditorSupported" class="app-layout" @contextmenu.prevent>
    <Toolbar />
    <LayerPanel />
    <CanvasArea />
    <PropertiesPanel />
  </div>

  <DesktopOnlyNotice v-else />
</template>
