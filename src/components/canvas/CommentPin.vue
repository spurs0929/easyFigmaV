<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { CanvasComment } from '@/types/comment'
import type { Viewport } from '@/store/viewport'

// ── 常數 ──────────────────────────────────────────────────────────────────────

/**
 * popover 預設寬度（px），與 CommentPin.scss 中的 `width: 240px` 保持一致。
 * 僅作為 getBoundingClientRect() 取值前（DOM 尚未掛載時）的 fallback，
 * 不影響實際渲染寬度。
 */
const POPOVER_WIDTH    = 240
const POPOVER_OFFSET_X = 6

// ── Props / Emits ──────────────────────────────────────────────────────────────

const props = defineProps<{
  comment:  CanvasComment
  viewport: Viewport
  /**
   * 元件建立時是否自動展開 popover（僅初始化時生效，one-time flag）。
   * 用於新增評論後立即聚焦輸入框。
   *
   * TODO：若需「一次只開一個 popover」，
   *       請將 open 狀態提升至父層（canvas.vue），
   *       改為由外部傳入 :open 並監聽 @request-open / @request-close。
   */
  autoOpen: boolean
}>()

const emit = defineEmits<{
  (e: 'update-text',     id: string, text: string): void
  (e: 'toggle-resolved', id: string): void
  (e: 'delete',          id: string): void
}>()

// ── Refs ───────────────────────────────────────────────────────────────────────

const pinRef      = ref<HTMLButtonElement | null>(null)
const popoverRef  = ref<HTMLDivElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

// ── 視窗尺寸（響應式，防抖更新） ─────────────────────────────────────────────

const windowHeight = ref(window.innerHeight)
const windowWidth  = ref(window.innerWidth)

let _resizeTimer: ReturnType<typeof setTimeout> | null = null

function _onResize(): void {
  if (_resizeTimer) clearTimeout(_resizeTimer)
  _resizeTimer = setTimeout(() => {
    windowHeight.value = window.innerHeight
    windowWidth.value  = window.innerWidth
  }, 100)
}

// ── 螢幕座標（宣告在所有依賴它的 watch 之前） ─────────────────────────────────

const screenPos = computed(() => ({
  x: props.comment.worldX * props.viewport.scale + props.viewport.x,
  y: props.comment.worldY * props.viewport.scale + props.viewport.y,
}))

// ── Popover 開關 ───────────────────────────────────────────────────────────────

const open     = ref(false)
const openLeft = ref(false)
const openUp   = ref(false)

/**
 * 從 getBoundingClientRect() 讀取實際尺寸，確保與 CSS 自動同步。
 * POPOVER_WIDTH 僅作為 DOM 尚未掛載時的 fallback。
 * 須在 nextTick（DOM 掛載後）呼叫。
 */
function _adjustPopoverDirection(): void {
  const el = popoverRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  openLeft.value = rect.right  > windowWidth.value
  openUp.value   = rect.bottom > windowHeight.value
}

function openPopover(): void {
  open.value = true
  nextTick(() => {
    _adjustPopoverDirection()
    textareaRef.value?.focus()
  })
}

function closePopover(): void {
  open.value = false
  pinRef.value?.focus()
}

function toggleOpen(): void {
  open.value ? closePopover() : openPopover()
}

// 畫布縮放 / 平移時重算方向（screenPos 已宣告，此處安全引用）
watch(screenPos, () => {
  if (open.value) nextTick(_adjustPopoverDirection)
})

// ── popoverStyle ──────────────────────────────────────────────────────────────

const popoverStyle = computed(() => {
  const el = popoverRef.value
  const w  = el ? el.getBoundingClientRect().width : POPOVER_WIDTH
  const sx = screenPos.value.x
  const sy = screenPos.value.y
  return {
    left:   openLeft.value ? `${sx - w - POPOVER_OFFSET_X}px` : `${sx + 24}px`,
    top:    openUp.value   ? 'auto'                            : `${sy}px`,
    bottom: openUp.value   ? `${windowHeight.value - sy}px`   : 'auto',
  }
})

// ── Click-outside ──────────────────────────────────────────────────────────────

function _onDocumentClick(e: MouseEvent): void {
  if (!open.value) return
  const target = e.target as Node
  if (pinRef.value?.contains(target) || popoverRef.value?.contains(target)) return
  closePopover()
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

onMounted(() => {
  document.addEventListener('click', _onDocumentClick)
  window.addEventListener('resize', _onResize)
  if (props.autoOpen) openPopover()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', _onDocumentClick)
  window.removeEventListener('resize', _onResize)
  if (_resizeTimer) clearTimeout(_resizeTimer)
})

// ── 文字編輯 ──────────────────────────────────────────────────────────────────

const draft = ref(props.comment.text)

// popover 關閉時同步外部變更，開啟中不覆蓋進行中的編輯
watch(() => props.comment.text, (newText) => {
  if (!open.value) draft.value = newText
})

/**
 * 送出：空白視為「取消編輯」，直接關閉不寫入 store。
 * 若需「清除文字」，請加獨立「清除」按鈕使意圖更明確。
 */
function onSubmit(): void {
  const trimmed = draft.value.trim()
  if (trimmed) emit('update-text', props.comment.id, trimmed)
  closePopover()
}

function onDelete(): void {
  emit('delete', props.comment.id)
  closePopover()
}

function onKeydown(e: KeyboardEvent): void {
  e.stopPropagation()
  if (e.key === 'Escape')                             { e.preventDefault(); closePopover() }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey))  { e.preventDefault(); onSubmit() }
}
</script>

<template>
  <button
    ref="pinRef"
    class="comment-pin"
    :class="{ 'comment-pin--resolved': comment.resolved }"
    :style="{ left: `${screenPos.x}px`, top: `${screenPos.y}px` }"
    :aria-label="`評論：${comment.text || '（空）'}`"
    :aria-expanded="open"
    @click.stop="toggleOpen"
  >
    <svg width="20" height="24" viewBox="0 0 20 24" fill="none" aria-hidden="true">
      <path
        d="M10 0C4.477 0 0 4.477 0 10C0 16 10 24 10 24C10 24 20 16 20 10C20 4.477 15.523 0 10 0Z"
        :fill="comment.resolved ? '#4B5563' : '#6366F1'"
      />
      <path
        d="M5 8H15M5 12H11"
        stroke="white" stroke-width="1.5" stroke-linecap="round"
      />
    </svg>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="popoverRef"
      role="dialog"
      aria-label="評論輸入框"
      class="comment-popover"
      :style="popoverStyle"
      @click.stop
    >
      <textarea
        ref="textareaRef"
        v-model="draft"
        class="comment-popover__textarea"
        placeholder="新增評論… (Ctrl+Enter 送出)"
        rows="3"
        @keydown="onKeydown"
      />
      <div class="comment-popover__actions">
        <button
          class="comment-popover__btn comment-popover__btn--resolve"
          @click="emit('toggle-resolved', comment.id)"
        >
          {{ comment.resolved ? '取消解決' : '標記已解決' }}
        </button>
        <div class="comment-popover__actions-right">
          <button
            class="comment-popover__btn comment-popover__btn--delete"
            @click="onDelete"
          >
            刪除
          </button>
          <button
            class="comment-popover__btn comment-popover__btn--submit"
            :disabled="!draft.trim()"
            @click="onSubmit"
          >
            送出
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style src="./CommentPin.scss" lang="scss" />
