// ── Comment ────────────────────────────────────────────────────────────────────

export interface CanvasComment {
  id:        string
  worldX:    number
  worldY:    number
  text:      string
  resolved:  boolean
  createdAt: number
}

/** 瀏覽器安全的 UUID，與 newElementId 保持一致。 */
export function newCommentId(): string {
  return crypto.randomUUID()
}
