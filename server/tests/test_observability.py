"""日誌與錯誤追蹤的行為測試。

這組測試釘住的是「不該出現在紀錄裡的東西」——那類缺陷不會讓任何功能壞掉，
只會安靜地把憑證寫進 log，所以必須由測試而不是 code review 來守。
"""

import logging

import structlog
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.routing import Route

from app.core.logging import add_client_ip, bind_client_ip, redact_sensitive
from app.core.request_context import RequestContextMiddleware, resolve_request_id
from app.core.sentry import scrub_event


def _scope(headers: list[tuple[bytes, bytes]]) -> dict:
    return {"type": "http", "headers": headers}


# ─────────────────────────── request_id ───────────────────────────


def test_generates_request_id_when_absent():
    first = resolve_request_id(_scope([]))
    second = resolve_request_id(_scope([]))

    assert len(first) == 32
    assert first != second


def test_reuses_valid_incoming_request_id():
    scope = _scope([(b"x-request-id", b"abc123def456")])

    assert resolve_request_id(scope) == "abc123def456"


def test_rejects_malformed_incoming_request_id():
    """換行會讓人眼可讀格式的輸出被塞進偽造的欄位（log forging）。"""
    scope = _scope([(b"x-request-id", b"abc\ninjected event=login_succeeded")])

    resolved = resolve_request_id(scope)

    assert "\n" not in resolved
    assert len(resolved) == 32


def test_rejects_overlong_incoming_request_id():
    scope = _scope([(b"x-request-id", b"a" * 200)])

    assert len(resolve_request_id(scope)) == 32


async def test_response_carries_request_id_header(client):
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.headers["x-request-id"]


async def test_response_echoes_valid_request_id(client):
    response = await client.get("/health", headers={"X-Request-ID": "trace-abc-123"})

    assert response.headers["x-request-id"] == "trace-abc-123"


def _events(caplog, name: str) -> list[dict]:
    """取出經過 structlog pipeline 的紀錄。

    用 caplog 而不是 structlog.testing.capture_logs()：後者會換掉整條
    processor chain，contextvars 就不會被併進來，而 request_id correlation
    正是這裡要驗的東西。走 stdlib handler 拿到的才是實際會輸出的內容。
    """
    return [
        record.msg
        for record in caplog.records
        if isinstance(record.msg, dict) and record.msg.get("event") == name
    ]


async def test_request_log_has_context_and_no_credentials(client, caplog):
    with caplog.at_level(logging.INFO):
        await client.get(
            "/api/auth/me",
            headers={"Authorization": "Bearer not-a-real-token"},
        )

    completed = _events(caplog, "request_completed")
    assert len(completed) == 1

    entry = completed[0]
    assert entry["method"] == "GET"
    assert entry["path"] == "/api/auth/me"
    assert entry["status"] == 401
    assert entry["request_id"]
    # client_ip 不在這裡：record.msg 正是 Sentry 會 repr() 出去的東西，
    # 它要由 format-time 的 processor 補，見下面兩個測試。
    assert "client_ip" not in entry

    # header 一律不進 log，所以整筆紀錄裡不該出現那個 token
    assert "not-a-real-token" not in str(entry)


async def _boom(_request):
    raise RuntimeError("這段訊息可能含使用者資料")


# 直接對中介層測例外路徑，不動到真正的 app：Starlette 同樣會把
# ServerErrorMiddleware 放在最外層，中介層的位置與正式環境一致。
_failing_app = Starlette(
    routes=[Route("/boom", _boom)],
    middleware=[Middleware(RequestContextMiddleware)],
)


async def test_failed_request_logs_error_type_only(caplog):
    transport = ASGITransport(app=_failing_app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as request_client:
        with caplog.at_level(logging.ERROR):
            response = await request_client.get("/boom")

    assert response.status_code == 500

    failed = _events(caplog, "request_failed")
    assert len(failed) == 1
    assert failed[0]["error"] == "RuntimeError"
    assert failed[0]["request_id"]
    # 例外訊息不進紀錄；traceback 由 uvicorn 那一筆負責
    assert "使用者資料" not in str(failed[0])



# ─────────────────────────── client_ip ───────────────────────────


def _processor_formatter() -> structlog.stdlib.ProcessorFormatter:
    """取出實際掛在 root handler 上的 formatter。

    不自己組一個：這裡要驗的是正式設定下的輸出，自己組會驗到測試自己的設定。
    pytest 另外掛了自己的 handler，所以用 formatter 的型別找而不是取 handlers[0]。
    """
    for handler in logging.getLogger().handlers:
        if isinstance(handler.formatter, structlog.stdlib.ProcessorFormatter):
            return handler.formatter
    raise AssertionError("root logger 上沒有 ProcessorFormatter，configure_logging 沒跑到")


def test_add_client_ip_injects_current_value():
    bind_client_ip("203.0.113.9")
    try:
        event = add_client_ip(None, "info", {"event": "x"})
    finally:
        bind_client_ip(None)

    assert event["client_ip"] == "203.0.113.9"


def test_add_client_ip_is_none_outside_a_request():
    bind_client_ip(None)

    assert add_client_ip(None, "info", {"event": "x"})["client_ip"] is None


def test_client_ip_reaches_stdout_but_not_the_record():
    """兩件事要同時成立：Render 的 log 看得到 IP，Sentry 的路徑看不到。"""
    record = logging.LogRecord(
        name="app.request",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="request_completed",
        args=(),
        exc_info=None,
    )

    bind_client_ip("203.0.113.9")
    try:
        rendered = _processor_formatter().format(record)
    finally:
        bind_client_ip(None)

    assert "203.0.113.9" in rendered
    # format 不能回頭改到 record 本身，否則 Sentry 還是拿得到
    assert "203.0.113.9" not in str(record.msg)


# ─────────────────────────── 遮蔽 ───────────────────────────


def test_redacts_sensitive_keys():
    event = redact_sensitive(
        None,
        "info",
        {
            "event": "debug_dump",
            "access_token": "eyJhbGciOi...",
            "refresh_token_pepper": "super-secret",
            "password": "correct-horse",
            "user_id": "42",
        },
    )

    assert event["access_token"] == "***"
    assert event["refresh_token_pepper"] == "***"
    assert event["password"] == "***"
    # 非敏感欄位不能被動到，否則遮蔽會讓紀錄失去用處
    assert event["user_id"] == "42"
    assert event["event"] == "debug_dump"


def test_redacts_nested_values():
    event = redact_sensitive(
        None,
        "info",
        {"event": "x", "payload": {"cookie": "refresh_token=abc"}, "items": [{"secret": "s"}]},
    )

    assert event["payload"]["cookie"] == "***"
    assert event["items"][0]["secret"] == "***"


def test_truncates_structures_beyond_max_depth():
    """深度上限不能變成繞過遮蔽的路徑。"""
    event = redact_sensitive(
        None,
        "info",
        {"event": "x", "request": {"user": {"auth": {"access_token": "VERY_SECRET"}}}},
    )

    assert event["request"]["user"]["auth"] == "[truncated]"
    assert "VERY_SECRET" not in str(event)


def test_truncates_deep_sequences():
    event = redact_sensitive(
        None,
        "info",
        {"event": "x", "a": {"b": {"c": [{"token": "VERY_SECRET"}]}}},
    )

    assert event["a"]["b"]["c"] == "[truncated]"
    assert "VERY_SECRET" not in str(event)


def test_keeps_scalars_at_max_depth():
    """純量的 key 在上一層已經檢查過，截斷它只會讓紀錄失去用處。"""
    event = redact_sensitive(None, "info", {"event": "x", "a": {"b": {"c": "plain"}}})

    assert event["a"]["b"]["c"] == "plain"


def test_keeps_none_for_absent_sensitive_field():
    """「沒有這個欄位」與「有但被遮蔽」是不同的資訊，不該被抹成同一種。"""
    event = redact_sensitive(None, "info", {"event": "x", "token": None})

    assert event["token"] is None


# ─────────────────────────── Sentry ───────────────────────────


def test_scrub_event_removes_request_credentials():
    event = scrub_event(
        {
            "request": {
                "url": "http://test/api/auth/refresh",
                "cookies": {"refresh_token": "raw-token"},
                "data": {"password": "correct-horse"},
                "query_string": "token=raw",
                "headers": {
                    "Authorization": "Bearer raw-token",
                    "Cookie": "refresh_token=raw-token",
                    "User-Agent": "pytest",
                },
            }
        },
        {},
    )

    request = event["request"]
    assert "cookies" not in request
    assert "data" not in request
    assert "query_string" not in request
    assert list(request["headers"]) == ["User-Agent"]


def test_scrub_event_tags_request_id():
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(request_id="abc123def456")
    try:
        event = scrub_event({}, {})
    finally:
        structlog.contextvars.clear_contextvars()

    assert event["tags"]["request_id"] == "abc123def456"


def test_scrub_event_removes_forwarded_ip_headers():
    """Cloudflare 與 Akamai 的 header 不在 SDK 的內建清單裡。"""
    event = scrub_event(
        {
            "request": {
                "headers": {
                    "Cf-Connecting-Ip": "203.0.113.9",
                    "True-Client-Ip": "203.0.113.9",
                    "X-Forwarded-For": "203.0.113.9, 10.0.0.1",
                    "X-Real-Ip": "203.0.113.9",
                    "User-Agent": "pytest",
                }
            }
        },
        {},
    )

    assert list(event["request"]["headers"]) == ["User-Agent"]


def test_scrub_event_redacts_ip_in_log_message():
    """canary：正常情況不該命中，命中就要留下痕跡。"""
    event = scrub_event(
        {"logentry": {"message": "{'event': 'request_completed', 'client_ip': '203.0.113.9'}"}},
        {},
    )

    assert "203.0.113.9" not in event["logentry"]["message"]
    assert "[ip-redacted]" in event["logentry"]["message"]
    assert event["tags"]["ip_scrub"] == "hit"


def test_scrub_event_leaves_clean_message_untagged():
    """時戳與耗時不能被誤判成 IP，否則 canary 永遠是紅的。"""
    message = (
        "{'event': 'request_completed', "
        "'timestamp': '2026-09-21T10:11:12.345Z', 'duration_ms': 12.34}"
    )
    event = scrub_event({"logentry": {"message": message}}, {})

    assert event["logentry"]["message"] == message
    assert "tags" not in event