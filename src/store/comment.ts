import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { type CanvasComment, newCommentId } from '@/types/comment'

const STORAGE_KEY = 'easyfigma_comments'

// ── Storage ────────────────────────────────────────────────────────────────────

function isValidComment(v: unknown): v is CanvasComment {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    typeof c.worldX === 'number' &&
    Number.isFinite(c.worldX) &&
    typeof c.worldY === 'number' &&
    Number.isFinite(c.worldY) &&
    typeof c.text === 'string' &&
    typeof c.resolved === 'boolean' &&
    typeof c.createdAt === 'number' &&
    c.createdAt > 0
  )
}

function loadFromStorage(): CanvasComment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidComment)
  } catch {
    return []
  }
}

function saveToStorage(comments: CanvasComment[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(comments))
  } catch (e) {
    console.error('[CommentStore] localStorage 寫入失敗（可能超出配額）', e)
  }
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useCommentStore = defineStore('comment', () => {
  const _comments = ref<CanvasComment[]>(loadFromStorage())

  /**
   * 對外暴露唯讀清單。
   * 這裡回傳淺拷貝，確保 push/splice 後列表本身會重新求值，
   * 讓 v-for 能正確收到新增/刪除的變化。
   */
  const comments = computed<readonly CanvasComment[]>(() => _comments.value.slice())
  // 防抖寫入：累積 300ms 內的變更後再序列化。
  let _debounceTimer: ReturnType<typeof setTimeout> | null = null

  function _markDirty(): void {
    if (_debounceTimer !== null) clearTimeout(_debounceTimer)
    _debounceTimer = setTimeout(() => saveToStorage(_comments.value), 300)
  }

  /** 立即寫入，清除待執行的防抖計時器。供 beforeunload / store dispose 呼叫。 */
  function flush(): void {
    if (_debounceTimer !== null) {
      clearTimeout(_debounceTimer)
      _debounceTimer = null
    }
    saveToStorage(_comments.value)
  }

  // 頁面關閉前強制同步，避免丟失最後 300ms 內的變更
  window.addEventListener('beforeunload', flush, { once: false })

  // ── 新增 ───────────────────────────────────────────────────────────────────

  function add(worldX: number, worldY: number): CanvasComment {
    const comment: CanvasComment = {
      id: newCommentId(),
      worldX,
      worldY,
      text: '',
      resolved: false,
      createdAt: Date.now(),
    }
    _comments.value.push(comment)
    _markDirty()
    return comment
  }

  // ── 更新文字 ────────────────────────────────────────────────────────────────

  function updateText(id: string, text: string): boolean {
    const target = _comments.value.find((c) => c.id === id)
    if (!target) {
      if (import.meta.env.DEV) console.warn(`[CommentStore] updateText: id "${id}" 不存在`)
      return false
    }
    target.text = text
    _markDirty()
    return true
  }

  // ── 切換解決狀態 ────────────────────────────────────────────────────────────

  function toggleResolved(id: string): boolean {
    const target = _comments.value.find((c) => c.id === id)
    if (!target) {
      if (import.meta.env.DEV) console.warn(`[CommentStore] toggleResolved: id "${id}" 不存在`)
      return false
    }
    target.resolved = !target.resolved
    _markDirty()
    return true
  }

  // ── 刪除 ───────────────────────────────────────────────────────────────────

  function remove(id: string): boolean {
    const idx = _comments.value.findIndex((c) => c.id === id)
    if (idx === -1) {
      if (import.meta.env.DEV) console.warn(`[CommentStore] remove: id "${id}" 不存在`)
      return false
    }
    _comments.value.splice(idx, 1)
    _markDirty()
    return true
  }

  return { comments, add, updateText, toggleResolved, remove, flush }
})
