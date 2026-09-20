"""結構化日誌設定。

三件事在這裡一次決定：

1. 所有輸出走同一條 pipeline。應用程式用 structlog 寫、uvicorn 與 SQLAlchemy 用
   stdlib logging 寫，兩邊各自格式化的話，聚合端就要解析兩種格式。
   `ProcessorFormatter` 讓 stdlib 的紀錄也經過同一組 processor 才輸出，
   所以既有的 `logging.getLogger(__name__)` 呼叫不必全部改寫也能拿到同樣的欄位。
2. production 輸出單行 JSON，其他環境輸出人眼可讀的單行。判斷寫在 settings，
   不在這裡讀環境變數——這個模組只接受參數。
3. 敏感欄位由最後一道 processor 統一遮蔽。這是刻意的縱深防禦：不依賴
   「每個呼叫點都記得不要記密碼」，因為那種規則遲早會有人漏掉。

刻意不做的事：不寫檔案、不做 rotation。容器化部署的慣例是寫 stdout，
輪替與保存交給平台（Render 收集 stdout）。
"""

import logging
import sys
from typing import Any

import structlog

# key 名稱只要「包含」這些字串就遮蔽。用子字串比對而不是完全比對，
# 是因為真正會出事的是 access_token / refresh_token_pepper / password_hash
# 這類組合字，逐一列舉一定會漏。
_SENSITIVE_KEY_PARTS = (
    "password",
    "passwd",
    "token",
    "secret",
    "pepper",
    "authorization",
    "cookie",
    "credential",
    "api_key",
    "apikey",
)

_REDACTED = "***"
_TRUNCATED = "[truncated]"

# 遮蔽只往下走三層。log 裡的巢狀結構不該太深，而無上限的遞迴
# 會讓一份畸形的 payload 變成 CPU 成本。
_MAX_DEPTH = 3


def _is_sensitive(key: str) -> bool:
    lowered = key.lower()
    return any(part in lowered for part in _SENSITIVE_KEY_PARTS)


def _scrub(value: Any, depth: int) -> Any:
    if depth >= _MAX_DEPTH:
        # 超過深度的巢狀結構整塊換掉，不原樣輸出。原樣返回的話，深度上限本身
        # 就成了繞過遮蔽的路徑：只要 secret 埋得夠深就會被完整印出來，而那正是
        # 這道 processor 要擋的事。純量沒有這個問題——它的 key 在上一層已經
        # 檢查過，直接保留。
        return _TRUNCATED if isinstance(value, dict | list | tuple) else value
    if isinstance(value, dict):
        return {
            key: (
                _REDACTED
                if _is_sensitive(str(key)) and value[key] is not None
                else _scrub(value[key], depth + 1)
            )
            for key in value
        }
    if isinstance(value, list | tuple):
        return [_scrub(item, depth + 1) for item in value]
    return value


def redact_sensitive(_logger: Any, _method: str, event_dict: dict) -> dict:
    """遮蔽敏感 key 的值。

    只看 key 不看 value：要從字串判斷「這是不是一個 JWT」既不可靠、成本也高，
    而呼叫點本來就知道自己在記什麼欄位。value 是 None 時保持 None——
    「沒有這個欄位」與「有但被遮蔽」是不同的資訊。
    """
    return _scrub(event_dict, 0)


def configure_logging(level: str = "INFO", json_output: bool = False) -> None:
    """設定 structlog 與 stdlib logging。必須在應用程式開始寫 log 之前呼叫。"""
    shared_processors: list[Any] = [
        # 這一行是 request_id correlation 的關鍵：中介層綁在 contextvars 的欄位
        # 會自動併進每一筆 log，呼叫點不必逐一傳遞。
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.UnicodeDecoder(),
        # 放在最後：所有欄位都齊了才遮蔽，中間的 processor 也就無從繞過。
        redact_sensitive,
    ]

    structlog.configure(
        processors=[
            *shared_processors,
            # 不直接 render，改交給 stdlib 的 handler，
            # 這樣 structlog 與 stdlib 兩邊的紀錄才會共用同一個出口。
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    renderers: list[Any] = (
        [structlog.processors.format_exc_info, structlog.processors.JSONRenderer()]
        if json_output
        # ConsoleRenderer 自己處理 exception，不需要 format_exc_info
        else [structlog.dev.ConsoleRenderer(colors=False)]
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        # foreign_pre_chain 只作用在「不是由 structlog 產生」的紀錄上，
        # 也就是 uvicorn / SQLAlchemy / 既有的 logging.getLogger() 呼叫。
        foreign_pre_chain=[*shared_processors, structlog.stdlib.ExtraAdder()],
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            *renderers,
        ],
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    # 直接指派而不是 addHandler：重複呼叫（測試、reload）不該累積 handler，
    # 否則每一筆 log 會被印很多次。
    root.handlers = [handler]
    root.setLevel(level)

    for name in ("uvicorn", "uvicorn.error"):
        # 清掉 uvicorn 自己的 handler 並讓它往上傳，才會走到我們的 formatter。
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True

    # uvicorn 的 access log 直接關掉：同一個請求由 RequestContextMiddleware
    # 記成一筆結構化紀錄，留著 uvicorn 那份只是重複、而且沒有 request_id。
    # 用程式關而不是靠 --no-access-log，本機 uvicorn --reload 才會一致。
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.handlers.clear()
    access_logger.disabled = True


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.stdlib.get_logger(name)