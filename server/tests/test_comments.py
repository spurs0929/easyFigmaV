"""留言端點：授權矩陣、請求驗證、回應內容。

授權分兩層，這組測試兩層都釘住：

1. 專案層與 test_projects_authorization.py 是同一套規則——非成員與不存在的專案都是
   404，未登入是 401。
2. 留言層：改 content 與刪除只有作者可以，其他成員拿到 403（不是 404，他本來就
   看得到這則留言）；改 resolved 任何成員都可以。專案 owner 沒有額外權限。

資料庫自己擋得住的事（CHECK、CASCADE）在 test_comment_model.py。
"""

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
import pytest_asyncio
from sqlalchemy import delete, event, func, select

from app.models import Comment, ProjectMember
from app.models.comment import COMMENT_CONTENT_MAX_LENGTH

T0 = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


@pytest_asyncio.fixture
async def team(make_user, make_project, make_member, make_comment) -> SimpleNamespace:
    """owner + 兩個 member + 一個完全無關的人，以及一則由 member 寫的留言。

    留言的作者刻意是 member 而不是 owner：這樣「owner 不是作者」與「另一個 member
    不是作者」是兩個分得開的情況，才測得出 owner 沒有額外權限。
    """
    owner = await make_user()
    author = await make_user()
    other_member = await make_user()
    outsider = await make_user()
    project = await make_project(owner)
    await make_member(project, author)
    await make_member(project, other_member)
    comment = await make_comment(project, author, "原本的內容", created_at=T0)
    return SimpleNamespace(
        owner=owner,
        author=author,
        other_member=other_member,
        outsider=outsider,
        project=project,
        comment=comment,
    )


def _base(project_id) -> str:
    return f"/api/projects/{project_id}/comments"


def _request(name: str, t: SimpleNamespace) -> tuple[str, str, dict | None]:
    base = _base(t.project.id)
    one = f"{base}/{t.comment.id}"
    if name == "list":
        return "GET", base, None
    if name == "create":
        return "POST", base, {"world_x": 1.5, "world_y": -2.0, "content": "新的留言"}
    if name == "edit_content":
        return "PATCH", one, {"content": "改過的內容"}
    if name == "toggle_resolved":
        return "PATCH", one, {"resolved": True}
    if name == "delete":
        return "DELETE", one, None
    raise AssertionError(name)


async def _stored(db_session, comment_id) -> Comment | None:
    """直接從資料庫讀，並且強制重新載入。

    端點用的是 Core 的 UPDATE / DELETE，不會同步 session 裡已經載入的實例；
    不 populate_existing 的話拿到的是 fixture 建立時的舊值，「資料沒被改」的斷言
    就會永遠成立。
    """
    return await db_session.scalar(
        select(Comment).where(Comment.id == comment_id).execution_options(populate_existing=True)
    )


# ── 授權矩陣 ──────────────────────────────────────────────────────────────

# (名稱, 作者預期, 其他 member 預期, owner（非作者）預期)
ENDPOINTS = [
    ("list", 200, 200, 200),
    ("create", 201, 201, 201),
    ("edit_content", 200, 403, 403),
    ("toggle_resolved", 200, 200, 200),
    ("delete", 204, 403, 403),
]
IDS = [e[0] for e in ENDPOINTS]
PARAMS = "name,author_status,member_status,owner_status"


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_author_is_allowed(
    client, team, auth, name, author_status, member_status, owner_status
):
    method, url, body = _request(name, team)

    response = await client.request(method, url, json=body, headers=auth(team.author))

    assert response.status_code == author_status


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_other_member_can_do_everything_except_edit_and_delete(
    client, team, auth, name, author_status, member_status, owner_status
):
    method, url, body = _request(name, team)

    response = await client.request(method, url, json=body, headers=auth(team.other_member))

    assert response.status_code == member_status


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_project_owner_has_no_extra_rights_over_others_comments(
    client, team, auth, name, author_status, member_status, owner_status
):
    """owner 對別人的留言，權限與一般 member 完全相同。"""
    method, url, body = _request(name, team)

    response = await client.request(method, url, json=body, headers=auth(team.owner))

    assert response.status_code == owner_status


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_outsider_gets_404(
    client, team, auth, name, author_status, member_status, owner_status
):
    """非成員連「這個專案存在」都不該推得出來，所以是 404 不是 403。"""
    method, url, body = _request(name, team)

    response = await client.request(method, url, json=body, headers=auth(team.outsider))

    assert response.status_code == 404
    assert response.json()["detail"] == "找不到專案"


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_unauthenticated_gets_401(
    client, team, name, author_status, member_status, owner_status
):
    method, url, body = _request(name, team)

    response = await client.request(method, url, json=body)

    assert response.status_code == 401


@pytest.mark.parametrize(PARAMS, ENDPOINTS, ids=IDS)
async def test_nonexistent_project_gets_404(
    client, team, auth, name, author_status, member_status, owner_status
):
    method, url, body = _request(name, team)
    url = url.replace(str(team.project.id), str(uuid.uuid4()))

    response = await client.request(method, url, json=body, headers=auth(team.author))

    assert response.status_code == 404
    assert response.json()["detail"] == "找不到專案"


async def test_outsider_gets_404_even_with_an_invalid_body(client, team, auth):
    """授權優先於請求驗證：非成員不該從 422 的內容得知這支端點接受什麼。"""
    response = await client.post(
        _base(team.project.id), json={"content": ""}, headers=auth(team.outsider)
    )

    assert response.status_code == 404


async def test_removed_member_loses_access_to_their_own_comment(client, db_session, team, auth):
    """作者身分不是存取權。被移出專案之後，連自己的留言都碰不到。"""
    await db_session.execute(
        delete(ProjectMember).where(
            ProjectMember.project_id == team.project.id,
            ProjectMember.user_id == team.author.id,
        )
    )
    one = f"{_base(team.project.id)}/{team.comment.id}"

    for method, url, body in [
        ("GET", _base(team.project.id), None),
        ("PATCH", one, {"content": "我還想改"}),
        ("DELETE", one, None),
    ]:
        response = await client.request(method, url, json=body, headers=auth(team.author))
        assert response.status_code == 404, method

    stored = await _stored(db_session, team.comment.id)
    assert stored is not None
    assert stored.content == "原本的內容"


# ── 留言必須屬於網址上的專案 ──────────────────────────────────────────────


@pytest.mark.parametrize(
    ("method", "body"),
    [("PATCH", {"content": "跨專案修改"}), ("PATCH", {"resolved": True}), ("DELETE", None)],
    ids=["edit_content", "toggle_resolved", "delete"],
)
async def test_comment_of_another_project_gets_404_and_is_untouched(
    client, db_session, team, make_project, auth, method, body
):
    """作者自己，拿自己的留言 id 接在另一個他也有權限的專案底下。

    兩個專案他都進得去、留言也是他寫的，唯一不對的是「這則留言不在這個專案裡」。
    這是 project_id 條件單獨負責的情況：少了它，這個請求會成功。
    """
    elsewhere = await make_project(team.author, name="作者自己的另一個專案")

    response = await client.request(
        method,
        f"{_base(elsewhere.id)}/{team.comment.id}",
        json=body,
        headers=auth(team.author),
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "找不到留言"
    stored = await _stored(db_session, team.comment.id)
    assert stored is not None
    assert stored.content == "原本的內容"
    assert stored.resolved is False


@pytest.mark.parametrize(
    ("method", "body"),
    [("PATCH", {"resolved": True}), ("DELETE", None)],
    ids=["patch", "delete"],
)
async def test_nonexistent_comment_gets_404(client, team, auth, method, body):
    response = await client.request(
        method,
        f"{_base(team.project.id)}/{uuid.uuid4()}",
        json=body,
        headers=auth(team.author),
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "找不到留言"


async def test_malformed_comment_id_gets_422(client, team, auth):
    response = await client.delete(
        f"{_base(team.project.id)}/not-a-uuid", headers=auth(team.author)
    )

    assert response.status_code == 422


# ── 狀態碼相同不代表沒發生副作用 ──────────────────────────────────────────


@pytest.mark.parametrize("who", ["other_member", "owner"])
async def test_non_author_content_patch_does_not_change_the_row(
    client, db_session, team, auth, who
):
    response = await client.patch(
        f"{_base(team.project.id)}/{team.comment.id}",
        json={"content": "被別人改掉"},
        headers=auth(getattr(team, who)),
    )

    assert response.status_code == 403
    stored = await _stored(db_session, team.comment.id)
    assert stored.content == "原本的內容"
    assert stored.updated_at == T0


async def test_non_author_patch_with_both_fields_changes_nothing(client, db_session, team, auth):
    """resolved 他有權限、content 沒有。整個請求被拒，不是只套用有權限的那一半。"""
    response = await client.patch(
        f"{_base(team.project.id)}/{team.comment.id}",
        json={"content": "被別人改掉", "resolved": True},
        headers=auth(team.other_member),
    )

    assert response.status_code == 403
    stored = await _stored(db_session, team.comment.id)
    assert stored.content == "原本的內容"
    assert stored.resolved is False
    assert stored.updated_at == T0


@pytest.mark.parametrize("who", ["other_member", "owner"])
async def test_non_author_delete_does_not_remove_the_row(client, db_session, team, auth, who):
    response = await client.delete(
        f"{_base(team.project.id)}/{team.comment.id}", headers=auth(getattr(team, who))
    )

    assert response.status_code == 403
    assert await _stored(db_session, team.comment.id) is not None


async def test_outsider_requests_have_no_side_effects(client, db_session, team, auth):
    base = _base(team.project.id)
    one = f"{base}/{team.comment.id}"
    headers = auth(team.outsider)

    await client.post(base, json={"world_x": 0, "world_y": 0, "content": "闖入"}, headers=headers)
    await client.patch(one, json={"content": "闖入", "resolved": True}, headers=headers)
    await client.delete(one, headers=headers)

    rows = (
        await db_session.scalars(select(Comment).where(Comment.project_id == team.project.id))
    ).all()
    assert [c.id for c in rows] == [team.comment.id]
    stored = await _stored(db_session, team.comment.id)
    assert stored.content == "原本的內容"
    assert stored.resolved is False


# ── 新增 ──────────────────────────────────────────────────────────────────


async def test_create_returns_the_comment_with_its_author(client, db_session, team, auth):
    response = await client.post(
        _base(team.project.id),
        json={"world_x": 120.5, "world_y": -48.25, "content": "標題太小"},
        headers=auth(team.other_member),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["world_x"] == 120.5
    assert body["world_y"] == -48.25
    assert body["content"] == "標題太小"
    assert body["resolved"] is False
    assert body["created_at"] is not None
    assert body["updated_at"] is not None
    assert body["author"] == {
        "user_id": str(team.other_member.id),
        "display_name": team.other_member.display_name,
        "email": team.other_member.email,
    }
    assert body["can_edit"] is True
    assert body["can_delete"] is True

    stored = await _stored(db_session, uuid.UUID(body["id"]))
    assert stored.project_id == team.project.id
    assert stored.author_id == team.other_member.id


async def test_create_ignores_an_author_supplied_in_the_body(client, db_session, team, auth):
    """作者是發出請求的人。body 裡塞別人的 id 不能讓留言掛在別人名下。"""
    response = await client.post(
        _base(team.project.id),
        json={
            "world_x": 0,
            "world_y": 0,
            "content": "冒名",
            "author_id": str(team.owner.id),
            "author": {"user_id": str(team.owner.id)},
            "resolved": True,
        },
        headers=auth(team.other_member),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["author"]["user_id"] == str(team.other_member.id)
    # resolved 也不是建立時可以指定的欄位
    assert body["resolved"] is False


async def test_create_accepts_integer_coordinates(client, team, auth):
    """畫布原點附近的座標常常是整數，JSON 裡不會有小數點。"""
    response = await client.post(
        _base(team.project.id),
        json={"world_x": 0, "world_y": -300, "content": "整數座標"},
        headers=auth(team.author),
    )

    assert response.status_code == 201
    assert (response.json()["world_x"], response.json()["world_y"]) == (0.0, -300.0)


@pytest.mark.parametrize(
    ("sent", "stored"),
    [
        (" hello ", "hello"),
        ("\n測試\t", "測試"),
        ("　全形空白包住　", "全形空白包住"),
        ("第一行\n\n  第二行", "第一行\n\n  第二行"),
    ],
    ids=["spaces", "newline-and-tab", "ideographic-space", "inner-whitespace-kept"],
)
async def test_create_trims_surrounding_whitespace_only(
    client, db_session, team, auth, sent, stored
):
    response = await client.post(
        _base(team.project.id),
        json={"world_x": 0, "world_y": 0, "content": sent},
        headers=auth(team.author),
    )

    assert response.status_code == 201
    assert response.json()["content"] == stored
    row = await _stored(db_session, uuid.UUID(response.json()["id"]))
    assert row.content == stored


# 只由空白組成。後四個是資料庫的 CHECK 擋不住的 Unicode 空白——這一層是它們唯一的防線。
BLANK_CONTENTS = [
    pytest.param("", id="empty"),
    pytest.param("    ", id="spaces"),
    pytest.param("\t", id="tab"),
    pytest.param("\n", id="newline"),
    pytest.param("\r\n", id="crlf"),
    pytest.param(" \t\n\r ", id="mixed"),
    pytest.param("　", id="ideographic-space"),
    pytest.param(" ", id="no-break-space"),
    pytest.param("  ", id="em-and-thin-space"),
    pytest.param(" 　\n  ", id="mixed-unicode"),
]


@pytest.mark.parametrize("content", BLANK_CONTENTS)
async def test_create_rejects_blank_content(client, db_session, team, auth, content):
    response = await client.post(
        _base(team.project.id),
        json={"world_x": 0, "world_y": 0, "content": content},
        headers=auth(team.author),
    )

    assert response.status_code == 422
    count = await db_session.scalar(
        select(func.count()).select_from(Comment).where(Comment.project_id == team.project.id)
    )
    assert count == 1  # 只有 fixture 的那一則


async def test_create_accepts_content_at_the_length_limit(client, team, auth):
    response = await client.post(
        _base(team.project.id),
        json={"world_x": 0, "world_y": 0, "content": "字" * COMMENT_CONTENT_MAX_LENGTH},
        headers=auth(team.author),
    )

    assert response.status_code == 201


async def test_create_measures_length_after_trimming(client, team, auth):
    """上限量的是存進去的內容。前後的空白會被去掉，不該算進長度。"""
    response = await client.post(
        _base(team.project.id),
        json={
            "world_x": 0,
            "world_y": 0,
            "content": "  " + "字" * COMMENT_CONTENT_MAX_LENGTH + "\n\n",
        },
        headers=auth(team.author),
    )

    assert response.status_code == 201
    assert len(response.json()["content"]) == COMMENT_CONTENT_MAX_LENGTH


async def test_create_rejects_content_over_the_length_limit(client, team, auth):
    """必須是 422。漏掉這層檢查的話，資料庫的 VARCHAR(2000) 會把它變成 500。"""
    response = await client.post(
        _base(team.project.id),
        json={"world_x": 0, "world_y": 0, "content": "字" * (COMMENT_CONTENT_MAX_LENGTH + 1)},
        headers=auth(team.author),
    )

    assert response.status_code == 422


async def test_create_rejects_content_with_a_nul_character(client, db_session, team, auth):
    """PostgreSQL 的文字欄位存不了 U+0000。

    這是合法的 JSON 字串、也過得了「trim 後不為空」，不在驗證擋下來的話，要到寫入
    資料庫才會失敗，變成 500。
    """
    response = await client.post(
        _base(team.project.id),
        json={"world_x": 0, "world_y": 0, "content": "前半\u0000後半"},
        headers=auth(team.author),
    )

    assert response.status_code == 422
    count = await db_session.scalar(
        select(func.count()).select_from(Comment).where(Comment.project_id == team.project.id)
    )
    assert count == 1


@pytest.mark.parametrize(
    "body",
    [
        {"world_y": 0, "content": "a"},
        {"world_x": 0, "content": "a"},
        {"world_x": 0, "world_y": 0},
        {"world_x": None, "world_y": 0, "content": "a"},
        {"world_x": "12", "world_y": 0, "content": "a"},
        {"world_x": True, "world_y": 0, "content": "a"},
        {"world_x": 0, "world_y": 0, "content": 123},
        {"world_x": 0, "world_y": 0, "content": None},
    ],
    ids=[
        "missing-x",
        "missing-y",
        "missing-content",
        "null-x",
        "string-x",
        "bool-x",
        "numeric-content",
        "null-content",
    ],
)
async def test_create_rejects_malformed_bodies(client, team, auth, body):
    response = await client.post(_base(team.project.id), json=body, headers=auth(team.author))

    assert response.status_code == 422


@pytest.mark.parametrize("field", ["world_x", "world_y"])
@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity", "1e400"])
async def test_create_rejects_non_finite_coordinates(
    client, db_session, team, auth, field, literal
):
    """NaN / Infinity 不是合法的 JSON，但 Python 的 json 模組收得下來。

    用原始字串送出而不是 json=：httpx 會先在客戶端序列化，測不到伺服器實際收到
    這些 token 時的行為。1e400 是合法的 JSON 數字，但超出 double 的範圍，解析後就是
    Infinity。
    """
    other = "world_y" if field == "world_x" else "world_x"
    raw = f'{{"{field}": {literal}, "{other}": 0, "content": "座標壞掉"}}'

    response = await client.post(
        _base(team.project.id),
        content=raw,
        headers={**auth(team.author), "Content-Type": "application/json"},
    )

    assert response.status_code == 422
    # 422 的格式與其他驗證錯誤相同，而且指得出是哪個欄位
    assert [error["loc"] for error in response.json()["detail"]] == [["body", field]]
    count = await db_session.scalar(
        select(func.count()).select_from(Comment).where(Comment.project_id == team.project.id)
    )
    assert count == 1


async def test_patch_with_a_non_finite_coordinate_gets_422(client, db_session, team, auth):
    """座標在 PATCH 是不允許的欄位，值又是 NaN：兩個理由都該是 422，不能是 500。"""
    response = await client.patch(
        f"{_base(team.project.id)}/{team.comment.id}",
        content='{"world_x": NaN, "resolved": true}',
        headers={**auth(team.author), "Content-Type": "application/json"},
    )

    assert response.status_code == 422
    assert (await _stored(db_session, team.comment.id)).resolved is False


async def test_validation_errors_keep_the_rejected_input_when_it_is_serializable(
    client, team, auth
):
    """只有無法序列化的 input 會被拿掉，一般的驗證錯誤維持 FastAPI 預設的內容。"""
    response = await client.post(
        _base(team.project.id),
        json={"world_x": "12", "world_y": 0, "content": "a"},
        headers=auth(team.author),
    )

    assert response.status_code == 422
    (error,) = response.json()["detail"]
    assert error["loc"] == ["body", "world_x"]
    assert error["input"] == "12"


# ── 列表 ──────────────────────────────────────────────────────────────────


async def test_list_is_empty_for_a_project_without_comments(client, make_user, make_project, auth):
    owner = await make_user()
    project = await make_project(owner)

    response = await client.get(_base(project.id), headers=auth(owner))

    assert response.status_code == 200
    assert response.json() == []


async def test_list_is_ordered_oldest_first(client, team, make_comment, auth):
    # 刻意不照時間順序建立：寫入順序與時間順序相同的話，沒有 ORDER BY 也可能剛好通過。
    newest = await make_comment(
        team.project, team.owner, "最新", created_at=T0 + timedelta(hours=2)
    )
    oldest = await make_comment(
        team.project, team.owner, "最舊", created_at=T0 - timedelta(hours=1)
    )
    middle = await make_comment(
        team.project, team.owner, "中間", created_at=T0 + timedelta(hours=1)
    )

    response = await client.get(_base(team.project.id), headers=auth(team.owner))

    assert [c["id"] for c in response.json()] == [
        str(oldest.id),
        str(team.comment.id),
        str(middle.id),
        str(newest.id),
    ]


async def test_list_breaks_created_at_ties_by_id(client, team, make_comment, auth):
    """同一瞬間建立的留言要有固定順序，否則每次重新整理 pin 的堆疊都可能不同。"""
    same_time = [
        await make_comment(team.project, team.owner, f"同時 {i}", created_at=T0) for i in range(6)
    ]
    expected = sorted([team.comment.id, *(c.id for c in same_time)])

    response = await client.get(_base(team.project.id), headers=auth(team.owner))

    assert [c["id"] for c in response.json()] == [str(i) for i in expected]


async def test_list_only_returns_comments_of_this_project(
    client, team, make_project, make_comment, auth
):
    elsewhere = await make_project(team.owner, name="另一個專案")
    await make_comment(elsewhere, team.owner, "別的專案的留言")

    response = await client.get(_base(team.project.id), headers=auth(team.owner))

    assert [c["id"] for c in response.json()] == [str(team.comment.id)]


async def test_list_carries_each_comments_own_author(client, team, make_comment, auth):
    await make_comment(team.project, team.owner, "owner 寫的", created_at=T0 + timedelta(hours=1))

    response = await client.get(_base(team.project.id), headers=auth(team.other_member))

    assert [c["author"] for c in response.json()] == [
        {
            "user_id": str(team.author.id),
            "display_name": team.author.display_name,
            "email": team.author.email,
        },
        {
            "user_id": str(team.owner.id),
            "display_name": team.owner.display_name,
            "email": team.owner.email,
        },
    ]


async def test_list_returns_display_name_when_the_author_has_one(client, db_session, team, auth):
    team.author.display_name = "小明"
    await db_session.flush()

    response = await client.get(_base(team.project.id), headers=auth(team.owner))

    assert response.json()[0]["author"]["display_name"] == "小明"


async def test_list_keeps_comments_of_a_removed_member(client, db_session, team, auth):
    """留言屬於專案。作者被移出之後，留言與作者資訊都還在。"""
    await db_session.execute(
        delete(ProjectMember).where(
            ProjectMember.project_id == team.project.id,
            ProjectMember.user_id == team.author.id,
        )
    )

    response = await client.get(_base(team.project.id), headers=auth(team.owner))

    assert response.status_code == 200
    assert [c["id"] for c in response.json()] == [str(team.comment.id)]
    assert response.json()[0]["author"]["user_id"] == str(team.author.id)


async def test_list_does_not_run_a_query_per_comment(client, engine, team, make_comment, auth):
    """作者資料必須跟著列表的那一次查詢回來。

    數的是整個請求送出的 SELECT：身分驗證一次、專案授權一次、列表一次。留言再多
    也是這三次——多出來的每一次都是 N+1。
    """
    for i in range(10):
        author = team.owner if i % 2 else team.other_member
        await make_comment(team.project, author, f"第 {i} 則")

    statements: list[str] = []

    def _record(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", _record)
    try:
        response = await client.get(_base(team.project.id), headers=auth(team.owner))
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", _record)

    assert response.status_code == 200
    assert len(response.json()) == 11
    assert len(statements) == 3, statements


# ── can_edit / can_delete ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("who", "expected"),
    [("author", True), ("other_member", False), ("owner", False)],
)
async def test_permission_flags_depend_on_the_viewer(client, team, auth, who, expected):
    """同一則留言，不同的人看到不同的值。它們必須與端點實際的授權一致。"""
    response = await client.get(_base(team.project.id), headers=auth(getattr(team, who)))

    comment = response.json()[0]
    assert comment["can_edit"] is expected
    assert comment["can_delete"] is expected


async def test_permission_flags_in_a_patch_response_are_the_callers(client, team, auth):
    """非作者切換 resolved 成功，回應裡的旗標仍然是「他不能改內容、不能刪」。"""
    response = await client.patch(
        f"{_base(team.project.id)}/{team.comment.id}",
        json={"resolved": True},
        headers=auth(team.other_member),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["can_edit"] is False
    assert body["can_delete"] is False
    # 作者仍然是原作者，不是送出這次請求的人
    assert body["author"]["user_id"] == str(team.author.id)


# ── 修改 ──────────────────────────────────────────────────────────────────


async def test_author_can_edit_content(client, db_session, team, auth):
    response = await client.patch(
        f"{_base(team.project.id)}/{team.comment.id}",
        json={"content": "  改過的內容\n"},
        headers=auth(team.author),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["content"] == "改過的內容"
    assert body["resolved"] is False
    assert body["id"] == str(team.comment.id)

    stored = await _stored(db_session, team.comment.id)
    assert stored.content == "改過的內容"
    # 沒帶的欄位不動
    assert stored.resolved is False
    assert (stored.world_x, stored.world_y) == (10.0, 20.0)
    assert stored.author_id == team.author.id


@pytest.mark.parametrize("who", ["author", "other_member", "owner"])
async def test_any_member_can_toggle_resolved(client, db_session, team, auth, who):
    url = f"{_base(team.project.id)}/{team.comment.id}"
    headers = auth(getattr(team, who))

    resolved = await client.patch(url, json={"resolved": True}, headers=headers)
    assert resolved.status_code == 200
    assert resolved.json()["resolved"] is True
    assert (await _stored(db_session, team.comment.id)).resolved is True

    reopened = await client.patch(url, json={"resolved": False}, headers=headers)
    assert reopened.status_code == 200
    assert reopened.json()["resolved"] is False

    stored = await _stored(db_session, team.comment.id)
    assert stored.resolved is False
    # 切換 resolved 不動內容
    assert stored.content == "原本的內容"


async def test_author_can_change_both_fields_at_once(client, db_session, team, auth):
    response = await client.patch(
        f"{_base(team.project.id)}/{team.comment.id}",
        json={"content": "改好了", "resolved": True},
        headers=auth(team.author),
    )

    assert response.status_code == 200
    stored = await _stored(db_session, team.comment.id)
    assert stored.content == "改好了"
    assert stored.resolved is True


@pytest.mark.parametrize(
    "body", [{"content": "改過的內容"}, {"resolved": True}], ids=["content", "resolved"]
)
async def test_patch_touches_updated_at_but_not_created_at(client, db_session, team, auth, body):
    """updated_at 是端點明確寫入的，不是 ORM 的 onupdate。漏掉就會停在建立時間。"""
    response = await client.patch(
        f"{_base(team.project.id)}/{team.comment.id}", json=body, headers=auth(team.author)
    )

    assert response.status_code == 200
    stored = await _stored(db_session, team.comment.id)
    assert stored.created_at == T0
    assert stored.updated_at > T0
    assert datetime.fromisoformat(response.json()["updated_at"]) == stored.updated_at


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"content": None},
        {"resolved": None},
        {"content": None, "resolved": True},
        {"resolved": "yes"},
        {"resolved": 1},
        {"content": 123},
        {"world_x": 99},
        {"world_y": 99, "resolved": True},
        {"author_id": str(uuid.uuid4()), "resolved": True},
    ],
    ids=[
        "empty",
        "null-content",
        "null-resolved",
        "null-content-with-resolved",
        "string-resolved",
        "int-resolved",
        "numeric-content",
        "coordinate-only",
        "coordinate-with-resolved",
        "author-with-resolved",
    ],
)
async def test_patch_rejects_malformed_bodies_without_changing_anything(
    client, db_session, team, auth, body
):
    """座標與作者不可修改：帶了就整個請求拒絕，不是忽略那個欄位後照樣套用其餘的。"""
    response = await client.patch(
        f"{_base(team.project.id)}/{team.comment.id}", json=body, headers=auth(team.author)
    )

    assert response.status_code == 422
    stored = await _stored(db_session, team.comment.id)
    assert stored.content == "原本的內容"
    assert stored.resolved is False
    assert (stored.world_x, stored.world_y) == (10.0, 20.0)
    assert stored.updated_at == T0


@pytest.mark.parametrize("content", BLANK_CONTENTS)
async def test_patch_rejects_blank_content(client, db_session, team, auth, content):
    response = await client.patch(
        f"{_base(team.project.id)}/{team.comment.id}",
        json={"content": content},
        headers=auth(team.author),
    )

    assert response.status_code == 422
    assert (await _stored(db_session, team.comment.id)).content == "原本的內容"


async def test_patch_rejects_content_with_a_nul_character(client, db_session, team, auth):
    response = await client.patch(
        f"{_base(team.project.id)}/{team.comment.id}",
        json={"content": "前半\u0000後半"},
        headers=auth(team.author),
    )

    assert response.status_code == 422
    assert (await _stored(db_session, team.comment.id)).content == "原本的內容"


async def test_patch_rejects_content_over_the_length_limit(client, db_session, team, auth):
    response = await client.patch(
        f"{_base(team.project.id)}/{team.comment.id}",
        json={"content": "字" * (COMMENT_CONTENT_MAX_LENGTH + 1)},
        headers=auth(team.author),
    )

    assert response.status_code == 422
    assert (await _stored(db_session, team.comment.id)).content == "原本的內容"


# ── 刪除 ──────────────────────────────────────────────────────────────────


async def test_author_can_delete_their_comment(client, db_session, team, make_comment, auth):
    bystander = await make_comment(team.project, team.author, "同一個作者的另一則")

    response = await client.delete(
        f"{_base(team.project.id)}/{team.comment.id}", headers=auth(team.author)
    )

    assert response.status_code == 204
    assert response.content == b""
    assert await _stored(db_session, team.comment.id) is None
    # 只刪掉指定的那一則
    assert await _stored(db_session, bystander.id) is not None


async def test_deleting_twice_gets_404_the_second_time(client, team, auth):
    url = f"{_base(team.project.id)}/{team.comment.id}"

    first = await client.delete(url, headers=auth(team.author))
    second = await client.delete(url, headers=auth(team.author))

    assert first.status_code == 204
    assert second.status_code == 404


async def test_owner_can_delete_their_own_comment(client, db_session, team, make_comment, auth):
    """owner 沒有額外權限，但也沒有比較少：自己寫的照樣能刪。"""
    mine = await make_comment(team.project, team.owner, "owner 自己的留言")

    response = await client.delete(f"{_base(team.project.id)}/{mine.id}", headers=auth(team.owner))

    assert response.status_code == 204
    assert await _stored(db_session, mine.id) is None


# ── 留言與畫布存檔互不影響 ────────────────────────────────────────────────


async def test_comment_mutations_do_not_bump_document_version(client, db_session, team, auth):
    """Comment V2 的第一個成功條件：留言不再競爭 document 的樂觀鎖。

    建立、修改、切換、刪除留言之後，拿著原本的 document_version 存檔必須成功。
    """
    base = _base(team.project.id)
    version_before = team.project.document_version

    created = await client.post(
        base, json={"world_x": 0, "world_y": 0, "content": "新留言"}, headers=auth(team.owner)
    )
    one = f"{base}/{created.json()['id']}"
    await client.patch(one, json={"content": "改過"}, headers=auth(team.owner))
    await client.patch(one, json={"resolved": True}, headers=auth(team.other_member))
    await client.delete(one, headers=auth(team.owner))

    detail = await client.get(f"/api/projects/{team.project.id}", headers=auth(team.owner))
    assert detail.json()["document_version"] == version_before

    saved = await client.put(
        f"/api/projects/{team.project.id}/document",
        json={"document_version": version_before, "document": detail.json()["document"]},
        headers=auth(team.other_member),
    )
    assert saved.status_code == 200


async def test_deleting_the_project_removes_its_comments(client, db_session, team, auth):
    response = await client.delete(f"/api/projects/{team.project.id}", headers=auth(team.owner))

    assert response.status_code == 204
    assert await _stored(db_session, team.comment.id) is None
