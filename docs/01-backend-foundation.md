# Backend Foundation

## 目的

easyFigmaV 後端以 FastAPI、SQLAlchemy 2.0 async、asyncpg、Alembic 與
PostgreSQL 組成。基礎層的設計目標是讓本機、Render 與 Neon 使用同一套
application code，同時把連線安全、migration 與 async database behavior
集中處理。

## Database URL 正規化

平台可能提供 `postgresql://` URL，但 SQLAlchemy async engine 需要
asyncpg dialect，因此設定層會將 scheme 正規化為：

``` text
postgresql+asyncpg://
```

這個轉換放在設定解析層，而不是散落在 deployment script，讓 application
只接收已正規化的 database configuration。

## TLS 決策

asyncpg 與 libpq 對 `sslmode` 的處理不同，因此不直接把 URL query
parameter 原封不動交給 asyncpg，而是解析後轉成 `SSLContext`。

原則：

``` text
DB_SSLMODE environment variable
        >
environment / host default
```

遠端連線預設採憑證驗證；本機開發可停用 TLS。

### 取捨

直接接受供應商 URL 中的 `sslmode=require` 比較省事，但 `require`
只保證加密，不等於完整驗證 server certificate。專案選擇顯式轉譯 TLS
policy，代價是設定程式碼較多，但避免「看起來有
SSL、實際驗證強度不足」的靜默降級。

## PgBouncer 與 prepared statements

Neon pooled endpoint 使用 PgBouncer transaction mode，而 asyncpg 預設
prepared statement cache 可能與 transaction pooling 產生衝突。

系統因此能辨識 pooler endpoint，並在需要時設定：

``` text
prepared_statement_cache_size=0
```

該參數屬於 asyncpg connection argument，而不是 SQLAlchemy engine
的頂層參數。

### 取捨

低流量 v1 不需要為了「有 pooler」而強迫所有環境走 transaction
pooling。直接 endpoint 的行為更單純；若使用 pooled endpoint，則明確關閉
incompatible cache。這比遇到 `DuplicatePreparedStatementError` 後靠
retry 掩蓋問題更可預期。

## Schema 基本原則

主要資料使用 UUID primary key。UUID 不是 authorization
的替代品，但比遞增 ID 更不容易被批次猜測。

時間欄位使用 `timestamptz`，避免 deployment environment 與 database
timezone 不一致造成 naive datetime ambiguity。

像 email lowercase、非空白 project name 等不變條件，除了 application
validation，也以 database constraint 作第二道防線。

## Alembic

Schema evolution 由 Alembic 管理。Model metadata 與 migration 是兩個不同
concern：

-   ORM model 描述 application 目前期待的 schema。
-   migration 描述 schema 如何從既有版本演進到目前版本。

CI 會實際從空 database 執行 `alembic upgrade head`，再執行 drift
check，而不是只確認 migration file 能 import。

## 設計原則

Backend foundation 的核心不是把所有 provider
差異藏起來，而是把差異限制在 configuration / session
boundary。API、domain behavior 與 authorization 不應知道目前 database
是本機 PostgreSQL、Neon direct endpoint 或 pooled endpoint。
