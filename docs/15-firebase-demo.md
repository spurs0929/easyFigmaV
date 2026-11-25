# 15 · Firebase Demo（firebase-demo 分支）

這個分支把後端從 **FastAPI + PostgreSQL（Render）** 換成 **Firebase Authentication + Cloud Firestore**，
前端仍是 Vue 3 + Pinia + Konva，部署在 **Firebase Hosting**。

## 換了什麼、沒換什麼

| 功能 | FastAPI 版 | Firebase 版 | 改動位置 |
|---|---|---|---|
| 註冊 / 登入 / 登出 | JWT + HttpOnly refresh cookie + rotation | Firebase Authentication（Email/Password） | `services/api.ts` |
| 雲端專案 CRUD | PostgreSQL `projects`（JSONB） | Firestore `projects/{id}`（document 存 JSON 字串） | `services/projects.ts` |
| 樂觀鎖 | `UPDATE ... WHERE document_version = ?` | `runTransaction` 比對版本 + rules 限制只能 +1 | `services/projects.ts`、`firestore.rules` |
| 成員 | `project_members` 表 | `member_ids` 陣列 + `users/{uid}` 名片 | `services/members.ts` |
| 留言 | `comments` 表 | `projects/{id}/comments` 子集合 | `services/comments.ts` |
| 授權 | `deps.py` 各端點檢查 | `firestore.rules` | `firestore.rules` |
| Presence | WebSocket | **未實作，預設關閉** | `config/app.ts` 的 `PRESENCE_ENABLED` |

**沒動的部分**：所有 Pinia store、元件、`documentBackend.ts` 的序列化存檔（drain / pending 合併）。
service 層刻意保留原本的函式簽名與 `ApiError(status)`，store 裡判斷 404 / 409 的邏輯完全沿用。

## 資料模型

```
users/{uid}
  email, email_lower, display_name, created_at

projects/{projectId}
  name, owner_id, member_ids: string[]   // 含 owner，給 array-contains 查詢
  document: string                        // JSON.stringify(DocumentSnapshot)
  document_version: number
  created_at, updated_at

projects/{projectId}/comments/{commentId}
  world_x, world_y, content, resolved
  author: { user_id, display_name, email }
  created_at, updated_at
```

`document` 存字串而非巢狀物件：Firestore 預設拒絕 `undefined` 欄位，而元素有大量 optional 欄位；
同時延續「後端不解讀文件結構」的設計。單一文件上限 1 MiB，rules 限制在 900 KB 內。

## 已知取捨

- **登出所有裝置**：Firebase 用戶端 SDK 無法撤銷其他裝置的 refresh token（需 Admin SDK），目前只登出本裝置。
- **email 可被登入者讀取**：用 email 邀請成員需要反查 uid，`users` 集合對登入者開放讀取。正式產品應改由 Cloud Functions 代查。
- **沒有 token family / 重放偵測**：交給 Firebase 管理，換來的是不必自己維護 token 生命週期。
- **刪除專案**：Firestore 不會連帶刪除子集合，`deleteProject` 用 batch 一併刪除留言（上限 500 筆）。

## 部署步驟

1. Firebase Console 建立專案（Spark 免費方案即可）。
2. Authentication → Sign-in method → 啟用 **Email/Password**。
3. Firestore Database → 建立資料庫（建議區域 `asia-east1`），以 production mode 開始。
4. 專案設定 → 新增 Web App，把 config 填進 `.env.production`（本機開發填 `.env.development.local`）。
5. 複製 `.firebaserc.example` 為 `.firebaserc`，填入專案 ID。
6. 部署：

```bash
npm i -g firebase-tools
firebase login
npm run deploy        # = npm run build && firebase deploy --only hosting,firestore:rules
```

網址為 `https://<專案ID>.web.app`。只改 rules 時用 `npm run deploy:rules`。
