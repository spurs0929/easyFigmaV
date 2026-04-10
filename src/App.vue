<script setup lang="ts">
import '@/styles/global.scss'
import Toolbar from '@/components/toolbar/Toolbar.vue'
import LayerPanel from '@/components/LayerPanel/LayerPanel.vue'
import CanvasArea from '@/components/canvas/canvas.vue'
import PropertiesPanel from '@/components/properties/PropertiesPanel.vue'
</script>

<template>
  <div class="app-layout" @contextmenu.prevent>
    <Toolbar />
    <LayerPanel />
    <CanvasArea />
    <PropertiesPanel />
  </div>
</template>
