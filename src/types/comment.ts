// ── Comment ────────────────────────────────────────────────────────────────────

export interface CanvasComment {
  id: string
  worldX: number
  worldY: number
  text: string
  resolved: boolean
  createdAt: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 型別守衛：驗證從 JSON / IndexedDB 反序列化的原始物件是否符合 CanvasComment 結構。
 * createdAt > 0 排除時間戳為 0 的損壞資料；isFiniteNumber 過濾 NaN / Infinity。
 * 供 comment store 與 document snapshot 驗證共用，避免重複邏輯。
 */
export function isCanvasComment(value: unknown): value is CanvasComment {
  if (!value || typeof value !== 'object') return false
  const comment = value as Record<string, unknown>
  return (
    typeof comment.id === 'string' &&
    isFiniteNumber(comment.worldX) &&
    isFiniteNumber(comment.worldY) &&
    typeof comment.text === 'string' &&
    typeof comment.resolved === 'boolean' &&
    isFiniteNumber(comment.createdAt) &&
    comment.createdAt > 0
  )
}

/** 瀏覽器安全的 UUID，與 newElementId 保持一致。 */
export function newCommentId(): string {
  return crypto.randomUUID()
}
