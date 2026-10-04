# Project Persistence and API

## Project model

核心欄位：

``` text
projects
  id                UUID
  owner_id          UUID
  name              varchar
  document          JSONB
  document_version  integer
  created_at
  updated_at
```

Membership 加入後，owner 仍由 `projects.owner_id` 定義，其他可存取者由
`project_members` 定義。

## Document 是 opaque JSONB

Backend 不理解 Konva element、`byId`、`rootIds` 等 editor schema，只把
document 視為有大小上限的 JSON document。

### 為什麼

Editor snapshot schema 可以演進，而不需要每次都修改 backend model /
migration。

### 代價

Server 無法對 document 內部 invariant 做強驗證。格式正確性由 frontend
serializer / parser 負責。

因此 database 不替 document 填 `{}` 這類看似方便的
default；「有效空文件」本身是 frontend schema 的一部分，應由 client
提供。

## Metadata 與 document API 分離

主要 project API 將 rename 與 document save 分開：

``` text
PATCH /projects/{id}             → metadata
PUT   /projects/{id}/document    → document snapshot + expected version
```

理由不是 REST 形式偏好，而是 workload 不同：

  操作         頻率    Payload Concurrency
  ---------- ------ ---------- ------------------------
  rename         低         小 last-write-wins 可接受
  autosave       高   大 JSONB optimistic locking

若混在同一支 PATCH，metadata update 可能被迫攜帶 document，或 handler
需要處理大量互不相關的 optional branch。

## `document_version`

版本名稱刻意叫 `document_version`，不是 row `version`。

``` text
rename       → document_version unchanged
document PUT → document_version + 1
```

如果 rename 也遞增版本，列表頁改名就會讓另一個正在編輯 document 的 tab
下次 autosave 得到假 409；兩個互不衝突的 domain operation
被錯誤綁在同一個 version counter。

## Atomic optimistic locking

Document save 把 expected version 放進 UPDATE：

``` sql
UPDATE projects
SET document = :document,
    document_version = document_version + 1
WHERE id = :id
  AND <caller can access project>
  AND document_version = :expected
RETURNING document_version, updated_at;
```

不能採：

``` text
SELECT version
→ application compare
→ UPDATE
```

因為兩個 request 可以同時讀到相同 version。

## 404 與 409

UPDATE 影響 0 rows 可能表示：

-   resource 不存在 / caller 無權限。
-   resource 可存取，但 expected version stale。

這兩種情況必須分開，否則 frontend 無法知道是「失去存取權」還是「需要處理
concurrency conflict」。

Membership 版本的 fallback query 也必須使用相同 `project_access()`
predicate，否則 outsider 可能藉由 409 得知某個 UUID 對應到真實 project。

## List 不載入 document

Project list 只需要 metadata，因此 query 本身就不 SELECT 大型 document
欄位，而不是「SELECT 完再從 response schema 隱藏」。

這是 I/O 設計，不只是 serialization 最佳化。

## Hard delete

v1 採 hard delete，沒有 soft-delete / trash requirement。

Soft delete 會把 `deleted_at IS NULL` 擴散到所有 query，並引入
restore、purge、unique constraint 與 membership
semantics。沒有產品需求時不先製造這組狀態。
