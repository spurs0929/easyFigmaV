import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from app.schemas.project import ProjectRole


class PresenceAuthMessage(BaseModel):
    """WebSocket 連上後的第一則訊息。

    extra="forbid"：協定只有這兩個欄位，多出來的東西代表 client 與 server
    對協定的理解不一致，直接拒絕比默默忽略容易發現。

    access_token 允許缺少或為空，由 endpoint 回「認證失敗」而不是「格式錯誤」：
    client 沒有 token 是登入狀態的問題，該做的是重新登入，不是修 bug。
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["auth"]
    access_token: str | None = None


class PresenceUser(BaseModel):
    """一個在線使用者。單位是 user，不是連線：同一人開幾個分頁都只出現一次。

    刻意不含 email：presence 只回答「誰在線」，其餘資料 client 從成員名單取得，
    同一份資訊不需要由兩條管道傳輸。
    """

    model_config = ConfigDict(frozen=True)

    user_id: uuid.UUID
    display_name: str | None
    # 與 REST 相同，只是顯示用的投影，不是授權依據。
    role: ProjectRole


class PresenceSnapshot(BaseModel):
    """某個專案當下的完整在線名單。

    送完整 snapshot 而不是 join / leave 差量：snapshot 是冪等的，client 漏掉一則
    也會被下一則修正。

    seq 單調遞增。不同 broadcast 的 send 可能交錯抵達，client 必須忽略
    seq <= 目前值的 snapshot，否則畫面會短暫退回舊名單。
    """

    type: Literal["presence.snapshot"] = "presence.snapshot"
    project_id: uuid.UUID
    seq: int
    users: list[PresenceUser]


# ── cursor ─────────────────────────────────────────────────────────────
#
# 座標一律是畫布的 world coordinate，不是 screen coordinate：每個人的 pan / zoom
# 都不同，只有 world 座標在所有 client 上指的是同一個位置，由收到的那一端
# 依自己的 viewport 換算。

# 有限的浮點數。strict：JSON 的數字（含整數）才接受，字串 "1"、true 都不行；
# allow_inf_nan=False：JSON parser 認得 NaN / Infinity，而 1e999 會被解析成 inf，
# 這些值一旦轉發出去，對方的座標換算就會算出 NaN。
_Coordinate = Annotated[float, Field(strict=True, allow_inf_nan=False)]


class CursorMoveMessage(BaseModel):
    """client → server：我的游標移到這裡。

    extra="forbid" 的理由與 PresenceAuthMessage 相同。訊息裡沒有 user_id：
    「是誰」由這條連線認證時的身分決定，不由 client 自己宣稱。
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["cursor.move"]
    x: _Coordinate
    y: _Coordinate


class CursorLeaveMessage(BaseModel):
    """client → server：我的游標離開畫布了（例如移到工具列上）。"""

    model_config = ConfigDict(extra="forbid")

    type: Literal["cursor.leave"]


# 認證之後 client 能送的全部訊息。以 type 做 discriminator：未知的 type 直接驗證
# 失敗，而不是逐一嘗試每個 model 之後回一串不相干的錯誤。
PresenceClientMessage = Annotated[
    CursorMoveMessage | CursorLeaveMessage,
    Field(discriminator="type"),
]
presence_client_message: TypeAdapter[CursorMoveMessage | CursorLeaveMessage] = TypeAdapter(
    PresenceClientMessage
)


class PresenceCursor(BaseModel):
    """server → client：某個在線使用者的游標位置。

    單位與 PresenceUser 相同，是 user 而不是連線：同一人開多個分頁時共用一個
    游標，最後送來的位置勝出。

    沒有 seq：server 不保存游標位置，這只是轉發。同一個 sender 的訊息在同一條
    連線上依序處理，順序由傳輸層保證。
    """

    type: Literal["presence.cursor"] = "presence.cursor"
    project_id: uuid.UUID
    user_id: uuid.UUID
    x: float
    y: float


class PresenceCursorLeave(BaseModel):
    """server → client：這個使用者的游標暫時不在畫布上。

    只代表「游標不見了」，不代表離線——離線由 presence.snapshot 表達。
    之後再收到同一人的 presence.cursor，游標就重新出現。
    """

    type: Literal["presence.cursor.leave"] = "presence.cursor.leave"
    project_id: uuid.UUID
    user_id: uuid.UUID