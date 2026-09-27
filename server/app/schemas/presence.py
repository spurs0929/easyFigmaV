import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict

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
