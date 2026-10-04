# WebSocket Presence

## Scope

Presence v1 只回答：

> 同一個 cloud project 現在有哪些使用者在線？

不做 cursor、selection synchronization 或 real-time document editing。

``` text
Presence = ephemeral state
Document = persistent state
```

兩者刻意使用不同 consistency model。

## Architecture

``` text
Server
PresenceManager
    ↑
WebSocket endpoint
    ↕
PresenceClient
    ↓
Pinia presence store
    ↓
PresenceMembers UI
```

Transport 不知道 Pinia；store 不實作 WebSocket reconnect；UI 不知道
protocol detail。

## Protocol

Endpoint：

``` text
WS /api/ws/projects/{project_id}/presence
```

Browser WebSocket 不能像 fetch 一樣自由設定 Authorization header，因此
connection accept 後的第一則 message 是 auth：

``` json
{"type":"auth","access_token":"<jwt>"}
```

Server 驗證 token、user、project membership 後才 register presence。

Token 不放 query string，避免 URL 被 proxy / access log 記錄。

代價是 unauthenticated socket 必須先被 accept，因此 server 設 auth
timeout，限制未認證 connection 佔用資源的時間。

## Origin validation

HTTP CORS middleware 不處理 WebSocket handshake，因此 endpoint 在 accept
前自己驗證 `Origin`。

v1 只支援 browser client，缺少 Origin、`null` 或不在 allowlist 的 Origin
都拒絕。

## Snapshot protocol

Server 不發 `joined` / `left` delta，而是每次狀態改變 broadcast 完整
snapshot：

``` text
presence.snapshot
  project_id
  seq
  users[]
```

### 為什麼 snapshot

Presence room 很小。Snapshot 讓 client 不需要維護 event-application
state machine：

-   漏一個 joined/left 不需要補 event。
-   reconnect 不需要 replay delta。
-   最新 snapshot 直接 replace local list。
-   user 離線只是「不在下一份 snapshot」。

代價是每次變化多傳一份小型完整名單；對 v1 room size 這比 client
consistency complexity 更便宜。

## `seq` 只負責 freshness

Async broadcast 可能讓較舊 snapshot 晚到：

``` text
seq=10 [A]
seq=11 [A,B]  → arrives first
seq=10 [A]    → arrives later
```

Client 只接受：

``` text
seq > latestSeq
```

`seq` 不是 document version，也不是 durable ordering：

-   process restart 可從頭開始。
-   每條新 socket 重設 client latestSeq。
-   只解決同一 connection lifecycle 的 snapshot freshness。

## PresenceManager data model

``` text
project
  → user
      → connections
```

名單以 user 為單位，不以 browser tab 為單位。

同一 user 開第二個 tab：

-   新增 connection。
-   user 已在線，不 broadcast「又多一個人」。

只有最後一條 connection 離開時，user 才真正離線。

## 為什麼沒有 asyncio.Lock

Manager 的 register / unregister / snapshot state mutation
是同步函式，critical section 中沒有 `await`。

Event loop 不會在純同步區段中途切換 coroutine。

Broadcast 在第一個 await 前先建立 snapshot 與 connection list
copy，再執行 network I/O。

前提也很清楚：這些同步 mutation 不應改成在 critical section 中
await，也不從其他 thread 直接修改 manager。

## Cleanup ownership

Send failure 時 manager 只 close socket，不同時移除 presence。

Endpoint 是 connection owner，統一在 `finally` unregister。

若 send path 與 endpoint 都各自 cleanup，第二次 unregister
可能無法正確判斷「這是不是 user 最後一條 connection」，造成離線 snapshot
漏 broadcast。

因此 cleanup 只有一個 authoritative entry point。

## DB session lifecycle

WebSocket connection 可能存在很久，因此不能用一個 request-style DB
dependency 讓 session 跟 socket 一樣長壽。

Authentication / membership check 使用短命 DB session，完成後回傳純
presence data，再關閉 session。

這避免每條長連線長期占用 connection pool。

## Client reconnect

PresenceClient 處理：

-   stale socket identity。
-   lifecycle generation。
-   4401 one-shot auth recovery。
-   exponential backoff。
-   runtime message validation。
-   seq filtering。

REST 401 與 WebSocket 4401 共用既有 single-flight refresh，避免兩種
transport 同時 rotation refresh token。

## Close semantics

主要 close code：

  Code   Meaning
  ------ ---------------------------------
  4400   protocol error
  4401   authentication failure
  4404   project missing or inaccessible
  4408   auth timeout
  1009   message too large
  1011   server/send failure

Project 不存在與 caller 非 member 共用 4404，延續 REST anti-enumeration
semantics。

## Failure isolation

Presence 是輔助資訊；presence failure 不應讓 editor 失效。

Reconnecting 時 UI 可以保留最後 snapshot 但標示
stale/reconnecting；protocol error 則停止，避免無限重試 client bug。

## v1 limitation

Presence registry 在 process memory：

``` text
endpoint → in-memory PresenceManager
```

因此目前假設單一 application instance。

未來可替換為：

``` text
endpoint → Redis-backed PresenceManager
```

只要 snapshot protocol 不變，client 不需要知道 state backend 已被替換。

這是 infrastructure limitation，不是 protocol limitation。

另外，feature-freeze 版本的既有 WebSocket connection 不會持續重新驗證
token / membership；若 member 在連線期間被移除，REST access
已失效，但既有 presence connection 的 runtime revocation
需要額外機制。v1 將此列為已知限制，而不是宣稱已提供 continuous
authorization。

## Testing

測試分層：

-   Manager：state transition / multi-tab semantics。
-   Endpoint：origin / auth / membership / close code / cleanup。
-   Client：reconnect / stale socket / generation / seq。
-   Store：consumer semantics。
-   Editor：lifecycle integration。
-   UI：rendering。
-   真實 uvicorn smoke：驗證實際 WebSocket protocol path。

Race condition 優先用 deterministic fake socket 測，而不是依賴真實
network timing，降低 flaky test。
