<script setup lang="ts">
/**
 * CommentPopover — 留言框。整個畫面同時只會有一個。
 *
 * 四種狀態：
 *   draft   新增：輸入框 + 取消 / 送出。送出成功之前畫布上沒有正式的留言。
 *   view    檢視既有留言：作者、時間、內容，以及依權限顯示的操作。預設狀態。
 *   edit    修改內容：輸入框 + 取消 / 儲存。
 *   confirm 刪除前的確認，在留言框內完成，不另外開對話框。
 *
 * 輸入框的文字只存在這個元件裡。store 只知道「有沒有尚未送出的文字」（dirty），
 * 用來擋掉會讓文字無聲消失的操作。
 *
 * 由 CommentOverlay 以留言 id 當 key 掛載：換一則留言就是一個新的實例，
 * 所以這裡不需要處理「同一個實例換了留言」的狀態重設。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue'
import UserAvatar from '@/components/common/UserAvatar.vue'
import { useCommentStore } from '@/store/comment'
import { useToolStore } from '@/store/tool'
import { COMMENT_MAX_LENGTH, type CommentView } from '@/types/comment'
import { ToolType } from '@/types/tool'

type Mode = 'draft' | 'view' | 'edit' | 'confirm'

/** 留言框與視窗邊緣的最小距離。 */
const VIEWPORT_MARGIN = 8
/** 留言框與圖釘中心的水平距離：圖釘半寬加上一點空隙。 */
const PIN_GAP = 18
/** 留言框上緣對齊圖釘上緣（圖釘高 24，放大後約 29）。 */
const PIN_HEIGHT = 28
/** 剩餘字數少於這個數量時才顯示計數，平常不干擾。 */
const COUNTER_THRESHOLD = 200

const props = defineProps<{
  /** 要顯示的既有留言；null 代表正在新增。 */
  comment: CommentView | null
  /** 圖釘尖端在瀏覽器視窗中的座標。 */
  anchor: { x: number; y: number }
}>()

const commentStore = useCommentStore()
const toolStore = useToolStore()

const rootRef = ref<HTMLDivElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const mode = ref<Mode>(props.comment ? 'view' : 'draft')
const text = ref('')
/** 剛被提醒過「還有文字沒送出」。文字或狀態一變就收起來。 */
const nudged = ref(false)
const shaking = ref(false)
let shakeTimer: ReturnType<typeof setTimeout> | null = null

const isEditing = computed(() => mode.value === 'draft' || mode.value === 'edit')
const trimmed = computed(() => text.value.trim())
const tooLong = computed(() => trimmed.value.length > COMMENT_MAX_LENGTH)
const showCounter = computed(() => trimmed.value.length > COMMENT_MAX_LENGTH - COUNTER_THRESHOLD)

/**
 * 有沒有離開就會遺失的文字。
 * 新增：打了任何非空白的字。編輯：內容與原本不同。
 */
const dirty = computed(() => {
  if (mode.value === 'draft') return trimmed.value.length > 0
  if (mode.value === 'edit') return trimmed.value !== props.comment?.text
  return false
})

const canSubmit = computed(
  () => trimmed.value.length > 0 && !tooLong.value && !commentStore.pending && dirty.value,
)

watch(dirty, (value) => commentStore.setDirty(value), { immediate: true })

// ── 作者與時間 ───────────────────────────────────────────────────────────────

const authorName = computed(() => {
  const author = props.comment?.author
  if (!author) return '本機留言'
  return author.displayName?.trim() || author.email
})

const createdAtIso = computed(() =>
  props.comment ? new Date(props.comment.createdAt).toISOString() : '',
)

/** 今天只顯示時間；今年省略年份；更早的才寫完整日期。 */
const createdAtLabel = computed(() => {
  if (!props.comment) return ''
  const date = new Date(props.comment.createdAt)
  const now = new Date()
  const time = date.toLocaleTimeString('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`
  const day = `${date.getMonth() + 1}/${date.getDate()}`
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${date.getFullYear()}/${day} ${time}`
})

// ── 定位 ─────────────────────────────────────────────────────────────────────

const size = ref({ width: 280, height: 0 })
const windowSize = ref({ width: window.innerWidth, height: window.innerHeight })

function measure(): void {
  const rect = rootRef.value?.getBoundingClientRect()
  if (!rect) return
  // 只在真的變了才寫入：這個函式在 onUpdated 裡被呼叫，無條件寫入會造成無限更新。
  if (rect.width !== size.value.width || rect.height !== size.value.height) {
    size.value = { width: rect.width, height: rect.height }
  }
}

function onWindowResize(): void {
  windowSize.value = { width: window.innerWidth, height: window.innerHeight }
}

/**
 * 預設在圖釘右側、上緣對齊圖釘。右邊放不下就換到左邊；上下超出視窗就往內推。
 * 圖釘被平移到視窗外時，留言框會停在視窗邊緣，不會跟著消失。
 */
const style = computed(() => {
  const { width, height } = size.value
  const { width: winW, height: winH } = windowSize.value

  let left = props.anchor.x + PIN_GAP
  if (left + width > winW - VIEWPORT_MARGIN) left = props.anchor.x - PIN_GAP - width
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, winW - width - VIEWPORT_MARGIN))

  let top = props.anchor.y - PIN_HEIGHT
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, winH - height - VIEWPORT_MARGIN))

  return { left: `${left}px`, top: `${top}px` }
})

// ── 焦點 ─────────────────────────────────────────────────────────────────────

function focusForMode(): void {
  if (isEditing.value) {
    const el = textareaRef.value
    if (!el) return
    el.focus()
    // 編輯既有內容時游標放在最後，而不是全選——全選之後多按一個鍵就整段不見。
    el.setSelectionRange(el.value.length, el.value.length)
  } else {
    // 檢視狀態沒有輸入框。把焦點放在留言框本身，Esc 才收得到。
    rootRef.value?.focus()
  }
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  measure()
  focusForMode()
})

onUpdated(measure)

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  if (shakeTimer) clearTimeout(shakeTimer)
})

watch(mode, () => {
  nudged.value = false
  void nextTick(focusForMode)
})

watch(text, () => {
  nudged.value = false
})

/**
 * store 擋下了一個會讓文字消失的操作（點畫布、點另一個圖釘）。
 * 晃一下並把焦點帶回輸入框，讓使用者知道為什麼沒反應。
 */
watch(
  () => commentStore.nudge,
  () => {
    nudged.value = true
    shaking.value = true
    if (shakeTimer) clearTimeout(shakeTimer)
    shakeTimer = setTimeout(() => {
      shaking.value = false
    }, 400)
    focusForMode()
  },
)

// ── 操作 ─────────────────────────────────────────────────────────────────────

async function submit(): Promise<void> {
  if (!canSubmit.value) return

  if (mode.value === 'draft') {
    const created = await commentStore.submitDraft(text.value)
    // 與文字工具一致：放完一個就回到選取工具。留在留言工具的話，
    // 下一次點畫布會再開一個新的留言框，多半不是使用者要的。
    if (created) toolStore.setTool(ToolType.Move)
    return
  }

  if (mode.value === 'edit' && props.comment) {
    const saved = await commentStore.updateText(props.comment.id, text.value)
    if (saved) mode.value = 'view'
  }
}

function startEdit(): void {
  if (!props.comment) return
  commentStore.clearError()
  text.value = props.comment.text
  mode.value = 'edit'
}

/**
 * 明確取消。新增時整個草稿消失，不留下任何圖釘；編輯時丟掉修改、回到檢視。
 * 這是使用者自己按的，所以即使有未送出的文字也直接放棄。
 */
function cancel(): void {
  if (commentStore.pending) return
  if (mode.value === 'draft') {
    commentStore.close()
    return
  }
  commentStore.clearError()
  mode.value = 'view'
}

/**
 * 一般的關閉（右上角的 X、檢視狀態按 Esc）。
 *
 * 走 requestClose 而不是 close：關閉不等於取消。編輯到一半按 X 時，文字不能
 * 無聲消失——store 會擋下來並提醒，使用者要明確按「取消」才會放棄修改。
 * 請求還在途中時 requestClose 同樣不會關。
 */
function closePopover(): void {
  commentStore.requestClose()
}

function toggleResolved(): void {
  if (props.comment) void commentStore.toggleResolved(props.comment.id)
}

function askDelete(): void {
  commentStore.clearError()
  mode.value = 'confirm'
}

async function confirmDelete(): Promise<void> {
  if (!props.comment) return
  // 成功的話 store 會把留言框一起關掉（這個元件隨之卸載）。
  // 失敗時回到檢視狀態，錯誤訊息顯示在留言框裡。
  const removed = await commentStore.remove(props.comment.id)
  if (!removed) mode.value = 'view'
}

function onKeydown(e: KeyboardEvent): void {
  // 留言框裡的按鍵不該傳到畫布：Delete 會刪掉選取的圖形，V / R / C 會切換工具。
  e.stopPropagation()

  if (e.key === 'Escape') {
    e.preventDefault()
    if (mode.value === 'view') closePopover()
    else cancel()
    return
  }

  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && isEditing.value) {
    e.preventDefault()
    void submit()
  }
}
</script>

<template>
  <div
    ref="rootRef"
    class="comment-popover"
    :class="{
      'comment-popover--shake': shaking,
      'comment-popover--resolved': comment?.resolved && !isEditing,
    }"
    :style="style"
    role="dialog"
    :aria-label="comment ? '留言' : '新增留言'"
    tabindex="-1"
    data-testid="comment-popover"
    @keydown="onKeydown"
  >
    <!-- 既有留言：作者與時間。新增時沒有這一列。 -->
    <header v-if="comment" class="comment-popover__header">
      <UserAvatar
        v-if="comment.author"
        :name="authorName"
        class="comment-popover__avatar"
        aria-hidden="true"
      />
      <div class="comment-popover__meta">
        <span class="comment-popover__author" data-testid="comment-author">{{ authorName }}</span>
        <time class="comment-popover__time" :datetime="createdAtIso" :title="createdAtIso">
          {{ createdAtLabel }}
        </time>
      </div>
      <span v-if="comment.resolved" class="comment-popover__badge">已解決</span>
      <button
        type="button"
        class="comment-popover__close"
        aria-label="關閉留言"
        :disabled="commentStore.pending"
        @click="closePopover"
      >
        <!-- 內嵌 SVG：專案沒有載入 primeicons 的字型，用 <i class="pi …"> 不會顯示 -->
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path
            d="M1 1L9 9M9 1L1 9"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </header>

    <!-- 新增 / 編輯 -->
    <template v-if="isEditing">
      <textarea
        ref="textareaRef"
        v-model="text"
        class="comment-popover__textarea"
        :class="{ 'comment-popover__textarea--invalid': tooLong }"
        :placeholder="mode === 'draft' ? '寫下留言…' : ''"
        :aria-label="mode === 'draft' ? '留言內容' : '修改留言內容'"
        :aria-invalid="tooLong"
        rows="3"
        data-testid="comment-input"
      />
      <p
        v-if="showCounter"
        class="comment-popover__counter"
        :class="{ 'comment-popover__counter--over': tooLong }"
      >
        {{ trimmed.length }} / {{ COMMENT_MAX_LENGTH }}
      </p>
    </template>

    <!-- 檢視 / 刪除確認：內容維持可見，確認時才知道要刪的是哪一則 -->
    <p v-else class="comment-popover__body" data-testid="comment-body">{{ comment?.text }}</p>

    <p v-if="nudged" class="comment-popover__notice" role="status">
      內容還沒送出，請先{{ mode === 'draft' ? '送出' : '儲存' }}或取消
    </p>
    <p
      v-if="commentStore.error"
      class="comment-popover__error"
      role="alert"
      data-testid="comment-error"
    >
      {{ commentStore.error }}
    </p>

    <footer class="comment-popover__actions">
      <template v-if="isEditing">
        <span class="comment-popover__hint"
          >Ctrl+Enter {{ mode === 'draft' ? '送出' : '儲存' }}</span
        >
        <div class="comment-popover__actions-right">
          <button
            type="button"
            class="comment-popover__btn"
            :disabled="commentStore.pending"
            data-testid="comment-cancel"
            @click="cancel"
          >
            取消
          </button>
          <button
            type="button"
            class="comment-popover__btn comment-popover__btn--primary"
            :disabled="!canSubmit"
            data-testid="comment-submit"
            @click="submit"
          >
            {{ mode === 'draft' ? '送出' : '儲存' }}
          </button>
        </div>
      </template>

      <template v-else-if="mode === 'confirm'">
        <span class="comment-popover__confirm">確定刪除這則留言？</span>
        <div class="comment-popover__actions-right">
          <button
            type="button"
            class="comment-popover__btn"
            :disabled="commentStore.pending"
            @click="mode = 'view'"
          >
            取消
          </button>
          <button
            type="button"
            class="comment-popover__btn comment-popover__btn--danger"
            :disabled="commentStore.pending"
            data-testid="comment-delete-confirm"
            @click="confirmDelete"
          >
            刪除
          </button>
        </div>
      </template>

      <template v-else-if="comment">
        <!-- 任何成員都能切換已解決，所以這顆按鈕不看權限旗標 -->
        <button
          type="button"
          class="comment-popover__btn comment-popover__btn--quiet"
          :disabled="commentStore.pending"
          data-testid="comment-resolve"
          @click="toggleResolved"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              :d="
                comment.resolved
                  ? 'M4.5 2L2 4.5L4.5 7M2 4.5H7.5A2.5 2.5 0 0 1 7.5 9.5H5'
                  : 'M2 6.5L4.8 9L10 3'
              "
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          {{ comment.resolved ? '重新開啟' : '標記已解決' }}
        </button>
        <div class="comment-popover__actions-right">
          <button
            v-if="comment.canEdit"
            type="button"
            class="comment-popover__btn"
            :disabled="commentStore.pending"
            data-testid="comment-edit"
            @click="startEdit"
          >
            編輯
          </button>
          <button
            v-if="comment.canDelete"
            type="button"
            class="comment-popover__btn comment-popover__btn--danger-quiet"
            :disabled="commentStore.pending"
            data-testid="comment-delete"
            @click="askDelete"
          >
            刪除
          </button>
        </div>
      </template>
    </footer>
  </div>
</template>

<style src="./CommentPopover.scss" lang="scss" />
