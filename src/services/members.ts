import { FirebaseError } from 'firebase/app'
import {
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  updateDoc,
  where,
} from 'firebase/firestore'
import { ApiError, requireUid } from '@/services/api'
import { db } from '@/services/firebase'
import { projectRef, type ProjectRole } from '@/services/projects'

/**
 * 成員名單上的一列。
 *
 * owner 也在 member_ids 裡（array-contains 查詢需要），但 owner_id 才是誰是 owner
 * 的唯一真相，role 一律由 owner_id 推導。
 */
export interface ProjectMember {
  user_id: string
  email: string
  display_name: string | null
  role: ProjectRole
}

interface ProjectAccess {
  ownerId: string
  memberIds: string[]
}

async function loadAccess(projectId: string): Promise<ProjectAccess> {
  try {
    const snap = await getDoc(projectRef(projectId))
    if (!snap.exists()) throw new ApiError(404, '找不到這個專案，或你沒有存取權限')
    const data = snap.data()
    return { ownerId: data.owner_id, memberIds: data.member_ids }
  } catch (error) {
    if (error instanceof FirebaseError && error.code === 'permission-denied') {
      throw new ApiError(404, '找不到這個專案，或你沒有存取權限')
    }
    throw error
  }
}

async function loadMember(userId: string, ownerId: string): Promise<ProjectMember> {
  const snap = await getDoc(doc(db, 'users', userId))
  const data = snap.data()
  return {
    user_id: userId,
    email: data?.email ?? '（已刪除的帳號）',
    display_name: data?.display_name ?? null,
    role: userId === ownerId ? 'owner' : 'member',
  }
}

/** owner 與 member 都看得到名單，owner 固定在第一列。 */
export async function listMembers(projectId: string): Promise<ProjectMember[]> {
  requireUid()
  const { ownerId, memberIds } = await loadAccess(projectId)
  const ordered = [ownerId, ...memberIds.filter((id) => id !== ownerId)]
  return Promise.all(ordered.map((id) => loadMember(id, ownerId)))
}

/**
 * 用 email 邀請一個既有帳號。只有 owner 可以（rules 也會擋）。
 * 查無此人 404、已經是成員 409，與 FastAPI 版相同。
 */
export async function addMember(projectId: string, email: string): Promise<ProjectMember> {
  const uid = requireUid()
  const { ownerId, memberIds } = await loadAccess(projectId)
  if (ownerId !== uid) throw new ApiError(403, '只有專案擁有者可以管理成員')

  const found = await getDocs(
    query(
      collection(db, 'users'),
      where('email_lower', '==', email.trim().toLowerCase()),
      limit(1),
    ),
  )
  const target = found.docs[0]
  if (!target) throw new ApiError(404, '找不到使用這個 Email 的帳號')
  if (target.id === ownerId) throw new ApiError(409, '你已經是這個專案的擁有者')
  if (memberIds.includes(target.id)) throw new ApiError(409, '這個帳號已經是成員')

  await updateDoc(projectRef(projectId), { member_ids: arrayUnion(target.id) })
  return loadMember(target.id, ownerId)
}

/** 移除成員。只有 owner 可以，且不能移除 owner 自己。 */
export async function removeMember(projectId: string, userId: string): Promise<void> {
  const uid = requireUid()
  const { ownerId } = await loadAccess(projectId)
  if (ownerId !== uid) throw new ApiError(403, '只有專案擁有者可以管理成員')
  if (userId === ownerId) throw new ApiError(409, '不能移除專案擁有者')
  await updateDoc(projectRef(projectId), { member_ids: arrayRemove(userId) })
}
