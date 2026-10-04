# API Routing and Deployment

## API boundary

Backend API 集中在 `/api` prefix 下。Frontend 與 backend
可以分開部署，而 client 只透過設定層決定 API base URL。

HTTP 與 WebSocket 共用 authentication / authorization primitives，但
transport lifecycle 不相同，因此 WebSocket 不硬套 HTTP middleware
的假設。

## CORS

Credentialed requests 使用明確 origin allowlist。

`X-Requested-With` 等非 safelisted header 會觸發 preflight，因此 CORS
設定也是 authentication security model
的一部分，而不只是「讓瀏覽器不要報錯」。

WebSocket 的 Origin 另外在 endpoint handshake 驗證；HTTP
`CORSMiddleware` 不應被假設會替 WebSocket 完成同樣保護。

## Frontend / backend 分離

Frontend 為靜態 SPA；backend 為 FastAPI web service；PostgreSQL 使用
Neon。

``` text
Browser
  ├─ static assets → frontend host
  ├─ HTTPS REST ──→ FastAPI
  └─ WSS ────────→ FastAPI presence endpoint

FastAPI ──→ Neon PostgreSQL
```

這讓 frontend deployment 與 backend runtime 可以獨立更新。

## Cold start

免費 / 低成本 deployment 可能發生 backend cold start，因此 client
不把單次 5xx / timeout 等同於 authentication failure。

Frontend request timeout 是 UX boundary：原生 `fetch` 沒有預設
timeout，如果完全不設上限，cold start 或 broken connection 可能讓 UI
永久 loading。

caller 提供的 AbortSignal 與 application timeout
必須組合，而不是二選一，否則 component 一旦傳入自己的 signal
就會意外關掉全域 timeout。

## Request body limits

大型 JSON document 需要 body-size protection。限制應在解析巨大 JSON
之前生效，並同時處理：

-   有 `Content-Length` 時的快速拒絕。
-   chunked request 的逐塊計數。
-   document-specific payload limit。

這避免 application 先把任意大小 body 全部讀入 memory 後才驗證。

## Database deployment

Database connection configuration 集中處理：

-   asyncpg scheme normalization
-   TLS policy
-   PgBouncer compatibility
-   connection health configuration

Deployment-specific secret 只透過 environment variables 注入，不寫入
repository。

## 取捨

v1 優先選擇能清楚解釋、能測試的 deployment topology，而不是提早引入
Kubernetes、Redis 或多 instance coordination。

這個選擇也直接影響 Presence：目前 in-memory presence registry 假設單一
application process；horizontal scaling 是已知 infrastructure
limitation，而不是偷偷忽略的問題。
