import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import load_only

from app.api.deps import CurrentUser, DbSession, enforce_body_size
from app.core.config import settings
from app.models import Project
from app.schemas.project import (
    DocumentSaved,
    DocumentUpdate,
    ProjectCreate,
    ProjectDetail,
    ProjectRename,
    ProjectSummary,
)

router = APIRouter(prefix="/projects", tags=["Projects"])

_NOT_FOUND = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="找不到專案")

# 列表用的欄位。document 不在裡面——那可能是幾百 KB，列表不需要，
# 而且用 load_only 是為了連「從資料庫撈出來」都省掉，不只是不回傳。
_SUMMARY_COLUMNS = (
    Project.id,
    Project.name,
    Project.document_version,
    Project.created_at,
    Project.updated_at,
)


def owned_project(*, with_document: bool = False):
    """取得屬於目前使用者的專案，否則 404。

    「不存在」與「不屬於你」都回 404：403 會洩漏「這個 UUID 對應的專案存在，
    只是不屬於你」。UUID 難猜，但沒必要提供這個資訊。

    之後加入 project_members 時，把這裡換成 owner OR member 的判斷即可，
    端點簽章完全不用動——這就是現在先抽成 dependency 的價值。
    """

    async def dependency(project_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Project:
        stmt = select(Project).where(Project.id == project_id, Project.owner_id == user.id)
        if not with_document:
            stmt = stmt.options(load_only(*_SUMMARY_COLUMNS))

        project = await db.scalar(stmt)
        if project is None:
            raise _NOT_FOUND
        return project

    return dependency


OwnedProject = Annotated[Project, Depends(owned_project())]
OwnedProjectWithDocument = Annotated[Project, Depends(owned_project(with_document=True))]


@router.get("", response_model=list[ProjectSummary])
async def list_projects(user: CurrentUser, db: DbSession) -> list[Project]:
    rows = await db.scalars(
        select(Project)
        .options(load_only(*_SUMMARY_COLUMNS))
        .where(Project.owner_id == user.id)
        .order_by(Project.updated_at.desc())
        .limit(settings.max_projects_per_page)
    )
    return list(rows)


@router.post(
    "",
    response_model=ProjectDetail,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(enforce_body_size)],
)
async def create_project(payload: ProjectCreate, user: CurrentUser, db: DbSession) -> Project:
    project = Project(owner_id=user.id, name=payload.name, document=payload.document)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


@router.get("/{project_id}", response_model=ProjectDetail)
async def get_project(project: OwnedProjectWithDocument) -> Project:
    return project


@router.patch("/{project_id}", response_model=ProjectSummary)
async def rename_project(
    payload: ProjectRename, project: OwnedProject, db: DbSession
) -> Project:
    project.name = payload.name
    # server_default=now() 只作用於 INSERT，UPDATE 必須自己帶，
    # 否則列表的「最近修改」排序會停在建立時間。
    project.updated_at = func.now()
    # 刻意不動 document_version：它是 document 的修訂版本。改名也遞增的話，
    # 使用者在列表頁改個名字，開著的編輯器下次存檔就會收到 409。
    await db.commit()
    await db.refresh(project)
    return project


@router.put(
    "/{project_id}/document",
    response_model=DocumentSaved,
    dependencies=[Depends(enforce_body_size)],
)
async def save_document(
    project_id: uuid.UUID,
    payload: DocumentUpdate,
    user: CurrentUser,
    db: DbSession,
) -> DocumentSaved:
    """儲存畫布內容，以 compare-and-set 實作樂觀鎖。

    這支刻意不用 owned_project dependency：一來授權條件已經在 UPDATE 的
    WHERE 裡，二來 dependency 會先把舊的 document 從資料庫撈出來，而這條
    路徑正要覆蓋它，撈出來純屬浪費。

    版本比對必須放進 UPDATE 本身。先讀出來、比對、再寫回的話，兩個並行請求
    可能都通過比對，後寫的那個會覆蓋掉前一個，樂觀鎖形同虛設。
    """
    result = await db.execute(
        update(Project)
        .where(
            Project.id == project_id,
            Project.owner_id == user.id,
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
        # 沒更新到任何列有兩種原因，要分開回應：專案不存在 / 不屬於你 → 404，
        # 存在但版本不符 → 409。少了這個查詢，衝突會被誤報成 404。
        #
        # 這裡不呼叫 rollback：UPDATE 沒有影響任何列，沒有東西需要回滾，
        # 而且 rollback 會把連線還回連線池，下一句查詢要重新取得連線。
        current = await db.scalar(
            select(Project.document_version).where(
                Project.id == project_id, Project.owner_id == user.id
            )
        )
        if current is None:
            raise _NOT_FOUND
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"專案已被其他視窗修改（目前版本 {current}），請重新載入",
        )

    await db.commit()
    return DocumentSaved(document_version=row[0], updated_at=row[1])


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    # 硬刪除。soft delete 要在每個查詢加 deleted_at IS NULL，漏一個就是
    # 別人刪掉的專案還查得到；沒有垃圾桶需求就不製造那個狀態。
    result = await db.execute(
        delete(Project).where(Project.id == project_id, Project.owner_id == user.id)
    )
    if result.rowcount == 0:
        raise _NOT_FOUND
    await db.commit()