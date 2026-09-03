"""請求 body 大小限制。

放在 ASGI middleware 而不是 FastAPI dependency，是因為 dependency 太晚了：
FastAPI 在 routing.py 的請求處理流程中，`await request.body()` 執行在
`solve_dependencies()` 之前，所以 dependency 跑到時整個 body 已經在記憶體裡。
那樣只省下 Pydantic 的驗證成本，沒有任何記憶體保護。

middleware 包住 ASGI 的 receive callable，在每一塊 body 抵達時累加計數，
超過上限就中止——這是唯一能在資料真正進記憶體前就攔下的位置，而且不依賴
Content-Length，chunked transfer encoding 同樣有效。
"""

from starlette.types import ASGIApp, Message, Receive, Scope, Send


class BodySizeLimitMiddleware:
    """限制請求 body 的位元組數，超過回 413。

    這是傳輸層的上限，比 document 本身的上限寬一些，因為 JSON 還有欄位名、
    括號與其他欄位。document 自身的大小由 schema 層的驗證負責——兩者檢查的
    是不同的東西，都要有。
    """

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # 有可信的 Content-Length 時可以連第一塊都不用讀。
        # 這個 header 可能不存在或造假，所以底下仍然逐塊計數。
        declared = _content_length(scope)
        if declared is not None and declared > self.max_bytes:
            await _send_413(send)
            return

        received = 0
        responded = False

        async def limited_receive() -> Message:
            nonlocal received, responded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    # 不用拋例外：FastAPI 讀 body 時是 except Exception，
                    # 會把任何錯誤都包成「解析 body 失敗」的 400，訊息就失真了。
                    # 直接回應，再讓應用程式看到連線中斷而自行結束。
                    if not responded:
                        responded = True
                        await _send_413(send)
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            # 已經送過 413 之後，應用程式對中斷的反應（多半是 400）要丟掉，
            # 否則會在同一個請求上送出第二份回應。
            if responded:
                return
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except Exception:
            # 應用程式對 http.disconnect 的反應可能是拋出例外，
            # 此時 413 已經送出，不需要再處理。
            if not responded:
                raise


def _content_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", []):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None


async def _send_413(send: Send) -> None:
    # bytes 字面值不會解讀 \u 跳脫，直接編碼中文字串
    body = '{"detail":"內容過大"}'.encode()
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})