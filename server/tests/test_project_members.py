"""成員端點：授權矩陣與邀請 / 移除的語意。

授權部分與 test_projects_authorization.py 是同一套規則的延伸：
非成員 404、member 對 owner-only 操作 403、未登入 401。
"""

from types import SimpleNamespace

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models import Project, ProjectMember


@pytest_asyncio.fixture
async def team(make_user, make_project, make_member) -> SimpleNamespace:
    """owner + 一個 member + 一個完全無關的人 + 一個尚未加入的受邀者。"""
    owner = await make_user()
    member = await make_user()
    outsider = await make_user()
    invitee = await make_user()
    project = await make_project(owner)
    await make_member(project, member)
    return SimpleNamespace(
        owner=owner, member=member, outsider=outsider, invitee=invitee, project=project
    )


def _request(name: str, t: SimpleNamespace) -> tuple[str, str, dict | None]:
    base = f"/api/projects/{t.project.id}/members"
    if name == "list":
        return "GET", base, None
    if name == "invite":
        return "POST", base, {"email": t.invitee.email}
    if name == "remove":
        return "DELETE", f"{base}/{t.member.id}", None
    raise AssertionError(name)


# (名稱, owner 預期, member 預期, 非成員預期)
ENDPOINTS = [
    ("list", 200, 200, 404),
    ("invite", 201, 403, 404),
    ("remove", 204, 403, 404),
]
IDS = [e[0] for e in ENDPOINTS]
PARAMS = "name,owner_status,member_status,outsider_status"


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_owner_is_allowed(
    client, team, auth, name, owner_status, member_status, outsider_status
):
    t = team
    method, url, body = _request(name, t)

    response = await client.request(method, url, json=body, headers=auth(t.owner))

    assert response.status_code == owner_status


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_member_cannot_manage_members(
    client, team, auth, name, owner_status, member_status, outsider_status
):
    t = team
    method, url, body = _request(name, t)

    response = await client.request(method, url, json=body, headers=auth(t.member))

    assert response.status_code == member_status


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_outsider_gets_404(
    client, team, auth, name, owner_status, member_status, outsider_status
):
    """非成員連「這個專案存在」都不該推得出來，所以是 404 不是 403。"""
    t = team
    method, url, body = _request(name, t)

    response = await client.request(method, url, json=body, headers=auth(t.outsider))

    assert response.status_code == outsider_status


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_unauthenticated_gets_401(
    client, team, name, owner_status, member_status, outsider_status
):
    t = team
    method, url, body = _request(name, t)

    response = await client.request(method, url, json=body)

    assert response.status_code == 401


# ── 邀請 ──────────────────────────────────────────────────────────────────


async def test_invite_makes_the_user_a_member(client, db_session, team, auth):
    t = team

    response = await client.post(
        f"/api/projects/{t.project.id}/members",
        json={"email": t.invitee.email},
        headers=auth(t.owner),
    )
    assert response.status_code == 201
    assert response.json() == {
        "user_id": str(t.invitee.id),
        "email": t.invitee.email,
        "display_name": None,
        "role": "member",
    }

    # 被邀請的人立刻打得開這個專案
    opened = await client.get(f"/api/projects/{t.project.id}", headers=auth(t.invitee))
    assert opened.status_code == 200


async def test_invite_normalizes_email_case(client, team, auth):
    t = team

    response = await client.post(
        f"/api/projects/{t.project.id}/members",
        json={"email": t.invitee.email.upper()},
        headers=auth(t.owner),
    )

    assert response.status_code == 201


async def test_invite_unknown_email_gets_404(client, team, auth):
    """v1 只邀請既有帳號，沒有 pending invitation。"""
    t = team

    response = await client.post(
        f"/api/projects/{t.project.id}/members",
        json={"email": "nobody@example.com"},
        headers=auth(t.owner),
    )

    assert response.status_code == 404


async def test_invite_existing_member_gets_409_not_500(client, team, auth):
    """重複邀請由複合主鍵擋下。

    IntegrityError 若沒有被 SAVEPOINT 隔離，整個交易會進入待回滾狀態，
    這支端點就會回 500，而且後續在同一個 session 的查詢也會一起壞掉。
    """
    t = team

    response = await client.post(
        f"/api/projects/{t.project.id}/members",
        json={"email": t.member.email},
        headers=auth(t.owner),
    )

    assert response.status_code == 409

    # 交易仍然可用：同一個 client 接著還能正常讀
    after = await client.get(f"/api/projects/{t.project.id}/members", headers=auth(t.owner))
    assert after.status_code == 200


async def test_invite_owner_gets_409(client, team, auth):
    t = team

    response = await client.post(
        f"/api/projects/{t.project.id}/members",
        json={"email": t.owner.email},
        headers=auth(t.owner),
    )

    assert response.status_code == 409


async def test_invite_does_not_leak_emails_to_outsiders(client, db_session, team, auth):
    """非成員的 404 必須在 email 查詢之前就發生。

    狀態碼一樣不代表沒查——這裡另外確認沒有任何列被寫進去。授權若排在查詢之後，
    這支端點就是一台任何登入者都能用的 email 探測器。
    """
    t = team

    response = await client.post(
        f"/api/projects/{t.project.id}/members",
        json={"email": t.invitee.email},
        headers=auth(t.outsider),
    )
    assert response.status_code == 404

    rows = await db_session.scalars(
        select(ProjectMember).where(ProjectMember.project_id == t.project.id)
    )
    assert [r.user_id for r in rows] == [t.member.id]


# ── 移除 ──────────────────────────────────────────────────────────────────


async def test_remove_revokes_access(client, team, auth):
    t = team

    response = await client.delete(
        f"/api/projects/{t.project.id}/members/{t.member.id}", headers=auth(t.owner)
    )
    assert response.status_code == 204

    # 被移除的人立刻回到非成員狀態
    opened = await client.get(f"/api/projects/{t.project.id}", headers=auth(t.member))
    assert opened.status_code == 404


async def test_remove_owner_is_forbidden(client, team, auth):
    """擁有權轉移不在 v1 範圍，所以不允許產生沒有 owner 的專案。"""
    t = team

    response = await client.delete(
        f"/api/projects/{t.project.id}/members/{t.owner.id}", headers=auth(t.owner)
    )

    assert response.status_code == 403


async def test_remove_non_member_gets_404(client, team, auth):
    t = team

    response = await client.delete(
        f"/api/projects/{t.project.id}/members/{t.outsider.id}", headers=auth(t.owner)
    )

    assert response.status_code == 404


# ── 名單 ──────────────────────────────────────────────────────────────────


async def test_list_members_includes_owner_first_with_derived_role(client, team, auth):
    t = team

    response = await client.get(f"/api/projects/{t.project.id}/members", headers=auth(t.owner))

    assert response.status_code == 200
    rows = response.json()
    assert [r["user_id"] for r in rows] == [str(t.owner.id), str(t.member.id)]
    assert [r["role"] for r in rows] == ["owner", "member"]


async def test_members_are_removed_with_the_project(client, db_session, team, auth):
    """ON DELETE CASCADE：刪掉專案不留孤兒成員列。"""
    t = team

    response = await client.delete(f"/api/projects/{t.project.id}", headers=auth(t.owner))
    assert response.status_code == 204

    gone = await db_session.scalar(select(Project).where(Project.id == t.project.id))
    assert gone is None
    rows = await db_session.scalars(
        select(ProjectMember).where(ProjectMember.project_id == t.project.id)
    )
    assert rows.all() == []
