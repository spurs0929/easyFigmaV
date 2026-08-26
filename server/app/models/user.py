import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, String, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        # unique(email) 是大小寫敏感的，光靠它 Foo@x.com 和 foo@x.com 會變成兩個帳號。
        # 應用層一律轉小寫再寫入，這條 CHECK 是防止某天某個端點忘了轉。
        CheckConstraint("email = lower(email)", name="email_lowercase"),
    )

    # 用 UUID 而非流水號：之後 projects 的 id 也會是 UUID，
    # 這樣就算某個端點漏了授權檢查，攻擊者也沒辦法靠遞增 id 掃出別人的資源。
    # 這不是授權的替代品，只是把 IDOR 的可利用性壓低。
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),  # PG13+ 內建，不需要 pgcrypto
    )
    # 320 = RFC 5321 的 local part 64 + @ + domain 255
    # 唯一性靠 DB constraint，不靠應用層先查再寫（那會有 race condition）
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    # argon2id 的 encoded hash 大約 100 字元，留餘裕給日後調參數
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(80))

    # timestamptz 而非 timestamp：Render 與 Neon 的時區設定不保證一致，
    # 存 naive datetime 之後對不起來很難查
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )