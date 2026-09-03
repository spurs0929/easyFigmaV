import { apiFetch } from '@/services/api'

/**
 * document 對這一層是不透明的，跟後端一致。
 *
 * 這裡刻意不 import DocumentSnapshot：API 層只負責搬運，內容的結構與版本
 * 由 documentStorage / parseDocumentSnapshot 負責解讀。畫布格式演進時
 * 不需要動到這個檔案。
 */
export type ProjectDocument = Record<string, unknown>

export interface ProjectSummary {
  id: string
  name: string
  document_version: number
  created_at: string
  updated_at: string
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
