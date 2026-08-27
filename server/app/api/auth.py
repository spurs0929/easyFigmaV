import logging
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, DbSession, rate_limit, require_csrf_header
from app.core import security
from app.core.config import settings
from app.core.ratelimit import auth_limiter, client_key
from app.models import RefreshToken, User
from app.schemas.auth import LoginRequest, RegisterRequest, TokenResponse, UserResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Auth"])

REFRESH_COOKIE_NAME = "refresh_token"
# 收斂到 /api/auth：登入、refresh、logout 都在這底下，其他端點不會收到這個 cookie。
REFRESH_COOKIE_PATH = "/api/auth"

# 對外一律用同一句。區分「查無此帳號」與「密碼錯誤」等於送給任何人一個
# 帳號存在性的查詢介面（user enumeration）。實際原因寫進 log。
_INVALID_CREDENTIALS = "帳號或密碼錯誤"


# ─────────────────────────── cookie ───────────────────────────


def _set_refresh_cookie(response: Response, raw_token: str, expires_at: datetime) -> None:
    """production 與本機的參數不同，這是刻意的。

    前後端在 Render 上是不同網域，cookie 屬於跨站，必須 SameSite=None；
    而 SameSite=None 一定要搭配 Secure，Secure 又需要 https。
    本機是 http://localhost，所以退回 Lax + 非 Secure，否則瀏覽器直接拒收。
    """
    max_age = int((expires_at - datetime.now(UTC)).total_seconds())
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=raw_token,
        max_age=max_age,
        path=REFRESH_COOKIE_PATH,
        httponly=True,  # JS 讀不到，XSS 偷不走
        secure=settings.is_production,
        samesite="none" if settings.is_production else "lax",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.is_production,
        samesite="none" if settings.is_production else "lax",
    )


# ─────────────────────────── 共用 ───────────────────────────


async def _issue_session(
    db: DbSession,
    response: Response,
    user: User,
    request: Request,
) -> TokenResponse:
    """開一條新的 family（登入 / 註冊時呼叫）。"""
    raw, fingerprint = security.generate_refresh_token()
    family_expires_at = security.family_expiry()

    db.add(
        RefreshToken(
            id=uuid.uuid4(),
            user_id=user.id,
            family_id=security.new_family_id(),
            token_hash=fingerprint,
            expires_at=security.refresh_token_expiry(family_expires_at),
            family_expires_at=family_expires_at,
            user_agent=(request.headers.get("user-agent") or "")[:255] or None,
        )
    )
    await db.commit()

    access_token, access_expires = security.create_access_token(user.id)
    _set_refresh_cookie(response, raw, family_expires_at)

    return TokenResponse(
        access_token=access_token,
        expires_in=int((access_expires - datetime.now(UTC)).total_seconds()),
        user=UserResponse.model_validate(user),
    )


async def _revoke_family(db: DbSession, family_id: uuid.UUID) -> None:
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    await db.commit()


# ─────────────────────────── 端點 ───────────────────────────


@router.post(
    "/register",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit("register"))],
)
async def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
    db: DbSession,
) -> TokenResponse:
    """註冊並直接發 session，省掉一次登入。

    已知限制：這個端點會洩漏 email 是否已註冊（user enumeration）。要真正解決
    需要 email 驗證流程——註冊一律回成功，實際寄信告知。那超出目前範圍，
    寫進 README 的已知限制。登入端點則已處理。
    """
    user = User(
        email=payload.email,
        password_hash=await security.hash_password(payload.password),
        display_name=payload.display_name or payload.email.split("@")[0],
    )
    db.add(user)

    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="此 email 已被註冊",
        ) from None

    return await _issue_session(db, response, user, request)


@router.post(
    "/login",
    response_model=TokenResponse,
    dependencies=[Depends(rate_limit("login"))],
)
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: DbSession,
) -> TokenResponse:
    user = await db.scalar(select(User).where(User.email == payload.email))

    if user is None:
        # 不能直接 return——查無帳號會比「算完 argon2 才發現密碼錯」快很多，
        # 回應時間本身就變成帳號存在性的 oracle。這裡墊掉那段時間。
        await security.burn_password_time(payload.password)
        logger.warning("login failed: reason=user_not_found")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _INVALID_CREDENTIALS)

    if not await security.verify_password(payload.password, user.password_hash):
        logger.warning("login failed: reason=bad_password user_id=%s", user.id)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _INVALID_CREDENTIALS)

    # 參數調高之後，讓使用者在下次登入時無痛升級，不必重設密碼
    if security.needs_rehash(user.password_hash):
        user.password_hash = await security.hash_password(payload.password)

    # 成功就清掉計數，避免使用者被自己先前的失誤鎖住
    auth_limiter.reset(client_key(request, "login"))
    return await _issue_session(db, response, user, request)


@router.post(
    "/refresh",
    response_model=TokenResponse,
    dependencies=[Depends(require_csrf_header), Depends(rate_limit("refresh"))],
)
async def refresh(request: Request, response: Response, db: DbSession) -> TokenResponse:
    """輪替 refresh token。

    整段的難點不在流程而在併發與重放的分辨，見下方各處註解。
    """
    raw = request.cookies.get(REFRESH_COOKIE_NAME)
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "沒有 refresh token")

    now = datetime.now(UTC)
    token = await db.scalar(
        select(RefreshToken).where(
            RefreshToken.token_hash == security.hash_refresh_token(raw)
        )
    )

    if token is None:
        _clear_refresh_cookie(response)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "refresh token 無效")

    if token.revoked_at is not None:
        grace = timedelta(seconds=settings.refresh_reuse_grace_seconds)
        is_concurrent_tab = (
            token.replaced_by_id is not None and now - token.revoked_at <= grace
        )
        if is_concurrent_tab:
            # 多分頁競態，不是攻擊。cookie 已經被上一個請求的 Set-Cookie 覆蓋，
            # 前端重試一次就會帶到新的值。
            #
            # 這裡刻意「不」發新 token。若發了，攻擊者拿舊 token 也能換到一條
            # 合法憑證，而且該 family 之後雙方都不會再出示已撤銷的 token，
            # 重放偵測就被永久關閉了。
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "token 剛被輪替，請重試",
            )

        # 已撤銷、又超出寬限窗 = 同一條 token 被用了第二次。正常客戶端不會這樣。
        logger.error(
            "refresh token replay detected: user_id=%s family_id=%s",
            token.user_id,
            token.family_id,
        )
        await _revoke_family(db, token.family_id)
        _clear_refresh_cookie(response)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session 已失效，請重新登入")

    if token.expires_at <= now or token.family_expires_at <= now:
        _clear_refresh_cookie(response)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session 已過期，請重新登入")

    # ── 原子性輪替 ──────────────────────────────────────────
    # 兩個並行請求同時通過上面的檢查是可能的。若各自建一條後繼 token，
    # rotation chain 會分叉成 RT1 → {RT2, RT3}，「一個 token 只有一個 successor」
    # 這個 invariant 就沒了，重放偵測也跟著失效。
    #
    # 用 compare-and-set 而不是 SELECT ... FOR UPDATE：不需要在產生新 token、
    # 寫入新列的整段期間持有 row lock。輸掉競爭的那個 rowcount 會是 0，
    # 那正好就是「有人剛剛搶先輪替了」，直接走跟多分頁一樣的重試路徑。
    result = await db.execute(
        update(RefreshToken)
        .where(RefreshToken.id == token.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    if result.rowcount != 1:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "token 剛被輪替，請重試")

    new_raw, new_fingerprint = security.generate_refresh_token()
    new_token = RefreshToken(
        id=uuid.uuid4(),
        user_id=token.user_id,
        family_id=token.family_id,  # 沿用，才追蹤得到整條鏈
        token_hash=new_fingerprint,
        expires_at=security.refresh_token_expiry(token.family_expires_at),
        family_expires_at=token.family_expires_at,  # 絕對壽命不因輪替延長
        user_agent=(request.headers.get("user-agent") or "")[:255] or None,
    )
    db.add(new_token)
    # 先 flush 讓新列存在，外鍵才過得了；整段仍在同一個 transaction 裡
    await db.flush()

    token.replaced_by_id = new_token.id
    await db.commit()

    user = await db.scalar(select(User).where(User.id == token.user_id))
    if user is None:
        _clear_refresh_cookie(response)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "使用者不存在")

    access_token, access_expires = security.create_access_token(user.id)
    _set_refresh_cookie(response, new_raw, token.family_expires_at)

    return TokenResponse(
        access_token=access_token,
        expires_in=int((access_expires - datetime.now(UTC)).total_seconds()),
        user=UserResponse.model_validate(user),
    )


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf_header)],
)
async def logout(request: Request, response: Response, db: DbSession) -> Response:
    """登出目前這台裝置：撤銷這條 family。

    刻意不要求 access token。access token 過期後使用者仍該登得出去，
    而且登出失敗沒有任何攻擊價值。
    """
    raw = request.cookies.get(REFRESH_COOKIE_NAME)
    if raw:
        token = await db.scalar(
            select(RefreshToken).where(
                RefreshToken.token_hash == security.hash_refresh_token(raw)
            )
        )
        if token is not None:
            await _revoke_family(db, token.family_id)

    _clear_refresh_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post(
    "/logout-all",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf_header)],
)
async def logout_all(user: CurrentUser, response: Response, db: DbSession) -> Response:
    """登出所有裝置：撤銷這個使用者的所有 family。

    這個要求有效的 access token——它是「我懷疑帳號被入侵」時的動作，
    影響範圍大，值得多一道驗證。
    """
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    await db.commit()

    _clear_refresh_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=UserResponse)
async def me(user: CurrentUser) -> User:
    return user