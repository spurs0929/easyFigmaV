"""每個請求一個 request_id，並在請求結束時記一筆結構化的存取日誌。

寫成 ASGI middleware 而不是 `BaseHTTPMiddleware`，理由與 body_limit 相同：
`BaseHTTPMiddleware` 會把回應包成 stream 再轉送，背景任務與例外傳遞的語意都會
改變。這一層只需要看 scope 與 http.response.start，沒有理由付那個代價。

刻意不記錄的東西（P3 的安全底線）：
- header 一律不記。Authorization 與 Cookie 都在裡面，逐一挑選遲早會漏。
- query string 不記。目前沒有端點把憑證放在 query，但這是常見的洩漏路徑。
- request / response body 不記。document 可能是幾百 KB，且屬於使用者資料。

會記的是 request_id / method / path / client_ip / status / duration_ms。
path 含 project UUID，那是資源識別碼不是憑證，保留它才追得到單一請求。

client_ip 只出現在 stdout 的輸出，不會進到 Sentry 的事件內容——它由
`app/core/logging.py` 的 format-time processor 注入，原因見該檔案。
"""

import re
import time
import uuid

import structlog
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.logging import bind_client_ip, get_logger

logger = get_logger("app.request")

REQUEST_ID_HEADER = "x-request-id"
_HEADER_BYTES = REQUEST_ID_HEADER.encode()

# 外部傳進來的 request_id 必須先過這一關再使用。這不是形式檢查：
# 那個值會進到每一筆 log，放行任意字串等於讓呼叫端可以塞入換行與偽造欄位
# （log forging）。JSON renderer 會跳脫，但人眼可讀格式不會。
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")

# 健康檢查由平台高頻輪詢，記成 INFO 會把真正的流量淹掉，降成 DEBUG。
_QUIET_PATHS = frozenset({"/health", "/health/ready"})


def _header(scope: Scope, name: bytes) -> str | None:
    headers: list[tuple[bytes, bytes]] = scope.get("headers", [])
    for key, value in headers:
        if key == name:
            return value.decode("latin-1")
    return None


def resolve_request_id(scope: Scope) -> str:
    """沿用上游傳進來的 request_id，格式不合法或沒有就自己產一個。

    沿用是為了讓前端、反向代理與後端的紀錄能對在一起；驗證是因為那是外部輸入。
    """
    incoming = _header(scope, _HEADER_BYTES)
    if incoming and _SAFE_REQUEST_ID.match(incoming):
        return incoming
    return uuid.uuid4().hex


class RequestContextMiddleware:
    """綁定 request context、回填 X-Request-ID、記錄一筆存取日誌。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = resolve_request_id(scope)
        client = scope.get("client")
        path = scope.get("path", "")

        # 先清再綁。contextvars 在每個請求各自的 task 裡是獨立的，
        # 但測試與背景任務不保證，清空的成本趨近於零。
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            request_id=request_id,
            method=scope.get("method", ""),
            path=path,
        )
        # client_ip 走獨立的 ContextVar，理由見 app/core/logging.py：走 structlog 的
        # contextvars 會讓它一起進到 Sentry 的事件內容裡。
        #
        # uvicorn 的 --proxy-headers 已經把 scope["client"] 換成真實來源 IP，
        # 少了那個參數這裡會是 Render 反向代理的位址。
        bind_client_ip(client[0] if client else None)

        started = time.perf_counter()
        status: int | None = None

        async def send_with_request_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                # 複製而不是就地 append：同一個 message 若被其他中介層重送，
                # 就地修改會把 header 疊上去第二次。
                message["headers"] = [
                    *message.get("headers", []),
                    (_HEADER_BYTES, request_id.encode()),
                ]
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        except Exception as exc:
            # 刻意不帶 traceback：例外繼續往上拋之後，uvicorn 會用
            # "uvicorn.error" 記一次完整的 traceback，而那筆紀錄仍在同一個
            # context 裡（我們不在結束時清 contextvars），所以一樣帶得到
            # request_id。這裡再記一次只會讓每個 500 出現兩份 traceback。
            # 只記類別名稱不記訊息——例外訊息可能包含使用者資料。
            logger.error(
                "request_failed",
                error=type(exc).__name__,
                duration_ms=_elapsed_ms(started),
            )
            raise

        emit = logger.debug if path in _QUIET_PATHS else logger.info
        emit("request_completed", status=status, duration_ms=_elapsed_ms(started))

        # 刻意不在這裡 clear_contextvars()：例外路徑上，Sentry 是在更外層才
        # 捕捉事件的，提早清掉 request_id 那個 tag 就消失了。跨請求的隔離由
        # 進來時的 clear 與「每個請求一個 task」共同保證。


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)
