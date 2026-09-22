"""專案端點的授權矩陣。

這組測試釘住三件事：

1. 非成員一律拿到 404，不是 403。403 會洩漏「這個 UUID 確實對應到一個專案」。
2. member 拿到的是 403 而不是 404——他本來就看得到這個專案，對他隱藏存在性沒有
   意義，只會讓錯誤訊息說謊。這兩條合起來才是完整的反列舉設計。
3. 授權判斷優先於其他錯誤。`save_document()` 特別重要——它刻意不使用
   `accessible_project()` dependency，而是把存取條件寫進 compare-and-set
   的 UPDATE 裡。授權條件同時存在於兩個不同機制，正是最容易在重構時走散的地方。
"""

import uuid

import pytest
from sqlalchemy import select

from app.models import Project

from .conftest import EMPTY_DOCUMENT

# (名稱, HTTP method, path 樣板, body, owner 預期, member 預期)
#
# member 可以讀、可以改名、可以存檔（改名屬於 edit）；只有刪除專案是 owner-only。
ENDPOINTS = [
    ("get", "GET", "/api/projects/{id}", None, 200, 200),
    ("rename", "PATCH", "/api/projects/{id}", {"name": "改名後"}, 200, 200),
    (
        "save_document",
        "PUT",
        "/api/projects/{id}/document",
        {"document_version": 1, "document": EMPTY_DOCUMENT},
        200,
        200,
    ),
    ("delete", "DELETE", "/api/projects/{id}", None, 204, 403),
]

IDS = [e[0] for e in ENDPOINTS]
PARAMS = "name,method,template,body,owner_status,member_status"


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_owner_is_allowed(
    client, make_user, make_project, auth, name, method, template, body, owner_status, member_status
):
    owner = await make_user()
    project = await make_project(owner)

    response = await client.request(
        method, template.format(id=project.id), json=body, headers=auth(owner)
    )

    assert response.status_code == owner_status


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_member_gets_access_except_owner_only_actions(
    client,
    make_user,
    make_project,
    make_member,
    auth,
    name,
    method,
    template,
    body,
    owner_status,
    member_status,
):
    owner = await make_user()
    member = await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    response = await client.request(
        method, template.format(id=project.id), json=body, headers=auth(member)
    )

    assert response.status_code == member_status


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_other_user_gets_404(
    client, make_user, make_project, auth, name, method, template, body, owner_status, member_status
):
    owner = await make_user()
    intruder = await make_user()
    project = await make_project(owner)

    response = await client.request(
        method, template.format(id=project.id), json=body, headers=auth(intruder)
    )

    assert response.status_code == 404


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_unauthenticated_gets_401(
    client, make_user, make_project, name, method, template, body, owner_status, member_status
):
    owner = await make_user()
    project = await make_project(owner)

    response = await client.request(method, template.format(id=project.id), json=body)

    assert response.status_code == 401


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_nonexistent_project_gets_404(
    client, make_user, auth, name, method, template, body, owner_status, member_status
):
    """不存在與不屬於你必須無法區分，否則 404 的反列舉設計就白做了。"""
    user = await make_user()

    response = await client.request(
        method, template.format(id=uuid.uuid4()), json=body, headers=auth(user)
    )

    assert response.status_code == 404


async def test_member_of_another_project_still_gets_404(
    client, make_user, make_project, make_member, auth
):
    """成員身分不會外溢到別的專案。

    project_access() 的 EXISTS 子查詢若漏掉 correlate 或漏掉 project_id 條件，
    條件就會從「這個專案的成員」鬆成「任何專案的成員」，而這個測試是唯一會發現
    這件事的地方——其他測試裡的成員剛好都只有一個專案。
    """
    owner = await make_user()
    outsider = await make_user()
    mine = await make_project(owner, name="不該被看到的")
    other = await make_project(outsider, name="外人自己的專案")
    await make_member(other, outsider)

    response = await client.get(f"/api/projects/{mine.id}", headers=auth(outsider))

    assert response.status_code == 404


# ── 狀態碼相同不代表沒發生副作用 ──────────────────────────────────────────


async def test_other_user_delete_does_not_remove_the_row(
    client, db_session, make_user, make_project, auth
):
    owner = await make_user()
    intruder = await make_user()
    project = await make_project(owner)

    response = await client.delete(f"/api/projects/{project.id}", headers=auth(intruder))
    assert response.status_code == 404

    still_there = await db_session.scalar(select(Project).where(Project.id == project.id))
    assert still_there is not None


async def test_member_delete_does_not_remove_the_row(
    client, db_session, make_user, make_project, make_member, auth
):
    owner = await make_user()
    member = await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    response = await client.delete(f"/api/projects/{project.id}", headers=auth(member))
    assert response.status_code == 403

    still_there = await db_session.scalar(select(Project).where(Project.id == project.id))
    assert still_there is not None


async def test_other_user_rename_does_not_change_the_name(
    client, db_session, make_user, make_project, auth
):
    owner = await make_user()
    intruder = await make_user()
    project = await make_project(owner, name="原始名稱")

    response = await client.patch(
        f"/api/projects/{project.id}", json={"name": "被入侵者改掉"}, headers=auth(intruder)
    )
    assert response.status_code == 404

    await db_session.refresh(project)
    assert project.name == "原始名稱"


async def test_other_user_save_does_not_overwrite_the_document(
    client, db_session, make_user, make_project, auth
):
    owner = await make_user()
    intruder = await make_user()
    project = await make_project(owner)

    response = await client.put(
        f"/api/projects/{project.id}/document",
        json={"document_version": 1, "document": {"tampered": True}},
        headers=auth(intruder),
    )
    assert response.status_code == 404

    await db_session.refresh(project)
    assert project.document == EMPTY_DOCUMENT
    assert project.document_version == 1


async def test_member_save_actually_writes(
    client, db_session, make_user, make_project, make_member, auth
):
    """member 的 200 必須是真的寫進去了，不是只回對狀態碼。"""
    owner = await make_user()
    member = await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    response = await client.put(
        f"/api/projects/{project.id}/document",
        json={"document_version": 1, "document": {"by": "member"}},
        headers=auth(member),
    )
    assert response.status_code == 200

    await db_session.refresh(project)
    assert project.document == {"by": "member"}
    assert project.document_version == 2


# ── 404 與 409 不可互相取代 ───────────────────────────────────────────────


async def test_owner_with_stale_version_gets_409(client, make_user, make_project, auth):
    owner = await make_user()
    project = await make_project(owner)

    response = await client.put(
        f"/api/projects/{project.id}/document",
        json={"document_version": 99, "document": EMPTY_DOCUMENT},
        headers=auth(owner),
    )

    assert response.status_code == 409


async def test_member_with_stale_version_gets_409(
    client, make_user, make_project, make_member, auth
):
    """CAS 失敗後的判別查詢也必須是 membership-aware。

    那個查詢若還停在 owner_id == me，member 的版本衝突會被誤報成 404，
    前端就會把「有人同時在編輯」當成「專案不見了」。
    """
    owner = await make_user()
    member = await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    response = await client.put(
        f"/api/projects/{project.id}/document",
        json={"document_version": 99, "document": EMPTY_DOCUMENT},
        headers=auth(member),
    )

    assert response.status_code == 409


async def test_other_user_with_stale_version_gets_404_not_409(
    client, make_user, make_project, auth
):
    """CAS 的 UPDATE 對「版本不符」與「你沒有存取權」都是 0 rows。

    後續的判別查詢若漏掉存取條件，這裡就會回 409——等於告訴入侵者
    「這個專案存在，而且它現在的版本不是 99」。
    """
    owner = await make_user()
    intruder = await make_user()
    project = await make_project(owner)

    response = await client.put(
        f"/api/projects/{project.id}/document",
        json={"document_version": 99, "document": EMPTY_DOCUMENT},
        headers=auth(intruder),
    )

    assert response.status_code == 404


# ── 列表端點 ──────────────────────────────────────────────────────────────


async def test_list_returns_owned_and_joined_projects(
    client, make_user, make_project, make_member, auth
):
    user = await make_user()
    other = await make_user()
    mine = await make_project(user, name="我的")
    joined = await make_project(other, name="我被邀請的")
    await make_member(joined, user)
    await make_project(other, name="與我無關的")

    response = await client.get("/api/projects", headers=auth(user))

    assert response.status_code == 200
    returned = {p["id"] for p in response.json()}
    assert returned == {str(mine.id), str(joined.id)}


async def test_list_does_not_duplicate_owned_projects(
    client, make_user, make_project, make_member, auth
):
    """owner 不該被寫進 project_members，但就算哪天被寫進去了，列表也不能出現兩次。

    這正是用 EXISTS 而不是 JOIN 的理由：JOIN 需要 DISTINCT 才能避免重複列。
    """
    owner = await make_user()
    project = await make_project(owner)
    await make_member(project, owner)

    response = await client.get("/api/projects", headers=auth(owner))

    assert response.status_code == 200
    assert [p["id"] for p in response.json()] == [str(project.id)]


async def test_list_requires_authentication(client):
    response = await client.get("/api/projects")
    assert response.status_code == 401


# ── role 是相對於請求者的推導值 ───────────────────────────────────────────
#
# role 只給前端決定顯示什麼用（「我的 / 參與中」、要不要出現刪除與成員管理入口），
# 不是授權依據——授權由端點自己的 dependency 判斷，上面的矩陣才是權威。
# 這一組釘住的是「每條回傳 summary 的路徑都帶了 role，而且帶的是這個請求者的」。


async def test_list_marks_owned_and_joined_projects(
    client, make_user, make_project, make_member, auth
):
    user = await make_user()
    other = await make_user()
    mine = await make_project(user, name="我的")
    joined = await make_project(other, name="我被邀請的")
    await make_member(joined, user)

    response = await client.get("/api/projects", headers=auth(user))

    assert response.status_code == 200
    assert {p["id"]: p["role"] for p in response.json()} == {
        str(mine.id): "owner",
        str(joined.id): "member",
    }


async def test_role_differs_per_viewer(client, make_user, make_project, make_member, auth):
    """同一個專案，兩個人看到的 role 不同。

    順便釘住 owner_id 不進回應：它是為了推導 role 才被查出來的，前端只需要知道
    「是不是我」，不需要知道是誰。
    """
    owner = await make_user()
    member = await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    as_owner = await client.get(f"/api/projects/{project.id}", headers=auth(owner))
    as_member = await client.get(f"/api/projects/{project.id}", headers=auth(member))

    assert as_owner.json()["role"] == "owner"
    assert as_member.json()["role"] == "member"
    assert "owner_id" not in as_member.json()


async def test_rename_response_keeps_the_caller_role(
    client, make_user, make_project, make_member, auth
):
    """改名回的 summary 會被前端拿去替換列表裡的那一筆。

    這裡若漏掉 role 或永遠回 owner，member 改個名字，列表上就會長出一顆刪除按鈕。
    """
    owner = await make_user()
    member = await make_user()
    project = await make_project(owner)
    await make_member(project, member)

    response = await client.patch(
        f"/api/projects/{project.id}", json={"name": "改名後"}, headers=auth(member)
    )

    assert response.status_code == 200
    assert response.json()["role"] == "member"


async def test_created_project_is_owned_by_its_creator(client, make_user, auth):
    user = await make_user()

    response = await client.post(
        "/api/projects", json={"name": "新專案", "document": EMPTY_DOCUMENT}, headers=auth(user)
    )

    assert response.status_code == 201
    assert response.json()["role"] == "owner"
