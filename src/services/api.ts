import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User as FirebaseUser,
} from 'firebase/auth'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { db, firebaseAuth } from '@/services/firebase'

// firebase-demo 分支：認證改由 Firebase Authentication 負責。
//
// 原本 FastAPI 版自己實作的 access token（記憶體）、HttpOnly refresh cookie、
// refresh rotation、single-flight、session generation guard，在這裡全部交給
// Firebase SDK：它把 refresh token 存在 IndexedDB，ID token 到期前自動換新。
//
// 對外的函式名稱與型別刻意維持不變，store 與元件不需要知道背後換了實作。
// 取捨：省下自己維護 token 生命週期，代價是失去 token family、重放偵測與
// 「登出所有裝置」這類伺服器端控制（後者需要 Admin SDK，純前端做不到）。

// ─────────────────────────── 型別 ───────────────────────────

export interface User {
  id: string
  email: string
  display_name: string | null
  created_at: string
}

export interface Session {
  user: User
}

/**
 * 保留 FastAPI 版的錯誤型別：Firestore service 層把「找不到 / 沒權限 / 版本衝突」
 * 也轉成同樣的 status，store 裡判斷 404、409 的邏輯就不用改。
 */
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

type SessionListener = (session: Session | null) => void
const listeners = new Set<SessionListener>()

/** 最近一次通知出去的使用者，用來過濾 onAuthStateChanged 的重複事件。 */
let publishedUid: string | null | undefined = undefined

let bootstrapPromise: Promise<Session | null> | null = null

/** 訂閱 session 變化。登入、登出與 token 失效時都會通知。回傳取消訂閱的函式。 */
export function onSessionChange(listener: SessionListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function toUser(user: FirebaseUser): User {
  const created = user.metadata.creationTime
  return {
    id: user.uid,
    email: user.email ?? '',
    display_name: user.displayName,
    created_at: created ? new Date(created).toISOString() : new Date().toISOString(),
  }
}

function toSession(user: FirebaseUser | null): Session | null {
  return user ? { user: toUser(user) } : null
}

function publish(session: Session | null): void {
  publishedUid = session?.user.id ?? null
  for (const listener of listeners) {
    // Listener 失敗不應影響其他訂閱者與 session flow。
    try {
      listener(session)
    } catch (error) {
      console.error('Session listener failed', error)
    }
  }
}

// 其他分頁登出、refresh token 被撤銷（例如在 Console 停用帳號）時，
// SDK 會觸發這個事件。只在「換了一個人」時通知：login() 自己已經 publish 過，
// 不需要再通知一次。
onAuthStateChanged(firebaseAuth, (user) => {
  const uid = user?.uid ?? null
  if (publishedUid === undefined || uid === publishedUid) return
  publish(toSession(user))
})

/** 目前登入者的 uid。Firestore service 用來組查詢與寫入作者。 */
export function requireUid(): string {
  const uid = firebaseAuth.currentUser?.uid
  if (!uid) throw new ApiError(401, '請先登入')
  return uid
}

/** Presence 仍引用這兩個函式；Firebase 版 Presence 未啟用，回傳值不會被使用。 */
export function getAccessToken(): string | null {
  return null
}

export async function refreshSession(): Promise<Session | null> {
  return toSession(firebaseAuth.currentUser)
}

/**
 * 啟動時恢復 session，整個 app 生命週期只執行一次。
 * router guard 必須 await 此 promise 再判斷登入狀態。
 *
 * authStateReady() 會等 SDK 從 IndexedDB 讀回上次的登入狀態，
 * 角色等同 FastAPI 版的 silent refresh。
 */
export function ensureBootstrapped(): Promise<Session | null> {
  bootstrapPromise ??= firebaseAuth.authStateReady().then(() => {
    const session = toSession(firebaseAuth.currentUser)
    publishedUid = session?.user.id ?? null
    return session
  })
  return bootstrapPromise
}

// ─────────────────────────── 認證 ───────────────────────────

export async function register(input: {
  email: string
  password: string
  display_name?: string
}): Promise<Session> {
  const { user } = await createUserWithEmailAndPassword(firebaseAuth, input.email, input.password)
  if (input.display_name) {
    await updateProfile(user, { displayName: input.display_name })
  }

  // Firebase Auth 不能用 email 反查使用者（那需要 Admin SDK），
  // 邀請成員時要靠這份公開的使用者名片。
  await setDoc(doc(db, 'users', user.uid), {
    email: user.email ?? input.email,
    email_lower: (user.email ?? input.email).toLowerCase(),
    display_name: input.display_name ?? null,
    created_at: serverTimestamp(),
  })

  const session = toSession(user)!
  publish(session)
  return session
}

/**
 * 用 Google 帳號登入。第一次登入等同註冊：Firebase Auth 自動建立使用者，
 * 這裡補建 users/{uid} 名片，邀請成員時才查得到這個人。
 *
 * 用 popup 而不是 redirect：redirect 在 Firebase Hosting 以外的網域、以及
 * Safari 擋第三方 storage 時容易失敗；popup 只要使用者允許彈出視窗即可。
 */
export async function loginWithGoogle(): Promise<Session> {
  const provider = new GoogleAuthProvider()
  // 已登入過 Google 的人也讓他選帳號，共用電腦上不會直接用到別人的帳號。
  provider.setCustomParameters({ prompt: 'select_account' })

  const { user } = await signInWithPopup(firebaseAuth, provider)

  const profileRef = doc(db, 'users', user.uid)
  if (!(await getDoc(profileRef)).exists()) {
    const email = user.email ?? ''
    await setDoc(profileRef, {
      email,
      email_lower: email.toLowerCase(),
      display_name: user.displayName,
      created_at: serverTimestamp(),
    })
  }

  const session = toSession(user)!
  publish(session)
  return session
}

export async function login(input: { email: string; password: string }): Promise<Session> {
  const { user } = await signInWithEmailAndPassword(firebaseAuth, input.email, input.password)
  const session = toSession(user)!
  publish(session)
  return session
}

/** 登出這個裝置。不論成功與否，一律回到未登入狀態。 */
export async function logout(): Promise<void> {
  try {
    await signOut(firebaseAuth)
  } finally {
    publish(null)
  }
}

/**
 * 登出所有裝置。
 *
 * Firebase 用戶端 SDK 沒有撤銷其他裝置 refresh token 的 API（需要 Admin SDK 的
 * revokeRefreshTokens），這裡只能登出目前裝置。
 */
export async function logoutAll(): Promise<void> {
  await logout()
}

export async function fetchMe(): Promise<User> {
  const user = firebaseAuth.currentUser
  if (!user) throw new ApiError(401, '請先登入')
  return toUser(user)
}
