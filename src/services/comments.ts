import { apiFetch } from '@/services/api'

/**
 * 雲端專案的一則留言，欄位名稱與後端回應相同。
 *
 * 留言是專案底下的獨立資源，不在 document 裡：新增、修改、刪除都不會動到
 * document_version，所以留言不會讓正在畫圖的人存檔時收到 409。
 */
export interface CommentDto {
  id: string
  world_x: number
  world_y: number
  content: string
  resolved: boolean
  created_at: string
  updated_at: string
  author: {
    user_id: string
    display_name: string | null
    email: string
  }
  /**
   * 相對於發出請求的人，由後端推導。只決定按鈕要不要顯示，不是授權——
   * 前端不要自己判斷「我是不是作者」。
   */
  can_edit: boolean
  can_delete: boolean
}

export interface CommentCreateInput {
  world_x: number
  world_y: number
  content: string
}

/**
 * 只有這兩個欄位可以改，而且至少要帶一個。座標不可修改，帶了後端會回 422。
 *
 * 權限不同：content 只有作者能改；resolved 任何成員都能切換。
 */
export interface CommentUpdateInput {
  content?: string
  resolved?: boolean
}

/** 這個專案的所有留言，由舊到新。一次全部回傳，沒有分頁。 */
export function listComments(projectId: string): Promise<CommentDto[]> {
  return apiFetch<CommentDto[]>(`/projects/${projectId}/comments`)
}

/** 新增留言。作者一律是發出請求的人，由後端決定。 */
export function createComment(projectId: string, input: CommentCreateInput): Promise<CommentDto> {
  return apiFetch<CommentDto>(`/projects/${projectId}/comments`, { method: 'POST', json: input })
}

/**
 * 修改內容或切換已解決。
 *
 * 失敗：非作者改 content 403、留言已不存在 404、內容空白或過長 422。
 */
export function updateComment(
  projectId: string,
  commentId: string,
  input: CommentUpdateInput,
): Promise<CommentDto> {
  return apiFetch<CommentDto>(`/projects/${projectId}/comments/${commentId}`, {
    method: 'PATCH',
    json: input,
  })
}

/** 刪除留言。只有作者可以；非作者 403、留言已不存在 404。 */
export function deleteComment(projectId: string, commentId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/comments/${commentId}`, { method: 'DELETE' })
}
