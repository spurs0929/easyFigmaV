<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Viewport } from '@/store/viewport'
import type { CanvasComment } from '@/types/comment'

const POPOVER_WIDTH = 240
const POPOVER_OFFSET_X = 6

const props = defineProps<{
  comment: CanvasComment
  viewport: Viewport
  autoOpen: boolean
}>()

const emit = defineEmits<{
  (e: 'update-text', id: string, text: string): void
  (e: 'toggle-resolved', id: string): void
  (e: 'delete', id: string): void
}>()

const pinRef = ref<HTMLButtonElement | null>(null)
const popoverRef = ref<HTMLDivElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const windowHeight = ref(window.innerHeight)
const windowWidth = ref(window.innerWidth)

let resizeTimer: ReturnType<typeof setTimeout> | null = null

function onResize(): void {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    windowHeight.value = window.innerHeight
    windowWidth.value = window.innerWidth
  }, 100)
}

const screenPos = computed(() => ({
  x: props.comment.worldX * props.viewport.scale + props.viewport.x,
  y: props.comment.worldY * props.viewport.scale + props.viewport.y,
}))

const open = ref(false)
const openLeft = ref(false)
const openUp = ref(false)

function adjustPopoverDirection(): void {
  const el = popoverRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  openLeft.value = rect.right > windowWidth.value
  openUp.value = rect.bottom > windowHeight.value
}

function openPopover(): void {
  open.value = true
  nextTick(() => {
    adjustPopoverDirection()
    textareaRef.value?.focus()
  })
}

function closePopover(): void {
  open.value = false
  pinRef.value?.focus()
}

function toggleOpen(): void {
  if (open.value) closePopover()
  else openPopover()
}

watch(screenPos, () => {
  if (open.value) nextTick(adjustPopoverDirection)
})

const popoverStyle = computed(() => {
  const width = popoverRef.value?.getBoundingClientRect().width ?? POPOVER_WIDTH
  const x = screenPos.value.x
  const y = screenPos.value.y
  return {
    left: openLeft.value ? `${x - width - POPOVER_OFFSET_X}px` : `${x + 24}px`,
    top: openUp.value ? 'auto' : `${y}px`,
    bottom: openUp.value ? `${windowHeight.value - y}px` : 'auto',
  }
})

function onDocumentMousedown(e: MouseEvent): void {
  if (!open.value) return
  const target = e.target as Node
  if (pinRef.value?.contains(target) || popoverRef.value?.contains(target)) return
  closePopover()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown)
  window.addEventListener('resize', onResize)
  if (props.autoOpen) openPopover()
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
  window.removeEventListener('resize', onResize)
  if (resizeTimer) clearTimeout(resizeTimer)
})

const draft = ref(props.comment.text)

watch(
  () => props.comment.text,
  (newText) => {
    if (!open.value) draft.value = newText
  },
)

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
  if (e.key === 'Escape') {
    e.preventDefault()
    closePopover()
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    onSubmit()
  }
}

function onWheel(e: WheelEvent): void {
  if (e.ctrlKey || e.metaKey) e.preventDefault()
  e.stopPropagation()
}
</script>

<template>
  <div
    class="comment-pin-layer"
    :style="{ left: `${screenPos.x}px`, top: `${screenPos.y}px` }"
    @wheel="onWheel"
  >
    <button
      ref="pinRef"
      class="comment-pin"
      :class="{ 'comment-pin--resolved': comment.resolved }"
      :aria-label="`評論：${comment.text || '（空）'}`"
      :aria-expanded="open"
      @click.stop="toggleOpen"
      @wheel="onWheel"
    >
      <svg width="20" height="24" viewBox="0 0 20 24" fill="none" aria-hidden="true">
        <path
          d="M10 0C4.477 0 0 4.477 0 10C0 16 10 24 10 24C10 24 20 16 20 10C20 4.477 15.523 0 10 0Z"
          :fill="comment.resolved ? '#4B5563' : '#6366F1'"
        />
        <path d="M5 8H15M5 12H11" stroke="white" stroke-width="1.5" stroke-linecap="round" />
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
        @wheel="onWheel"
      >
        <textarea
          ref="textareaRef"
          v-model="draft"
          class="comment-popover__textarea"
          placeholder="輸入評論（Ctrl+Enter 送出）"
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
            <button class="comment-popover__btn comment-popover__btn--delete" @click="onDelete">
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
  </div>
</template>

<style src="./CommentPin.scss" lang="scss" />
