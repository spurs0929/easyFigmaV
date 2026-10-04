# v1 Architecture and Boundaries

## v1 定位

easyFigmaV v1 是一個具有完整 authentication、cloud
persistence、membership 與 online presence 的多人專案系統。

它不是 real-time collaborative document editor。

這個邊界是架構決策，不是「協作做到一半」。

## Core flow

``` text
Authentication
      ↓
Project Membership
      ↓
 ┌────┴─────────────┐
 │                  │
REST CRUD       WebSocket
 │                  │
Persistent       Presence
Document          Snapshot
 │                  │
PostgreSQL       In-memory
```

## Persistent state 與 ephemeral state 分離

### Document

Document 必須：

-   process restart 後仍存在。
-   以 PostgreSQL 保存。
-   使用 `document_version` optimistic locking。
-   在 conflict 時保護較新的 server state。

### Presence

Presence 可以：

-   process restart 後消失。
-   reconnect 後重建。
-   只關心最新 snapshot。
-   不寫入 database。

因此：

``` text
document_version = persistent concurrency
presence seq      = transport freshness
```

不能因為兩者都叫「版本 / 序號」就混用。

## Membership 是 REST 與 WebSocket 的共同 authorization foundation

Project access 集中成 owner/member predicate。

REST 用它保護 project / comment resource；WebSocket 在建立 presence
connection 時也使用相同 membership semantics。

這避免 HTTP 與 WebSocket 各自長出不同的「誰可以進 project」規則。

## 為什麼 v1 不做 operation-based collaboration

真正的 real-time document editing 不是「把目前 PUT document 改成
WebSocket send」就完成。

Server-authoritative operation model 會連帶需要：

-   operation schema。
-   ordering / sequence allocation。
-   idempotency。
-   reconnect replay。
-   snapshot 與 operation checkpoint 對齊。
-   optimistic apply / reconcile。
-   undo/redo semantics 改寫。
-   conflict semantics。
-   operation log retention / compaction。
-   多 instance coordination。

這會改變 editor mutation path 與 persistence
model，而不是一個可以安全塞進 Presence feature 的小延伸。

v1 因此保留 snapshot document persistence，Presence 只解決 ephemeral
online state。

## 為什麼沒有 CRDT

目前產品需求沒有離線多人 merge、任意順序 operation convergence
等必須使用 CRDT 的要求。

在需求尚未成立前導入 CRDT 會同時增加：

-   document model complexity。
-   debugging complexity。
-   persistence format complexity。
-   undo/redo complexity。
-   test state space。

v1 先用 optimistic locking 明確偵測 document conflict，而不是假裝
conflict 不存在。

## 為什麼沒有 Redis

Current PresenceManager 是明確的 infrastructure boundary：

``` text
WebSocket endpoint
      ↓
PresenceManager interface / behavior
      ↓
in-memory state
```

單 instance deployment 不需要 external coordination。

Horizontal scaling 時才需要 Redis / pub-sub / distributed presence
TTL。提早加入 Redis 只會增加 deployment、failure mode 與 local
development complexity，卻沒有解決目前存在的產品問題。

## 為什麼 membership 不直接做 RBAC

v1 capability 只有：

``` text
owner  → read/edit/manage/delete
member → read/edit
```

這時加入 admin/editor/viewer/custom permission 會要求 role
schema、permission matrix、migration、UI 與更多 authorization tests。

Owner/member 已足以支撐目前 collaboration boundary，因此 role 先維持
derived semantics。

## Consistency choices

系統不是所有地方都追求同一種 consistency：

  Area                Strategy                      Reason
  ------------------- ----------------------------- -----------------------------
  refresh rotation    CAS + grace                   concurrent browser requests
  document save       optimistic locking            low expected write conflict
  cloud autosave      single-flight + latest wins   snapshot semantics
  presence            full snapshot + seq           ephemeral small state
  membership insert   DB PK constraint              race-safe uniqueness
  comment delete      mutation rowcount check       TOCTOU race

這些不是不同工程師各寫一套，而是依 resource 的持久性、衝突成本與
workload 選擇不同保證。

## Security boundary

主要安全原則：

-   authentication 與 resource authorization 分離。
-   outsider 使用 404 anti-enumeration semantics。
-   owner-only operation 對已知 resource 的 member 使用 403。
-   WebSocket Origin 在 handshake 層另外驗證。
-   refresh credential 不放 JavaScript storage。
-   structured log / Sentry 不記錄 credential。
-   security-relevant invariant 同時考慮 application 與 database
    boundary。

## Known v1 limitations

v1 刻意接受：

-   Presence 只支援 single-instance in-memory coordination。
-   沒有 real-time document operation synchronization。
-   沒有 CRDT。
-   沒有 Redis。
-   沒有完整 RBAC。
-   沒有 pending invitation / email invitation workflow。
-   cloud unload flush 是 best-effort。
-   Presence connection 建立後不提供完整 continuous membership
    revalidation。

這些限制應被視為 architecture boundary，而不是 README 裡藏起來的 TODO。

## Extension direction

若未來需求真的進入多人同步編輯，較自然的演進順序是：

``` text
existing membership / auth
        ↓
operation protocol
        ↓
server ordering + idempotency
        ↓
snapshot checkpoint
        ↓
reconnect replay / reconcile
        ↓
distributed coordination if scaling requires it
```

Presence protocol 可以維持獨立，因為「誰在線」與「document operation
如何一致」本來就是不同 concern。
