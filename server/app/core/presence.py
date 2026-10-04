"""單機記憶體的 presence 狀態：哪些使用者正在看哪個專案。

這一層只管「runtime 狀態」，刻意不碰認證、授權與資料庫：能呼叫 register() 的
連線，一定已經在 endpoint 那一層通過了 token 驗證與成員檢查。把兩件事分開，
這個模組才能不靠網路、不靠資料庫做單元測試。

── 為什麼沒有 asyncio.Lock ─────────────────────────────────────────────
所有修改狀態的方法（register / unregister）以及組 snapshot 都是同步函式。
asyncio 只會在 await 的地方切換 coroutine，同步函式從頭到尾不會被其他
coroutine 插隊，所以「讀取 → 判斷 → 修改」天然就是一個 critical section。

broadcast() 是唯一對外的 async 方法，它在第一個 await 之前就同步地組好 snapshot、
複製好連線清單，之後的網路傳送只碰那份複本。這正是「持鎖修改 / 取複本 → 放鎖
→ 傳送」的結構，只是 critical section 由「沒有 await」來保證，不是由鎖。

relay() 也是同步的：它只把游標放進每個收件連線的信箱，實際傳送由那條連線自己的
背景 task 負責（見 _CursorOutbox）。

加一把 asyncio.Lock 並不會多保護到任何東西，反而會讓人以為 await 可以放進
critical section。規則是：register / unregister 必須維持同步。哪天有人需要在
裡面 await，那一刻才是需要鎖的時候——而且鎖內仍然不能做網路傳送。

這個保證只在單一 event loop 內成立：不可以從其他 thread（例如 to_thread）
呼叫這個模組。

── 已知限制（single-instance v1）───────────────────────────────────────
- 狀態在 process 記憶體，多實例 / 多 worker 各看各的，彼此看不到對方的使用者
- 重啟即歸零，由 client 重連重建
- 已建立的連線在存活期間不會重新驗證 token 與成員資格：token 過期或被移出
  專案的人，在斷線重連之前仍留在名單上、也仍收得到名單與其他人的游標
- 游標位置不保存：relay() 只是轉發，晚加入或重連的人要等對方再次移動才看得到
  （信箱裡等待送出的那一則不算保存：送出或連線離開就沒了）
- snapshot 與游標走不同的路徑送出，同一條連線上兩者的先後沒有保證：使用者離線時
  尚未送出的游標會被清掉，但已經在傳送途中的那一則可能比「他已離線」的 snapshot
  晚到。client 必須以名單為準，忽略名單外的人的游標
"""

import asyncio
import itertools
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.core.logging import get_logger
from app.schemas.presence import PresenceSnapshot, PresenceUser

logger = get_logger(__name__)

# 單一連線的 send 上限。慢到超過這個時間的 client 視為壞掉的連線，
# 不讓它拖住同一個 room 裡其他人收到名單。
SEND_TIMEOUT_SECONDS = 5.0

# 1011 = server 端遇到非預期狀況。client 應該重連，重連後拿到的會是最新名單。
CLOSE_SEND_FAILED = 1011


class PresenceConnection(Protocol):
    """manager 對連線的全部要求。Starlette 的 WebSocket 天然符合。

    用 Protocol 而不是直接依賴 WebSocket 型別，單元測試才能用假連線。
    連線以物件身分（identity）作為 set 的成員，WebSocket 沒有覆寫 __eq__ / __hash__。
    """

    async def send_json(self, data: Any) -> None: ...

    async def close(self, code: int = ...) -> None: ...


@dataclass
class _CursorOutbox:
    """一條收件連線尚未送出的游標訊息，以及負責送出它們的 task。

    游標是「最新狀態」而不是事件流：收件端來不及收的時候，中間的位置沒有價值。
    所以每個 sender 只留最新的一則（move 與 leave 互相覆蓋），而不是排成佇列。

    這個結構同時給出兩個上限，與訊息頻率無關：
    - pending 的大小 ≤ 同一個 room 裡的其他使用者人數
    - 每條連線最多一個 task（有東西要送時才存在，送完就結束）
    """

    # key 是 sender 的 user_id。dict 保留插入順序：先等待的 sender 先送。
    pending: dict[uuid.UUID, dict[str, Any]] = field(default_factory=dict)
    task: asyncio.Task[None] | None = None
    # 傳送失敗過。這條連線已經被關閉、正在等它的擁有者 unregister，
    # 在那之前不再替它排任何東西。
    dead: bool = False


@dataclass
class _OnlineUser:
    user: PresenceUser
    connections: set[PresenceConnection] = field(default_factory=set)


@dataclass
class _Room:
    seq: int
    # dict 保留插入順序，名單因此依上線先後排列，不需要另外排序。
    users: dict[uuid.UUID, _OnlineUser] = field(default_factory=dict)


class PresenceManager:
    def __init__(self) -> None:
        self._rooms: dict[uuid.UUID, _Room] = {}
        # 整個 manager 共用一個計數器，而不是每個 room 各自從 1 數起：room 清空後
        # 被重新建立時，seq 仍然只增不減，不必考慮「重建的 room 從頭數」的邊界情況。
        self._seq = itertools.count(1)
        # 收過游標的連線才有項目，每條連線最多一個；unregister 時移除。
        self._outboxes: dict[PresenceConnection, _CursorOutbox] = {}

    def register(self, project_id: uuid.UUID, user: PresenceUser, conn: PresenceConnection) -> bool:
        """加入一條已通過驗證與授權的連線。

        回傳 True 表示這個使用者剛從離線變成在線，呼叫端應該 broadcast；
        同一個人多開一個分頁時回傳 False，名單沒有變化，不需要通知其他人。

        同一人已在線時沿用第一條連線帶進來的 user 資料，不以新連線覆蓋。
        """
        room = self._rooms.get(project_id)
        if room is None:
            # seq 在下面加入使用者時才取號，一個 room 不會出現沒有人的版本。
            room = self._rooms[project_id] = _Room(seq=0)

        online = room.users.get(user.user_id)
        if online is not None:
            online.connections.add(conn)
            return False

        room.users[user.user_id] = _OnlineUser(user=user, connections={conn})
        room.seq = next(self._seq)
        return True

    def unregister(
        self, project_id: uuid.UUID, user_id: uuid.UUID, conn: PresenceConnection
    ) -> bool:
        """移除一條連線。可以重複呼叫，未註冊過的連線直接忽略。

        回傳 True 表示這是該使用者最後一條連線，他剛離線，呼叫端應該 broadcast。
        room 空了就整個刪掉，專案數量再多也不會留下空殼。
        """
        room = self._rooms.get(project_id)
        if room is None:
            return False
        online = room.users.get(user_id)
        if online is None or conn not in online.connections:
            return False

        online.connections.discard(conn)
        # 這條連線不會再收任何東西：取消它的傳送 task。cancel() 是同步的，
        # 這個函式因此仍然沒有 await。
        outbox = self._outboxes.pop(conn, None)
        if outbox is not None and outbox.task is not None:
            outbox.task.cancel()
        if online.connections:
            return False

        del room.users[user_id]
        # 他離線了：其他人信箱裡還沒送出的、他的游標不該在「他已離線」之後才送到。
        for other in room.users.values():
            for other_conn in other.connections:
                other_outbox = self._outboxes.get(other_conn)
                if other_outbox is not None:
                    other_outbox.pending.pop(user_id, None)
        if room.users:
            room.seq = next(self._seq)
        else:
            del self._rooms[project_id]
        return True

    def snapshot(self, project_id: uuid.UUID) -> PresenceSnapshot:
        """目前的在線名單。沒有任何連線的專案回傳空名單、seq 0。"""
        room = self._rooms.get(project_id)
        if room is None:
            return PresenceSnapshot(project_id=project_id, seq=0, users=[])
        return PresenceSnapshot(
            project_id=project_id,
            seq=room.seq,
            users=[online.user for online in room.users.values()],
        )

    async def broadcast(self, project_id: uuid.UUID) -> None:
        """把目前名單送給這個專案的所有連線。

        await 之前的部分是同步的：snapshot 與連線清單在這裡就定型，傳送期間
        其他連線加入或離開都不影響這一輪，也不會出現「迭代中 set 被修改」。

        個別連線失敗不會讓整個 broadcast 失敗。
        """
        room = self._rooms.get(project_id)
        if room is None:
            return
        payload = self.snapshot(project_id).model_dump(mode="json")
        targets = [conn for online in room.users.values() for conn in online.connections]

        await asyncio.gather(*(self._send(project_id, conn, payload) for conn in targets))

    def relay(self, project_id: uuid.UUID, sender_id: uuid.UUID, payload: dict[str, Any]) -> None:
        """把一則游標訊息交給這個專案裡「其他使用者」的所有連線。

        同步、立刻返回：只是放進每條收件連線的信箱（_CursorOutbox），不等任何人
        收到。呼叫端是 sender 的接收迴圈，它不能被收件端的速度拖住——否則一個
        很慢的收件者會讓 sender 的下一則訊息卡到 SEND_TIMEOUT_SECONDS，累積在
        socket buffer 裡的舊座標之後還要一則一則追趕。

        每個 sender 在每個信箱裡只佔一格，新的覆蓋舊的。收件端跟得上時每一則都
        會送出；跟不上時跳過中間的位置，直接送最新的。同一個 sender 的訊息不會
        亂序：信箱裡同時只有一則，而每條連線只有一個 task 在送。

        排除的單位是 user 而不是連線：sender 自己的其他分頁也不會收到。游標的
        身分是 user_id，client 本來就不畫自己的游標，送過去只是浪費。

        不動 seq：名單沒有變。晚加入的人要等對方再次送出才會收到。

        sender 已經不在名單上時（連線正在關閉）不轉發：其他人即將或已經收到
        不含他的 snapshot，再送他的游標只會讓 client 收到名單外的人。
        """
        room = self._rooms.get(project_id)
        if room is None or sender_id not in room.users:
            return

        for user_id, online in room.users.items():
            if user_id == sender_id:
                continue
            for conn in online.connections:
                outbox = self._outboxes.get(conn)
                if outbox is None:
                    outbox = self._outboxes[conn] = _CursorOutbox()
                if outbox.dead:
                    continue
                outbox.pending[sender_id] = payload
                if outbox.task is None:
                    # 強參考存在 outbox 上：event loop 對 task 只有弱參考。
                    outbox.task = asyncio.create_task(self._drain(project_id, conn, outbox))

    async def _drain(
        self, project_id: uuid.UUID, conn: PresenceConnection, outbox: _CursorOutbox
    ) -> None:
        """把一條連線信箱裡的游標送完就結束。

        「檢查信箱是空的 → 把 task 清掉」之間沒有 await，relay() 因此不可能在這個
        task 即將結束時放進一則訊息卻沒有人送：它要嘛在檢查之前放進來（這裡會
        送出），要嘛在 task 清掉之後才執行（它會啟動新的 task）。

        被 unregister 取消時，CancelledError 從 _send 的 await 傳出來，直接結束。
        """
        try:
            while outbox.pending:
                sender_id = next(iter(outbox.pending))
                payload = outbox.pending.pop(sender_id)
                if not await self._send(project_id, conn, payload):
                    # _send 已經關掉這條連線。cleanup 仍然只有一個入口：連線的
                    # 擁有者收到斷線後 unregister，這裡只是不再替它做任何事。
                    outbox.dead = True
                    outbox.pending.clear()
                    return
        finally:
            outbox.task = None

    async def _send(
        self, project_id: uuid.UUID, conn: PresenceConnection, payload: dict[str, Any]
    ) -> bool:
        """送出單一連線，失敗就關掉那條連線。回傳是否送出成功。

        刻意只 close、不 unregister：連線的擁有者（endpoint 的 receive loop）會因此
        收到斷線，由它的 finally 統一 unregister 並 broadcast「此人已離線」。
        若在這裡直接移除，finally 裡的 unregister 會回傳 False，其他人就永遠
        收不到這個人離線的通知。cleanup 只有一個入口。

        只攔 Exception：CancelledError 必須繼續往上傳，否則 shutdown 取消不掉。
        """
        try:
            await asyncio.wait_for(conn.send_json(payload), SEND_TIMEOUT_SECONDS)
        except Exception as exc:
            logger.warning(
                "presence_send_failed",
                project_id=str(project_id),
                error=type(exc).__name__,
            )
            try:
                await asyncio.wait_for(conn.close(code=CLOSE_SEND_FAILED), SEND_TIMEOUT_SECONDS)
            except Exception:  # noqa: S110
                # 連線多半已經斷了，close 失敗是預期中的，沒有其他事可做。
                pass
            return False
        return True


presence = PresenceManager()