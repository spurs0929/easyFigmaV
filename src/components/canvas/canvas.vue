<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useElementStore } from '@/store/element'
import { useViewportStore } from '@/store/viewport'

// ── Store ─────────────────────────────────────────────────────────────────────

const elementStore = useElementStore()
const viewportStore = useViewportStore()

// ── Canvas ref ────────────────────────────────────────────────────────────────

const containerRef = ref<HTMLDivElement | null>(null)

// ── Resize observer（畫布隨容器自動調整）──────────────────────────────────────

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!containerRef.value) return
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0]
    if (entry) {
      viewportStore.setContainerSize(entry.contentRect.width, entry.contentRect.height)
    }
  })
  resizeObserver.observe(containerRef.value)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})
</script>

<template>
  <div ref="containerRef" class="canvas-container">
    <!-- Canvas 渲染層（Konva / vue-konva 將在此掛載） -->
    <div class="canvas-placeholder">
      <span>Canvas Area</span>
      <span class="canvas-placeholder__hint">{{ elementStore.rootElements.length }} 個元素</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.canvas-container {
  flex: 1;
  position: relative;
  background: #141414;
  overflow: hidden;
  min-width: 0;
}

.canvas-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #444;
  font-size: 13px;
  pointer-events: none;
  user-select: none;

  &__hint {
    font-size: 11px;
    color: #333;
  }
}
</style>
