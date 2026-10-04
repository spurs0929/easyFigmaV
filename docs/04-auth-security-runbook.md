# Authentication Security Runbook

本文件只記錄 authentication secret / credential
事件的技術處置原則，不包含一般 deployment 操作流程。

## Secret categories

系統至少有不同用途的 secret：

-   JWT signing secret。
-   Refresh token pepper / hashing secret。
-   Database credential。
-   Sentry DSN 等 observability configuration。

不同用途的 secret 不共用同一個值，避免一個 secret 洩漏後擴大 blast
radius。

## JWT signing key rotation

若 signing key 疑似洩漏，舊 access token 在 key 失效前都可能被偽造。

處置原則：

1.  產生新的高熵 signing key。
2.  更新 production secret。
3.  redeploy / restart 讓 application 使用新 key。
4.  舊 access token 立即失效。
5.  依事件範圍評估是否同時撤銷 refresh sessions。

Access token 本來就是短效 credential，因此 rotation
的使用者影響被限制在重新取得 session。

## Refresh token secret / pepper rotation

Refresh token database 只保存 hash。若用於 token hashing 的 secret
必須更換，既有 hash 通常無法在沒有 dual-key migration 的情況下繼續驗證。

v1 的簡單、安全策略是：

``` text
rotate pepper
→ revoke existing refresh sessions
→ users sign in again
```

### 取捨

可以建立 key version / dual pepper migration 來做到無感
rotation，但會增加 credential migration
狀態與長期維護成本。對目前產品規模，強制重新登入比維護多代 secret
驗證更容易證明正確。

## Refresh replay incident

若偵測到 grace window 之外的已輪替 refresh token：

``` text
old token replay
→ security event
→ revoke token family
→ subsequent refresh denied
```

事件調查可透過 `request_id`、`family_id`、`user_id` 與 server security
log correlation。

Sentry 不應保存 credential；client IP 是否保留則依 sink 的用途決定，詳見
observability 文件。

## Credential exposure response

若 repository、log 或第三方 issue 中出現真實 credential：

1.  先撤銷 / rotate credential，不把「刪除文字」當成撤銷。
2.  再清除 repository / log / issue 中的敏感內容。
3.  檢查是否存在衍生 credential 或相同 secret reuse。
4.  驗證 production 已使用新值。
5.  檢查 structured logs 與 Sentry raw event 是否仍會重新收集該資料。

## 原則

Security runbook 的核心是：

> Secret rotation 必須讓舊 credential 真正失去授權能力。

只刪 `.env`、Git history、Sentry issue 或 dashboard 資料都不能替代
rotation / revocation。
