import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Double,
    ForeignKey,
    Index,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# 與 schemas 共用同一個上限：欄位長度與請求驗證若各寫一份，哪天只改一邊，
# 通過驗證的內容就會在寫入時變成 500。
COMMENT_CONTENT_MAX_LENGTH = 2000


class Comment(Base):
    """畫布上的一則留言。

    獨立成表而不是留在 projects.document 裡，理由有兩個：

    1. document 整份共用一個 document_version。留言放在裡面時，A 留言就會讓正在
       畫圖的 B 下一次存檔收到 409——兩個人改的根本不是同一件事。
    2. document 對後端是不透明的，放在裡面的留言沒有辦法做「只有作者能改」這種
       授權。要判斷作者，作者就必須是後端看得懂的欄位。

    刻意沒有 relationship()：理由同 ProjectMember。列表需要的作者資訊用一次明確的
    JOIN 取得，不讓 async session 在存取屬性時產生非預期的 IO。

    resolved 只是一個旗標。誰在什麼時候標記的（resolved_by / resolved_at）屬於
    workflow，v1 不做，所以不存。
    """

    __tablename__ = "comments"
    __table_args__ = (
        # 唯一的列表查詢是「這個專案的留言，依建立時間排序」。單欄的 project_id
        # 也找得到列，但排序要另外做；複合索引讓兩件事一次完成。
        # 不加 DESC、不把 id 放進來：理由同 ix_projects_owner_id_updated_at，
        # 而 id 只是同一瞬間建立時的 tie-breaker，不值得為它加寬索引。
        Index("ix_comments_project_id_created_at", "project_id", "created_at"),
        # 擋掉空白留言。API 會先 trim 再驗證，這是第二道——空的 pin 在畫布上
        # 是一個看不出用途的東西。
        # ⚠️ 這道比 API 窄：btrim(text) 只去掉空白字元，換行與 tab 不算，所以只含
        # 換行的內容過得了這裡。完整的「trim 後不可為空」由 schema 負責。
        CheckConstraint("char_length(btrim(content)) > 0", name="content_not_blank"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        # 專案刪除時留言一起消失，不留孤兒列
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    author_id: Mapped[uuid.UUID] = mapped_column(
        # 與其他表一致：刪帳號時連同他的留言一起消失。
        # 刻意不建索引：沒有任何查詢以作者為條件。代價是日後若加上刪帳號，
        # 這條 CASCADE 會掃全表，到時再補。
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )

    # 世界座標（未經 viewport 縮放），與前端的 worldX / worldY 同一個意思。
    # double precision 對應 JS 的 number，來回不會掉精度。
    # NaN / Infinity 由 API 層拒絕；PostgreSQL 的 double 本身是存得進去的。
    world_x: Mapped[float] = mapped_column(Double, nullable=False)
    world_y: Mapped[float] = mapped_column(Double, nullable=False)

    content: Mapped[str] = mapped_column(String(COMMENT_CONTENT_MAX_LENGTH), nullable=False)
    resolved: Mapped[bool] = mapped_column(Boolean, server_default=text("false"), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # 刻意不設 onupdate：與 Project 相同，由端點在 UPDATE 時明確寫入。
    # 這樣「哪些修改算是更新」是端點看得見的決定，而不是 ORM 的副作用。
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
