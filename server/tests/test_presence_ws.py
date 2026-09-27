"""Presence WebSocket 的整合測試：認證、授權、在線名單的生命週期與清理。

用 httpx-ws 的 ASGIWebSocketTransport 在同一個 event loop 裡跑 app，才能和
REST 測試共用同一個 db_session（同一個還沒 commit 的交易）。

⚠️ WebSocket client 必須在測試本體裡用 `async with make_client() as client:` 開啟。
transport 內部有一個 anyio task group，若在 async yield fixture 裡先開好，
它會在 setup 的 task 進入、在 teardown 的 task 離開，anyio 會直接報錯。
"""

import asyncio
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, nullcontext
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from httpx import AsyncClient
from httpx_ws import AsyncWebSocketSession, aconnect_ws
from httpx_ws import WebSocketDisconnect as ClientDisconnect
from httpx_ws.transport import ASGIWebSocketTransport

from app.api import presence as presence_api
from app.core.config import settings
from app.core.presence import CLOSE_SEND_FAILED, PresenceManager
from app.core.security import ALGORITHM, create_access_token
from app.main import app
from app.schemas.presence import PresenceUser

ORIGIN = settings.cors_origins[0]
RECEIVE_TIMEOUT = 2.0


@pytest.fixture(autouse=True)
def presence_state(monkeypatch, db_session) -> PresenceManager:
    """每個測試一個全新的 PresenceManager，並讓 endpoint 使用測試的 db_session。

    兩者都用 monkeypatch 換掉 endpoint 模組裡的名稱，而不是替 production 程式碼
    加 reset() 或可覆寫的 session 工廠——production 的寫法因此維持最直白的樣子。

    nullcontext 不會在離開時關掉 session：db_session 屬於 fixture，
    由它負責 rollback。
    """
    manager = PresenceManager()
    monkeypatch.setattr(presence_api, "presence", manager)
    monkeypatch.setattr(presence_api, "AsyncSessionLocal", lambda: nullcontext(db_session))
    return manager


@pytest.fixture
def make_client() -> Callable[[], AsyncClient]:
    def _make() -> AsyncClient:
        return AsyncClient(
            transport=ASGIWebSocketTransport(app),
            base_url="http://test",
            headers={"Origin": ORIGIN},
        )

    return _make


def url(project_id: uuid.UUID) -> str:
    return f"/api/ws/projects/{project_id}/presence"


def auth_message(user) -> dict:
    token, _ = create_access_token(user.id)
    return {"type": "auth", "access_token": token}


@asynccontextmanager
async def open_ws(
    client: AsyncClient, project_id: uuid.UUID, **kwargs
) -> AsyncIterator[AsyncWebSocketSession]:
    # client 端的 keepalive ping 在 in-process transport 裡沒有對應處理，關掉；
    # 真實環境的 ping 由 uvicorn 負責，不是這裡要測的東西。
    async with aconnect_ws(
        url(project_id), client, keepalive_ping_interval_seconds=None, **kwargs
    ) as ws:
        yield ws


@asynccontextmanager
async def joined(client: AsyncClient, project_id: uuid.UUID, user) -> AsyncIterator[tuple]:
    """連線、認證，並讀掉自己的第一份 snapshot。"""
    async with open_ws(client, project_id) as ws:
        await ws.send_json(auth_message(user))
        first = await receive(ws)
        yield ws, first


async def receive(ws: AsyncWebSocketSession) -> dict:
    return await asyncio.wait_for(ws.receive_json(), RECEIVE_TIMEOUT)


async def close_code(ws: AsyncWebSocketSession) -> int:
    """server 應該要關掉連線；收到任何訊息都代表資訊外洩或流程錯誤。"""
    with pytest.raises(ClientDisconnect) as exc_info:
        await receive(ws)
    return exc_info.value.code


def user_ids(snapshot: dict) -> list[str]:
    return [u["user_id"] for u in snapshot["users"]]


async def eventually(predicate: Callable[[], bool]) -> None:
    """server 端的 finally 在另一個 task 跑，等它跑完再斷言。"""
    for _ in range(100):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not reached")


# ── Origin ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("origin", [None, "https://evil.example.com", "null"])
async def test_disallowed_origin_is_rejected_before_accept(
    make_client, make_user, make_project, presence_state, origin
):
    owner = await make_user()
    project = await make_project(owner)
    headers = {} if origin is None else {"Origin": origin}

    async with make_client() as client:
        client.headers.pop("Origin")
        with pytest.raises(ClientDisconnect) as exc_info:
            async with open_ws(client, project.id, headers=headers):
                pass

    assert exc_info.value.code == presence_api.CLOSE_ORIGIN_REJECTED
    assert presence_state._rooms == {}


# ── 認證 ───────────────────────────────────────────────────────────────


async def test_no_auth_message_times_out(make_client, make_user, make_project, monkeypatch):
    monkeypatch.setattr(presence_api, "AUTH_TIMEOUT_SECONDS", 0.1)
    project = await make_project(await make_user())

    async with make_client() as client, open_ws(client, project.id) as ws:
        assert await close_code(ws) == presence_api.CLOSE_AUTH_TIMEOUT


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "[]",
        '"auth"',
        '{"access_token": "x"}',
        '{"type": "auth", "access_token": "x", "extra": 1}',
        '{"type": "auth", "access_token": 123}',
        '{"type": "auth", "access_token": "' + "x" * 5000 + '"}',
    ],
    ids=["not-json", "array", "string", "no-type", "extra-field", "token-not-string", "oversized"],
)
async def test_malformed_auth_message_is_protocol_violation(
    make_client, make_user, make_project, raw
):
    project = await make_project(await make_user())

    async with make_client() as client, open_ws(client, project.id) as ws:
        await ws.send_text(raw)
        assert await close_code(ws) == presence_api.CLOSE_INVALID_MESSAGE


async def test_wrong_first_message_type(make_client, make_user, make_project):
    project = await make_project(await make_user())

    async with make_client() as client, open_ws(client, project.id) as ws:
        await ws.send_json({"type": "hello", "access_token": "x"})
        assert await close_code(ws) == presence_api.CLOSE_INVALID_MESSAGE


async def test_binary_first_message_is_protocol_violation(make_client, make_user, make_project):
    project = await make_project(await make_user())

    async with make_client() as client, open_ws(client, project.id) as ws:
        await ws.send_bytes(b'{"type": "auth"}')
        assert await close_code(ws) == presence_api.CLOSE_INVALID_MESSAGE


@pytest.mark.parametrize(
    "message",
    [
        {"type": "auth"},
        {"type": "auth", "access_token": None},
        {"type": "auth", "access_token": ""},
    ],
    ids=["absent", "null", "empty"],
)
async def test_missing_token_is_unauthenticated(make_client, make_user, make_project, message):
    project = await make_project(await make_user())

    async with make_client() as client, open_ws(client, project.id) as ws:
        await ws.send_json(message)
        assert await close_code(ws) == presence_api.CLOSE_UNAUTHENTICATED


async def test_invalid_token_is_unauthenticated(make_client, make_user, make_project):
    project = await make_project(await make_user())

    async with make_client() as client, open_ws(client, project.id) as ws:
        await ws.send_json({"type": "auth", "access_token": "not-a-jwt"})
        assert await close_code(ws) == presence_api.CLOSE_UNAUTHENTICATED


async def test_expired_token_is_unauthenticated(make_client, make_user, make_project):
    owner = await make_user()
    project = await make_project(owner)
    past = datetime.now(UTC) - timedelta(minutes=5)
    expired = jwt.encode(
        {"sub": str(owner.id), "iat": past, "exp": past, "typ": "access"},
        settings.secret_key,
        algorithm=ALGORITHM,
    )

    async with make_client() as client, open_ws(client, project.id) as ws:
        await ws.send_json({"type": "auth", "access_token": expired})
        assert await close_code(ws) == presence_api.CLOSE_UNAUTHENTICATED


async def test_deleted_user_is_unauthenticated(
    make_client, make_user, make_project, make_member, db_session
):
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)
    message = auth_message(member)
    await db_session.delete(member)
    await db_session.flush()

    async with make_client() as client, open_ws(client, project.id) as ws:
        await ws.send_json(message)
        assert await close_code(ws) == presence_api.CLOSE_UNAUTHENTICATED


# ── 授權 ───────────────────────────────────────────────────────────────


async def test_owner_can_join(make_client, make_user, make_project):
    owner = await make_user()
    project = await make_project(owner)

    async with make_client() as client, joined(client, project.id, owner) as (_, snapshot):
        assert snapshot["type"] == "presence.snapshot"
        assert snapshot["project_id"] == str(project.id)
        assert snapshot["users"] == [
            {"user_id": str(owner.id), "display_name": None, "role": "owner"}
        ]


async def test_member_can_join(make_client, make_user, make_project, make_member):
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with make_client() as client, joined(client, project.id, member) as (_, snapshot):
        assert snapshot["users"] == [
            {"user_id": str(member.id), "display_name": None, "role": "member"}
        ]


async def test_non_member_is_rejected_without_seeing_presence(
    make_client, make_user, make_project, presence_state
):
    owner, outsider = await make_user(), await make_user()
    project = await make_project(owner)

    async with make_client() as client, joined(client, project.id, owner) as (owner_ws, _):
        async with open_ws(client, project.id) as ws:
            await ws.send_json(auth_message(outsider))
            # 第一個收到的就是 close，沒有任何 snapshot 先送出來
            assert await close_code(ws) == presence_api.CLOSE_PROJECT_NOT_FOUND

        assert user_ids(presence_state.snapshot(project.id).model_dump(mode="json")) == [
            str(owner.id)
        ]


async def test_nonexistent_project_is_indistinguishable_from_non_member(
    make_client, make_user, make_project
):
    """不存在與不是成員回同一個 code，WebSocket 不能變成探測專案是否存在的管道。"""
    user = await make_user()
    someone_elses = await make_project(await make_user())

    async with make_client() as client:
        async with open_ws(client, someone_elses.id) as ws:
            await ws.send_json(auth_message(user))
            not_member = await close_code(ws)
        async with open_ws(client, uuid.uuid4()) as ws:
            await ws.send_json(auth_message(user))
            not_found = await close_code(ws)

    assert not_member == not_found == presence_api.CLOSE_PROJECT_NOT_FOUND


async def test_invalid_project_id_is_rejected(make_client):
    async with make_client() as client:
        with pytest.raises(ClientDisconnect):
            async with aconnect_ws(
                "/api/ws/projects/not-a-uuid/presence", client, keepalive_ping_interval_seconds=None
            ):
                pass


# ── 在線名單的生命週期 ─────────────────────────────────────────────────


async def test_second_user_join_updates_both(make_client, make_user, make_project, make_member):
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with make_client() as client, joined(client, project.id, owner) as (owner_ws, first):
        async with joined(client, project.id, member) as (_, member_view):
            owner_view = await receive(owner_ws)

            assert owner_view == member_view
            assert user_ids(owner_view) == [str(owner.id), str(member.id)]
            assert owner_view["seq"] > first["seq"]


async def test_projects_are_isolated(make_client, make_user, make_project):
    alice, bob = await make_user(), await make_user()
    project_a, project_b = await make_project(alice), await make_project(bob)

    async with make_client() as client, joined(client, project_a.id, alice) as (alice_ws, _):
        async with joined(client, project_b.id, bob) as (_, bob_view):
            assert user_ids(bob_view) == [str(bob.id)]

        # bob 的進出都不應該送到 project_a。再有人加入 project_a 時，
        # alice 收到的下一則必須就是那一則。
        async with joined(client, project_a.id, alice):
            pass
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(alice_ws.receive_json(), 0.2)


async def test_disconnect_broadcasts_offline(
    make_client, make_user, make_project, make_member, presence_state
):
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with make_client() as client, joined(client, project.id, owner) as (owner_ws, _):
        async with joined(client, project.id, member):
            await receive(owner_ws)  # member 加入

        after = await receive(owner_ws)
        assert user_ids(after) == [str(owner.id)]

    await eventually(lambda: presence_state._rooms == {})


async def test_same_user_second_tab(make_client, make_user, make_project, make_member):
    """第二個分頁拿到目前名單；名單與 seq 都不變；其他人不會收到通知。"""
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with make_client() as client, joined(client, project.id, owner) as (owner_ws, _):
        async with joined(client, project.id, member) as (_, tab1_view):
            await receive(owner_ws)
            async with joined(client, project.id, member) as (_, tab2_view):
                assert tab2_view == tab1_view
                assert user_ids(tab2_view).count(str(member.id)) == 1

            # 關掉第二個分頁：member 仍在線，owner 不應收到任何東西
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(owner_ws.receive_json(), 0.2)

        # 最後一個分頁關掉，才是真的離線
        after = await receive(owner_ws)
        assert user_ids(after) == [str(owner.id)]


async def test_user_stays_online_until_last_tab_closes(
    make_client, make_user, make_project, presence_state
):
    owner = await make_user()
    project = await make_project(owner)

    async with make_client() as client, joined(client, project.id, owner):
        async with joined(client, project.id, owner):
            pass
        await eventually(
            lambda: len(presence_state._rooms[project.id].users[owner.id].connections) == 1
        )
        assert user_ids(presence_state.snapshot(project.id).model_dump(mode="json")) == [
            str(owner.id)
        ]

    await eventually(lambda: presence_state._rooms == {})


# ── 協定與清理 ─────────────────────────────────────────────────────────


async def test_message_after_auth_is_protocol_violation(
    make_client, make_user, make_project, presence_state
):
    owner = await make_user()
    project = await make_project(owner)

    async with make_client() as client, joined(client, project.id, owner) as (ws, _):
        await ws.send_json({"type": "cursor", "x": 1})
        assert await close_code(ws) == presence_api.CLOSE_INVALID_MESSAGE

    await eventually(lambda: presence_state._rooms == {})


async def test_client_crash_still_cleans_up(
    make_client, make_user, make_project, make_member, presence_state
):
    """client 端例外中止連線，server 仍然 unregister 並通知其他人。

    in-process transport 模擬不出真正的 TCP 中斷；真實環境裡那由 uvicorn 的
    protocol ping 偵測，最後一樣是 receive() 收到 disconnect，走同一條路徑。
    """
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with make_client() as client, joined(client, project.id, owner) as (owner_ws, _):
        # httpx-ws 會把 context 內的例外包進它自己 task group 的 ExceptionGroup
        with pytest.raises(ExceptionGroup) as exc_info:
            async with joined(client, project.id, member):
                await receive(owner_ws)
                raise RuntimeError("client crashed")
        assert exc_info.group_contains(RuntimeError, match="client crashed")

        after = await receive(owner_ws)
        assert user_ids(after) == [str(owner.id)]


async def test_unexpected_server_error_still_cleans_up(
    make_client, make_user, make_project, presence_state, monkeypatch
):
    """register 之後任何例外都會經過 finally，不留下殭屍在線狀態。"""
    owner = await make_user()
    project = await make_project(owner)

    async def boom(_project_id):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(presence_state, "broadcast", boom)

    async with make_client() as client, open_ws(client, project.id) as ws:
        await ws.send_json(auth_message(owner))
        assert await close_code(ws) == 1011

    await eventually(lambda: presence_state._rooms == {})


async def test_broken_connection_does_not_affect_others(
    make_client, make_user, make_project, make_member, presence_state
):
    """一條送不出去的連線被 PresenceManager 關掉，其他人照常收到名單。

    壞連線用假物件直接放進 manager：從真實 client 穩定觸發 send 失敗需要
    production 端的 hook，不值得。它的 unregister 由測試代替 endpoint 執行。
    """
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    class BrokenConnection:
        closed_with: int | None = None

        async def send_json(self, data) -> None:
            raise RuntimeError("gone")

        async def close(self, code: int = 1000) -> None:
            self.closed_with = code

    broken = BrokenConnection()
    ghost = PresenceUser(user_id=uuid.uuid4(), display_name=None, role="member")

    async with make_client() as client, joined(client, project.id, owner) as (owner_ws, _):
        presence_state.register(project.id, ghost, broken)
        async with joined(client, project.id, member) as (_, member_view):
            owner_view = await receive(owner_ws)
            assert owner_view == member_view
            assert broken.closed_with == CLOSE_SEND_FAILED
        presence_state.unregister(project.id, ghost.user_id, broken)

    await eventually(lambda: presence_state._rooms == {})
