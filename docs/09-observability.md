# Observability and Sentry

## 結構化日誌

Backend 使用 structlog。Production 輸出單行
JSON，開發環境使用較適合人讀的格式。

事件採穩定 event name：

``` python
logger.info("login_failed", reason="invalid_credentials")
```

而不是把 metadata 全塞進自由文字 message。

## 為什麼選 structlog

主要理由是 `contextvars`。

Request middleware 只需要 bind 一次 `request_id`，同一 request lifecycle
裡的 log 就能自動取得 correlation id，不必把 `request_id` 當參數一路傳進
service function。

代價是增加 dependency 與 logging convention，但換來一致的 structured
context。

## stdlib log 也進同一 pipeline

Root handler 使用 `ProcessorFormatter`，讓 uvicorn、SQLAlchemy 與既有
stdlib logging 也能輸出同樣格式。

這避免「application log 是 JSON，但 framework log 是另一套文字格式」。

## Request ID

Inbound `X-Request-ID` 只有符合允許格式才採用，否則 server 產生新的 id。

Response 回傳 `X-Request-ID`，並讓同一值出現在 structured log / Sentry
tag，支援：

``` text
client report
→ request_id
→ Render log
→ Sentry event
```

## 敏感資料原則

Application 不記錄 request body、Authorization、Cookie 等 credential。

Sentry 只有在設定 DSN 時啟用，並關閉預設 PII 收集與 request body。

但 `send_default_pii=False` 不代表 application 自己寫進 log
的資料會自動消失。

## Sink-specific privacy

不同 sink 有不同用途：

  Field          Server security log               Sentry
  -------------- --------------------------------- ---------------------------------
  `request_id`   keep                              keep
  `family_id`    keep                              keep
  `user_id`      keep                              keep as pseudonymous identifier
  `client_ip`    keep for incident investigation   remove
  credentials    remove                            remove

這比「所有敏感資料一律刪除」更精確：資料是否保留取決於該 sink
是否真的需要它。

## 為什麼 client_ip 在 sink 分岔前處理

曾考慮在 Sentry `before_send` 用 regex 從 message 清除 `client_ip`。

問題是 structlog event 經 LoggingIntegration 後可能已經變成字串，regex
會依賴 formatter 輸出格式，格式一改就可能靜默失效。

選擇是在 stdout / Sentry 分岔前決定資料流：

-   `request_id` 在 log-time context，因為需要進 Sentry。
-   `client_ip` 只在 stdout format-time 注入，使 Sentry path
    從源頭拿不到它。
-   `before_send` 仍 scrub proxy IP headers，並保留 regex 作
    defense-in-depth，而不是主要防線。

## 不設定 Sentry User Context

不呼叫 `set_user()`。

`user_id` 若作為 log metadata 只是 pseudonymous correlation
field；若設成 Sentry first-class user context，Sentry 會開始建立
affected users 等使用者維度。v1
不需要這個功能，因此不增加額外識別資料處理。

## E2E 驗證

Observability 不只做 unit test。

### Path 1：application security error

真實 refresh-token replay：

``` text
replay detection
→ logger.error
→ Sentry LoggingIntegration
→ Sentry issue
```

驗證 production ingest、`request_id` correlation、transaction
naming、credential scrub 與 SQL breadcrumb behavior。

### Path 2：unhandled exception

本機以不進版控的 temporary route 觸發真正 RuntimeError：

``` text
unhandled exception
→ FastAPI / Starlette
→ Sentry ASGI integration
→ exception event
```

驗證：

-   `handled=false`
-   完整 stack trace
-   application frame
-   request_id
-   Authorization / Cookie / refresh token / query scrub
-   raw event sentinel 0 matches
-   無 Sentry User Context

兩條 path 分開驗證，因為 logger-generated event 成功不代表 ASGI
unhandled exception path 也一定成功。

## 邊界

「HTTP request credential 已 scrub」不能被描述成「application log
的任何內容都會自動 scrub」。Application 自己寫入 log 的欄位仍必須在
logging design 階段控制。
