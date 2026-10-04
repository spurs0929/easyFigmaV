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


# ── relay ──────────────────────────────────────────────────────────────
#
# relay() 是同步的，只把游標放進收件連線的信箱；實際傳送在背景 task。
# 測試用 flush() 等信箱送完再斷言。


class GatedConnection(FakeConnection):
    """send 會停在 gate 上，直到測試放行：用來模擬「還在送上一則」的收件端。"""

    def __init__(self) -> None:
        super().__init__()
        self.gate = asyncio.Event()
        self.sending = asyncio.Event()

    async def send_json(self, data: Any) -> None:
        self.sending.set()
        await self.gate.wait()
        await super().send_json(data)


def cursor(x: float) -> dict[str, Any]:
    return {"type": "presence.cursor", "x": x, "y": 0.0}


CURSOR = cursor(1.0)
LEAVE = {"type": "presence.cursor.leave"}


def drain_tasks(manager: PresenceManager) -> list[asyncio.Task]:
    return [box.task for box in manager._outboxes.values() if box.task is not None]


async def flush(manager: PresenceManager) -> None:
    """等所有信箱送完（或失敗）。"""
    while tasks := drain_tasks(manager):
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_relay_reaches_other_users_but_not_the_sender(manager, project_id):
    alice, bob, carol = make_user(), make_user(), make_user()
    alice_conn, bob_conn, carol_conn = FakeConnection(), FakeConnection(), FakeConnection()
    manager.register(project_id, alice, alice_conn)
    manager.register(project_id, bob, bob_conn)
    manager.register(project_id, carol, carol_conn)

    manager.relay(project_id, alice.user_id, CURSOR)
    await flush(manager)

    assert alice_conn.sent == []
    assert bob_conn.sent == [CURSOR]
    assert carol_conn.sent == [CURSOR]


async def test_relay_skips_every_tab_of_the_sender(manager, project_id):
    """排除的單位是 user：sender 的另一個分頁也不會收到自己的游標。"""
    alice, bob = make_user(), make_user()
    alice_tab1, alice_tab2 = FakeConnection(), FakeConnection()
    bob_tab1, bob_tab2 = FakeConnection(), FakeConnection()
    manager.register(project_id, alice, alice_tab1)
    manager.register(project_id, alice, alice_tab2)
    manager.register(project_id, bob, bob_tab1)
    manager.register(project_id, bob, bob_tab2)

    manager.relay(project_id, alice.user_id, CURSOR)
    await flush(manager)

    assert alice_tab1.sent == [] and alice_tab2.sent == []
    assert bob_tab1.sent == [CURSOR] and bob_tab2.sent == [CURSOR]


async def test_relay_does_not_leak_to_other_projects(manager):
    project_a, project_b = uuid.uuid4(), uuid.uuid4()
    alice, bob, outsider = make_user(), make_user(), make_user()
    bob_conn, outsider_conn = FakeConnection(), FakeConnection()
    manager.register(project_a, alice, FakeConnection())
    manager.register(project_a, bob, bob_conn)
    manager.register(project_b, outsider, outsider_conn)

    manager.relay(project_a, alice.user_id, CURSOR)
    await flush(manager)

    assert bob_conn.sent == [CURSOR]
    assert outsider_conn.sent == []


async def test_relay_keeps_no_state(manager, project_id):
    """轉發不是名單變動：seq 與名單不變，送完之後信箱裡也沒有留下任何位置。"""
    alice, bob = make_user(), make_user()
    manager.register(project_id, alice, FakeConnection())
    manager.register(project_id, bob, FakeConnection())
    before = manager.snapshot(project_id)

    manager.relay(project_id, alice.user_id, CURSOR)
    await flush(manager)

    assert manager.snapshot(project_id) == before
    assert all(not box.pending for box in manager._outboxes.values())
    # 晚加入的人只拿得到名單，沒有任何人的游標可以補給他。
    late = FakeConnection()
    manager.register(project_id, make_user(), late)
    await manager.broadcast(project_id)
    await flush(manager)
    assert [message["type"] for message in late.sent] == ["presence.snapshot"]


async def test_relay_from_user_who_is_not_online_is_dropped(manager, project_id):
    """連線正在關閉、已經 unregister 的 sender：其他人不該再收到名單外的人的游標。"""
    bob_conn = FakeConnection()
    manager.register(project_id, make_user(), bob_conn)

    manager.relay(project_id, uuid.uuid4(), CURSOR)
    await flush(manager)

    assert bob_conn.sent == []
    assert manager._outboxes == {}


async def test_relay_to_empty_project_is_noop(manager, project_id):
    manager.relay(project_id, uuid.uuid4(), CURSOR)
    assert manager._rooms == {}
    assert manager._outboxes == {}


async def test_every_cursor_is_delivered_in_order_when_recipient_keeps_up(manager, project_id):
    """收件端跟得上時不丟任何一則：只留最新的一格不等於只送最後一則。"""
    alice, bob = make_user(), make_user()
    bob_conn = FakeConnection()
    manager.register(project_id, alice, FakeConnection())
    manager.register(project_id, bob, bob_conn)

    sent = [cursor(1.0), cursor(2.0), LEAVE, cursor(3.0)]
    for payload in sent:
        manager.relay(project_id, alice.user_id, payload)
        await flush(manager)

    assert bob_conn.sent == sent


# ── relay：收件端很慢或壞掉 ────────────────────────────────────────────


async def test_slow_recipient_does_not_block_sender_or_healthy_recipients(manager, project_id):
    """regression：一個卡住的收件端，不會讓 sender 的下一則游標等它。

    relay() 是同步函式，這裡完全沒有 await 過那個卡住的連線——如果 relay() 還在
    等收件端，這個測試會在第一次呼叫就停住。
    """
    alice, slow_user, healthy_user = make_user(), make_user(), make_user()
    slow, healthy = FakeConnection(hang=True), FakeConnection()
    manager.register(project_id, alice, FakeConnection())
    manager.register(project_id, slow_user, slow)
    manager.register(project_id, healthy_user, healthy)

    for x in (1.0, 2.0, 3.0):
        manager.relay(project_id, alice.user_id, cursor(x))
        # 只讓出執行權，沒有等任何逾時：healthy 的傳送不需要 slow 先完成。
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert healthy.sent[-1] == cursor(x)

    assert healthy.sent == [cursor(1.0), cursor(2.0), cursor(3.0)]
    assert slow.sent == []
    assert slow.closed_with is None  # 還沒逾時，仍在等它

    manager.unregister(project_id, slow_user.user_id, slow)


async def test_pending_work_is_bounded_regardless_of_message_rate(manager, project_id):
    """regression：不管 sender 送多快，每條連線最多一個 task、每個 sender 最多一格。"""
    alice, carol, bob = make_user(), make_user(), make_user()
    stuck = GatedConnection()
    manager.register(project_id, alice, FakeConnection())
    manager.register(project_id, carol, FakeConnection())
    manager.register(project_id, bob, stuck)
    tasks_before = len(asyncio.all_tasks())

    for x in range(1000):
        manager.relay(project_id, alice.user_id, cursor(float(x)))
        manager.relay(project_id, carol.user_id, cursor(float(-x)))
        if x == 0:
            await stuck.sending.wait()  # bob 的 task 已經卡在第一則上

    outbox = manager._outboxes[stuck]
    # 兩個 sender 各一格，不是 2000 則。
    assert set(outbox.pending) == {alice.user_id, carol.user_id}
    # 整個 manager 的 task 數 ≤ 連線數（3），與送了幾則無關。
    assert len(drain_tasks(manager)) <= 3
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert len(asyncio.all_tasks()) - tasks_before == 1  # 只剩卡住的那一個

    stuck.gate.set()
    await flush(manager)
    assert asyncio.all_tasks() == {asyncio.current_task()}


async def test_slow_recipient_skips_to_latest_position(manager, project_id):
    """收件端送完上一則之後，拿到的是每個 sender 最新的位置，不是積壓的舊座標。"""
    alice, bob = make_user(), make_user()
    bob_conn = GatedConnection()
    manager.register(project_id, alice, FakeConnection())
    manager.register(project_id, bob, bob_conn)

    manager.relay(project_id, alice.user_id, cursor(1.0))
    await bob_conn.sending.wait()
    for x in (2.0, 3.0, 4.0):
        manager.relay(project_id, alice.user_id, cursor(x))

    bob_conn.gate.set()
    await flush(manager)

    assert bob_conn.sent == [cursor(1.0), cursor(4.0)]


async def test_leave_replaces_a_pending_move_and_vice_versa(manager, project_id):
    """move 與 leave 共用同一格：最後的狀態一定是最後送出的那一則。"""
    alice, bob = make_user(), make_user()
    bob_conn = GatedConnection()
    manager.register(project_id, alice, FakeConnection())
    manager.register(project_id, bob, bob_conn)

    manager.relay(project_id, alice.user_id, cursor(1.0))
    await bob_conn.sending.wait()
    manager.relay(project_id, alice.user_id, cursor(2.0))
    manager.relay(project_id, alice.user_id, LEAVE)

    bob_conn.gate.set()
    await flush(manager)

    assert bob_conn.sent == [cursor(1.0), LEAVE]


async def test_broken_recipient_is_closed_but_not_unregistered(manager, project_id):
    alice, bob, carol = make_user(), make_user(), make_user()
    broken, healthy = FakeConnection(fail=True), FakeConnection()
    manager.register(project_id, alice, FakeConnection())
    manager.register(project_id, bob, broken)
    manager.register(project_id, carol, healthy)

    manager.relay(project_id, alice.user_id, CURSOR)
    await flush(manager)

    assert healthy.sent == [CURSOR]
    # 與 broadcast 相同：只關閉、不 unregister，cleanup 交給那條連線的擁有者。
    assert broken.closed_with == CLOSE_SEND_FAILED
    assert bob.user_id in online_ids(manager, project_id)


async def test_timed_out_recipient_is_closed(manager, project_id, monkeypatch):
    monkeypatch.setattr(presence_module, "SEND_TIMEOUT_SECONDS", 0.05)
    alice, bob = make_user(), make_user()
    hung = FakeConnection(hang=True)
    manager.register(project_id, alice, FakeConnection())
    manager.register(project_id, bob, hung)

    manager.relay(project_id, alice.user_id, CURSOR)
    await flush(manager)

    assert hung.closed_with == CLOSE_SEND_FAILED


async def test_nothing_is_queued_for_a_recipient_after_it_failed(manager, project_id):
    """傳送失敗的連線在被 unregister 之前，不會再累積訊息、也不會再啟動 task。"""
    alice, bob = make_user(), make_user()
    broken = FakeConnection(fail=True)
    manager.register(project_id, alice, FakeConnection())
    manager.register(project_id, bob, broken)
    manager.relay(project_id, alice.user_id, CURSOR)
    await flush(manager)

    for x in range(100):
        manager.relay(project_id, alice.user_id, cursor(float(x)))

    assert manager._outboxes[broken].pending == {}
    assert drain_tasks(manager) == []


# ── relay：cleanup ─────────────────────────────────────────────────────


async def test_unregister_cancels_the_pending_send(manager, project_id):
    """連線離開時，卡在傳送中的 task 一併取消，不留下 orphan task。"""
    alice, bob = make_user(), make_user()
    hung = FakeConnection(hang=True)
    manager.register(project_id, alice, FakeConnection())
    manager.register(project_id, bob, hung)
    manager.relay(project_id, alice.user_id, CURSOR)
    await asyncio.sleep(0)
    (task,) = drain_tasks(manager)

    manager.unregister(project_id, bob.user_id, hung)

    assert hung not in manager._outboxes
    await asyncio.gather(task, return_exceptions=True)
    assert task.cancelled()
    assert asyncio.all_tasks() == {asyncio.current_task()}


async def test_emptied_project_leaves_no_outbox_or_task(manager, project_id):
    alice, bob = make_user(), make_user()
    alice_conn, bob_conn = FakeConnection(), FakeConnection(hang=True)
    manager.register(project_id, alice, alice_conn)
    manager.register(project_id, bob, bob_conn)
    manager.relay(project_id, alice.user_id, CURSOR)
    manager.relay(project_id, bob.user_id, CURSOR)
    await asyncio.sleep(0)

    manager.unregister(project_id, alice.user_id, alice_conn)
    manager.unregister(project_id, bob.user_id, bob_conn)
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert manager._rooms == {}
    assert manager._outboxes == {}
    assert asyncio.all_tasks() == {asyncio.current_task()}


async def test_closing_one_tab_keeps_the_other_tabs_outbox(manager, project_id):
    alice, bob = make_user(), make_user()
    bob_tab1, bob_tab2 = FakeConnection(), GatedConnection()
    manager.register(project_id, alice, FakeConnection())
    manager.register(project_id, bob, bob_tab1)
    manager.register(project_id, bob, bob_tab2)
    manager.relay(project_id, alice.user_id, CURSOR)
    await bob_tab2.sending.wait()

    manager.unregister(project_id, bob.user_id, bob_tab1)
    bob_tab2.gate.set()
    await flush(manager)

    assert bob_tab2.sent == [CURSOR]


async def test_queued_cursor_of_user_who_went_offline_is_dropped(manager, project_id):
    """還沒送出的游標不會在「他已離線」之後才送到。"""
    alice, carol, bob = make_user(), make_user(), make_user()
    alice_conn, bob_conn = FakeConnection(), GatedConnection()
    manager.register(project_id, alice, alice_conn)
    manager.register(project_id, carol, FakeConnection())
    manager.register(project_id, bob, bob_conn)

    manager.relay(project_id, carol.user_id, cursor(1.0))
    await bob_conn.sending.wait()  # bob 正在收 carol 的游標
    manager.relay(project_id, alice.user_id, cursor(2.0))  # alice 的還在信箱裡
    manager.unregister(project_id, alice.user_id, alice_conn)

    bob_conn.gate.set()
    await flush(manager)

    assert bob_conn.sent == [cursor(1.0)]