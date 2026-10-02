// ── Comment ────────────────────────────────────────────────────────────────────

/**
 * 留言的持久化形狀：本機草稿存進 DocumentSnapshot（IndexedDB、JSON 匯出入）的就是這個。
 *
 * 雲端專案的留言不走這裡——它們是後端的獨立資源（見 services/comments.ts），
 * 不屬於 document，也不會被寫進任何快照。
 */
export interface CanvasComment {
  id: string
  worldX: number
  worldY: number
  text: string
  resolved: boolean
  createdAt: number
}

export interface CommentAuthor {
  userId: string
  displayName: string | null
  email: string
}

/**
 * 畫面上的一則留言。元件只認這個型別，不需要知道留言來自本機還是雲端。
 *
 * 本機草稿沒有帳號的概念：author 是 null，兩個權限旗標都是 true。
 *
 * ⚠️ canEdit / canDelete 只決定按鈕要不要顯示，不是授權。雲端的值由後端依發出
 * 請求的人推導，真正的權限判斷仍在後端的端點上。
 */
export interface CommentView extends CanvasComment {
  author: CommentAuthor | null
  canEdit: boolean
  canDelete: boolean
}

/**
 * 還沒送出的留言：只有位置。
 *
 * 文字不在這裡——那是輸入框自己的狀態。送出成功之前它沒有 id、不進快照、
 * 不寫入任何儲存，取消就整個消失。
 */
export interface CommentDraft {
  worldX: number
  worldY: number
}

/** 與後端 COMMENT_CONTENT_MAX_LENGTH 相同。量的是去掉前後空白之後的長度。 */
export const COMMENT_MAX_LENGTH = 2000

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
