<script setup lang="ts">
/**
 * CommentPin — 畫布上的一個留言圖釘。
 *
 * 只負責「在哪裡、長什麼樣子、被點了」。留言框不在這裡：同一時間只會有一個
 * 留言框，由 CommentOverlay 依 commentStore.activeId 決定要為哪一則顯示。
 * 每個 pin 各自管理開關的話，「目前開著哪一則」就沒有單一的答案。
 */
import { computed } from 'vue'
import type { CommentView } from '@/types/comment'

const props = defineProps<{
  comment: CommentView
  /** 圖釘尖端在覆疊層內的座標（已由世界座標換算）。 */
  x: number
  y: number
  /** 這一則的留言框是否開著。 */
  active: boolean
}>()

const emit = defineEmits<{
  open: [id: string]
}>()

const label = computed(() => {
  const author = props.comment.author
  const who = author ? author.displayName?.trim() || author.email : '本機留言'
  const state = props.comment.resolved ? '（已解決）' : ''
  return `${who}${state}：${props.comment.text}`
})
</script>

<template>
  <button
    type="button"
    class="comment-pin"
    :class="{ 'comment-pin--resolved': comment.resolved, 'comment-pin--active': active }"
    :style="{ left: `${x}px`, top: `${y}px` }"
    :aria-label="label"
    :aria-expanded="active"
    :title="label"
    data-testid="comment-pin"
    @click.stop="emit('open', comment.id)"
  >
    <svg width="20" height="24" viewBox="0 0 20 24" fill="none" aria-hidden="true">
      <path
        class="comment-pin__body"
        d="M10 0C4.477 0 0 4.477 0 10C0 16 10 24 10 24C10 24 20 16 20 10C20 4.477 15.523 0 10 0Z"
      />
      <!-- 已解決：打勾；未解決：兩行文字 -->
      <path
        v-if="comment.resolved"
        d="M5.5 10.5L8.5 13.5L14.5 7"
        stroke="white"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path v-else d="M5 8H15M5 12H11" stroke="white" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  </button>
</template>

<style src="./CommentPin.scss" lang="scss" />
