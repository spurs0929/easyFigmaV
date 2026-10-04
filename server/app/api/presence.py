"""Presence WebSocket：誰正在看這個專案、他們的游標在哪裡。

協定：
    client → server
        第一則：{"type": "auth", "access_token": "<jwt>"}
        之後：  {"type": "cursor.move", "x": <float>, "y": <float>}
                {"type": "cursor.leave"}
    server → client
        {"type": "presence.snapshot", ...}       在線名單
        {"type": "presence.cursor", ...}         某人的游標位置
        {"type": "presence.cursor.leave", ...}   某人的游標離開畫布
    schema 見 app/schemas/presence.py。座標是畫布的 world coordinate。

token 走第一則訊息而不是 URL：瀏覽器的 WebSocket API 無法設定 Authorization
header，而放 query string 會進到 uvicorn 的存取日誌與代理紀錄。代價是必須先
accept 才拿得到 token，所以用 AUTH_TIMEOUT_SECONDS 限制未驗證連線能佔用多久。
這也是刻意的：只有 accept 之後，瀏覽器才讀得到 close code；握手階段被拒，
client 只會看到 1006，無從決定該重新登入還是停止重連。

close code（client 依此決定重連策略）：
    4400  訊息不符協定（壞 JSON、錯誤格式、未知的 type、非有限的座標、
          binary frame）→ bug，不重連
    4401  認證失敗（沒有 token、無效、過期、使用者不存在）→ refresh token 後重連
    4404  專案不存在或不是成員，兩者刻意不區分，同 REST 的 404 → 不重連
    4408  accept 之後沒有在時限內送出 auth → 可重連
    1011  server 端錯誤 / 傳送失敗（uvicorn 與 PresenceManager 產生）→ 可重連
    Origin 不在允許清單：在 accept 之前拒絕，瀏覽器看到的是握手失敗

游標是 user 層級的，與在線名單同一個單位：
    - 同一人開多個分頁共用一個游標，最後送來的 cursor.move 勝出。
    - 連線關閉「不會」送出 presence.cursor.leave。同一人還有其他分頁時他仍然在線，
      游標不該消失；最後一條連線關閉時，他會從 presence.snapshot 的名單消失，
      client 以名單為準移除游標。離線只有 snapshot 這一個訊號。
    - presence.cursor.leave 只在 client 主動送出 cursor.leave 時產生。

已知限制（v1 接受）：
    - 已建立的連線不會重新驗證。token 過期、被移出專案或專案被刪除之後，連線在
      斷線前仍然有效——仍在名單上，也仍收得到名單與其他人的游標。
    - cursor 訊息沒有 server 端的頻率限制，正常 client 自己節流（約 20 則 / 秒），
      不守規矩的 client 可以送得更快。
"""

import asyncio
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, WebSocketException
from pydantic import ValidationError
from sqlalchemy import select
from starlette.websockets import WebSocketState

from app.api.deps import project_access, project_role, user_from_token
from app.core.config import settings
from app.core.logging import get_logger
from app.core.presence import presence
from app.db.session import AsyncSessionLocal
from app.models import Project
from app.schemas.presence import (
    CursorMoveMessage,
    PresenceAuthMessage,
    PresenceCursor,
    PresenceCursorLeave,
    PresenceUser,
    presence_client_message,
)

router = APIRouter(tags=["Presence"])
logger = get_logger(__name__)

# 未驗證的連線最多能佔用多久。正常 client 連上後立刻送 auth，幾百毫秒內就會到。
AUTH_TIMEOUT_SECONDS = 5.0

# auth 訊息的上限。一個 JWT 只有幾百字元，這個數字只是擋掉把大塊資料塞進
# 第一則訊息的情況；傳輸層的上限另由 uvicorn --ws-max-size 負責（見 Dockerfile）。
MAX_AUTH_MESSAGE_CHARS = 4096

# cursor 訊息的上限。最長的合法訊息（兩個完整精度的 float）不到一百個字元。
MAX_CURSOR_MESSAGE_CHARS = 256

CLOSE_INVALID_MESSAGE = 4400
CLOSE_UNAUTHENTICATED = 4401
CLOSE_PROJECT_NOT_FOUND = 4404
CLOSE_AUTH_TIMEOUT = 4408
# Origin 檢查發生在 accept 之前，這個 code 瀏覽器讀不到，選標準的 policy violation。
CLOSE_ORIGIN_REJECTED = 1008


@router.websocket("/ws/projects/{project_id}/presence")
async def presence_socket(websocket: WebSocket, project_id: uuid.UUID) -> None:
    # 刻意沒有任何 Depends(get_db)：dependency 的生命週期是整個 endpoint，
    # 對 WebSocket 來說就是整條連線——那會讓一條 pool 連線被佔住數小時。
    # DB 只在 _authenticate() 裡以 async with 短暫開啟。
    _check_origin(websocket)
    await websocket.accept()

    token = await _receive_auth_token(websocket)
    if token is None:
        # client 在送出 auth 之前就斷線了，沒有東西需要清理。
        return
    user = await _authenticate(project_id, token)

    # ── 從這裡開始連線算是「在線」。──────────────────────────────────
    # register 放在 try 的第一行：finally 一定涵蓋它，register 與 try 之間
    # 不存在任何可能 raise 或 return 的空隙。即使 register 本身中途失敗，
    # unregister 對未註冊的連線是 no-op。
    try:
        became_online = presence.register(project_id, user, websocket)
        logger.info(
            "presence_connected",
            project_id=str(project_id),
            user_id=str(user.user_id),
            new_user=became_online,
        )
        if became_online:
            # 名單變了：所有人（包含這條新連線）都需要新的 snapshot。
            await presence.broadcast(project_id)
        else:
            # 同一人多開一個分頁：名單沒變，其他人不需要通知，
            # 但這條新連線還沒有任何狀態，要單獨送一份目前的 snapshot。
            await websocket.send_json(presence.snapshot(project_id).model_dump(mode="json"))
        await _relay_cursor_messages(websocket, project_id, user)
    except WebSocketDisconnect:
        pass
    finally:
        # unregister 是同步的，在 finally 的第一個 await 之前就完成：即使連線是被
        # 取消（shutdown）而進到這裡、後面的 broadcast 又被再次取消，狀態也已經乾淨。
        if presence.unregister(project_id, user.user_id, websocket):
            await presence.broadcast(project_id)
        logger.info("presence_disconnected", project_id=str(project_id), user_id=str(user.user_id))


def _check_origin(websocket: WebSocket) -> None:
    """只允許前端網域發起的連線。

    CORSMiddleware 不處理 WebSocket：握手不受瀏覽器的同源政策限制，任何網站的
    JS 都能對這裡發起連線。在 first-message auth 之下，惡意網站拿不到 token，
    本來就過不了下一關；這是縱深防禦，而且它在 accept 之前，連一條未驗證的
    連線都不讓對方佔到。

    允許清單直接沿用 CORS_ORIGINS：「哪些前端可以呼叫這個 API」只有一份設定。
    沒有 Origin header 的連線（非瀏覽器 client）一律拒絕——v1 沒有這種 client。
    """
    if websocket.headers.get("origin") not in settings.cors_origins:
        raise WebSocketException(code=CLOSE_ORIGIN_REJECTED)


async def _receive_auth_token(websocket: WebSocket) -> str | None:
    """等第一則訊息並取出 token。client 已斷線時回傳 None。"""
    try:
        message = await asyncio.wait_for(websocket.receive(), AUTH_TIMEOUT_SECONDS)
    except TimeoutError:
        raise WebSocketException(code=CLOSE_AUTH_TIMEOUT) from None

    if message["type"] == "websocket.disconnect":
        return None

    text = message.get("text")
    if text is None or len(text) > MAX_AUTH_MESSAGE_CHARS:
        raise WebSocketException(code=CLOSE_INVALID_MESSAGE)
    try:
        auth = PresenceAuthMessage.model_validate_json(text)
    except ValidationError:
        # 不記錄 exc：錯誤內容可能包含 client 送來的原文，也就是 token。
        raise WebSocketException(code=CLOSE_INVALID_MESSAGE) from None

    if not auth.access_token:
        raise WebSocketException(code=CLOSE_UNAUTHENTICATED)
    return auth.access_token


async def _authenticate(project_id: uuid.UUID, token: str) -> PresenceUser:
    """認證 + 授權，DB session 只活在這個函式裡。

    回傳的是 PresenceUser（純資料）而不是 ORM 物件，session 關閉之後沒有任何東西
    還能觸發 lazy load 或把連線拉回來。
    """
    async with AsyncSessionLocal() as db:
        user = await user_from_token(db, token)
        if user is None:
            raise WebSocketException(code=CLOSE_UNAUTHENTICATED)

        # 與 REST 的 accessible_project() 同一個授權條件。專案不存在與不是成員
        # 回同一個 code，不讓 WebSocket 變成探測專案是否存在的管道。
        owner_id = await db.scalar(
            select(Project.owner_id).where(Project.id == project_id, project_access(user.id))
        )
        if owner_id is None:
            raise WebSocketException(code=CLOSE_PROJECT_NOT_FOUND)

        return PresenceUser(
            user_id=user.id,
            display_name=user.display_name,
            role=project_role(owner_id, user.id),
        )


async def _relay_cursor_messages(
    websocket: WebSocket, project_id: uuid.UUID, user: PresenceUser
) -> None:
    """認證之後的接收迴圈：把 cursor 訊息轉發給其他人，直到連線結束。

    不符協定的訊息一律關閉連線，而不是忽略：默默接受等於替未定義的訊息開了
    一扇門。死連線的偵測不靠應用層 heartbeat——uvicorn 會送 protocol 層的 ping，
    對方沒回應就斷線，這裡的 receive() 會因此收到 disconnect。

    這個迴圈不等任何收件者：relay() 只是把游標放進每個收件連線的信箱就返回，
    某個收件端很慢或壞掉，都不會延後這裡讀下一則訊息（見 PresenceManager.relay）。

    這裡不碰資料庫：每秒數十則的訊息不能各查一次成員資格（見模組說明的已知限制）。
    """
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return

        payload = _cursor_payload(message.get("text"), project_id, user)
        if payload is None:
            # PresenceManager 可能已經因為傳送失敗而先關掉這條連線。
            if websocket.application_state == WebSocketState.CONNECTED:
                await websocket.close(code=CLOSE_INVALID_MESSAGE)
            return
        presence.relay(project_id, user.user_id, payload)


def _cursor_payload(
    text: str | None, project_id: uuid.UUID, user: PresenceUser
) -> dict[str, object] | None:
    """把 client 的 cursor 訊息轉成要轉發的內容。不符協定時回傳 None。

    user_id 取自這條連線認證時的身分，client 無法替別人送游標。
    """
    # text 是 None 代表 binary frame。
    if text is None or len(text) > MAX_CURSOR_MESSAGE_CHARS:
        return None
    try:
        message = presence_client_message.validate_json(text)
    except ValidationError:
        return None

    if isinstance(message, CursorMoveMessage):
        outgoing: PresenceCursor | PresenceCursorLeave = PresenceCursor(
            project_id=project_id, user_id=user.user_id, x=message.x, y=message.y
        )
    else:
        outgoing = PresenceCursorLeave(project_id=project_id, user_id=user.user_id)
    return outgoing.model_dump(mode="json")