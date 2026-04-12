import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { type CanvasComment, newCommentId } from '@/types/comment'

const STORAGE_KEY = 'easyfigma_comments'

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

function writeToStorage(comments: readonly CanvasComment[]): void {
  try {
    if (comments.length === 0) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(comments))
  } catch (e) {
    console.error('[CommentStore] localStorage write failed', e)
  }
}

let _lifecycleBound = false
let _flushComments: (() => void) | null = null

function bindLifecycle(flush: () => void): void {
  _flushComments = flush
  if (_lifecycleBound) return

  const flushCurrent = (): void => _flushComments?.()

  window.addEventListener('beforeunload', flushCurrent)
  window.addEventListener('pagehide', flushCurrent)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushCurrent()
  })

  _lifecycleBound = true
}

export const useCommentStore = defineStore('comment', () => {
  const _comments = ref<CanvasComment[]>(loadFromStorage())

  const comments = computed<readonly CanvasComment[]>(() => _comments.value.slice())

  function flush(): void {
    writeToStorage(_comments.value)
  }

  function persist(): void {
    flush()
  }

  bindLifecycle(flush)

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
    persist()
    return comment
  }

  function updateText(id: string, text: string): boolean {
    const target = _comments.value.find((c) => c.id === id)
    if (!target) {
      if (import.meta.env.DEV) console.warn(`[CommentStore] updateText: id "${id}" does not exist`)
      return false
    }
    target.text = text
    persist()
    return true
  }

  function toggleResolved(id: string): boolean {
    const target = _comments.value.find((c) => c.id === id)
    if (!target) {
      if (import.meta.env.DEV) console.warn(`[CommentStore] toggleResolved: id "${id}" does not exist`)
      return false
    }
    target.resolved = !target.resolved
    persist()
    return true
  }

  function remove(id: string): boolean {
    const idx = _comments.value.findIndex((c) => c.id === id)
    if (idx === -1) {
      if (import.meta.env.DEV) console.warn(`[CommentStore] remove: id "${id}" does not exist`)
      return false
    }
    _comments.value.splice(idx, 1)
    persist()
    return true
  }

  return { comments, add, updateText, toggleResolved, remove, flush }
})
