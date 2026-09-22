import json
import uuid
from typing import Annotated, Any

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from app.core.config import settings
from app.core.ratelimit import auth_limiter, client_key
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models import Project, ProjectMember, User
from app.schemas.project import ProjectRole

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
    由本模組的 accessible_project() / OwnerProject 處理——只驗身分不驗存取權
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


# ── 專案授權 ──────────────────────────────────────────────────────────────
#
# 兩個層級，刻意分開：
#   accessible_project() → owner 或 member，看得到這個專案
#   OwnerProject         → 只有 owner，能邀請、移除成員、刪除專案
#
# 放在 deps.py 而不是 projects.py：projects 與 members 兩個 router 都要用同一套
# 判斷，授權邏輯出現兩份就是它們哪天走散的開始。


def project_access(user_id: uuid.UUID) -> ColumnElement[bool]:
    """「這個人看得到這個專案嗎」的 WHERE 條件。

    owner 的真相在 projects.owner_id，member 的真相在 project_members，所以是
    OR 而不是單查一張表。用相關子查詢的 EXISTS 而不是 JOIN：JOIN 會讓同時是
    owner 又（不該發生地）有 member 列的專案出現兩次，接著就得補 DISTINCT，
    而 DISTINCT 會逼出排序或雜湊。EXISTS 找到一列就停，語意上也正是我們要問的。

    回傳的是條件本身而不是完整查詢，因為它要用在三個地方：dependency 的
    SELECT、save_document 的 CAS UPDATE、以及衝突判別查詢。授權條件只寫一次，
    三處才不會走散。
    """
    return or_(
        Project.owner_id == user_id,
        select(1)
        .where(ProjectMember.project_id == Project.id, ProjectMember.user_id == user_id)
        # 明確 correlate：少了它，子查詢可能把 projects 自己也放進 FROM，
        # 條件就從「這個專案」變成「任何專案」，等於所有人都有存取權。
        .correlate(Project)
        .exists(),
    )


def project_role(owner_id: uuid.UUID, user_id: uuid.UUID) -> ProjectRole:
    """回應上的 role。推導出來的，不是欄位。

    跟 project_access() 放在一起是刻意的：兩者依據的是同一個真相
    （projects.owner_id）。誰要是在別的模組自己再推一次，遲早會出現「回應說你是
    owner、授權卻判定你是 member」這種兩邊說法不一致的狀態。

    ⚠️ 這個值只決定前端顯示什麼，不是授權依據。授權一律由端點自己的 dependency
    判斷，客戶端看到什麼 role 都不影響。
    """
    return "owner" if owner_id == user_id else "member"


def project_not_found() -> HTTPException:
    """每次建立新的實例。

    Exception 被 raise 時會綁上 traceback，共用同一個 module 層級的實例
    等於讓並行的請求互相覆寫彼此的狀態。
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="找不到專案")


def not_project_owner() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN, detail="只有專案擁有者能執行這個操作"
    )


def accessible_project(*, with_document: bool = False):
    """取得目前使用者有存取權的專案，否則 404。

    「不存在」與「你不是成員」都回 404：403 會洩漏「這個 UUID 對應的專案存在」。
    UUID 難猜，但沒必要提供這個資訊。

    document 預設 defer 掉。它可能是幾百 KB，而改名、刪除、成員管理都用不到它，
    這是為了連「從資料庫撈出來」都省掉，不只是不回傳。
    """

    async def dependency(project_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Project:
        stmt = select(Project).where(Project.id == project_id, project_access(user.id))
        if not with_document:
            stmt = stmt.options(defer(Project.document))

        project = await db.scalar(stmt)
        if project is None:
            raise project_not_found()
        return project

    return dependency


AccessibleProject = Annotated[Project, Depends(accessible_project())]
AccessibleProjectWithDocument = Annotated[Project, Depends(accessible_project(with_document=True))]


async def require_project_owner(project: AccessibleProject, user: CurrentUser) -> Project:
    """owner-only 操作用。

    先經過 accessible_project()，所以非成員在那裡就已經拿到 404；能走到這行的人
    一定看得到這個專案，對他回 403 不會洩漏任何他還不知道的事。反過來說，若這裡
    改成自己查一次 projects，403 與 404 的差異就會變成 UUID 探測器。
    """
    if project.owner_id != user.id:
        raise not_project_owner()
    return project


OwnerProject = Annotated[Project, Depends(require_project_owner)]


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
