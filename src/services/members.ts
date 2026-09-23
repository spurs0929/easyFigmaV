import { apiFetch } from '@/services/api'
import type { ProjectRole } from '@/services/projects'

/**
 * 成員名單上的一列。
 *
 * owner 不存在 project_members 表裡（projects.owner_id 才是唯一真相），
 * role 一律由後端推導，前端不要自己判斷誰是 owner。
 */
export interface ProjectMember {
  user_id: string
  email: string
  display_name: string | null
  role: ProjectRole
}

/** owner 與 member 都看得到名單，owner 固定在第一列。 */
export function listMembers(projectId: string): Promise<ProjectMember[]> {
  return apiFetch<ProjectMember[]>(`/projects/${projectId}/members`)
}

/**
 * 用 email 邀請一個既有帳號。只有 owner 可以。
 *
 * v1 沒有 pending invitation：查無此人就是 404，不會寄邀請信也不會留下待接受的紀錄。
 * 其他失敗：已經是成員 409、邀請 owner 自己 409、非 owner 403、太頻繁 429。
 */
export function addMember(projectId: string, email: string): Promise<ProjectMember> {
  return apiFetch<ProjectMember>(`/projects/${projectId}/members`, {
    method: 'POST',
    json: { email },
  })
}

/** 移除成員。只有 owner 可以，且不能移除 owner 自己（v1 沒有擁有權轉移）。 */
export function removeMember(projectId: string, userId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' })
}
