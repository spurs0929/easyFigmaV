import json
import uuid
from typing import Annotated, Any, NamedTuple

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.ratelimit import auth_limiter, client_key
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models import Project, User

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


# ─────────────────────────── 專案 ───────────────────────────


class ProjectRef(NamedTuple):
    """通過授權的專案，只帶必要欄位。

    刻意不載入 document：autosave 每幾秒送一次，若為了檢查擁有權而先把舊的
    document（可能數百 KB）讀出來再覆蓋，等於把資料庫流量加倍。
    需要完整內容的端點自己再依 id 取一次。
    """

    id: uuid.UUID
    document_version: int


async def require_owned_project(
    project_id: uuid.UUID,
    user: CurrentUser,
    db: DbSession,
) -> ProjectRef:
    """所有專案端點的授權入口。

    「不存在」與「不屬於你」都回 404。若對後者回 403，等於告訴對方
    「這個 UUID 確實對應到一個專案，只是不是你的」——UUID 雖然難猜，
    但沒有必要提供這個資訊。

    之後加入 project_members 時，把這裡改成處理 owner OR member 即可，
    端點的簽章完全不用動。
    """
    row = (
        await db.execute(
            select(Project.id, Project.document_version).where(
                Project.id == project_id,
                Project.owner_id == user.id,
            )
        )
    ).first()

    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "找不到專案")

    return ProjectRef(row.id, row.document_version)


OwnedProject = Annotated[ProjectRef, Depends(require_owned_project)]


def ensure_document_size(document: dict[str, Any]) -> None:
    """第二道大小檢查：實際序列化後的位元組數。

    第一道是 BodySizeLimitMiddleware，它限制的是整個 HTTP body；這一道限制的
    是 document 本身，兩者檢查的東西不同，都要有。

    刻意回 413 而不是讓 Pydantic validator 產生 422：對呼叫端而言「內容過大」
    就是同一件事，不該因為被哪一層攔到而拿到不同的狀態碼。

    量的是 UTF-8 位元組不是 len(dict)——後者只是鍵的數量，跟大小無關。
    用最精簡的分隔符是因為這裡要衡量的是「存進 Postgres 的量」，
    JSONB 本來就會正規化，送來的空白不算數。
    """
    size = len(json.dumps(document, separators=(",", ":")).encode())
    if size > settings.max_document_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"內容過大（{size} bytes，上限 {settings.max_document_bytes}）",
        )