"""專案端點的授權矩陣。

這組測試釘住兩件事：

1. 非擁有者一律拿到 404，不是 403。403 會洩漏「這個 UUID 確實對應到一個專案」。
2. 授權判斷優先於其他錯誤。`save_document()` 特別重要——它刻意不使用
   `owned_project()` dependency，而是把 `owner_id` 條件寫進 compare-and-set
   的 UPDATE 裡。授權條件同時存在於兩個不同機制，正是最容易在重構時走散的地方。
"""

import uuid

import pytest
from sqlalchemy import select

from app.models import Project

from .conftest import EMPTY_DOCUMENT

# (名稱, HTTP method, path 樣板, body, 擁有者預期狀態碼)
ENDPOINTS = [
    ("get", "GET", "/api/projects/{id}", None, 200),
    ("rename", "PATCH", "/api/projects/{id}", {"name": "改名後"}, 200),
    (
        "save_document",
        "PUT",
        "/api/projects/{id}/document",
        {"document_version": 1, "document": EMPTY_DOCUMENT},
        200,
    ),
    ("delete", "DELETE", "/api/projects/{id}", None, 204),
]

IDS = [e[0] for e in ENDPOINTS]


@pytest.mark.parametrize("name,method,template,body,owner_status", ENDPOINTS, ids=IDS)
async def test_owner_is_allowed(
    client, make_user, make_project, auth, name, method, template, body, owner_status
):
    owner = await make_user()
    project = await make_project(owner)

    response = await client.request(
        method, template.format(id=project.id), json=body, headers=auth(owner)
    )

    assert response.status_code == owner_status


@pytest.mark.parametrize("name,method,template,body,owner_status", ENDPOINTS, ids=IDS)
async def test_other_user_gets_404(
    client, make_user, make_project, auth, name, method, template, body, owner_status
):
    owner = await make_user()
    intruder = await make_user()
    project = await make_project(owner)

    response = await client.request(
        method, template.format(id=project.id), json=body, headers=auth(intruder)
    )

    assert response.status_code == 404


@pytest.mark.parametrize("name,method,template,body,owner_status", ENDPOINTS, ids=IDS)
async def test_unauthenticated_gets_401(
    client, make_user, make_project, name, method, template, body, owner_status
):
    owner = await make_user()
    project = await make_project(owner)

    response = await client.request(method, template.format(id=project.id), json=body)

    assert response.status_code == 401


@pytest.mark.parametrize("name,method,template,body,owner_status", ENDPOINTS, ids=IDS)
async def test_nonexistent_project_gets_404(
    client, make_user, auth, name, method, template, body, owner_status
):
    """不存在與不屬於你必須無法區分，否則 404 的反列舉設計就白做了。"""
    user = await make_user()

    response = await client.request(
        method, template.format(id=uuid.uuid4()), json=body, headers=auth(user)
    )

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


async def test_other_user_with_stale_version_gets_404_not_409(
    client, make_user, make_project, auth
):
    """CAS 的 UPDATE 對「版本不符」與「不是你的」都是 0 rows。

    後續的判別查詢若漏掉 owner_id 條件，這裡就會回 409——等於告訴入侵者
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


async def test_list_only_returns_own_projects(client, make_user, make_project, auth):
    owner = await make_user()
    other = await make_user()
    mine = await make_project(owner, name="我的")
    await make_project(other, name="別人的")

    response = await client.get("/api/projects", headers=auth(owner))

    assert response.status_code == 200
    returned = response.json()
    assert [p["id"] for p in returned] == [str(mine.id)]


async def test_list_requires_authentication(client):
    response = await client.get("/api/projects")
    assert response.status_code == 401