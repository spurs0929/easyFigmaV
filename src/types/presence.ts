/**
 * Presence 協定的型別與 runtime 驗證。
 *
 * 對應後端 server/app/schemas/presence.py 與 server/app/api/presence.py。
 * WebSocket 是信任邊界：server 雖然是自己的，但 JSON 進來時沒有任何型別保證，
 * 版本不一致或 bug 都可能送來不同形狀的資料。驗證不過的訊息一律不進入狀態。
 */

export const PRESENCE_ROLES = ['owner', 'member'] as const
export type PresenceRole = (typeof PRESENCE_ROLES)[number]

export interface PresenceUser {
  user_id: string
  display_name: string | null
  role: PresenceRole
}

export const PRESENCE_SNAPSHOT_TYPE = 'presence.snapshot'

export interface PresenceSnapshot {
  type: typeof PRESENCE_SNAPSHOT_TYPE
  project_id: string
  /** 同一條連線內，數字較大的 snapshot 較新。不保證連續。 */
  seq: number
  users: PresenceUser[]
}

/** server 關閉連線時帶的 code。語意與重連策略見 server/app/api/presence.py。 */
export const PresenceCloseCode = {
  /** client 送了不符協定的訊息：是 bug，不重連。 */
  InvalidMessage: 4400,
  /** token 無效、過期或使用者不存在：最多嘗試一次 refresh。 */
  Unauthenticated: 4401,
  /** 專案不存在或不是成員（刻意不區分）：不重連。 */
  ProjectNotFound: 4404,
  /** accept 之後沒有及時送出 auth：暫時性，可重連。 */
  AuthTimeout: 4408,
} as const

/** 停止之後不會自行恢復，需要呼叫端重新 connect()。 */
export type PresenceStopReason =
  /** 4400，或 server 送來無法解讀的訊息。 */
  | 'protocol_error'
  /** 4404。 */
  | 'project_unavailable'
  /** 4401 且已用完那一次 refresh，或 refresh 判定 session 已失效。 */
  | 'unauthenticated'

export type PresenceStatus =
  /** 沒有任何連線：尚未 connect，或已經 disconnect()。 */
  | { state: 'idle' }
  /** 正在建立連線或等待認證結果。 */
  | { state: 'connecting'; projectId: string }
  /** 已通過認證並收到第一份 snapshot。 */
  | { state: 'connected'; projectId: string }
  /** 連線中斷，delayMs 之後重試。attempt 從 1 開始。 */
  | { state: 'reconnecting'; projectId: string; attempt: number; delayMs: number }
  /** 終止狀態，不會自行重連。 */
  | { state: 'stopped'; projectId: string; reason: PresenceStopReason }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPresenceUser(value: unknown): value is PresenceUser {
  return (
    isRecord(value) &&
    typeof value.user_id === 'string' &&
    value.user_id.length > 0 &&
    (value.display_name === null || typeof value.display_name === 'string') &&
    (PRESENCE_ROLES as readonly unknown[]).includes(value.role)
  )
}

/**
 * 驗證並正規化一則 snapshot。不合法時回傳 null。
 *
 * 只複製已知欄位：server 日後多送的欄位不會悄悄流進 UI 狀態。
 */
export function parsePresenceSnapshot(value: unknown): PresenceSnapshot | null {
  if (
    !isRecord(value) ||
    value.type !== PRESENCE_SNAPSHOT_TYPE ||
    typeof value.project_id !== 'string' ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 0 ||
    !Array.isArray(value.users) ||
    !value.users.every(isPresenceUser)
  ) {
    return null
  }

  return {
    type: PRESENCE_SNAPSHOT_TYPE,
    project_id: value.project_id,
    seq: value.seq as number,
    users: value.users.map(({ user_id, display_name, role }) => ({ user_id, display_name, role })),
  }
}
