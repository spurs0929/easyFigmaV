"""PresenceManager 的單元測試。

不需要網路也不需要資料庫：manager 只依賴 PresenceConnection 這個 Protocol，
這裡用假連線記錄它收到了什麼、有沒有被關掉。
"""

import asyncio
import uuid
from typing import Any

import pytest

from app.core import presence as presence_module
from app.core.presence import CLOSE_SEND_FAILED, PresenceManager
from app.schemas.presence import PresenceUser


class FakeConnection:
    def __init__(self, *, fail: bool = False, hang: bool = False, fail_close: bool = False):
        self.sent: list[dict[str, Any]] = []
        self.closed_with: int | None = None
        self._fail = fail
        self._hang = hang
        self._fail_close = fail_close

    async def send_json(self, data: Any) -> None:
        if self._fail:
            raise RuntimeError("connection is gone")
        if self._hang:
            await asyncio.Event().wait()
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        if self._fail_close:
            raise RuntimeError("already closed")
        self.closed_with = code


def make_user(role: str = "member", display_name: str | None = None) -> PresenceUser:
    return PresenceUser(user_id=uuid.uuid4(), display_name=display_name, role=role)


def online_ids(manager: PresenceManager, project_id: uuid.UUID) -> list[uuid.UUID]:
    return [u.user_id for u in manager.snapshot(project_id).users]


@pytest.fixture
def manager() -> PresenceManager:
    # 每個測試一個新的 manager，不碰 module 層級的單例。
    return PresenceManager()


@pytest.fixture
def project_id() -> uuid.UUID:
    return uuid.uuid4()


# ── register / snapshot ────────────────────────────────────────────────


def test_first_connection_brings_user_online(manager, project_id):
    alice = make_user("owner")

    became_online = manager.register(project_id, alice, FakeConnection())

    assert became_online is True
    assert manager.snapshot(project_id).users == [alice]


def test_second_user_joins_in_arrival_order(manager, project_id):
    alice, bob = make_user("owner"), make_user()
    manager.register(project_id, alice, FakeConnection())

    became_online = manager.register(project_id, bob, FakeConnection())

    assert became_online is True
    assert online_ids(manager, project_id) == [alice.user_id, bob.user_id]


def test_projects_are_isolated(manager):
    project_a, project_b = uuid.uuid4(), uuid.uuid4()
    alice, bob = make_user(), make_user()

    manager.register(project_a, alice, FakeConnection())
    manager.register(project_b, bob, FakeConnection())

    assert online_ids(manager, project_a) == [alice.user_id]
    assert online_ids(manager, project_b) == [bob.user_id]


def test_unknown_project_has_empty_snapshot(manager, project_id):
    snapshot = manager.snapshot(project_id)

    assert snapshot.users == []
    assert snapshot.seq == 0


def test_snapshot_payload_shape(manager, project_id):
    """這是 client 會解析的協定，欄位要固定，而且不能帶 email。"""
    alice = make_user("owner", display_name="Alice")
    manager.register(project_id, alice, FakeConnection())

    payload = manager.snapshot(project_id).model_dump(mode="json")

    assert payload == {
        "type": "presence.snapshot",
        "project_id": str(project_id),
        "seq": payload["seq"],
        "users": [{"user_id": str(alice.user_id), "display_name": "Alice", "role": "owner"}],
    }


# ── 同一使用者多條連線 ────────────────────────────────────────────────


def test_second_connection_of_same_user_is_not_a_new_user(manager, project_id):
    alice = make_user()
    manager.register(project_id, alice, FakeConnection())

    became_online = manager.register(project_id, alice, FakeConnection())

    assert became_online is False
    assert online_ids(manager, project_id) == [alice.user_id]


def test_user_stays_online_while_any_connection_remains(manager, project_id):
    alice = make_user()
    tab1, tab2 = FakeConnection(), FakeConnection()
    manager.register(project_id, alice, tab1)
    manager.register(project_id, alice, tab2)

    went_offline = manager.unregister(project_id, alice.user_id, tab1)

    assert went_offline is False
    assert online_ids(manager, project_id) == [alice.user_id]


def test_last_connection_takes_user_offline(manager, project_id):
    alice, bob = make_user(), make_user()
    tab1, tab2 = FakeConnection(), FakeConnection()
    manager.register(project_id, alice, tab1)
    manager.register(project_id, alice, tab2)
    manager.register(project_id, bob, FakeConnection())

    manager.unregister(project_id, alice.user_id, tab1)
    went_offline = manager.unregister(project_id, alice.user_id, tab2)

    assert went_offline is True
    assert online_ids(manager, project_id) == [bob.user_id]


def test_extra_connection_keeps_first_user_data(manager, project_id):
    """同一人已在線時，後來的連線不覆寫名單上的資料。"""
    user_id = uuid.uuid4()
    first = PresenceUser(user_id=user_id, display_name="Old", role="member")
    second = PresenceUser(user_id=user_id, display_name="New", role="member")
    manager.register(project_id, first, FakeConnection())

    manager.register(project_id, second, FakeConnection())

    assert manager.snapshot(project_id).users == [first]


# ── unregister / cleanup ──────────────────────────────────────────────


def test_empty_room_is_removed(manager, project_id):
    alice = make_user()
    conn = FakeConnection()
    manager.register(project_id, alice, conn)

    manager.unregister(project_id, alice.user_id, conn)

    assert project_id not in manager._rooms
    assert manager.snapshot(project_id).users == []


def test_unregister_is_idempotent(manager, project_id):
    """endpoint 的 finally 與其他路徑可能對同一條連線呼叫兩次。"""
    alice = make_user()
    conn = FakeConnection()
    manager.register(project_id, alice, conn)

    assert manager.unregister(project_id, alice.user_id, conn) is True
    assert manager.unregister(project_id, alice.user_id, conn) is False


def test_unregister_unknown_connection_is_ignored(manager, project_id):
    alice = make_user()
    manager.register(project_id, alice, FakeConnection())

    assert manager.unregister(project_id, alice.user_id, FakeConnection()) is False
    assert manager.unregister(uuid.uuid4(), alice.user_id, FakeConnection()) is False
    assert online_ids(manager, project_id) == [alice.user_id]


# ── seq ────────────────────────────────────────────────────────────────


def test_seq_increases_on_every_roster_change(manager, project_id):
    alice, bob = make_user(), make_user()
    bob_conn = FakeConnection()
    seqs = []

    manager.register(project_id, alice, FakeConnection())
    seqs.append(manager.snapshot(project_id).seq)
    manager.register(project_id, bob, bob_conn)
    seqs.append(manager.snapshot(project_id).seq)
    manager.unregister(project_id, bob.user_id, bob_conn)
    seqs.append(manager.snapshot(project_id).seq)

    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)
    assert seqs[0] > 0


def test_seq_unchanged_when_roster_unchanged(manager, project_id):
    """多開一個分頁或關掉其中一個，名單內容沒變，版本也不變。"""
    alice = make_user()
    tab1, tab2 = FakeConnection(), FakeConnection()
    manager.register(project_id, alice, tab1)
    before = manager.snapshot(project_id).seq

    manager.register(project_id, alice, tab2)
    manager.unregister(project_id, alice.user_id, tab2)

    assert manager.snapshot(project_id).seq == before


def test_seq_keeps_increasing_after_room_is_recreated(manager, project_id):
    alice = make_user()
    conn = FakeConnection()
    manager.register(project_id, alice, conn)
    old_seq = manager.snapshot(project_id).seq
    manager.unregister(project_id, alice.user_id, conn)

    manager.register(project_id, alice, FakeConnection())

    assert manager.snapshot(project_id).seq > old_seq


# ── broadcast ──────────────────────────────────────────────────────────


async def test_broadcast_reaches_every_connection_in_room(manager, project_id):
    alice, bob = make_user(), make_user()
    alice_tab1, alice_tab2, bob_conn = FakeConnection(), FakeConnection(), FakeConnection()
    manager.register(project_id, alice, alice_tab1)
    manager.register(project_id, alice, alice_tab2)
    manager.register(project_id, bob, bob_conn)

    await manager.broadcast(project_id)

    expected = manager.snapshot(project_id).model_dump(mode="json")
    for conn in (alice_tab1, alice_tab2, bob_conn):
        assert conn.sent == [expected]


async def test_broadcast_does_not_leak_to_other_projects(manager):
    project_a, project_b = uuid.uuid4(), uuid.uuid4()
    in_a, in_b = FakeConnection(), FakeConnection()
    manager.register(project_a, make_user(), in_a)
    manager.register(project_b, make_user(), in_b)

    await manager.broadcast(project_a)

    assert len(in_a.sent) == 1
    assert in_b.sent == []


async def test_broadcast_to_empty_project_is_noop(manager, project_id):
    await manager.broadcast(project_id)


async def test_broken_connection_does_not_break_broadcast(manager, project_id):
    healthy, broken = FakeConnection(), FakeConnection(fail=True)
    manager.register(project_id, make_user(), healthy)
    broken_user = make_user()
    manager.register(project_id, broken_user, broken)

    await manager.broadcast(project_id)

    assert len(healthy.sent) == 1
    assert broken.closed_with == CLOSE_SEND_FAILED
    # 只關連線不移除：unregister 由連線擁有者的 finally 負責，
    # 那一次 unregister 才會回傳 True 並觸發「已離線」的 broadcast。
    assert broken_user.user_id in online_ids(manager, project_id)


async def test_close_failure_after_send_failure_is_swallowed(manager, project_id):
    healthy = FakeConnection()
    manager.register(project_id, make_user(), healthy)
    manager.register(project_id, make_user(), FakeConnection(fail=True, fail_close=True))

    await manager.broadcast(project_id)

    assert len(healthy.sent) == 1


async def test_slow_connection_is_timed_out_and_closed(manager, project_id, monkeypatch):
    monkeypatch.setattr(presence_module, "SEND_TIMEOUT_SECONDS", 0.05)
    healthy, slow = FakeConnection(), FakeConnection(hang=True)
    manager.register(project_id, make_user(), healthy)
    manager.register(project_id, make_user(), slow)

    await asyncio.wait_for(manager.broadcast(project_id), timeout=1)

    assert len(healthy.sent) == 1
    assert slow.closed_with == CLOSE_SEND_FAILED


async def test_roster_change_during_broadcast(manager, project_id):
    """傳送期間有人離開：這一輪照原本的名單送完，不會因為 set 被修改而爆炸。"""
    alice, bob = make_user(), make_user()
    bob_conn = FakeConnection()

    class LeavesOthersOnSend(FakeConnection):
        async def send_json(self, data: Any) -> None:
            manager.unregister(project_id, bob.user_id, bob_conn)
            await asyncio.sleep(0)
            await super().send_json(data)

    alice_conn = LeavesOthersOnSend()
    manager.register(project_id, alice, alice_conn)
    manager.register(project_id, bob, bob_conn)

    await manager.broadcast(project_id)

    assert len(alice_conn.sent) == 1
    assert online_ids(manager, project_id) == [alice.user_id]
