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
        # content 至少要有一個非空白字元。空的 pin 在畫布上是一個看不出用途的東西。
        #
        # 不用 projects 那條的 btrim(content)：btrim(text) 預設只去掉空格（U+0020），
        # 只含換行或 tab 的內容過得了它。
        #
        # 把空白字元逐一列出，而不是寫 \S 或 [[:space:]]，原因有兩個：
        #   1. 那兩種寫法對非 ASCII 字元的判斷取決於資料庫的 collation——全形空白
        #      U+3000 在 C.UTF-8 之下算空白、在 C 之下不算。CHECK 的結果若會隨環境
        #      改變，同一筆資料就可能在本機寫得進去、還原到另一台卻失敗。
        #   2. [[:space:]] 裡的冒號會被 SQLAlchemy 的 text() 當成 bind parameter。
        # 列出來的是 ASCII 的六個空白：空格、tab、LF、CR、form feed、vertical tab。
        #
        # 範圍因此刻意停在 ASCII：全形空白這類 Unicode 空白過得了這裡，由 API 的
        # 驗證負責。必須是 raw string——否則 Python 會先把 \t、\n 換成真的字元。
        CheckConstraint(r"content ~ '[^ \t\n\r\f\v]'", name="content_not_blank"),
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
