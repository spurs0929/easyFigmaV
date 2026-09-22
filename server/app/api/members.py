import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import AccessibleProject, DbSession, OwnerProject, project_role, rate_limit
from app.models import Project, ProjectMember, User
from app.schemas.member import MemberInvite, ProjectMemberOut

router = APIRouter(prefix="/projects/{project_id}/members", tags=["Members"])


def _as_member(user: User, project: Project) -> ProjectMemberOut:
    return ProjectMemberOut(
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        role=project_role(project.owner_id, user.id),
    )


@router.get("", response_model=list[ProjectMemberOut])
async def list_members(project: AccessibleProject, db: DbSession) -> list[ProjectMemberOut]:
    """owner 與 member 都看得到成員名單。

    分兩個查詢而不是一個 UNION：owner 與 member 來自不同的真相來源，分開寫才看得出
    這件事。名單很短（v1 沒有大型團隊），省不到什麼。

    email 會給同專案的其他成員看到——邀請本來就是用 email 進行的，這是可接受的
    揭露範圍。但它不得進入 log。
    """
    owner = await db.scalar(select(User).where(User.id == project.owner_id))
    members = await db.scalars(
        select(User)
        .join(ProjectMember, ProjectMember.user_id == User.id)
        .where(ProjectMember.project_id == project.id)
        .order_by(ProjectMember.created_at)
    )

    # owner 一定存在：projects.owner_id 是 NOT NULL 外鍵，帳號刪除會連帶刪掉專案。
    rows = [_as_member(owner, project)] if owner else []
    rows.extend(_as_member(m, project) for m in members)
    return rows


@router.post(
    "",
    response_model=ProjectMemberOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit("project_invite"))],
)
async def add_member(
    payload: MemberInvite,
    project: OwnerProject,
    db: DbSession,
) -> ProjectMemberOut:
    """邀請既有使用者成為成員。只有 owner 可以。

    ⚠️ 授權必須先完成。OwnerProject 這個 dependency 在 handler 被呼叫之前就已經
    確認「這個專案存在、而且你是它的 owner」，email 查詢才發生在它後面。順序反過來
    的話，任何登入者都能拿這支端點問「某個 email 有沒有註冊」。

    即使如此，一個 owner 仍然可以用自己的專案逐一試探 email，所以額外掛了速率限制。
    這是刻意的取捨：邀請流程若不能明確回報「查無此人」，使用者根本不知道該怎麼辦。
    取捨已記錄在 docs/。
    """
    user = await db.scalar(select(User).where(User.email == payload.email))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="找不到這個 email 對應的使用者"
        )

    if user.id == project.owner_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="擁有者已經在專案裡，不需要邀請"
        )

    try:
        # SAVEPOINT：重複邀請的權威判斷是複合主鍵，不是應用層先查一次——先查再寫
        # 之間有空窗，兩個並行請求會同時通過檢查。讓資料庫擋，再把違規轉成 409。
        # 沒有這個 SAVEPOINT 的話，IntegrityError 會讓整個交易進入待回滾狀態，
        # 之後任何查詢都會失敗，409 就變成 500。
        async with db.begin_nested():
            db.add(ProjectMember(project_id=project.id, user_id=user.id))
    except IntegrityError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="這個使用者已經是專案成員"
        ) from exc

    await db.commit()
    return _as_member(user, project)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    user_id: uuid.UUID,
    project: OwnerProject,
    db: DbSession,
) -> None:
    """移除成員。只有 owner 可以。

    v1 沒有「成員自行退出」——授權矩陣裡沒有這一格，加了就要決定 owner 收不收得到
    通知、前端要不要即時反應，那是另一張 task。
    """
    if user_id == project.owner_id:
        # 擁有權轉移不在 v1 範圍內，所以 owner 也不能把自己移除掉——
        # 那會產生一個沒有 owner 的專案。
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="不能移除專案擁有者")

    result = await db.execute(
        delete(ProjectMember).where(
            ProjectMember.project_id == project.id, ProjectMember.user_id == user_id
        )
    )
    if result.rowcount == 0:
        # 這裡回 404 不洩漏任何東西：能走到這行的人已經是這個專案的 owner，
        # 成員名單本來就是他看得到的資訊。
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="這個使用者不是專案成員")
    await db.commit()
