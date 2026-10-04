# Membership and Authorization

## Scope

v1 只有兩種 project identity：

``` text
owner
member
```

Owner 與 member 都能 read / edit project；只有 owner 能邀請、移除 member
與刪除 project。

不做 admin/editor/viewer RBAC、pending invitation、ownership transfer 或
member self-leave。

## Data model

``` text
projects.owner_id            → owner truth source

project_members
  project_id
  user_id
  created_at
  PRIMARY KEY(project_id, user_id)
  INDEX(user_id)             → member truth source
```

## 為什麼 owner 不寫入 `project_members`

若 owner 同時存在：

``` text
projects.owner_id
project_members(role='owner')
```

authorization fact 就有兩份 truth source。任何 create / transfer /
manual repair 漏掉同步都可能讓兩者分歧。

因此 owner 只由 `projects.owner_id` 定義，member 才有 membership row。

代價是 access query 需要：

``` sql
projects.owner_id = :user_id
OR EXISTS (
  SELECT 1
  FROM project_members
  WHERE project_members.project_id = projects.id
    AND project_members.user_id = :user_id
)
```

這個複雜度集中在 `project_access()`，而不是散落在 endpoint。

## 為什麼沒有 role column

目前 membership row 的存在本身就代表 `member`；owner 又已由 project
定義。

API response 的 `role` 是 derived value，而不是 database field。

提前加永遠只會存 `"member"` 的 role column，只是在沒有 RBAC requirement
時增加一個未使用狀態。

## 為什麼用 EXISTS

問題是「membership 是否存在」，不是「取得 membership row」。

`EXISTS` 找到符合 row 就能停止，也避免 JOIN 造成 project duplication
後再補 DISTINCT。

`project_access()` 的 correlated subquery 必須正確 correlate
project；這類 authorization SQL 有專門 regression test，避免 query
correlation 錯誤把「某 project 的 member」擴大成「所有 project
都能存取」。

## Authentication 與 authorization 分離

``` text
get_current_user()  → who are you?
project_access()    → can you access this resource?
```

登入成功不代表能操作任意 UUID resource。

## 404 / 403 anti-enumeration

規則：

``` text
outsider / nonexistent project → 404
member performs owner-only op  → 403
```

Outsider 不應從 response 差異得知某個 UUID 是否真實存在。

Member 已經知道 project 存在，因此 owner-only action 回 403 比假裝
resource 不存在更準確，也沒有新增資訊洩漏。

`OwnerProject` 必須疊在 `AccessibleProject` 之後，才能保證 outsider 先被
404 擋掉。

## DELETE project 的特殊處理

DELETE 將 owner authorization 放進 SQL mutation：

``` sql
DELETE FROM projects
WHERE id = :id
  AND owner_id = :current_user
```

若 `rowcount == 0`，不能直接查「project 是否存在」，否則 outsider 可用
403/404 探測 UUID。

Fallback 只問 caller 是否為該 project 的 member：

``` text
member   → 403
outsider → 404
missing  → 404
```

## Document CAS 與 membership

Membership 不能只修改 GET dependency。

Document save 的 CAS UPDATE 與 CAS failure fallback 都必須使用同一個
`project_access()` predicate，否則可能出現：

``` text
GET project → member allowed
PUT document → still owner-only
```

或更嚴重地讓 outsider 從 409 version conflict 推知 resource 存在。

## Invitation

v1 只允許邀請已註冊 user。

流程順序：

``` text
authenticate
→ verify project access
→ verify owner
→ lookup target email
→ insert membership
```

Email lookup 必須在 owner authorization 之後，避免任意登入者利用
endpoint 枚舉 registered email。

即使如此，合法 owner 仍可利用自己的 project 測試 email 是否存在。v1
接受這項 usability/security trade-off，並以 invite rate limit 降低濫用。

## Duplicate invite 與 SAVEPOINT

不能使用「SELECT 不存在 → INSERT」當 race protection；兩個 concurrent
request 可以同時通過 SELECT。

權威保護是：

``` text
PRIMARY KEY(project_id, user_id)
```

DB constraint violation 再轉成 409。

INSERT 使用 nested transaction / SAVEPOINT 隔離 `IntegrityError`，避免
constraint violation 把整個 outer transaction 留在 rollback-required
狀態。

## E2E

Membership 曾以兩個獨立 browser session 驗證：

``` text
owner creates project
→ invites member
→ member sees project
→ member reads/edits document
→ server persists change
→ owner sees change
→ owner removes member
→ project disappears from member list
→ known project URL becomes inaccessible
```

這驗證的不只是 endpoint，而是 UI → store → HTTP → authorization →
PostgreSQL → reload 的完整 lifecycle。
