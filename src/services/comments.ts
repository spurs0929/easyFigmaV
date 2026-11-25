import { FirebaseError } from 'firebase/app'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  type DocumentData,
  type DocumentSnapshot,
} from 'firebase/firestore'
import { ApiError, requireUid } from '@/services/api'
import { db, firebaseAuth } from '@/services/firebase'
import { toIso } from '@/services/projects'
import { COMMENT_MAX_LENGTH } from '@/types/comment'

/**
 * 雲端專案的一則留言，欄位名稱沿用 FastAPI 版，comment store 不需要改。
 *
 * 存在 projects/{id}/comments 子集合，不在 document 裡：新增、修改、刪除都不會動到
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
  /** 只決定按鈕要不要顯示，不是授權——權限在 firestore.rules。 */
  can_edit: boolean
  can_delete: boolean
}

export interface CommentCreateInput {
  world_x: number
  world_y: number
  content: string
}

/** content 只有作者能改；resolved 任何成員都能切換。 */
export interface CommentUpdateInput {
  content?: string
  resolved?: boolean
}

const commentsCol = (projectId: string) => collection(db, 'projects', projectId, 'comments')
const commentRef = (projectId: string, id: string) => doc(db, 'projects', projectId, 'comments', id)

function toDto(snap: DocumentSnapshot<DocumentData>, uid: string): CommentDto {
  const data = snap.data()!
  const isAuthor = data.author.user_id === uid
  return {
    id: snap.id,
    world_x: data.world_x,
    world_y: data.world_y,
    content: data.content,
    resolved: data.resolved,
    created_at: toIso(data.created_at),
    updated_at: toIso(data.updated_at),
    author: data.author,
    can_edit: isAuthor,
    can_delete: isAuthor,
  }
}

function validateContent(content: string): string {
  const trimmed = content.trim()
  if (!trimmed || trimmed.length > COMMENT_MAX_LENGTH) {
    throw new ApiError(422, `留言內容不可為空白，且最多 ${COMMENT_MAX_LENGTH} 個字元`)
  }
  return trimmed
}

function deniedAs(status: number, detail: string) {
  return (error: unknown): never => {
    if (error instanceof FirebaseError && error.code === 'permission-denied') {
      throw new ApiError(status, detail)
    }
    throw error
  }
}

async function loadExisting(projectId: string, commentId: string) {
  const snap = await getDoc(commentRef(projectId, commentId)).catch(
    deniedAs(404, '找不到這個專案，或你沒有存取權限'),
  )
  if (!snap.exists()) throw new ApiError(404, '這則留言已經被刪除')
  return snap
}

/** 這個專案的所有留言，由舊到新。 */
export async function listComments(projectId: string): Promise<CommentDto[]> {
  const uid = requireUid()
  const snap = await getDocs(query(commentsCol(projectId), orderBy('created_at', 'asc'))).catch(
    deniedAs(404, '找不到這個專案，或你沒有存取權限'),
  )
  return snap.docs.map((d) => toDto(d, uid))
}

/** 新增留言。作者一律是目前登入者，rules 會驗證 author.user_id == request.auth.uid。 */
export async function createComment(
  projectId: string,
  input: CommentCreateInput,
): Promise<CommentDto> {
  const uid = requireUid()
  const user = firebaseAuth.currentUser!
  const ref = await addDoc(commentsCol(projectId), {
    world_x: input.world_x,
    world_y: input.world_y,
    content: validateContent(input.content),
    resolved: false,
    author: { user_id: uid, display_name: user.displayName, email: user.email ?? '' },
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  }).catch(deniedAs(404, '找不到這個專案，或你沒有存取權限'))
  return toDto(await getDoc(ref), uid)
}

/** 修改內容或切換已解決。非作者改 content 403、留言已不存在 404、內容不合法 422。 */
export async function updateComment(
  projectId: string,
  commentId: string,
  input: CommentUpdateInput,
): Promise<CommentDto> {
  const uid = requireUid()
  const existing = await loadExisting(projectId, commentId)

  const patch: Record<string, unknown> = { updated_at: serverTimestamp() }
  if (input.content !== undefined) {
    if (existing.data().author.user_id !== uid) {
      throw new ApiError(403, '只有留言作者可以修改內容')
    }
    patch.content = validateContent(input.content)
  }
  if (input.resolved !== undefined) patch.resolved = input.resolved

  await updateDoc(commentRef(projectId, commentId), patch).catch(
    deniedAs(403, '你沒有權限修改這則留言'),
  )
  return toDto(await getDoc(commentRef(projectId, commentId)), uid)
}

/** 刪除留言。只有作者可以；非作者 403、留言已不存在 404。 */
export async function deleteComment(projectId: string, commentId: string): Promise<void> {
  const uid = requireUid()
  const existing = await loadExisting(projectId, commentId)
  if (existing.data().author.user_id !== uid) {
    throw new ApiError(403, '只有留言作者可以刪除')
  }
  await deleteDoc(commentRef(projectId, commentId)).catch(deniedAs(403, '你沒有權限刪除這則留言'))
}
