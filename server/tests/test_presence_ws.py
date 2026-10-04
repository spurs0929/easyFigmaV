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


# ── cursor：轉發 ───────────────────────────────────────────────────────
#
# 「沒有收到某則訊息」一律用「下一則收到的是另一則」來斷言，而不是等一段時間
# 看有沒有東西進來：前者不依賴時間，也不會讓測試變慢。


def cursor_move(x: float, y: float) -> dict:
    return {"type": "cursor.move", "x": x, "y": y}


CURSOR_LEAVE = {"type": "cursor.leave"}


async def test_cursor_move_is_relayed_to_other_users(
    make_client, make_user, make_project, make_member
):
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (member_ws, _),
    ):
        await receive(owner_ws)  # member 上線的 snapshot

        await owner_ws.send_json(cursor_move(12.5, -340))

        assert await receive(member_ws) == {
            "type": "presence.cursor",
            "project_id": str(project.id),
            "user_id": str(owner.id),
            "x": 12.5,
            "y": -340.0,
        }


async def test_cursor_move_is_not_echoed_to_sender(
    make_client, make_user, make_project, make_member
):
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (member_ws, _),
    ):
        await receive(owner_ws)

        await owner_ws.send_json(cursor_move(1, 1))
        await receive(member_ws)
        await member_ws.send_json(cursor_move(2, 2))

        # owner 收到的下一則是 member 的游標，中間沒有自己那一則。
        echoed = await receive(owner_ws)
        assert (echoed["user_id"], echoed["x"]) == (str(member.id), 2.0)


async def test_cursor_user_id_comes_from_the_connection_not_the_message(
    make_client, make_user, make_project, make_member
):
    """訊息裡帶 user_id 是多餘欄位（4400），不可能藉此替別人送游標。"""
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (member_ws, _),
    ):
        await receive(owner_ws)

        await member_ws.send_json({**cursor_move(1, 1), "user_id": str(owner.id)})

        assert await close_code(member_ws) == presence_api.CLOSE_INVALID_MESSAGE
        # owner 只看到 member 離線，沒有任何游標訊息。
        assert (await receive(owner_ws))["type"] == "presence.snapshot"


async def test_cursor_is_not_relayed_to_other_projects(
    make_client, make_user, make_project, make_member
):
    alice, dave = await make_user(), await make_user()
    bob, carol = await make_user(), await make_user()
    project_a, project_b = await make_project(alice), await make_project(bob)
    await make_member(project_a, dave)
    await make_member(project_b, carol)

    async with (
        make_client() as client,
        joined(client, project_a.id, alice) as (alice_ws, _),
        joined(client, project_a.id, dave) as (dave_ws, _),
        joined(client, project_b.id, bob) as (bob_ws, _),
        joined(client, project_b.id, carol) as (carol_ws, _),
    ):
        await receive(bob_ws)  # carol 上線的 snapshot

        await alice_ws.send_json(cursor_move(1, 1))
        # dave 收到，代表 project A 的轉發已經處理完。
        assert (await receive(dave_ws))["user_id"] == str(alice.id)

        await carol_ws.send_json(cursor_move(2, 2))
        from_b = await receive(bob_ws)
        assert (from_b["project_id"], from_b["user_id"]) == (str(project_b.id), str(carol.id))


async def test_cursor_leave_is_relayed_and_cursor_can_come_back(
    make_client, make_user, make_project, make_member
):
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (member_ws, _),
    ):
        await receive(owner_ws)

        await owner_ws.send_json(cursor_move(1, 1))
        await owner_ws.send_json(CURSOR_LEAVE)
        await owner_ws.send_json(cursor_move(3, 4))

        # 同一個 sender 的訊息依送出的順序抵達。
        assert (await receive(member_ws))["type"] == "presence.cursor"
        assert await receive(member_ws) == {
            "type": "presence.cursor.leave",
            "project_id": str(project.id),
            "user_id": str(owner.id),
        }
        back = await receive(member_ws)
        assert (back["type"], back["x"], back["y"]) == ("presence.cursor", 3.0, 4.0)


async def test_cursor_does_not_change_roster_or_seq(
    make_client, make_user, make_project, make_member, presence_state
):
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (member_ws, roster),
    ):
        await owner_ws.send_json(cursor_move(1, 1))
        await owner_ws.send_json(CURSOR_LEAVE)
        await receive(member_ws)
        await receive(member_ws)

        assert presence_state.snapshot(project.id).model_dump(mode="json") == roster


async def test_cursor_position_is_not_stored_for_late_joiners(
    make_client, make_user, make_project, make_member
):
    """server 不保存游標：晚加入的人只拿到名單，要等對方再次移動才看得到游標。"""
    owner, member, late = await make_user(), await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)
    await make_member(project, late)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (member_ws, _),
    ):
        await owner_ws.send_json(cursor_move(1, 1))
        await receive(member_ws)

        async with joined(client, project.id, late) as (late_ws, first):
            assert first["type"] == "presence.snapshot"

            await owner_ws.send_json(cursor_move(5, 6))
            # 下一則就是新的位置，中間沒有補送 (1, 1)。
            moved = await receive(late_ws)
            assert (moved["type"], moved["x"], moved["y"]) == ("presence.cursor", 5.0, 6.0)


async def test_integer_coordinates_are_accepted(make_client, make_user, make_project, make_member):
    """JSON 不區分整數與浮點數，瀏覽器的 JSON.stringify(10.0) 就是 "10"。"""
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (member_ws, _),
    ):
        await owner_ws.send_text('{"type": "cursor.move", "x": 10, "y": -0}')
        moved = await receive(member_ws)
        assert (moved["x"], moved["y"]) == (10.0, 0.0)


# ── cursor：協定驗證 ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "[1, 2]",
        '{"x": 1, "y": 2}',
        '{"type": "cursor", "x": 1, "y": 2}',
        '{"type": "presence.cursor", "x": 1, "y": 2}',
        '{"type": "auth", "access_token": "x"}',
        '{"type": "cursor.move", "x": 1}',
        '{"type": "cursor.move", "y": 1}',
        '{"type": "cursor.move"}',
        '{"type": "cursor.move", "x": 1, "y": 2, "z": 3}',
        '{"type": "cursor.leave", "x": 1, "y": 2}',
        '{"type": "cursor.move", "x": "1", "y": 2}',
        '{"type": "cursor.move", "x": true, "y": 2}',
        '{"type": "cursor.move", "x": null, "y": 2}',
        '{"type": "cursor.move", "x": NaN, "y": 2}',
        '{"type": "cursor.move", "x": 1, "y": Infinity}',
        '{"type": "cursor.move", "x": -Infinity, "y": 2}',
        '{"type": "cursor.move", "x": 1e999, "y": 2}',
        '{"type": "cursor.move", "x": 1, "y": 2' + " " * 300 + "}",
    ],
    ids=[
        "not-json",
        "array",
        "no-type",
        "unknown-type",
        "server-message-type",
        "auth-again",
        "missing-y",
        "missing-x",
        "missing-both",
        "extra-field",
        "leave-with-extra-field",
        "string-coordinate",
        "bool-coordinate",
        "null-coordinate",
        "nan",
        "infinity",
        "negative-infinity",
        "overflow-to-infinity",
        "oversized",
    ],
)
async def test_invalid_cursor_message_is_protocol_violation(
    make_client, make_user, make_project, make_member, raw
):
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (member_ws, _),
    ):
        await receive(owner_ws)

        await member_ws.send_text(raw)

        assert await close_code(member_ws) == presence_api.CLOSE_INVALID_MESSAGE
        # 壞訊息沒有被轉發：owner 收到的下一則是 member 離線的名單，不是游標。
        after = await receive(owner_ws)
        assert after["type"] == "presence.snapshot"
        assert user_ids(after) == [str(owner.id)]


async def test_binary_cursor_message_is_protocol_violation(
    make_client, make_user, make_project, presence_state
):
    owner = await make_user()
    project = await make_project(owner)

    async with make_client() as client, joined(client, project.id, owner) as (ws, _):
        await ws.send_bytes(b'{"type": "cursor.move", "x": 1, "y": 2}')
        assert await close_code(ws) == presence_api.CLOSE_INVALID_MESSAGE

    await eventually(lambda: presence_state._rooms == {})


async def test_valid_cursor_messages_keep_the_connection_open(
    make_client, make_user, make_project, presence_state
):
    """沒有其他人在線時，合法的 cursor 訊息沒有收件者，但也不是錯誤。"""
    owner = await make_user()
    project = await make_project(owner)

    async with make_client() as client, joined(client, project.id, owner) as (ws, _):
        await ws.send_json(cursor_move(1, 1))
        await ws.send_json(CURSOR_LEAVE)
        # 連線還在：再開一個分頁，manager 看得到兩條連線。
        async with joined(client, project.id, owner):
            assert len(presence_state._rooms[project.id].users[owner.id].connections) == 2


# ── cursor：同一使用者多個分頁 ─────────────────────────────────────────


async def test_cursor_from_any_tab_uses_the_same_user_identity(
    make_client, make_user, make_project, make_member
):
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (tab1, _),
    ):
        roster = await receive(owner_ws)
        async with joined(client, project.id, member) as (tab2, tab2_view):
            # 兩個分頁仍然只是一個在線使用者。
            assert user_ids(tab2_view) == user_ids(roster)
            assert user_ids(roster).count(str(member.id)) == 1

            await tab1.send_json(cursor_move(1, 1))
            first = await receive(owner_ws)
            await tab2.send_json(cursor_move(2, 2))
            second = await receive(owner_ws)

            # 同一個 user_id，後送的位置就是目前的位置。
            assert first["user_id"] == second["user_id"] == str(member.id)
            assert (second["x"], second["y"]) == (2.0, 2.0)


async def test_cursor_is_not_sent_to_senders_other_tab(
    make_client, make_user, make_project, make_member
):
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (tab1, _),
        joined(client, project.id, member) as (tab2, _),
    ):
        await receive(owner_ws)

        await tab1.send_json(cursor_move(1, 1))
        await receive(owner_ws)
        await owner_ws.send_json(cursor_move(9, 9))

        # tab2 收到的下一則是 owner 的游標，不是同一人另一個分頁的。
        assert (await receive(tab2))["user_id"] == str(owner.id)


async def test_closing_one_tab_does_not_remove_the_cursor(
    make_client, make_user, make_project, make_member, presence_state
):
    """A1 關閉、A2 還在：使用者仍在線，其他人不會收到 leave，也不會收到新名單。"""
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    def member_connections() -> int:
        return len(presence_state._rooms[project.id].users[member.id].connections)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (tab2, _),
    ):
        await receive(owner_ws)
        async with joined(client, project.id, member) as (tab1, _):
            await tab1.send_json(cursor_move(1, 1))
            await receive(owner_ws)
        await eventually(lambda: member_connections() == 1)

        await tab2.send_json(cursor_move(2, 2))

        # tab1 關閉之後 owner 收到的第一則就是 tab2 的移動：
        # 中間沒有 presence.cursor.leave，也沒有 presence.snapshot。
        after = await receive(owner_ws)
        assert (after["type"], after["user_id"], after["x"]) == (
            "presence.cursor",
            str(member.id),
            2.0,
        )


async def test_last_tab_closing_is_signalled_by_snapshot_only(
    make_client, make_user, make_project, make_member
):
    """最後一條連線離開：離線由 snapshot 表達，不另外送 presence.cursor.leave。"""
    owner, member, witness = await make_user(), await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)
    await make_member(project, witness)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, witness) as (witness_ws, _),
    ):
        await receive(owner_ws)
        async with joined(client, project.id, member) as (member_ws, _):
            await receive(owner_ws)
            await member_ws.send_json(cursor_move(1, 1))
            await receive(owner_ws)

        offline = await receive(owner_ws)
        assert offline["type"] == "presence.snapshot"
        assert str(member.id) not in user_ids(offline)

        # 之後 owner 收到的下一則是 witness 的游標：member 離線沒有產生第二則訊息。
        await witness_ws.send_json(cursor_move(7, 7))
        assert (await receive(owner_ws))["user_id"] == str(witness.id)


async def test_tab_can_send_leave_while_other_tab_keeps_cursor_alive(
    make_client, make_user, make_project, make_member
):
    """client 主動送的 leave 只是暫時移除；同一人之後的 move 讓游標重新出現。"""
    owner, member = await make_user(), await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    async with (
        make_client() as client,
        joined(client, project.id, owner) as (owner_ws, _),
        joined(client, project.id, member) as (tab1, _),
        joined(client, project.id, member) as (tab2, _),
    ):
        await receive(owner_ws)

        await tab1.send_json(CURSOR_LEAVE)
        assert (await receive(owner_ws))["type"] == "presence.cursor.leave"
        await tab2.send_json(cursor_move(4, 4))
        back = await receive(owner_ws)
        assert (back["type"], back["user_id"]) == ("presence.cursor", str(member.id))