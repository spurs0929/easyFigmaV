<script setup lang="ts">
import '@/styles/global.scss'
import AppToolbar from '@/components/toolbar/AppToolbar.vue'
import LayerPanel from '@/components/LayerPanel/LayerPanel.vue'
import CanvasArea from '@/components/canvas/canvas.vue'
import PropertiesPanel from '@/components/properties/PropertiesPanel.vue'
</script>

<template>
  <div class="app-layout">
    <AppToolbar />
    <LayerPanel />
    <CanvasArea />
    <PropertiesPanel />
  </div>
</template>
