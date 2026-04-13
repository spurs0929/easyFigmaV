<script setup lang="ts">
/**
 * CommentOverlay — 評論覆疊層
 *
 * 職責：
 * 1. 以 Teleport to="body" 脫離 Konva Stage 的 DOM 樹，避免 z-index 堆疊上下文衝突。
 * 2. 透過 canvasRect（畫布相對視窗的絕對位置）定位自身，使 overflow: hidden 裁切
 *    超出畫布邊界的 CommentPin，視覺效果與 Konva Stage 對齊。
 * 3. pointer-events: none 讓滑鼠事件穿透至 Konva Stage；CommentPin 內部的互動元素
 *    各自設定 pointer-events: auto 接收點擊。
 */
import type { Viewport } from '@/store/viewport'
import type { CanvasComment } from '@/types/comment'
import CommentPin from './CommentPin.vue'

defineProps<{
  /** 目前所有評論資料（唯讀，來自 CommentStore）。 */
  comments: readonly CanvasComment[]
  /** 目前畫布的 viewport 狀態（scale / x / y），供子元件進行世界座標 → 螢幕座標轉換。 */
  viewport: Viewport
  /**
   * 最近新增的評論 id，對應的 CommentPin 在 onMounted 時會自動展開 popover。
   * null 表示無需自動開啟。
   */
  autoOpenCommentId: string | null
  /**
   * 畫布容器相對瀏覽器視窗的位置與尺寸（由 ResizeObserver 維護）。
   * 用於將覆疊層精確對齊 Konva Stage 的可視區域。
   */
  canvasRect: {
    left: number
    top: number
    width: number
    height: number
  }
}>()

const emit = defineEmits<{
  (e: 'update-text', id: string, text: string): void
  (e: 'toggle-resolved', id: string): void
  (e: 'delete', id: string): void
}>()
</script>

<template>
  <Teleport to="body">
    <div
      class="comment-overlay"
      :style="{
        left: `${canvasRect.left}px`,
        top: `${canvasRect.top}px`,
        width: `${canvasRect.width}px`,
        height: `${canvasRect.height}px`,
      }"
    >
      <CommentPin
        v-for="comment in comments"
        :key="comment.id"
        :comment="comment"
        :viewport="viewport"
        :auto-open="comment.id === autoOpenCommentId"
        @update-text="(id, text) => emit('update-text', id, text)"
        @toggle-resolved="emit('toggle-resolved', $event)"
        @delete="emit('delete', $event)"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.comment-overlay {
  position: fixed;
  z-index: 150;
  pointer-events: none;
  overflow: hidden;
}
</style>
