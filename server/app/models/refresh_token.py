import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class RefreshToken(Base):
    """一筆 = 一個曾經發出去的 refresh token。

    輪替模型：每次 /auth/refresh 撤銷舊的、發新的，兩者共用 family_id。
    一次登入 = 一條 family 鏈，一個 token 只有一個 successor。

    重放偵測：收到已 revoked 的 token 代表它被用了第二次。正常客戶端不會這樣，
    所以推定 token 外洩，撤銷整條 family（該次登入的所有裝置強制重新登入）。

    多分頁競態：refresh token 在 httpOnly cookie，整個瀏覽器共用。分頁 A 輪替後
    Set-Cookie 會覆蓋掉，但分頁 B 已經在飛的那個請求仍帶著舊值。所以 revoked
    之後有一段寬限窗（refresh_reuse_grace_seconds），窗內回可重試的錯誤，
    不撤 family，也**不發新 token**——發新 token 會讓攻擊者拿到合法憑證，
    且該 family 之後永遠不會再出示已撤銷的 token，等於重放偵測被永久關閉。
    """

    __tablename__ = "refresh_tokens"
    __table_args__ = (
        # 撤銷整條 family 時用；查詢條件是 family_id + 尚未撤銷
        Index("ix_refresh_tokens_family_id_revoked_at", "family_id", "revoked_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        # 刪帳號時連同所有 session 一起消失，不留孤兒列
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    # HMAC-SHA256 hex 固定 64 字元。存指紋不存原文：資料庫外洩時，沒有 pepper
    # 就算拿到這欄也無法反推或驗證候選 token。unique 讓查詢直接走索引。
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 整條 family 的絕對到期，輪替時原樣沿用。沒有它，持續輪替就能無限續命。
    family_expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # NULL = 仍有效。撤銷時間要記下來才能判斷是否落在寬限窗內。
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # 這條被輪替成哪一條。純稽核用途，出事時能重建整條鏈。
    replaced_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("refresh_tokens.id", ondelete="SET NULL")
    )

    # 之後做「登入中的裝置」清單用。存的是使用者自己的資料給使用者自己看，
    # 但仍是個人資料
    user_agent: Mapped[str | None] = mapped_column(String(255))
