# Authentication

## 目標

認證系統採短效 access token + 可輪替 refresh token：

``` text
login / register
    ↓
access token (short-lived)
refresh token (HttpOnly cookie)
    ↓
access expires
    ↓
refresh rotation
    ↓
new access + new refresh
```

設計重點不是單純「使用 JWT」，而是限制 credential 暴露時間、處理 refresh
token replay，並讓正常的網路重試不會被誤判為攻擊。

## Password hashing：Argon2id

Password 是低熵、人類產生的 secret，因此使用 memory-hard 的
Argon2id，而不是快速 hash。

Refresh token 則是高熵、機器產生的 random secret，server 不需要用昂貴
password hash 驗證；資料庫保存的是 token hash，而非 refresh token 明文。

### 取捨

慢 password hash 能增加離線破解成本，但同時會放大登入端點的 CPU / memory
成本，因此 authentication endpoint 需要 rate limiting。安全 primitive
不能只看單一演算法，還要看它在 online request path 上造成的資源成本。

## Access token

Access token 壽命短，前端只放在 memory，不持久化到 localStorage。

JWT 驗證回答的是：

> 這個 request 代表哪一個 user？

它不回答：

> 這個 user 是否能操作這個 project？

Resource authorization 由 membership layer 另外處理。

## Refresh token rotation

每次成功 refresh 都會輪替 refresh token。舊 token
會被標記為已被替換，新的 token 屬於同一個 token family。

這使 server 能辨識：

-   正常使用最新 token。
-   舊 request 因競態稍晚抵達。
-   已輪替 token 在合理時間後再次出現的 replay。

## Grace window

瀏覽器多分頁或網路 retry 可能讓同一個舊 refresh token
幾乎同時抵達。若所有 reuse 都立即視為攻擊，正常競態就會把整個 session
family 撤銷。

因此系統提供短 grace window。

Grace 內的舊 token reuse：

``` text
→ 409 Conflict
→ 不發新的 refresh token
```

Grace 外 replay：

``` text
→ security event
→ revoke token family
```

### 為什麼 grace request 不發新 token

若兩個使用舊 token 的並行 request 都能各自取得新 token，就會產生 refresh
lineage 分叉，rotation 不再是單一鏈。

因此 grace window 的目標只是「不要把正常競態當攻擊」，不是讓舊 token
繼續具有換發能力。

## CAS 與 refresh concurrency

Refresh rotation 採 conditional update / compare-and-swap 思維，而不是先
SELECT 狀態、再於 application code 判斷、最後 UPDATE。

把「目前 token 仍可被輪替」的條件放進 database mutation，避免兩個
request 都在 SELECT 階段看到相同舊狀態。

### 取捨

`SELECT ... FOR UPDATE` 可以序列化競爭者，但會讓 request 等待 lock。CAS
讓競爭者快速失敗並由 API 語意處理，較符合 refresh 與 document save
這類「低衝突、衝突可辨識」的 workload。

## CSRF defense

Refresh credential 位於 HttpOnly cookie，因此 cookie-authenticated
endpoint 仍需要考慮 CSRF。

Client 會送 `X-Requested-With`。這不是因為惡意 JavaScript「無法設定」該
header，而是它不是 CORS safelisted header，跨來源 request 會先觸發
preflight；不在 allowlist 的 origin 無法通過。

代價是跨來源 API 多一趟 OPTIONS，但 v1 接受這個成本來換取較清楚的 CSRF
boundary。

## Session revocation

Logout / logout-all 會讓 server-side refresh state
失效。前端收到確定代表 session 無效的 401 / 403 時才清除
session；暫時性的 5xx、429 或 refresh concurrency 409 不等於 credential
已失效。

這個區分避免 deployment cold start 或短暫網路錯誤把使用者誤登出。
