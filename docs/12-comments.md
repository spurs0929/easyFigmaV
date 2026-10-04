# Comments

## Scope

Comments 從 editor-local state 演進為 cloud project 的 server-backed
resource，使留言不再只是某一個 browser 的附屬資料。

Comments 與 canvas document 分離後，可以使用獨立的
authorization、validation 與 CRUD
semantics，而不必為每一次留言操作重寫整包 project JSONB。

## Resource ownership

Comment 屬於 project，因此 authorization 不是只驗證「comment id
存在」，而是必須把 project access 一起放進 resource lookup / mutation。

這延續整個 project API 的原則：

``` text
authentication ≠ resource authorization
```

Owner / member 可依目前 project edit capability 操作；outsider 不應透過
comment endpoint 得知不可存取 project 的內部 resource。

## Content validation

Comment content 需要 application validation，也需要 database constraint
防止純空白內容繞過不同 application path。

只檢查：

``` text
length(content) > 0
```

不夠，因為 `"   "` 仍是非空字串。

因此 constraint 必須考慮 trim 後的內容，而 API boundary 也做相同語意的
validation。

### 取捨

把 invariant 同時放在 API 與 DB 看似重複，但責任不同：

-   API validation 提供清楚的 client error。
-   DB constraint 防止未來其他 code path / migration script 寫入 invalid
    state。

## DELETE race

典型流程若是：

``` text
SELECT comment
→ verify author / permission
→ DELETE comment
```

在 SELECT 與 DELETE 之間，另一個 request 可能已經刪除同一列。

因此 DELETE 本身的 result 必須被檢查：

``` text
rowcount == 0 → 404
```

不能因為前面的 authorization SELECT 曾成功，就假設 DELETE
一定刪得到資料。

這是 TOCTOU 類型的 race：authorization / existence check 與 mutation
是兩個時間點。

## 為什麼不為測試加入 production hook

Race regression test 應盡量透過資料庫狀態與既有 API boundary
驗證，不為了讓 test 比較容易插入 production-only synchronization hook。

測試基礎設施不應反過來污染 production design。

## Frontend persistence boundary

舊版 comment store 曾有獨立 localStorage persistence，同時 comment
又可能出現在 document snapshot，形成兩份 local truth source。

這會造成 cloud project → local draft 切換時的資料污染風險。

後續設計原則是：

``` text
local document state   → local persistence boundary
cloud project comments → cloud comment API
```

避免同一份 cloud comment 同時被 document snapshot、Pinia 與 localStorage
各自當成 authoritative persistence。

## Error semantics

Comments 延續 project resource 的錯誤原則：

-   不可存取的 project/resource 不因 response 差異暴露 existence。
-   concurrent delete 後再次 delete 應得到 deterministic not-found
    semantics。
-   validation error 與 authorization error 分開。
-   DB constraint violation 不應直接冒成未處理的 500。

## Testing focus

Comments 的測試重點不是只有 happy-path CRUD，而是：

-   whitespace-only content。
-   project membership authorization。
-   author / mutation permission。
-   resource/project association。
-   concurrent deletion / `rowcount == 0`。
-   frontend cloud lifecycle 不再污染 local draft。

這些 case 比「POST 之後 GET 得到同一段文字」更能保護真正容易退化的行為。
