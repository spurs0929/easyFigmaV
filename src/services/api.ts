import { API_TIMEOUT_MS, REFRESH_MAX_RETRIES, REFRESH_RETRY_DELAY_MS } from '@/config/app'
import { apiUrl } from '@/config/env'

// 設計背景與取捨見 docs/02-auth.md。

// ─────────────────────────── 型別 ───────────────────────────

export interface User {
  id: string
  email: string
  display_name: string | null
  created_at: string
}

export interface Session {
  access_token: string
  token_type: string
  expires_in: number
  user: User
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly payload?: unknown,
  ) {
    super(detail)
    this.name = 'ApiError'
  }
}

// ─────────────────────────── 狀態 ───────────────────────────

// access token 僅保存在記憶體，不寫入 Web Storage。頁面重載後透過 HttpOnly
// refresh cookie 恢復 session，降低長期憑證被前端 JavaScript 直接讀取的風險。
let accessToken: string | null = null

// 合併同一 runtime 內的並行 refresh，避免 token rotation 互相衝突。
let refreshInFlight: Promise<Session | null> | null = null

// App 啟動期間只執行一次 silent refresh。
let bootstrapPromise: Promise<Session | null> | null = null

// 每次 session 狀態改變就遞增。飛行中的 refresh 會記下開始時的世代，
// 回來時若已不符就丟棄結果——否則登出後才回來的 refresh 會把 session 復活。
let sessionGeneration = 0

type SessionListener = (session: Session | null) => void
const listeners = new Set<SessionListener>()

/** 訂閱 session 變化。登入、輪替成功與失效時都會通知。回傳取消訂閱的函式。 */
export function onSessionChange(listener: SessionListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(session: Session | null): void {
  sessionGeneration += 1
  accessToken = session?.access_token ?? null

  for (const listener of listeners) {
    // 隔離個別 listener 的例外，否則單一訂閱者出錯會讓其餘訂閱者收不到通知，
    // 也會讓 refreshSession() 在後端其實成功的情況下 reject。
    try {
      listener(session)
    } catch (error) {
      console.error('Session listener failed', error)
    }
  }
}

export function getAccessToken(): string | null {
  return accessToken
}

// ─────────────────────────── 底層請求 ───────────────────────────

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  json?: unknown
  signal?: AbortSignal
  /** 內部使用：避免 401 重試無限遞迴。 */
  _retried?: boolean
  /** 內部使用：這個請求的 401 是預期結果，不應觸發 silent refresh。 */
  _skipRefresh?: boolean
}

function buildSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS)
  // 組合而非取代：caller 傳入自己的 signal 時，逾時仍需生效。
  return caller ? AbortSignal.any([caller, timeout]) : timeout
}

async function rawFetch(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {
    // Cookie-based auth 端點要求此 header，搭配 CORS allowlist 作為 CSRF 防護。
    'X-Requested-With': 'XMLHttpRequest',
  }

  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  if (options.json !== undefined) headers['Content-Type'] = 'application/json'

  return fetch(apiUrl(path), {
    method: options.method ?? 'GET',
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
    // refresh token 使用 cookie，跨來源請求需明確包含 credentials。
    credentials: 'include',
    signal: buildSignal(options.signal),
  })
}

async function toError(response: Response): Promise<ApiError> {
  let detail = `請求失敗（${response.status}）`
  let payload: unknown

  try {
    payload = await response.json()
    const body = payload as { detail?: unknown }
    if (typeof body.detail === 'string') {
      detail = body.detail
    } else if (Array.isArray(body.detail)) {
      // FastAPI validation error：取第一筆訊息。
      const first = body.detail[0] as { msg?: string } | undefined
      if (first?.msg) detail = first.msg
    }
  } catch {
    // 非 JSON 回應時保留預設錯誤訊息。
  }

  return new ApiError(response.status, detail, payload)
}

// ─────────────────────────── refresh ───────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function attemptRefresh(
  attempt = 0,
  generation = sessionGeneration,
): Promise<Session | null> {
  const response = await rawFetch('/auth/refresh', { method: 'POST' })

  // 409 表示 refresh token 已被其他並行請求輪替，常見於多分頁同時 refresh。
  // 後端不視為重放攻擊，因此允許短暫延遲後重試。
  if (response.status === 409 && attempt < REFRESH_MAX_RETRIES) {
    await sleep(REFRESH_RETRY_DELAY_MS * (attempt + 1))
    return attemptRefresh(attempt + 1, generation)
  }

  // 這個請求飛行期間發生過登入或登出，結果已經過期，直接丟棄。
  if (generation !== sessionGeneration) return null

  if (!response.ok) {
    // 只有後端明確表示憑證無效時才清除 session。5xx 與 429 是暫時性故障，
    // Render 免費方案冷啟動時尤其常見，當成登出會讓使用者莫名被踢出去。
    if (response.status === 401 || response.status === 403) {
      publish(null)
      return null
    }
    throw await toError(response)
  }

  const session = (await response.json()) as Session
  publish(session)
  return session
}

/** 換取新的 access token。並行呼叫共用同一個請求。 */
export function refreshSession(): Promise<Session | null> {
  refreshInFlight ??= attemptRefresh().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

/**
 * 啟動時嘗試恢復 session，整個 app 生命週期只執行一次。
 * router guard 必須 await 此 promise 再判斷登入狀態。
 */
export function ensureBootstrapped(): Promise<Session | null> {
  bootstrapPromise ??= refreshSession()
  return bootstrapPromise
}

// ─────────────────────────── 對外的請求函式 ───────────────────────────

/** 發送 API 請求。401 時共用 single-flight refresh，成功後僅重試原請求一次。 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await rawFetch(path, options)

  if (response.status === 401 && !options._retried && !options._skipRefresh) {
    const session = await refreshSession()
    if (!session) throw await toError(response)
    return apiFetch<T>(path, { ...options, _retried: true })
  }

  if (!response.ok) throw await toError(response)
  if (response.status === 204) return undefined as T

  return (await response.json()) as T
}

// ─────────────────────────── 認證端點 ───────────────────────────

export async function register(input: {
  email: string
  password: string
  display_name?: string
}): Promise<Session> {
  const session = await apiFetch<Session>('/auth/register', {
    method: 'POST',
    json: input,
    // 註冊回 401 不可能是 access token 過期，不該觸發 refresh。
    _skipRefresh: true,
  })
  publish(session)
  return session
}

export async function login(input: { email: string; password: string }): Promise<Session> {
  const session = await apiFetch<Session>('/auth/login', {
    method: 'POST',
    json: input,
    // 401 就是帳密錯誤，不該觸發 refresh。
    _skipRefresh: true,
  })
  publish(session)
  return session
}

/**
 * 登出這個裝置。
 *
 * 產品決策：無論伺服器端是否成功，都清除本機 session——使用者按下登出後，
 * 畫面不該還停在已登入狀態。
 *
 * 代價：若失敗原因是網路或伺服器問題而非 cookie 失效，refresh cookie 仍然
 * 有效，重新載入頁面會恢復登入。呼叫端可以捕捉例外並提示使用者重試。
 */
export async function logout(): Promise<void> {
  try {
    await apiFetch<void>('/auth/logout', { method: 'POST' })
  } finally {
    publish(null)
  }
}

/** 登出所有裝置。與 logout 相同的取捨。 */
export async function logoutAll(): Promise<void> {
  try {
    await apiFetch<void>('/auth/logout-all', { method: 'POST' })
  } finally {
    publish(null)
  }
}

export function fetchMe(): Promise<User> {
  return apiFetch<User>('/auth/me')
}
