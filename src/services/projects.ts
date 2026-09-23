import { apiFetch } from '@/services/api'

/**
 * document 對這一層是不透明的，跟後端一致。
 *
 * 這裡刻意不 import DocumentSnapshot：API 層只負責搬運，內容的結構與版本
 * 由 documentStorage / parseDocumentSnapshot 負責解讀。畫布格式演進時
 * 不需要動到這個檔案。
 */
export type ProjectDocument = Record<string, unknown>

/**
 * 相對於目前登入者的角色，不是專案的屬性：同一個專案，建立者拿到 'owner'，
 * 被邀請的人拿到 'member'。後端由 projects.owner_id 推導，資料庫沒有這個欄位。
 *
 * ⚠️ 只用來決定 UI 顯示什麼。權限是後端每支端點各自判斷的，前端藏起刪除按鈕
 * 只是不讓人誤按，不是安全機制。
 */
export type ProjectRole = 'owner' | 'member'

export interface ProjectSummary {
  id: string
  name: string
  document_version: number
  created_at: string
  updated_at: string
  role: ProjectRole
}

export interface ProjectDetail extends ProjectSummary {
  document: ProjectDocument
}

/** 存檔成功後只回版本與時間，不回整包 document。 */
export interface DocumentSaved {
  document_version: number
  updated_at: string
}

export function listProjects(): Promise<ProjectSummary[]> {
  return apiFetch<ProjectSummary[]>('/projects')
}

export function createProject(input: {
  name?: string
  document: ProjectDocument
}): Promise<ProjectDetail> {
  return apiFetch<ProjectDetail>('/projects', { method: 'POST', json: input })
}

export function getProject(id: string): Promise<ProjectDetail> {
  return apiFetch<ProjectDetail>(`/projects/${id}`)
}

export function renameProject(id: string, name: string): Promise<ProjectSummary> {
  return apiFetch<ProjectSummary>(`/projects/${id}`, { method: 'PATCH', json: { name } })
}

/**
 * 存檔。documentVersion 是讀取當下的版本，用來做樂觀鎖。
 * 版本不符時後端回 409，呼叫端要提示使用者重新載入而不是重試。
 */
export function saveDocument(
  id: string,
  documentVersion: number,
  document: ProjectDocument,
): Promise<DocumentSaved> {
  return apiFetch<DocumentSaved>(`/projects/${id}/document`, {
    method: 'PUT',
    json: { document_version: documentVersion, document },
  })
}

export function deleteProject(id: string): Promise<void> {
  return apiFetch<void>(`/projects/${id}`, { method: 'DELETE' })
}
