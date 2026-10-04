<script setup lang="ts">
/**
 * CommentOverlay — 留言覆疊層
 *
 * 職責：
 * 1. 以 Teleport to="body" 脫離 Konva Stage 的 DOM 樹，避免 z-index 堆疊上下文衝突。
 * 2. 透過 canvasRect（畫布相對視窗的絕對位置）定位自身，使 overflow: hidden 裁切
 *    超出畫布邊界的圖釘，視覺效果與 Konva Stage 對齊。
 * 3. pointer-events: none 讓滑鼠事件穿透至 Konva Stage；圖釘與提示各自打開。
 * 4. 決定留言框要為誰顯示：整個畫面同時只有一個，對象是 commentStore 的草稿
 *    或 activeId 指到的那一則。
 *
 * 留言資料與所有操作都直接來自 commentStore，不經過 CanvasArea 轉手——
 * CanvasArea 只需要告訴這裡畫布在哪、viewport 是什麼。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useCommentStore } from '@/store/comment'
import type { Viewport } from '@/store/viewport'
import CommentPin from './CommentPin.vue'
import CommentPopover from './CommentPopover.vue'

const props = defineProps<{
  /** 目前畫布的 viewport 狀態（scale / x / y），用於世界座標 → 螢幕座標轉換。 */
  viewport: Viewport
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

const commentStore = useCommentStore()

/** 世界座標 → 覆疊層內的座標。圖釘、草稿圖釘、留言框的位置都從這裡來。 */
function toOverlay(worldX: number, worldY: number): { x: number; y: number } {
  return {
    x: worldX * props.viewport.scale + props.viewport.x,
    y: worldY * props.viewport.scale + props.viewport.y,
  }
}

const pins = computed(() =>
  commentStore.comments.map((comment) => ({
    comment,
    ...toOverlay(comment.worldX, comment.worldY),
  })),
)

const draftPin = computed(() =>
  commentStore.draft ? toOverlay(commentStore.draft.worldX, commentStore.draft.worldY) : null,
)

/**
 * 留言框的對象與位置。草稿與既有留言互斥（store 保證），所以最多一個。
 *
 * key 讓換一則留言時重新掛載留言框：輸入中的文字、檢視 / 編輯狀態都屬於
 * 「那一則」，不該被帶到下一則。
 */
const popover = computed(() => {
  const target = commentStore.draft ?? commentStore.activeComment
  if (!target) return null
  const local = toOverlay(target.worldX, target.worldY)
  return {
    key: commentStore.activeComment?.id ?? 'draft',
    comment: commentStore.activeComment,
    // 留言框是 position: fixed，要的是視窗座標
    anchor: { x: props.canvasRect.left + local.x, y: props.canvasRect.top + local.y },
  }
})

/**
 * 沒有留言框開著時，修改失敗的訊息顯示在這裡（例如留言已經被別人刪掉，
 * 留言框跟著關了，但使用者需要知道剛才發生什麼事）。
 */
const notice = computed(() => {
  if (commentStore.loadError) return { text: commentStore.loadError, retry: true }
  if (commentStore.error && !commentStore.hasOpenPopover) {
    return { text: commentStore.error, retry: false }
  }
  return null
})

/**
 * 點到留言框以外的地方 → 請求關閉（有未送出的文字時 store 會擋下來）。
 *
 * 這個 listener 跟著覆疊層存在，不是留言框開啟時才註冊：在 mousedown 處理途中
 * 才註冊的 listener，會收到「造成它被註冊的那一次 mousedown」，剛開的留言框
 * 就會被自己關掉。
 *
 * 畫布上的點擊不在這裡處理。那一下要不要放新的留言、還是只關掉目前的留言框，
 * 必須跟工具的行為一起決定，所以交給 CanvasArea 的 stage mousedown。
 */
function onDocumentMousedown(e: MouseEvent): void {
  if (!commentStore.hasOpenPopover) return
  const target = e.target
  if (!(target instanceof Element)) return
  if (target.closest('.comment-popover, .comment-pin, .canvas-container')) return
  commentStore.requestClose()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
})
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
        v-for="pin in pins"
        :key="pin.comment.id"
        :comment="pin.comment"
        :x="pin.x"
        :y="pin.y"
        :active="pin.comment.id === commentStore.activeId"
        @open="commentStore.open"
      />

      <!-- 還沒送出的留言：只是位置標記，沒有內容可以開啟 -->
      <span
        v-if="draftPin"
        class="comment-pin comment-pin--draft"
        :style="{ left: `${draftPin.x}px`, top: `${draftPin.y}px` }"
        aria-hidden="true"
        data-testid="comment-draft-pin"
      >
        <svg width="20" height="24" viewBox="0 0 20 24" fill="none" overflow="visible">
          <path
            class="comment-pin__body"
            d="M10 0C4.477 0 0 4.477 0 10C0 16 10 24 10 24C10 24 20 16 20 10C20 4.477 15.523 0 10 0Z"
          />
        </svg>
      </span>

      <div v-if="notice" class="comment-overlay__notice" role="alert" data-testid="comment-notice">
        <span>{{ notice.text }}</span>
        <button
          v-if="notice.retry"
          type="button"
          class="comment-overlay__notice-btn"
          @click="commentStore.reload()"
        >
          重試
        </button>
        <button
          v-else
          type="button"
          class="comment-overlay__notice-btn"
          aria-label="關閉訊息"
          @click="commentStore.clearError()"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path
              d="M1 1L9 9M9 1L1 9"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </div>

    <!-- 留言框在覆疊層外面：覆疊層會裁切超出畫布的內容，留言框不該被裁 -->
    <CommentPopover
      v-if="popover"
      :key="popover.key"
      :comment="popover.comment"
      :anchor="popover.anchor"
    />
  </Teleport>
</template>

<style scoped lang="scss">
.comment-overlay {
  position: fixed;
  z-index: 150;
  pointer-events: none;
  overflow: hidden;

  &__notice {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: calc(100% - 24px);
    padding: 6px 8px 6px 12px;
    background: #1e1e1e;
    border: 1px solid #f87171;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    color: #f87171;
    // 覆疊層 Teleport 到 body，繼承不到 .app-layout 的字型
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 12px;
    pointer-events: auto;
  }

  &__notice-btn {
    flex: none;
    padding: 2px 8px;
    border: 1px solid #444;
    border-radius: 4px;
    background: transparent;
    color: #c9d1d9;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;

    &:hover {
      background: #2d2d2d;
    }

    &:focus-visible {
      outline: 2px solid #6366f1;
      outline-offset: 1px;
    }
  }
}
</style>
