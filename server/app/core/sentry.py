"""Sentry 錯誤追蹤。

只在設定了 `SENTRY_DSN` 時啟用，沒設就完全不初始化——本機與 CI 不需要為了跑起來
而準備一個 DSN，也不會有測試事件被送到正式專案。

隱私立場與 logging 一致：`send_default_pii=False`，body 不送，cookie 與
Authorization header 在 `before_send` 再刪一次。Sentry 自己有 data scrubbing，
這裡不依賴它——同一件事在兩層各做一次的成本是幾行程式碼。
"""

import logging
from typing import Any

import sentry_sdk
import structlog
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.logging import LoggingIntegration, ignore_logger
from sentry_sdk.integrations.starlette import StarletteIntegration

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_SENSITIVE_HEADERS = {"authorization", "cookie", "set-cookie", "x-api-key"}


def scrub_event(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any]:
    """送出前把請求相關的敏感欄位拔掉，並補上 request_id。

    request_id 從 structlog 的 contextvars 取，而不是另外傳一次——
    中介層已經綁過，這裡讀同一份，log 與 Sentry 事件就對得起來。
    """
    request = event.get("request")
    if isinstance(request, dict):
        request.pop("cookies", None)
        request.pop("data", None)
        request.pop("query_string", None)
        headers = request.get("headers")
        if isinstance(headers, dict):
            request["headers"] = {
                key: value
                for key, value in headers.items()
                if key.lower() not in _SENSITIVE_HEADERS
            }

    request_id = structlog.contextvars.get_contextvars().get("request_id")
    if request_id:
        tags = event.setdefault("tags", {})
        if isinstance(tags, dict):
            tags["request_id"] = request_id

    return event


def init_sentry() -> None:
    if not settings.sentry_dsn:
        logger.info("sentry_disabled", reason="no_dsn")
        return
    if settings.environment == "test":
        # 測試環境即使誤設了 DSN 也不送。
        logger.info("sentry_disabled", reason="test_environment")
        return

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.environment,
        release=settings.release,
        traces_sample_rate=settings.sentry_traces_sample_rate,
        # 預設就是 False，明寫是因為這個旗標一旦翻成 True，
        # cookie、header 與使用者資料會被一起送出去。
        send_default_pii=False,
        max_request_body_size="never",
        before_send=scrub_event,
        integrations=[
            # transaction_style="endpoint" 用路由樣板當交易名稱。預設的 "url"
            # 會把 project UUID 寫進名稱，同一支端點會被拆成無數個交易。
            StarletteIntegration(transaction_style="endpoint"),
            FastApiIntegration(transaction_style="endpoint"),
            # ERROR 以上送成事件，INFO 以上留成 breadcrumb：
            # 出錯時看得到同一個請求先前發生了什麼。
            LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
        ],
    )
    # 同一個未處理的例外會被三個地方看到：Starlette 整合、uvicorn 的
    # "Exception in ASGI application"、以及中介層的 request_failed。
    # 只留整合那一筆，另外兩個 logger 不轉成事件（breadcrumb 也一併關掉）。
    ignore_logger("uvicorn.error")
    ignore_logger("app.request")

    logger.info("sentry_enabled", environment=settings.environment)