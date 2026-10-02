"""comments 表的資料庫層保證。

這裡只測「資料庫自己擋得住什麼」：CHECK、預設值、CASCADE。這些是 API 驗證之外的
第二道，就算某個端點漏了檢查也必須成立，所以不透過 HTTP、直接對 session 操作。
授權與請求驗證屬於端點，在 test_comments.py。
"""

import pytest
from sqlalchemy import delete, func, select, update
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


# 只由空白組成的內容。CHECK 列舉的是 ASCII 的六個空白字元，這裡每一個都要單獨
# 出現過一次——少列一個，對應的那筆就會寫得進去。
BLANK_CONTENTS = [
    pytest.param("", id="empty"),
    pytest.param(" ", id="one-space"),
    pytest.param("    ", id="spaces"),
    pytest.param("\t", id="tab"),
    pytest.param("\n", id="newline"),
    pytest.param("\r", id="carriage-return"),
    pytest.param("\r\n", id="crlf"),
    pytest.param("\f", id="form-feed"),
    pytest.param("\v", id="vertical-tab"),
    pytest.param(" \t\n\r ", id="mixed"),
]

# 有內容，只是前後（或中間）帶著空白。CHECK 不能因為看到空白就整筆拒絕，
# 也不負責 trim——存進去的必須是原樣。
NON_BLANK_CONTENTS = [
    pytest.param("a", id="single-char"),
    pytest.param("hello", id="ascii"),
    pytest.param(" hello ", id="ascii-padded-with-spaces"),
    pytest.param("\nhello\t", id="ascii-padded-with-newline-and-tab"),
    pytest.param("測試", id="unicode"),
    pytest.param(" 測試\n", id="unicode-padded"),
    pytest.param("第一行\n\n第二行", id="multiline"),
]


@pytest.mark.parametrize("content", BLANK_CONTENTS)
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


@pytest.mark.parametrize("content", NON_BLANK_CONTENTS)
async def test_content_with_surrounding_whitespace_is_accepted_as_is(
    db_session, make_user, make_project, content
):
    owner = await make_user()
    project = await make_project(owner)

    db_session.add(_comment(project, owner, content))
    await db_session.flush()

    stored = await db_session.scalar(
        select(Comment.content).where(Comment.project_id == project.id)
    )
    assert stored == content


@pytest.mark.parametrize("content", BLANK_CONTENTS)
async def test_existing_comment_cannot_be_updated_to_blank(
    db_session, make_user, make_project, content
):
    """CHECK 對 UPDATE 同樣成立：留言不能先合法建立、再被改成空白。"""
    owner = await make_user()
    project = await make_project(owner)
    comment = _comment(project, owner, "原本的內容")
    db_session.add(comment)
    await db_session.flush()

    with pytest.raises(IntegrityError) as excinfo:
        async with db_session.begin_nested():
            await db_session.execute(
                update(Comment).where(Comment.id == comment.id).values(content=content)
            )

    assert "ck_comments_content_not_blank" in str(excinfo.value)
    stored = await db_session.scalar(select(Comment.content).where(Comment.id == comment.id))
    assert stored == "原本的內容"


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
