# Frontend Authentication

## 分層

Frontend auth 刻意拆成 transport、state 與 routing：

``` text
router
  ↓
auth store
  ↓
API service
  ↓
FastAPI
```

API service 處理 token、refresh、retry 與 HTTP semantics；Pinia store
只維護 session state；router 只根據 store 的 ready / authenticated state
決定 navigation。

這個邊界避免 Pinia store 開始知道 refresh cookie、409 grace window 等
transport detail。

## Access token 只放 memory

Access token 不寫 localStorage / sessionStorage。頁面重整後 token
消失，再由 HttpOnly refresh cookie 執行 silent refresh。

這降低 token 長期暴露給 JavaScript storage 的風險，但不代表能「防住
XSS」：惡意 script 仍可能以使用者身分發 request，或讀取當下 memory 中的
access token。

## Bootstrap gate

Application 第一次啟動時先恢復 session，再讓 router guard 做判斷。

兩層控制不同問題：

-   API service 的 bootstrap promise：HTTP refresh 只送一次。
-   Store 的 `ready`：bootstrap 結果只套用一次。

沒有這層 gate，已登入使用者重新整理時會在 refresh 尚未完成前被誤判成
guest。

## Single-flight refresh

多個 request 同時收到 401 時只允許一個 refresh：

``` text
A → 401 ─┐
B → 401 ─┼→ one refresh → retry A/B/C
C → 401 ─┘
```

這不是單純的效能最佳化。Refresh token 會 rotation；若十個 request 各自
refresh，彼此可能使用剛被另一個 request 輪替掉的 token，甚至觸發 replay
detection。

## 409 retry

Backend grace window 會用 409 表示 refresh concurrency，而不是 session
invalid。

Client 可短暫 retry，但 retry 用盡後應拋出 error，不應 logout。409
表示競爭激烈，不表示 credential 已被撤銷。

## Session generation

Single-flight 只能解決「同一代 session 裡的併發」，無法處理：

``` text
refresh request in flight
→ user logs out
→ old refresh returns later
```

因此 session lifecycle 使用 generation / identity guard。舊世代 async
result 即使成功回來，也不能重新把已登出的 session 寫回 store。

這個模式後來也出現在 document persistence 與 Presence
client：非同步結果必須確認自己仍屬於目前 lifecycle。

## Failure semantics

只有明確代表 session invalid 的 401 / 403 才清 session。

``` text
401 / 403     → session invalid
409           → concurrency, throw/retry
429           → rate limited, throw
5xx/network   → transient failure, throw
```

這對會 cold start 的 backend 特別重要：503 不能被 UI
解讀成「你被登出了」。

## `_skipRefresh`

不是用 `/auth/*` 路徑一刀切禁止 refresh，而是只對 login / register
這種「401 本身就是業務結果」的 request 明確標記 skip。

如此 `/auth/me`、logout-all 等需要有效 access token 的 auth endpoint
仍能在 access token 過期時正常 refresh + retry。

## CSRF header

Client 統一帶 `X-Requested-With`，讓跨 origin credentialed request
先經過 CORS preflight。

代價是多 OPTIONS request；好處是規則一致，不依賴每個 caller 記得哪些
endpoint 使用 cookie credential。
