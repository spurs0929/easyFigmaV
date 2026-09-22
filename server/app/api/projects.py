import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import delete, func, select, update

from app.api.deps import (
    AccessibleProject,
    AccessibleProjectWithDocument,
    CurrentUser,
    DbSession,
    ensure_document_size,
    not_project_owner,
    project_access,
    project_not_found,
    project_role,
)
from app.core.config import settings
from app.core.logging import get_logger
from app.models import Project, ProjectMember
from app.schemas.project import (
    DocumentSaved,
    DocumentUpdate,
    ProjectCreate,
    ProjectDetail,
    ProjectRename,
    ProjectSummary,
)

router = APIRouter(prefix="/projects", tags=["Projects"])

logger = get_logger(__name__)

# 列表與改名共用的欄位。直接指定欄位而不是撈整個 entity，是為了連「把 document
# 從資料庫拿出來」都省掉——它可能是幾百 KB，而這兩條路徑都用不到它。
_SUMMARY_COLUMNS = (
    Project.id,
    # role 的來源。它不會出現在回應裡，但推導 role 需要它，而多讀一個 UUID 欄位
    # 跟 document 完全不是同一個量級。
    Project.owner_id,
    Project.name,
    Project.document_version,
    Project.created_at,
    Project.updated_at,
)


def _summary(row: Any, user_id: uuid.UUID) -> ProjectSummary:
    """把一列專案資料組成回應。

    row 可以是 _SUMMARY_COLUMNS 查出來的 Row，也可以是 Project 實例——兩者的欄位
    存取方式相同，所以列表、改名、單筆都走同一個組裝點，role 才不會有某條路徑忘了帶。

    不用 model_validate(row)：role 不在資料列裡，它要由 user_id 推導。
    """
    return ProjectSummary(
        id=row.id,
        name=row.name,
        document_version=row.document_version,
        created_at=row.created_at,
        updated_at=row.updated_at,
        role=project_role(row.owner_id, user_id),
    )


def _detail(project: Project, user_id: uuid.UUID) -> ProjectDetail:
    return ProjectDetail(**_summary(project, user_id).model_dump(), document=project.document)


@router.get("", response_model=list[ProjectSummary])
async def list_projects(user: CurrentUser, db: DbSession) -> list[ProjectSummary]:
    """自己擁有的，加上被邀請加入的。

    條件用 project_access() 而不是在這裡另外寫一次 OR：列表看得到的專案集合，
    必須與單筆端點放行的集合完全相同，否則會出現「列表看得到但打不開」
    或更糟的「列表看不到但打得開」。

    每一列都帶 role，前端才分得出「我的」與「參與中」。用 owner_id 在 Python 端
    推導而不是在 SQL 裡寫 CASE：推導只有一份（project_role()），SQL 與 Python
    兩套寫法遲早會走散。
    """
    rows = await db.execute(
        select(*_SUMMARY_COLUMNS)
        .where(project_access(user.id))
        .order_by(Project.updated_at.desc())
        .limit(settings.max_projects_per_page)
    )
    return [_summary(row, user.id) for row in rows]


@router.post(
    "",
    response_model=ProjectDetail,
    status_code=status.HTTP_201_CREATED,
)
async def create_project(payload: ProjectCreate, user: CurrentUser, db: DbSession) -> ProjectDetail:
    ensure_document_size(payload.document)
    project = Project(owner_id=user.id, name=payload.name, document=payload.document)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    # 建立者必然是 owner，但仍走同一個推導，不寫死字串。
    return _detail(project, user.id)


@router.get("/{project_id}", response_model=ProjectDetail)
async def get_project(project: AccessibleProjectWithDocument, user: CurrentUser) -> ProjectDetail:
    return _detail(project, user.id)


@router.patch("/{project_id}", response_model=ProjectSummary)
async def rename_project(
    payload: ProjectRename, project: AccessibleProject, user: CurrentUser, db: DbSession
) -> ProjectSummary:
    """改名。member 也可以——改名屬於 edit，不是 owner-only 的管理操作。

    用 UPDATE ... RETURNING 而不是改屬性再 commit + refresh：refresh() 會重新
    載入實例的欄位，而 document 是 deferred 的，意圖上不該在改名路徑被碰到。
    直接指定要回傳的欄位，SQL 就不可能把它撈回來。

    授權已經由 dependency 完成，所以這裡的 WHERE 只需要主鍵——條件寫兩次
    反而會讓人以為這裡也是授權點。

    updated_at 必須明確帶上：server_default=now() 只作用於 INSERT，
    UPDATE 不會自動更新，漏了的話列表的「最近修改」排序會停在建立時間，
    而且不會有任何錯誤訊息。

    刻意不動 document_version：它是 document 的修訂版本。改名也遞增的話，
    使用者在列表頁改個名字，開著的編輯器下次存檔就會收到 409。
    """
    row = (
        await db.execute(
            update(Project)
            .where(Project.id == project.id)
            .values(name=payload.name, updated_at=func.now())
            .returning(*_SUMMARY_COLUMNS)
            .execution_options(synchronize_session=False)
        )
    ).one()
    await db.commit()
    # 回傳的是 summary，前端會拿它直接替換列表裡的那一筆，所以 role 必須跟著回去，
    # 而且必須是「這個請求者的」role，不是永遠 owner。
    return _summary(row, user.id)


@router.put(
    "/{project_id}/document",
    response_model=DocumentSaved,
)
async def save_document(
    project_id: uuid.UUID,
    payload: DocumentUpdate,
    user: CurrentUser,
    db: DbSession,
) -> DocumentSaved:
    """儲存畫布內容，以 compare-and-set 實作樂觀鎖。member 也可以存檔。

    這支刻意不用 accessible_project dependency：一來授權條件已經在 UPDATE 的
    WHERE 裡，二來 dependency 會先把舊的 document 從資料庫撈出來，而這條
    路徑正要覆蓋它，撈出來純屬浪費。

    版本比對必須放進 UPDATE 本身。先讀出來、比對、再寫回的話，兩個並行請求
    可能都通過比對，後寫的那個會覆蓋掉前一個，樂觀鎖形同虛設。

    ⚠️ 授權條件在這支端點出現兩次：CAS 的 UPDATE 與底下判別 404/409 的查詢。
    兩處都必須是 project_access()，只改一處的話，第二個查詢就會用比較寬鬆
    （或比較嚴格）的條件回答「這個專案存在嗎」，狀態碼會開始說謊。
    """
    ensure_document_size(payload.document)

    result = await db.execute(
        update(Project)
        .where(
            Project.id == project_id,
            project_access(user.id),
            Project.document_version == payload.document_version,
        )
        .values(
            document=payload.document,
            document_version=Project.document_version + 1,
            updated_at=func.now(),
        )
        .returning(Project.document_version, Project.updated_at)
    )
    row = result.first()

    if row is None:
        # 沒更新到任何列有兩種原因，要分開回應：專案不存在 / 你沒有存取權 → 404，
        # 存在但版本不符 → 409。少了這個查詢，衝突會被誤報成 404。
        #
        # UPDATE 影響 0 列不是資料庫錯誤，transaction 仍可繼續查詢。
        current = await db.scalar(
            select(Project.document_version).where(
                Project.id == project_id, project_access(user.id)
            )
        )
        if current is None:
            raise project_not_found()
        # 樂觀鎖衝突是正常流程的一部分，不是錯誤；記成 info 是為了量測——
        # 衝突頻率是判斷「單機持久化是否還夠用」的依據之一。
        logger.info(
            "document_save_conflict",
            project_id=str(project_id),
            expected_version=payload.document_version,
            current_version=current,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"專案已被其他視窗修改（目前版本 {current}），請重新載入",
        )

    await db.commit()
    return DocumentSaved(document_version=row[0], updated_at=row[1])


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    """只有 owner 能刪。

    硬刪除。soft delete 要在每個查詢加 deleted_at IS NULL，漏一個就是
    別人刪掉的專案還查得到；沒有垃圾桶需求就不製造那個狀態。

    成員一併消失：project_members 的外鍵是 ON DELETE CASCADE。
    """
    result = await db.execute(
        delete(Project).where(Project.id == project_id, Project.owner_id == user.id)
    )
    if result.rowcount == 0:
        # 刪不到有兩種可能：不是你的，或根本不存在。要分辨的只有「你是不是這個
        # 專案的 member」——member 本來就看得到這個專案，對他回 403 沒有洩漏。
        #
        # ⚠️ 這裡刻意只查 project_members，不查 projects 是否存在。若改成
        # 「專案存在 → 403」，任何人都能拿這支端點逐一測試 UUID 是否對應到
        # 真實專案，反列舉的 404 設計就白做了。
        is_member = await db.scalar(
            select(1).where(
                ProjectMember.project_id == project_id, ProjectMember.user_id == user.id
            )
        )
        if is_member:
            raise not_project_owner()
        raise project_not_found()
    await db.commit()
