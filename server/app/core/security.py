import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import anyio
import anyio.to_thread
import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import settings

# OWASP Password Storage Cheat Sheet 對 argon2id 的最低建議：m=19456 KiB, t=2, p=1。
# 不用 argon2-cffi 的預設值（m=65536, t=3, p=4）是因為 Render 免費方案只有 512MB RAM
# 與極少的 CPU 配額，64MB/次 在幾個並行登入下就會把記憶體吃光。
# 這是「安全參數受部署環境限制」的取捨，不是安全性打折——19456 仍在建議門檻之上，
# 而且 needs_rehash() 留了日後升級參數的路徑。
_hasher = PasswordHasher(
    time_cost=2,
    memory_cost=19456,
    parallelism=1,
    hash_len=32,
    salt_len=16,
)

# argon2 是同步的 CPU 密集運算（實測單次約 30ms）。直接在 async 端點裡呼叫會
# 卡住整個事件迴圈，期間所有請求都停擺，包含 /health。所以丟到執行緒池。
#
# 再加上限：19MB × N 的記憶體壓力在小 instance 上是超線性惡化的，實測 4 並行
# 需要 14 倍單次耗時，不是 4 倍。沒有上限的話，幾十個並行登入就能打垮服務——
# 亦即 argon2 本身會變成 DoS 放大器。上限 2 → 峰值約 38MB，安全。
#
# 這只是第一道防線，登入端點的速率限制（ratelimit.py）是第二道，兩者都要有。
_hash_limiter = anyio.CapacityLimiter(settings.password_hash_concurrency)

ALGORITHM = "HS256"

# 查無此帳號時拿來墊時間用的假 hash，避免「快速回應 = 此 email 未註冊」的
# timing oracle。配合統一錯誤訊息才算真的防住 user enumeration。
_DUMMY_HASH = _hasher.hash("dummy-password-for-constant-time-login")


# ─────────────────────────── 密碼 ───────────────────────────


def hash_password_sync(plain: str) -> str:
    return _hasher.hash(plain)


def verify_password_sync(plain: str, stored_hash: str) -> bool:
    try:
        _hasher.verify(stored_hash, plain)
    except (VerifyMismatchError, InvalidHashError, VerificationError):
        return False
    return True


async def hash_password(plain: str) -> str:
    return await anyio.to_thread.run_sync(hash_password_sync, plain, limiter=_hash_limiter)


async def verify_password(plain: str, stored_hash: str) -> bool:
    """驗證密碼。任何失敗都回 False，不讓例外型別洩漏資訊。"""
    return await anyio.to_thread.run_sync(
        verify_password_sync, plain, stored_hash, limiter=_hash_limiter
    )


async def burn_password_time(plain: str) -> None:
    """查無此帳號時呼叫，讓回應時間與「密碼錯誤」一致。"""
    await verify_password(plain, _DUMMY_HASH)


def needs_rehash(stored_hash: str) -> bool:
    """參數調整後，讓使用者下次登入時自動升級 hash。

    呼叫端在 verify 成功後檢查這個，True 就用新參數重算並寫回。
    這樣日後 Render 換大一點的 instance、把 memory_cost 調高時，
    不需要強迫所有人重設密碼。
    """
    try:
        return _hasher.check_needs_rehash(stored_hash)
    except InvalidHashError:
        return False


# ─────────────────────── Access Token (JWT) ───────────────────────


def create_access_token(user_id: uuid.UUID) -> tuple[str, datetime]:
    """回傳 (token, 到期時間)。到期時間給前端排程 refresh 用。"""
    now = datetime.now(UTC)
    expires_at = now + timedelta(minutes=settings.access_token_ttl_minutes)
    payload = {
        "sub": str(user_id),  # PyJWT 2.10+ 要求 sub 必須是字串
        "iat": now,
        "exp": expires_at,
        "jti": secrets.token_urlsafe(16),
        "typ": "access",
    }
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM), expires_at


def decode_access_token(token: str) -> uuid.UUID | None:
    """驗證並取出 user_id。任何問題都回 None，由呼叫端統一回 401。"""
    try:
        payload = jwt.decode(
            token,
            settings.secret_key,
            algorithms=[ALGORITHM],  # 明確指定，避免 alg=none 與演算法混淆攻擊
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.PyJWTError:
        return None

    # refresh token 不是 JWT，理論上進不來，但明確擋掉比較安全
    if payload.get("typ") != "access":
        return None

    try:
        return uuid.UUID(payload["sub"])
    except (ValueError, KeyError, TypeError):
        return None


# ─────────────────────── Refresh Token ───────────────────────

# 32 bytes = 256 bits 熵，token_urlsafe 產出 43 個字元
_REFRESH_TOKEN_BYTES = 32


def generate_refresh_token() -> tuple[str, str]:
    """回傳 (原始 token, 指紋)。原始值只進 cookie，資料庫只存指紋。"""
    raw = secrets.token_urlsafe(_REFRESH_TOKEN_BYTES)
    return raw, hash_refresh_token(raw)


def hash_refresh_token(raw: str) -> str:
    """用 HMAC-SHA256 而不是 argon2，這是刻意的。

    argon2 的「慢」是為了防禦低熵密碼的離線暴力破解。refresh token 是 256 bits
    的 CSPRNG 隨機值，字典攻擊不存在，慢雜湊只是白白增加每次 refresh 的延遲。

    更關鍵的是查詢方式：argon2 每次的 salt 不同，同一個 token 每次 hash 都不一樣，
    無法用 hash 當索引查表，只能全撈出來逐一比對。HMAC-SHA256 是確定性的，
    可以直接建 unique index 做 O(1) 查詢。

    用 HMAC 而非裸 SHA-256 則是 defense in depth：資料庫單獨外洩時，攻擊者
    沒有 pepper，連驗證候選 token 都做不到。對 256-bit 隨機值來說實務差異很小，
    但成本也只有一行。

    pepper 與 SECRET_KEY 分開，兩者才能各自獨立輪換（見 config.py）。
    """
    return hmac.new(
        settings.refresh_token_pepper.encode(),
        raw.encode(),
        hashlib.sha256,
    ).hexdigest()


def refresh_token_expiry(family_expires_at: datetime) -> datetime:
    """單一 token 的到期。不會超過整條 family 的絕對壽命上限。

    沒有這個上限的話，只要持續輪替就能無限續命，7 天的設定形同虛設。
    """
    return min(
        datetime.now(UTC) + timedelta(days=settings.refresh_token_ttl_days),
        family_expires_at,
    )


def family_expiry() -> datetime:
    """一條 family 的絕對到期，登入時決定，之後輪替時原樣沿用。"""
    return datetime.now(UTC) + timedelta(days=settings.refresh_family_max_days)


def new_family_id() -> uuid.UUID:
    """一次登入 = 一個 family。輪替時沿用，偵測到重放時整條撤銷。"""
    return uuid.uuid4()
