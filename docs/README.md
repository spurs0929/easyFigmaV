# easyFigmaV Technical Documentation

這個目錄記錄 easyFigmaV
目前主要的後端、前端持久化、認證、授權、WebSocket、CI 與 observability
設計。

文件重點不是逐 commit 的開發歷程，而是：

-   系統目前如何運作。
-   為什麼選擇目前的設計。
-   曾評估哪些替代方案，以及沒有採用的原因。
-   安全性、併發、效能與可維護性之間的取捨。
-   v1 刻意接受的限制與未實作範圍。

## 文件索引

1.  [Backend Foundation](01-backend-foundation.md)
2.  [Authentication](02-authentication.md)
3.  [API Routing and Deployment](03-api-and-deployment.md)
4.  [Authentication Security Runbook](04-auth-security-runbook.md)
5.  [Frontend Authentication](05-frontend-auth.md)
6.  [Project Persistence and API](06-project-persistence.md)
7.  [Cloud Persistence](07-cloud-persistence.md)
8.  [Continuous Integration](08-ci.md)
9.  [Observability and Sentry](09-observability.md)
10. [Membership and Authorization](10-membership-and-authorization.md)
11. [WebSocket Presence](11-websocket-presence.md)
12. [Comments](12-comments.md)
13. [v1 Architecture and Boundaries](13-v1-architecture.md)

## Architecture at a Glance

``` text
Vue 3 / Pinia / Konva
        │
        ├── REST ───────────────┐
        │                       │
        └── WebSocket Presence  │
                                ▼
                         FastAPI
                    ┌───────────┴───────────┐
                    │                       │
             Authentication          Authorization
             JWT + refresh           membership
                    │                       │
                    └───────────┬───────────┘
                                ▼
                   SQLAlchemy 2.0 async
                                │
                         PostgreSQL / Neon
```

Persistent document state 與 ephemeral presence state 刻意分離：document
由 PostgreSQL + `document_version` 保證持久化與 optimistic
concurrency；presence 只維護「現在誰在線」，可在 process restart
後重建。
