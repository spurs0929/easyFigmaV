import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Project(Base):
    """一個雲端專案。

    document 對後端是不透明的：它就是前端的 DocumentSnapshot 序列化後的樣子，
    後端不解析、不驗證內部結構。這讓畫布格式可以自行演進而不需要動後端，
    代價是後端無法對內容做任何保證，只能限制大小。
    """

    __tablename__ = "projects"
    __table_args__ = (
        # 列表查詢一定是「我的專案，依最近修改排序」，複合索引比單欄的 owner_id
        # 更貼近實際存取模式。不加 DESC：btree 可以反向掃描，效果相同，而且
        # 帶方向的索引 Alembic autogenerate 偵測不穩，容易產生假差異。
        Index("ix_projects_owner_id_updated_at", "owner_id", "updated_at"),
        # 擋掉純空白的名稱。前端會 trim，這是第二道。
        CheckConstraint("char_length(btrim(name)) > 0", name="name_not_blank"),
        # 版本號從 1 開始且只增不減，0 或負數代表程式邏輯出錯。
        CheckConstraint("document_version > 0", name="document_version_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        # 刪帳號時專案一起消失，不留孤兒列
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)

    # 刻意沒有 server default：空文件的結構是前端定義的（DOCUMENT_SNAPSHOT_VERSION
    # 加上 byId / rootIds），後端給 '{}' 只會產生前端解不開的無效文件。
    document: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)

    # 這是 document 的修訂版本，不是整筆 row 的版本。改名稱不會遞增它——
    # 否則使用者在列表頁改個名字，開著的編輯器下次存檔就會收到 409，
    # 而實際上沒有任何人改過畫布內容。
    document_version: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("1")
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )