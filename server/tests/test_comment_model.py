"""comments 表的資料庫層保證。

這裡只測「資料庫自己擋得住什麼」：CHECK、預設值、CASCADE。這些是 API 驗證之外的
第二道，就算某個端點漏了檢查也必須成立，所以不透過 HTTP、直接對 session 操作。
授權與請求驗證屬於端點，在 test_comments.py。
"""

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.models import Comment, Project, User
from app.models.comment import COMMENT_CONTENT_MAX_LENGTH


def _comment(project: Project, author: User, content: str = "這裡的間距不對") -> Comment:
    return Comment(
        project_id=project.id,
        author_id=author.id,
        world_x=120.5,
        world_y=-48.25,
        content=content,
    )


async def _count(db_session, project: Project) -> int:
    return await db_session.scalar(
        select(func.count()).select_from(Comment).where(Comment.project_id == project.id)
    )


async def test_server_defaults_are_filled_in(db_session, make_user, make_project):
    owner = await make_user()
    project = await make_project(owner)

    comment = _comment(project, owner)
    db_session.add(comment)
    await db_session.flush()
    await db_session.refresh(comment)

    assert comment.id is not None
    assert comment.resolved is False
    assert comment.created_at is not None
    assert comment.updated_at is not None
    # 座標是 double precision：負數與小數都要原樣回來
    assert (comment.world_x, comment.world_y) == (120.5, -48.25)


@pytest.mark.parametrize("content", ["", " ", "     "], ids=repr)
async def test_blank_content_is_rejected_by_the_database(
    db_session, make_user, make_project, content
):
    owner = await make_user()
    project = await make_project(owner)

    # begin_nested：違反約束會讓所在的交易失效。包一層 savepoint，失敗只回滾這一層，
    # 外層（db_session fixture 的交易）還能繼續查詢。
    with pytest.raises(IntegrityError) as excinfo:
        async with db_session.begin_nested():
            db_session.add(_comment(project, owner, content))
            await db_session.flush()

    # 確認擋下來的是這條 CHECK，不是別的約束剛好也失敗
    assert "ck_comments_content_not_blank" in str(excinfo.value)
    assert await _count(db_session, project) == 0


@pytest.mark.parametrize("content", ["\n", "\t", " \n\t "], ids=repr)
async def test_check_does_not_cover_non_space_whitespace(
    db_session, make_user, make_project, content
):
    """記錄 CHECK 的實際範圍，不是期望的行為。

    PostgreSQL 的 btrim(text) 只去掉空白字元（U+0020），換行與 tab 不算。所以只含
    換行或 tab 的內容過得了這條 CHECK——「trim 之後不可為空」的完整語意由 API 層
    負責（Python 的 str.strip 會去掉所有空白字元）。

    這條測試存在的目的是讓這個落差被看見：哪天把 CHECK 加強了，它會失敗，
    提醒把這裡一起改掉，而不是讓人以為資料庫一直都擋得住。
    """
    owner = await make_user()
    project = await make_project(owner)

    db_session.add(_comment(project, owner, content))
    await db_session.flush()

    assert await _count(db_session, project) == 1


async def test_content_at_the_length_limit_is_accepted(db_session, make_user, make_project):
    owner = await make_user()
    project = await make_project(owner)

    db_session.add(_comment(project, owner, "字" * COMMENT_CONTENT_MAX_LENGTH))
    await db_session.flush()

    assert await _count(db_session, project) == 1


async def test_content_over_the_length_limit_is_rejected(db_session, make_user, make_project):
    owner = await make_user()
    project = await make_project(owner)

    # 超長是 DataError（string data right truncation），不是 IntegrityError
    with pytest.raises(DBAPIError):
        async with db_session.begin_nested():
            db_session.add(_comment(project, owner, "字" * (COMMENT_CONTENT_MAX_LENGTH + 1)))
            await db_session.flush()

    assert await _count(db_session, project) == 0


async def test_comment_requires_an_existing_project(db_session, make_user, make_project):
    owner = await make_user()
    project = await make_project(owner)
    comment = _comment(project, owner)
    comment.project_id = owner.id  # 一個存在的 UUID，但不是專案

    with pytest.raises(IntegrityError) as excinfo:
        async with db_session.begin_nested():
            db_session.add(comment)
            await db_session.flush()

    assert "fk_comments_project_id_projects" in str(excinfo.value)


async def test_deleting_a_project_removes_its_comments_only(db_session, make_user, make_project):
    owner = await make_user()
    author = await make_user()
    doomed = await make_project(owner, name="要刪的")
    kept = await make_project(owner, name="留著的")

    db_session.add_all(
        [
            _comment(doomed, owner, "一"),
            _comment(doomed, author, "二"),
            _comment(kept, author, "三"),
        ]
    )
    await db_session.flush()

    # 用 Core 的 DELETE，與 delete_project 端點相同：CASCADE 是資料庫做的，
    # 不是 ORM 逐筆刪——這張表沒有 relationship()，ORM 也無從得知要刪什麼。
    await db_session.execute(delete(Project).where(Project.id == doomed.id))

    assert await _count(db_session, doomed) == 0
    assert await _count(db_session, kept) == 1


async def test_deleting_an_author_removes_their_comments_only(db_session, make_user, make_project):
    owner = await make_user()
    leaving = await make_user()
    project = await make_project(owner)

    db_session.add_all(
        [_comment(project, owner, "owner 的"), _comment(project, leaving, "離開的人的")]
    )
    await db_session.flush()

    await db_session.execute(delete(User).where(User.id == leaving.id))

    remaining = (
        await db_session.scalars(select(Comment.content).where(Comment.project_id == project.id))
    ).all()
    assert remaining == ["owner 的"]
