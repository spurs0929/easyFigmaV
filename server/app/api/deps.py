from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ratelimit import auth_limiter, client_key
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models import User

DbSession = Annotated[AsyncSession, Depends(get_db)]

_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="未通過驗證",
    headers={"WWW-Authenticate": "Bearer"},
)


async def get_current_user(
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    """之後所有需要登入的端點都掛這個。

    注意這只回答「你是誰」，不回答「你能不能碰這個資源」。授權是另一件事，
    要用 require_project_role 之類的 dependency 處理——只驗身分不驗擁有權
    就是 IDOR 的來源。
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise _UNAUTHORIZED

    user_id = decode_access_token(authorization[7:].strip())
    if user_id is None:
        raise _UNAUTHORIZED

    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None:
        # token 有效但使用者已被刪除
        raise _UNAUTHORIZED

    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def require_csrf_header(
    x_requested_with: Annotated[str | None, Header()] = None,
) -> None:
    """給所有靠 cookie 驗證的端點用（refresh / logout）。

    這些端點的憑證是瀏覽器自動附帶的 cookie，所以會受 CSRF 影響。因為前後端
    不同網域（且 onrender.com 在 Public Suffix List 上），cookie 必須是
    SameSite=None，SameSite 這道防線用不上。

    改用自訂 header：跨來源請求只要帶自訂 header 就會觸發 preflight，
    而 preflight 會被我們的 CORS allowlist 擋在真正的請求之前。
    攻擊者的頁面無法從別的網域補上這個 header。
    """
    if x_requested_with != "XMLHttpRequest":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="缺少必要的請求標頭",
        )


def rate_limit(scope: str):
    """回傳一個限流 dependency。scope 用來區分不同端點的計數桶。"""

    async def _check(request: Request) -> None:
        if not auth_limiter.check(client_key(request, scope)):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="嘗試次數過多，請稍後再試",
            )

    return _check
