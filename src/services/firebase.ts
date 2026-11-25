import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { FIREBASE_CONFIG } from '@/config/env'

/**
 * Firebase 的唯一初始化點。
 *
 * firebase-demo 分支以 Firebase Authentication + Firestore 取代 FastAPI + PostgreSQL。
 * 這份 config 會編進前端 bundle，本來就是公開資訊；資料能不能被讀寫，
 * 由 firestore.rules 決定，不是靠藏住 apiKey。
 */
export const firebaseApp = initializeApp(FIREBASE_CONFIG)
export const firebaseAuth = getAuth(firebaseApp)
export const db = getFirestore(firebaseApp)
