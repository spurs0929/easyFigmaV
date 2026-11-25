import { FirebaseError } from 'firebase/app'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type DocumentSnapshot as FirestoreSnapshot,
} from 'firebase/firestore'
import { ApiError, requireUid } from '@/services/api'
import { db } from '@/services/firebase'

/**
 * document 對這一層是不透明的，跟 FastAPI 版一致。
 *
 * Firestore 裡存成 JSON 字串而不是巢狀物件，原因有二：
 *   1. Firestore 預設拒絕 undefined 欄位，而元素有大量 optional 欄位。
 *   2. 延續「後端不解讀文件結構」的設計，畫布格式演進不需要動資料庫或 rules。
 * 單一 Firestore 文件上限 1 MiB，rules 另外限制字串長度。
 */
export type ProjectDocument = Record<string, unknown>

/**
 * 相對於目前登入者的角色，不是專案的屬性。由 owner_id 推導。
 *
 * ⚠️ 只用來決定 UI 顯示什麼。真正的權限在 firestore.rules。
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

export interface DocumentSaved {
  document_version: number
  updated_at: string
}

const DEFAULT_NAME = '未命名專案'
const NAME_MAX_LENGTH = 120

export const projectsCol = () => collection(db, 'projects')
export const projectRef = (id: string) => doc(db, 'projects', id)

/** serverTimestamp() 剛寫入、尚未回到本機時是 null，以現在時間代替。 */
export function toIso(value: unknown): string {
  return value instanceof Timestamp ? value.toDate().toISOString() : new Date().toISOString()
}

function toSummary(snap: FirestoreSnapshot<DocumentData>, uid: string): ProjectSummary {
  const data = snap.data()!
  return {
    id: snap.id,
    name: data.name,
    document_version: data.document_version,
    created_at: toIso(data.created_at),
    updated_at: toIso(data.updated_at),
    role: data.owner_id === uid ? 'owner' : 'member',
  }
}

/**
 * 非成員讀取時 rules 會回 permission-denied。跟 FastAPI 版一樣統一回 404：
 * 「不存在」與「沒權限」對外不可區分，避免被拿來測試專案 id 是否存在。
 */
function notFoundOnDenied(error: unknown): never {
  if (error instanceof FirebaseError && error.code === 'permission-denied') {
    throw new ApiError(404, '找不到這個專案，或你沒有存取權限')
  }
  throw error
}

function normalizeName(name: string | undefined): string {
  const trimmed = (name ?? DEFAULT_NAME).trim()
  if (!trimmed || trimmed.length > NAME_MAX_LENGTH) {
    throw new ApiError(422, `專案名稱不可為空白，且最多 ${NAME_MAX_LENGTH} 個字元`)
  }
  return trimmed
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const uid = requireUid()
  // 查詢條件必須跟 rules 的 read 條件一致，Firestore 才會放行整個查詢。
  const snap = await getDocs(query(projectsCol(), where('member_ids', 'array-contains', uid)))
  // 在前端排序：搭配 orderBy 需要 array-contains + updated_at 的複合索引，
  // demo 規模下不值得多維護一份 firestore.indexes.json。
  return snap.docs
    .map((d) => toSummary(d, uid))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export async function createProject(input: {
  name?: string
  document: ProjectDocument
}): Promise<ProjectDetail> {
  const uid = requireUid()
  const name = normalizeName(input.name)
  const ref = await addDoc(projectsCol(), {
    name,
    owner_id: uid,
    member_ids: [uid],
    document: JSON.stringify(input.document),
    document_version: 0,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  })

  const now = new Date().toISOString()
  return {
    id: ref.id,
    name,
    document_version: 0,
    created_at: now,
    updated_at: now,
    role: 'owner',
    document: input.document,
  }
}

export async function getProject(id: string): Promise<ProjectDetail> {
  const uid = requireUid()
  const snap = await getDoc(projectRef(id)).catch(notFoundOnDenied)
  if (!snap.exists()) throw new ApiError(404, '找不到這個專案，或你沒有存取權限')

  let document: ProjectDocument
  try {
    document = JSON.parse(snap.data().document) as ProjectDocument
  } catch {
    throw new Error('雲端文件格式無法辨識，可能由不相容的版本建立')
  }
  return { ...toSummary(snap, uid), document }
}

/** 改名。member 也可以，且不動 document_version（它是文件內容的版本）。 */
export async function renameProject(id: string, name: string): Promise<ProjectSummary> {
  const uid = requireUid()
  await updateDoc(projectRef(id), {
    name: normalizeName(name),
    updated_at: serverTimestamp(),
  }).catch(notFoundOnDenied)
  return toSummary(await getDoc(projectRef(id)), uid)
}

/**
 * 存檔，以 transaction 實作樂觀鎖（compare-and-set）。
 *
 * transaction 內先讀版本，不符就丟 409；符合才寫入並 +1。若兩個視窗同時送出，
 * Firestore 會讓後提交的那個 transaction 重跑，重跑時讀到的已是新版本，
 * 於是一樣得到 409——跟 PostgreSQL 版 `UPDATE ... WHERE document_version = ?`
 * 的語意相同。rules 也要求 document_version 只能 +1，繞過前端也無法跳號覆蓋。
 */
export async function saveDocument(
  id: string,
  documentVersion: number,
  document: ProjectDocument,
): Promise<DocumentSaved> {
  requireUid()
  const ref = projectRef(id)
  const next = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists()) throw new ApiError(404, '找不到這個專案，或你沒有存取權限')

    const current = snap.data().document_version as number
    if (current !== documentVersion) {
      throw new ApiError(409, '這個專案已在其他視窗被修改')
    }

    tx.update(ref, {
      document: JSON.stringify(document),
      document_version: current + 1,
      updated_at: serverTimestamp(),
    })
    return current + 1
  }).catch(notFoundOnDenied)

  return { document_version: next, updated_at: new Date().toISOString() }
}

/**
 * 只有 owner 能刪。Firestore 刪除文件不會連帶刪除子集合，
 * 所以先把留言一起放進同一個 batch。
 */
export async function deleteProject(id: string): Promise<void> {
  const uid = requireUid()
  const snap = await getDoc(projectRef(id)).catch(notFoundOnDenied)
  if (!snap.exists()) throw new ApiError(404, '找不到這個專案，或你沒有存取權限')
  if (snap.data().owner_id !== uid) throw new ApiError(403, '只有專案擁有者可以刪除專案')

  const comments = await getDocs(collection(db, 'projects', id, 'comments'))
  // 單一 batch 上限 500 筆；demo 規模足夠，超過時需要分批。
  const batch = writeBatch(db)
  comments.forEach((c) => batch.delete(c.ref))
  batch.delete(projectRef(id))
  await batch.commit()
}
