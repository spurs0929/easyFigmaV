import time
from collections import defaultdict, deque

from fastapi import Request

from app.core.config import settings


class SlidingWindowRateLimiter:
    """單機記憶體的滑動視窗限流。

    存在的理由不只是防暴力破解密碼——argon2 每次要 19MB 記憶體與約 30ms CPU，
    沒有限流的話，登入端點本身就是一個 DoS 放大器：攻擊者只要持續打 /auth/login，
    不需要猜中任何密碼就能耗盡小 instance 的資源。

    已知限制（寫進 README）：
    - 狀態在記憶體，多實例各算各的，實際上限 = 設定值 × 實例數
    - 重啟就歸零
    """

    def __init__(self, max_attempts: int, window_seconds: int) -> None:
        self._max = max_attempts
        self._window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> bool:
        """回傳 True 表示放行。放行時同時記一次。"""
        now = time.monotonic()
        bucket = self._hits[key]

        while bucket and now - bucket[0] > self._window:
            bucket.popleft()

        if len(bucket) >= self._max:
            return False

        bucket.append(now)
        return True

    def reset(self, key: str) -> None:
        """登入成功後清掉該來源的計數，避免正常使用者被自己的失誤鎖住。"""
        self._hits.pop(key, None)

    def prune(self) -> None:
        """清掉已經沒有紀錄的 key，避免字典無限成長。"""
        now = time.monotonic()
        for key in list(self._hits):
            bucket = self._hits[key]
            while bucket and now - bucket[0] > self._window:
                bucket.popleft()
            if not bucket:
                del self._hits[key]


auth_limiter = SlidingWindowRateLimiter(
    settings.auth_rate_limit_attempts,
    settings.auth_rate_limit_window_seconds,
)


def client_key(request: Request, scope: str) -> str:
    """取得限流的 key。

    依賴 uvicorn 的 --proxy-headers：Render 在反向代理後面，沒有那個參數的話
    request.client.host 會是代理的 IP，所有使用者共用同一個 bucket。
    """
    ip = request.client.host if request.client else "unknown"
    return f"{scope}:{ip}"
