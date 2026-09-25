"""Sentry 錯誤追蹤。

只在設定了 `SENTRY_DSN` 時啟用，沒設就完全不初始化——本機與 CI 不需要為了跑起來
而準備一個 DSN，也不會有測試事件被送到正式專案。

隱私立場與 logging 一致：`send_default_pii=False`，body 不送，cookie 與
Authorization header 在 `before_send` 再刪一次。Sentry 自己有 data scrubbing，
這裡不依賴它——同一件事在兩層各做一次的成本是幾行程式碼。
"""

import logging
import re
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

# 來源 IP 的 header。SDK 自己只擋 X-Forwarded-For 與 X-Real-IP，Cloudflare 與
# Akamai 那兩個不在它的清單裡，而 Render 前面就有 Cloudflare。與其依賴 SDK 的
# 內部清單，這裡四個一起擋。
_IP_HEADERS = {"cf-connecting-ip", "true-client-ip", "x-forwarded-for", "x-real-ip"}

_STRIPPED_HEADERS = _SENSITIVE_HEADERS | _IP_HEADERS

# 縱深防禦，預期永遠零命中。structlog 的 event dict 到 Sentry 時已經被 repr() 成
# 字串，key 名稱比對的遮蔽 processor 對它無效，只剩樣式比對這條路。正解是讓 IP
# 根本不要進到 event dict（見 app/core/logging.py），這條規則的用途是當 canary：
# 命中就代表有新的路徑把 IP 寫進了 log，事件上會留下 ip_scrub 這個 tag。
#
# IPv6 要求至少四段，否則 ISO 時戳的 10:11:12 會被誤判成 IP，canary 就永遠是紅的。
_IP_PATTERN = re.compile(
    r"(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}"
    r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.])"
    r"|(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}(?![\w:])"
)

_IP_PLACEHOLDER = "[ip-redacted]"


def _scrub_ip_in_message(event: dict[str, Any]) -> bool:
    """把 logentry 訊息裡的 IP 樣式換掉，回傳是否命中。

    只掃 logentry：structlog 的 event dict 是以 record.msg 的 repr() 進到這裡的，
    其他欄位（exception、request）不是應用程式自己寫的內容。
    """
    logentry = event.get("logentry")
    if not isinstance(logentry, dict):
        return False

    message = logentry.get("message")
    if not isinstance(message, str):
        return False

    scrubbed, hits = _IP_PATTERN.subn(_IP_PLACEHOLDER, message)
    if not hits:
        return False

    logentry["message"] = scrubbed
    return True


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
                key: value for key, value in headers.items() if key.lower() not in _STRIPPED_HEADERS
            }

    if _scrub_ip_in_message(event):
        tags = event.setdefault("tags", {})
        if isinstance(tags, dict):
            tags["ip_scrub"] = "hit"

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
        # SDK 預設是 True，也就是會把每個 stack frame 的區域變數送出去。auth 的
        # frame 裡會有明文密碼與 refresh token，那正是這一整套遮蔽要擋的東西，
        # 所以顯式關掉。代價是例外事件少了區域變數，要靠 event 本身的欄位除錯。
        include_local_variables=False,
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
