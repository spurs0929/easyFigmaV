# Cloud Persistence

## 核心抽象：DocumentBackend

Editor store 不直接綁死 IndexedDB 或 HTTP，而是依賴小型 persistence
interface：

``` ts
interface DocumentBackend {
  readonly kind: 'local' | 'cloud'
  readonly available: boolean
  readonly debounceMs: number
  load(): Promise<DocumentSnapshot | null>
  save(snapshot: DocumentSnapshot): Promise<void>
}
```

``` text
document store
    ↓
DocumentBackend
   ↙       ↘
local     cloud
IndexedDB HTTP + document_version
```

## 為什麼只抽這一層

既有 local storage abstraction 本來就已經是 persistence seam，因此加入
cloud backend 不需要重寫 editor state machine。

刻意沒有建立大型 `PersistenceManager` / Strategy factory
hierarchy。只有兩種 backend、共同介面很小，多一層 abstraction
目前只會增加理解成本。

## Debounce 不等於 serialization

Debounce 只能保證「停止變更一段時間後才送」，不能保證上一個 save
已完成。

慢網路下可能發生：

``` text
PUT expected=10 ────────────────>
        user edits
        debounce expires
PUT expected=10 ───────>
first request commits → version 11
second request → 409
```

這是 client 自己跟自己衝突。

## Single-flight + latest-value coalescing

Cloud backend 同時只允許一個 PUT in flight。期間產生的新 snapshot
只保留最新一份：

``` text
A ───────────────────> save
    B → C → D
                     D ───────> save
```

不是 queue B/C/D。

### 取捨

Autosave 保存的是完整 snapshot。中間 snapshot
沒有獨立業務價值；排隊只會增加 network / database load，並讓 client
越存越落後。

Latest-wins coalescing 更符合 snapshot persistence 的語意。

## Conflict 與 transient failure 分開

409 表示 backend 已經知道 client 的 version
stale。此時不能繼續拿同一個舊 version 硬送 pending snapshot。

Network / 5xx 則不代表 version 一定失效，因此不永久鎖死 backend。

## Generation guard

切換 project 時，舊 project 的 async load/save 可能晚回來。

只在 async function 開始時檢查 project id 不夠，因為 await 期間
lifecycle 已經可能改變。Guard 必須放在真正修改 store / 建立 watcher /
觸發 side effect 的 commit point 前。

``` text
start A
await A.load()
switch to B
B loaded
A returns late
→ generation mismatch
→ discard A result
```

這避免把 A 的 document 套到 B，甚至被 B 的 autosave watcher 存回 B。

## Load failure 不得觸發 upload

Cloud project load 失敗時不能把 store 當下殘留內容視為「初始
document」再 autosave，否則讀取失敗可能反過來覆寫 server。

因此 persistence lifecycle 只有在 cloud load 成功且仍屬於目前 generation
時才啟動 save watcher。

## Page lifecycle

`visibilitychange`、`pagehide`、`beforeunload` 可嘗試 flush，但 browser
對 unload 階段的 async request 沒有 durability guarantee。

`sendBeacon` 也不是直接替代方案：目前 save 需要 Authorization 與 server
回傳的新 `document_version`。為了最後 1 個 debounce window 另做
cookie-auth save protocol，v1 認為成本大於收益。

因此 unload flush 明確定義為 best-effort。
