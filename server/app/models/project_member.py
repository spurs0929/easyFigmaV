import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ProjectMember(Base):
    """專案成員。

    這張表只記 member。owner 的唯一真相仍然是 projects.owner_id，不在這裡另外
    寫一列——兩份真相就要同步，而同步失敗的那一刻就是授權漏洞。授權判斷因此是
    owner_id = :me OR EXISTS(member row)，而不是單查這張表。

    刻意沒有 role 欄位：有沒有列在這裡本身就是 role。加了欄位等於先替 RBAC 鋪路，
    而 RBAC 是 v1 明確排除的項目。回應裡的 "owner" / "member" 由 owner_id 推導。

    也刻意沒有 relationship()：目前所有需求都能用明確的 select 寫清楚，而 async
    session 之下的 lazy loading 會在存取屬性時變成非預期的 IO。
    """

    __tablename__ = "project_members"
    __table_args__ = (
        # 反向查詢：「我參與了哪些專案」。主鍵的前綴是 project_id，只用 user_id
        # 當條件時吃不到它，列表端點每次都會變成全表掃描。
        Index("ix_project_members_user_id", "user_id"),
    )

    # 複合主鍵同時提供唯一性：同一個人在同一個專案不可能有兩列，
    # 重複邀請由資料庫擋，不靠應用層先查再寫（那有 race condition）。
    project_id: Mapped[uuid.UUID] = mapped_column(
        # 專案刪除時成員一起消失，不留孤兒列
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )