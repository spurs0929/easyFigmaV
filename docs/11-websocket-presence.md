# WebSocket Presence

## Scope

Presence v1 回答兩個問題：

> 同一個 cloud project 現在有哪些使用者在線？
>
> 他們的游標在畫布的哪裡？

兩者都是 collaboration awareness，不是 document collaboration。

v1 **沒有實作**共同文件編輯、selection synchronization、OT、CRDT 或
operation-based document synchronization。看得到別人的游標，不代表
兩個人可以同時編輯同一份文件而不衝突；document 仍然只透過 REST 與
`document_version` optimistic locking 儲存（見
[Cloud Persistence](07-cloud-persistence.md)）。

```text
Presence / Cursor = ephemeral state
Document          = persistent state
```

兩者刻意使用不同 consistency model。

## Architecture

```text
Server
PresenceManager
    ↑
WebSocket endpoint
    ↕
PresenceClient                 ← 唯一的 socket owner
    ↓            ↑
Pinia presence store           ← users / status / cursors
    ↓            ↑
PresenceMembers   RemoteCursors      CanvasArea
（在線名單）      （別人的游標）     （回報自己的游標）
```

Transport 不知道 Pinia；store 不實作 WebSocket reconnect 或 throttle；UI
不知道 protocol detail。

Cursor 與在線名單共用同一條 WebSocket，沒有第二條 socket，也沒有第二套
reconnect / auth lifecycle。

## Protocol

Endpoint：

```text
WS /api/ws/projects/{project_id}/presence
```

Browser WebSocket 不能像 fetch 一樣自由設定 Authorization header，因此
connection accept 後的第一則 message 是 auth：

```json
{ "type": "auth", "access_token": "<jwt>" }
```

Server 驗證 token、user、project membership 後才 register presence。

Auth 之後的完整 message 集合：

| Direction       | Type                    | Purpose                  |
| --------------- | ----------------------- | ------------------------ |
| client → server | `auth`                  | 第一則，且只能一則       |
| client → server | `cursor.move`           | 自己的游標位置           |
| client → server | `cursor.leave`          | 游標離開畫布             |
| server → client | `presence.snapshot`     | 完整在線名單             |
| server → client | `presence.cursor`       | 某個使用者的游標位置     |
| server → client | `presence.cursor.leave` | 某個使用者的游標離開畫布 |

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

```text
presence.snapshot
  project_id
  seq
  users[]
```

### 為什麼 snapshot

Presence room 很小。Snapshot 讓 client 不需要維護 event-application
state machine：

- 漏一個 joined/left 不需要補 event。
- reconnect 不需要 replay delta。
- 最新 snapshot 直接 replace local list。
- user 離線只是「不在下一份 snapshot」。

代價是每次變化多傳一份小型完整名單；對 v1 room size 這比 client
consistency complexity 更便宜。

## `seq` 只負責 freshness

Async broadcast 可能讓較舊 snapshot 晚到：

```text
seq=10 [A]
seq=11 [A,B]  → arrives first
seq=10 [A]    → arrives later
```

Client 只接受：

```text
seq > latestSeq
```

`seq` 不是 document version，也不是 durable ordering：

- process restart 可從頭開始。
- 每條新 socket 重設 client latestSeq。
- 只解決同一 connection lifecycle 的 snapshot freshness。

## Cursor protocol

```text
client → server
  cursor.move   { x, y }
  cursor.leave  { }

server → client
  presence.cursor        { project_id, user_id, x, y }
  presence.cursor.leave  { project_id, user_id }
```

設計重點：

- **Identity 由 authenticated connection 決定。** Client 訊息裡沒有
  `user_id`；server 用這條連線認證時的身分填入。訊息若自帶 `user_id`
  會因為多餘欄位被視為 protocol error，client 無法替別人送游標。
- **座標是 canvas world coordinate**，不是 screen coordinate。每個人的
  pan / zoom 都不同，只有 world 座標在所有 client 上指的是同一個位置。
- **Validation**：`x` / `y` 必須是有限數字（JSON integer 可接受；字串、
  boolean、null、NaN、±Infinity 都拒絕），不允許多餘欄位，單則訊息上限
  256 字元。不符合一律以 4400 關閉連線。
- **不 echo 給 sender。** 排除的單位是 user：sender 自己的其他分頁也
  不會收到。
- **Cursor 以 user 為單位**，與在線名單相同。同一 user 的多條
  connection 轉發時帶的是同一個 `user_id`，而接收端的 store 以
  `user_id` 為 cursor key，所以不同分頁送出的 cursor update 會更新
  同一個 remote cursor，由接收端最後收到並處理的那一則決定目前顯示的
  位置。這是接收端覆寫同一個 key 的結果，不是 server-side
  last-write-wins：server 不保存任何 cursor position。
- **Server 不保存 cursor position。** 這是純轉發；晚加入或重連的
  client 要等對方再次移動才看得到游標。
- **Cursor 不影響 presence `seq`。** 名單沒有變，`seq` 只屬於
  snapshot。
- **離線只由 snapshot 表達。** Connection 關閉時 server 不會送
  `presence.cursor.leave`；user 的最後一條連線離開後，他會從下一份
  snapshot 消失，client 以名單為準移除游標。
  `presence.cursor.leave` 只在 client 主動送出 `cursor.leave` 時產生。

### Cursor relay 與 backpressure

Sender 的 receive loop 不等待任何 recipient。`PresenceManager.relay()`
是同步函式，只把訊息放進每條收件連線的 outbox 就返回：

```text
recipient connection
  → outbox: { sender user_id → latest cursor message }
  → 至多一個 drain task
```

- 每個 sender 在每個 outbox 只佔一格，新的覆蓋舊的；`move` 與 `leave`
  共用同一格。
- Recipient 跟得上時每一則都會送出；跟不上時跳過中間位置，直接送
  最新的。
- Pending work 有上限且與訊息頻率無關：每個 outbox ≤ room 內其他 user
  數，drain task ≤ connection 數。
- Unregister 時取消該連線的 drain task 並移除 outbox；user 離線時，
  其他人 outbox 裡尚未送出的、他的游標也一併丟棄。
- Send failure 沿用既有規則：close（1011）但不 unregister，之後不再
  替那條連線排入任何訊息。

Cursor 是 latest-state 而不是 event stream，所以這裡選擇 coalescing，
而不是 queue。

## PresenceManager data model

```text
project
  → user
      → connections
```

名單以 user 為單位，不以 browser tab 為單位。

同一 user 開第二個 tab：

- 新增 connection。
- user 已在線，不 broadcast「又多一個人」。

只有最後一條 connection 離開時，user 才真正離線。

## 為什麼沒有 asyncio.Lock

Manager 的 register / unregister / snapshot state mutation
是同步函式，critical section 中沒有 `await`。

Event loop 不會在純同步區段中途切換 coroutine。

Broadcast 在第一個 await 前先建立 snapshot 與 connection list
copy，再執行 network I/O。Cursor 的 `relay()` 本身就是同步函式，network
I/O 發生在各連線自己的 drain task。

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

- stale socket identity。
- lifecycle generation。
- 4401 one-shot auth recovery。
- exponential backoff。
- runtime message validation。
- seq filtering。

REST 401 與 WebSocket 4401 共用既有 single-flight refresh，避免兩種
transport 同時 rotation refresh token。

Cursor 沒有改動 reconnect、backoff、auth recovery 或 generation
機制：cursor message 不會讓連線變成 connected，也不會重設 retry state。

## Client message routing

PresenceClient 先看 `type` 再決定交給哪個 parser。不同情況的處理刻意
不同：

| Incoming message                               | Behaviour             |
| ---------------------------------------------- | --------------------- |
| 非文字、非 JSON、不是 object、沒有字串 `type`  | protocol error → stop |
| `presence.snapshot` 格式錯誤或屬於別的 project | protocol error → stop |
| cursor message 格式錯誤或屬於別的 project      | 只丟棄該則            |
| 第一份 valid snapshot 之前收到的 cursor        | 丟棄                  |
| 不認得的 `type`                                | 忽略                  |

為什麼 snapshot 與 cursor 採不同 failure semantics：

- **Snapshot 是 authoritative presence state。** 壞掉的名單不能顯示，
  也沒有東西可以修正它，所以停止。
- **Cursor 是 ephemeral / best-effort UI state。** 單一 cursor packet
  壞掉不應讓在線名單一起失效；下一則 cursor 自然會覆蓋它。
- **未知 type 忽略**，讓 server 之後新增 message type 時，尚未更新的
  client 不會失去既有功能。

無法辨識成 message 的資料（非 JSON、沒有合法 `type`）仍然停止：此時
雙方對 message 的基本形狀已經不一致，沒有任何內容可信。

## Client cursor lifecycle

送出：

- 只有 `connected`（已收到第一份 snapshot）時才送。connecting、
  reconnecting、stopped、idle 一律丟棄，不排隊到連線恢復之後。
- Local draft（`/`）沒有 presence connection，狀態是 idle，因此不送。
- 非有限的座標不送（server 會以 4400 關閉整條連線）。

接收與清理（presence store）：

- Cursor 以 `user_id` 為 key 保存，後到的位置覆蓋前一個。
- **不接受目前在線名單之外的 cursor**：直接丟棄，不先存起來。
  Cursor 與 snapshot 的抵達順序沒有保證，先存起來的話，對方重新上線
  時會出現舊位置。
- 新的 snapshot 會移除已離線成員的 cursor。
- 收到 `presence.cursor.leave` 移除該 user 的 cursor；之後再收到
  `presence.cursor` 就重新出現。
- Status 只要不是 `connected` 就清空所有 cursor。Reconnecting 期間
  在線名單會保留（標示為可能過期），cursor 不保留：位置停在斷線前
  就是錯的，而且 server 不會在重連後補送。
- Project change、`disconnect()`、logout / session invalidation 都會
  清空 cursor。
- Disconnect、socket close、換 project 時，transport 會丟掉尚未送出
  的 pending cursor 與 throttle timer，不會帶到下一條連線。
- **不做 idle timeout。** 滑鼠停著不動是正常狀態，游標會留在原地。

## Cursor throttle

Client 是唯一的節流點（server 沒有 rate limiting）：

- 間隔 50ms（`PRESENCE_CURSOR_THROTTLE_MS`），約 20 則 / 秒。
- **Leading + trailing**：第一次更新立刻送出；window 內的後續更新
  不送，window 結束時補送最後一次，並開始下一個 window。
- 同一個 window 只保留最後一次 cursor update。
- `cursor.move` 與 `cursor.leave` 共用同一個 throttle slot，所以最後
  送出的一定是最後的狀態。例如同一個 window 內 `move A → move B →
leave → move C`，實際送出 `move A`、`move C`。
- **Pending leave 遇到 disconnect / teardown 會被丟棄。** 這是
  intentional best-effort semantics：不使用 ACK、retry 或 queue 來保證
  leave 送達。連線結束後，server 會在該 user 的最後一條連線離開時
  送出新的 snapshot，其他 client 由此移除游標。

## Coordinate and rendering

Outbound：

- `CanvasArea` 監聽 `document` 的 `mousemove`，以**畫布的 spatial
  region**（canvas container 的矩形）判斷滑鼠是否在畫布上，而不是看
  滑鼠底下是哪個 DOM element。
- 在矩形內：把 client 座標換成 world 座標（`viewportStore.toWorld()`）
  回報。在矩形外、或滑鼠離開 browser window：送一次 leave。
- Comment pin、comment popover、text edit overlay、context menu 都
  Teleport 到 body 並疊在畫布上。滑鼠移到它們上面仍然算在畫布上，
  不會送出 `cursor.leave`，游標位置也會繼續更新——這些 UI 用 DOM
  還是用 Konva 實作，不應改變 cursor presence 的語意。
- Wheel pan / zoom 時滑鼠沒有移動，但指到的 world position 已經
  不同，因此補送一次（`pointerWorld()`），同樣經過 throttle。

Transport 一律使用 world coordinate。

Remote rendering（`RemoteCursors`）：

```text
screen = world × scale + viewport offset
```

- 使用獨立的 DOM overlay，不進任何 Konva layer。
- Overlay 以 Teleport 掛到 body，並與 canvas spatial region 對齊、
  裁切超出畫布的部分。
- Viewport 是 reactive state：自己 pan / zoom 時，別人的游標跟著
  畫布移動，仍然指向同一個 world position。
- `pointer-events: none`，z-index 低於 comment overlay。
- 不畫自己的游標；只畫目前在線名單中、而且有位置的 user。
- 顯示 `display_name`；顏色由 `user_id` deterministic hash 到固定的
  12 色 palette。
- 沒有 smoothing / interpolation / CSS transition。

## Persistence boundary

Cursor 只存在於 presence store 的記憶體，不進入：

- document JSON
- PostgreSQL document state（server 也不保存 cursor position）
- IndexedDB
- localStorage
- autosave
- `document_version`
- undo history
- selection / transform / hit-test

Document snapshot 只由 element store 與 comment store 組成，undo history
屬於 element store；cursor 不在這兩者之中。Remote cursor 是 DOM overlay
而不是 Konva node，所以結構上不可能被選取、變形或存進文件。

Presence / Cursor 是 ephemeral collaboration awareness，與 persistent
document collaboration 是不同問題。

## Close semantics

主要 close code：

Code Meaning

---

4400 protocol error（含不合法的 cursor message）
4401 authentication failure
4404 project missing or inaccessible
4408 auth timeout
1009 message too large
1011 server/send failure

Project 不存在與 caller 非 member 共用 4404，延續 REST anti-enumeration
semantics。

## Failure isolation

Presence 是輔助資訊；presence failure 不應讓 editor 失效。

Reconnecting 時 UI 可以保留最後 snapshot 但標示
stale/reconnecting；protocol error 則停止，避免無限重試 client bug。

Cursor 再多一層隔離：cursor message 的錯誤不會影響在線名單（見
Client message routing）。

## v1 limitation

Presence registry 在 process memory：

```text
endpoint → in-memory PresenceManager
```

因此目前假設單一 application instance。

未來可替換為：

```text
endpoint → Redis-backed PresenceManager
```

只要 protocol 不變，client 不需要知道 state backend 已被替換。

這是 infrastructure limitation，不是 protocol limitation。Multi-instance
的 presence / cursor synchronization 不在 v1 scope：不同 instance 上的
使用者彼此看不到對方，也收不到對方的游標。

另外，feature-freeze 版本的既有 WebSocket connection 不會持續重新驗證
token / membership；若 member 在連線期間被移除，REST access
已失效，但既有 presence connection 的 runtime revocation
需要額外機制。v1 將此列為已知限制，而不是宣稱已提供 continuous
authorization。

Cursor 讓這個限制涵蓋的資訊變多：被移除的 member 在既有 socket 關閉
之前，除了仍留在名單上、仍收得到名單，也仍收得到其他人的游標位置，
他自己的游標也仍會被轉發。Server 不會在每則 cursor message 重新查
membership。這段時間沒有上限，直到那條 socket 因任何原因關閉；之後
reconnect 會被 4404 拒絕。

### Cursor limitations

- **Server 沒有 cursor rate limiting。** 正常 client 自己節流；不守
  規矩的 client 可以送得更快。Outbox coalescing 限制了 server 端的
  pending work，但不限制 inbound 頻率。
- **Cursor position 不保存。** 晚加入或重連後，要等對方再次移動才
  看得到游標。
- **Cursor 與 snapshot 之間沒有 cross-message-type ordering
  guarantee。** 兩者走不同的送出路徑；user 離線時，已在傳送途中的
  cursor 可能比「他已離線」的 snapshot 晚到。Client 以名單為準，
  丟棄名單外的 cursor。
- **Multi-tab pending leave。** 同一 user 還有其他分頁保持連線時，
  若某個分頁的 pending `cursor.leave` 因 disconnect 被丟棄（或分頁
  直接關閉），user 仍然在線，其他人畫面上的游標會停在最後位置，
  直到該 user 的任一分頁再送出 cursor，或他完全離線。
- **顏色可能撞色。** Palette 只有 12 色，不同 user 可能得到相同
  顏色，以 display name 輔助辨識。
- **沒有 smoothing / interpolation。** 游標以約 20Hz 跳動更新。
- **沒有 idle timeout。** 停著不動的游標會一直顯示。
- **部署時的舊分頁。** Cursor 上線前載入的舊版 client 會把
  `presence.cursor` 視為 protocol error 而停止 presence，重新整理後
  恢復。

## Testing

測試分層：

- Manager：state transition / multi-tab semantics / cursor relay、
  coalescing、bounded pending work、cleanup。
- Endpoint：origin / auth / membership / close code / cleanup / cursor
  validation、relay、multi-tab。
- Client：reconnect / stale socket / generation / seq / message
  routing / cursor throttle。
- Store：consumer semantics / cursor lifecycle。
- Editor：lifecycle integration。
- UI：rendering / cursor coordinate transform。
- 真實 uvicorn smoke：驗證實際 WebSocket protocol path。

`CanvasArea` 的 cursor 回報（Konva 與 DOM event 的互動）沒有 unit
test，以雙帳號 browser 手動驗證。

Race condition 優先用 deterministic fake socket 測，而不是依賴真實
network timing，降低 flaky test。
