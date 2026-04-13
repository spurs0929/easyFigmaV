<script setup lang="ts">
/**
 * CommentPin — 單一評論圖釘元件
 *
 * 職責：
 * 1. 根據世界座標與 viewport 計算螢幕位置，跟隨畫布縮放 / 平移即時更新。
 * 2. 點擊圖釘展開 popover（Teleport to="body"）進行評論編輯。
 * 3. 自動調整 popover 方向，避免溢出視窗邊界（右側不足 → 向左，底部不足 → 向上）。
 * 4. 阻止 Wheel 事件冒泡至 Konva Stage（防止在 popover 內滾動時縮放畫布）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Viewport } from '@/store/viewport'
import type { CanvasComment } from '@/types/comment'

/** popover 預設寬度（px），getBoundingClientRect 讀不到時的備用值。 */
const POPOVER_WIDTH = 240
/** 圖釘右側與 popover 左緣之間的水平間距（px）。 */
const POPOVER_OFFSET_X = 6

const props = defineProps<{
  /** 該圖釘對應的評論資料。 */
  comment: CanvasComment
  /** 畫布 viewport（scale / x / y），用於世界座標 → 螢幕座標轉換。 */
  viewport: Viewport
  /**
   * 為 true 時，元件 mounted 後自動展開 popover（剛建立的評論使用）。
   * 此 prop 為 one-time flag，只在 onMounted 消費一次，後續變更不重新觸發。
   */
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

/** 視窗高度，用於 popover 方向計算；resize 事件觸發後更新。 */
const windowHeight = ref(window.innerHeight)
/** 視窗寬度，同上。 */
const windowWidth = ref(window.innerWidth)

/** resize 防抖計時器，避免高頻 resize 事件連續重算。 */
let resizeTimer: ReturnType<typeof setTimeout> | null = null

/** 視窗 resize 防抖處理：100ms 靜默後才更新視窗尺寸快照。 */
function onResize(): void {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    windowHeight.value = window.innerHeight
    windowWidth.value = window.innerWidth
  }, 100)
}

/**
 * 世界座標 → 螢幕座標（考慮 viewport 縮放與平移）。
 * 每當 viewport 或評論位置變更時自動重算，驅動 pin 與 popover 跟隨移動。
 */
const screenPos = computed(() => ({
  x: props.comment.worldX * props.viewport.scale + props.viewport.x,
  y: props.comment.worldY * props.viewport.scale + props.viewport.y,
}))

/** popover 是否展開。 */
const open = ref(false)
/** popover 是否向左展開（右側空間不足時為 true）。 */
const openLeft = ref(false)
/** popover 是否向上展開（底部空間不足時為 true）。 */
const openUp = ref(false)

/**
 * 讀取 popover 的 getBoundingClientRect 並根據視窗邊界更新展開方向旗標。
 * 必須在 nextTick 後呼叫，確保 popover DOM 已渲染完成。
 */
function adjustPopoverDirection(): void {
  const el = popoverRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  openLeft.value = rect.right > windowWidth.value
  openUp.value = rect.bottom > windowHeight.value
}

/** 展開 popover：設定 open 旗標後等待 DOM 更新，再調整方向並聚焦 textarea。 */
function openPopover(): void {
  open.value = true
  nextTick(() => {
    adjustPopoverDirection()
    textareaRef.value?.focus()
  })
}

/** 收起 popover，並將焦點還給圖釘按鈕（無障礙考量）。 */
function closePopover(): void {
  open.value = false
  pinRef.value?.focus()
}

/** 切換 popover 開關狀態。 */
function toggleOpen(): void {
  if (open.value) closePopover()
  else openPopover()
}

/**
 * 當畫布縮放 / 平移時，screenPos 改變。
 * 若 popover 已開啟，重新計算方向避免溢出視窗。
 */
watch(screenPos, () => {
  if (open.value) nextTick(adjustPopoverDirection)
})

/**
 * popover 定位樣式。
 * - 水平：優先向右展開（pin 右側 + 24px），右側不足時改向左（pin 左側 - popoverWidth - offset）。
 * - 垂直：優先向下（top = screenPos.y），底部不足時改向上（bottom = windowHeight - screenPos.y）。
 */
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

/**
 * 點擊 pin 與 popover 以外的區域時關閉 popover。
 * 使用 document mousedown（非 click）是為了在 mousedown 階段即關閉，
 * 避免 click 事件在關閉後仍觸發其他元素的點擊行為。
 */
function onDocumentMousedown(e: MouseEvent): void {
  if (!open.value) return
  const target = e.target as Node
  if (pinRef.value?.contains(target) || popoverRef.value?.contains(target)) return
  closePopover()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown)
  window.addEventListener('resize', onResize)
  // autoOpen 為 one-time flag：只在首次 mounted 時消費，不響應後續變更
  if (props.autoOpen) openPopover()
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
  window.removeEventListener('resize', onResize)
  if (resizeTimer) clearTimeout(resizeTimer)
})

/**
 * 評論文字的草稿狀態（v-model 來源）。
 * 僅在 popover 關閉時才同步外部 prop，
 * 避免使用者正在輸入時被其他來源（多人協作）的更新覆寫。
 */
const draft = ref(props.comment.text)

watch(
  () => props.comment.text,
  (newText) => {
    // popover 展開中：使用者正在編輯，不強制同步以免打斷輸入
    if (!open.value) draft.value = newText
  },
)

/**
 * 送出評論：修剪空白後 emit update-text，空字串不送出（按鈕已透過 :disabled 攔截）。
 * 送出後收起 popover。
 */
function onSubmit(): void {
  const trimmed = draft.value.trim()
  if (trimmed) emit('update-text', props.comment.id, trimmed)
  closePopover()
}

/** 刪除評論：emit delete 後收起 popover（元件隨即由父層 v-for 移除）。 */
function onDelete(): void {
  emit('delete', props.comment.id)
  closePopover()
}

/**
 * textarea 鍵盤事件處理：
 * - stopPropagation：阻止 Konva Stage 的全域 keydown 攔截（如 Delete 鍵刪除圖形）。
 * - Escape：取消編輯並收起 popover。
 * - Ctrl/Cmd + Enter：快速送出。
 */
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

/**
 * Wheel 事件攔截：
 * - Ctrl/Cmd + Wheel：阻止瀏覽器原生頁面縮放（preventDefault）。
 * - 所有 wheel：stopPropagation 阻止冒泡至 Konva Stage 觸發畫布縮放。
 */
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
