<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import '@/styles/global.scss'
import Toolbar from '@/components/toolbar/Toolbar.vue'
import LayerPanel from '@/components/LayerPanel/LayerPanel.vue'
import CanvasArea from '@/components/canvas/canvas.vue'
import PropertiesPanel from '@/components/properties/PropertiesPanel.vue'
import { useDocumentStore } from '@/store/document'

const documentStore = useDocumentStore()

// App 掛載時啟動 IndexedDB 自動存檔並嘗試載入上次存檔；卸載時釋放 watcher 與事件監聽。
onMounted(() => {
  void documentStore.startPersistence()
})

onUnmounted(() => {
  documentStore.stopPersistence()
})
</script>

<template>
  <div class="app-layout" @contextmenu.prevent>
    <Toolbar />
    <LayerPanel />
    <CanvasArea />
    <PropertiesPanel />
  </div>
</template>
