<script setup lang="ts">
import type { Viewport } from '@/store/viewport'
import type { CanvasComment } from '@/types/comment'
import CommentPin from './CommentPin.vue'

defineProps<{
  comments: readonly CanvasComment[]
  viewport: Viewport
  autoOpenCommentId: string | null
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
