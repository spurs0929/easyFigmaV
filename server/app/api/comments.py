import json
import uuid
from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from sqlalchemy import delete, func, select, update

from app.api.deps import AccessibleProject, CurrentUser, DbSession
from app.models import Comment, User
from app.schemas.comment import CommentAuthor, CommentCreate, CommentOut, CommentUpdate


def _without_unserializable_input(error: dict[str, Any]) -> dict[str, Any]:
    """驗證錯誤裡的 input 若無法序列化成 JSON，就把它拿掉。"""
    try:
        json.dumps(error.get("input"), allow_nan=False)
    except (TypeError, ValueError):
        return {key: value for key, value in error.items() if key != "input"}
    return error


class _NonFiniteSafeRoute(APIRoute):
    """讓「座標是 NaN / Infinity」得到 422，而不是 500。

    Pydantic 確實會拒絕這些值，問題出在回報的那一步：FastAPI 預設的 422 會把被拒絕
    的輸入原樣放進 detail[].input，而 JSONResponse 以 allow_nan=False 序列化——
    NaN 進不了 JSON，於是「驗證失敗」在產生回應時又丟了一次例外，變成 500。

    這裡只處理那個 input：其餘欄位（type / loc / msg）原樣交回預設的 handler，
    422 的格式與其他端點完全相同。

    刻意只掛在這個 router 上而不是註冊全域的 exception handler：全域 handler 會
    改變所有端點的錯誤路徑，那不是這張 task 該決定的事。
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def safe_handler(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError as exc:
                raise RequestValidationError(
                    [_without_unserializable_input(error) for error in exc.errors()],
                    body=exc.body,
                ) from exc

        return safe_handler


router = APIRouter(
    prefix="/projects/{project_id}/comments",
    tags=["Comments"],
    route_class=_NonFiniteSafeRoute,
)

# 授權分兩層，刻意分開：
#
#   專案層：每一支端點都掛 AccessibleProject。非成員、專案不存在都在那裡拿到 404，
#           走得到 handler 的人一定看得到這個專案的所有留言。
#   留言層：改 content、刪除只有作者可以；改 resolved 任何成員都可以。
#
# 因此留言層的拒絕回 403 而不是 404：對方本來就 GET 得到這則留言，403 沒有洩漏任何
# 他還不知道的事。理由同 require_project_owner。

# 回應需要的留言欄位。UPDATE ... RETURNING 與 SELECT 共用同一份，組裝點才只有一個。
_COMMENT_COLUMNS = (
    Comment.id,
    Comment.author_id,
    Comment.world_x,
    Comment.world_y,
    Comment.content,
    Comment.resolved,
    Comment.created_at,
    Comment.updated_at,
)


def _is_author(author_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    """「這個人是不是作者」只寫在這裡。

    端點的授權判斷與回應上的 can_edit / can_delete 都呼叫它。兩邊各寫一次的話，
    哪天規則改了只改到一邊，就會出現「按鈕有顯示、按下去卻是 403」。
    """
    return author_id == user_id


def _out(comment: Any, author: Any, viewer_id: uuid.UUID) -> CommentOut:
    """把一列留言加上作者資料組成回應。

    comment 可以是 _COMMENT_COLUMNS 查出來的 Row，也可以是 Comment 實例；author 可以
    是 Row 也可以是 User——兩者的欄位存取方式相同，所以四支端點走同一個組裝點。

    viewer_id 是發出請求的人，不是作者：can_edit / can_delete 是相對於他推導的。
    """
    mine = _is_author(comment.author_id, viewer_id)
    return CommentOut(
        id=comment.id,
        world_x=comment.world_x,
        world_y=comment.world_y,
        content=comment.content,
        resolved=comment.resolved,
        created_at=comment.created_at,
        updated_at=comment.updated_at,
        author=CommentAuthor(
            user_id=comment.author_id,
            display_name=author.display_name,
            email=author.email,
        ),
        can_edit=mine,
        can_delete=mine,
    )


def _comment_not_found() -> HTTPException:
    """每次建立新的實例，理由同 project_not_found()。"""
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="找不到留言")


async def _load_author(db: DbSession, project_id: uuid.UUID, comment_id: uuid.UUID) -> Any:
    """取得留言的作者資料，留言不在這個專案裡就是 404。

    ⚠️ 條件必須同時有 comment_id 與 project_id。只用 comment_id 的話，A 專案的成員
    把 B 專案的留言 id 接在 A 的網址後面，就能操作一則他根本看不到的留言——
    AccessibleProject 驗的是網址上的專案，不是這則留言所屬的專案。

    「不存在」與「屬於別的專案」回同一個 404，不讓人用來探測留言 id。
    """
    row = (
        await db.execute(
            select(Comment.author_id, User.email, User.display_name)
            .join(User, User.id == Comment.author_id)
            .where(Comment.id == comment_id, Comment.project_id == project_id)
        )
    ).one_or_none()
    if row is None:
        raise _comment_not_found()
    return row


@router.get("", response_model=list[CommentOut])
async def list_comments(
    project: AccessibleProject, user: CurrentUser, db: DbSession
) -> list[CommentOut]:
    """這個專案的所有留言，由舊到新。

    一次全部回傳，不分頁：留言是畫布上的 pin，開啟專案時就要全部畫出來，分頁只會讓
    前端多一層「還有幾頁沒載」的同步問題。

    作者資料用一次 JOIN 取得，不是每則留言各查一次。用 INNER JOIN：author_id 是
    NOT NULL 外鍵，不會有找不到作者的留言。

    作者已經不是成員也照樣列出——留言屬於專案，不隨成員資格消失。

    排序加上 id：同一個交易內建立的留言 created_at 完全相同，沒有 tie-breaker 的話
    順序由資料庫決定，每次重新整理 pin 的堆疊順序都可能不一樣。
    """
    rows = await db.execute(
        select(*_COMMENT_COLUMNS, User.email, User.display_name)
        .join(User, User.id == Comment.author_id)
        .where(Comment.project_id == project.id)
        .order_by(Comment.created_at, Comment.id)
    )
    # 同一個 Row 同時帶著留言欄位與作者欄位，所以兩個參數傳的是同一個物件。
    return [_out(row, row, user.id) for row in rows]


@router.post("", response_model=CommentOut, status_code=status.HTTP_201_CREATED)
async def create_comment(
    payload: CommentCreate, project: AccessibleProject, user: CurrentUser, db: DbSession
) -> CommentOut:
    """新增留言。owner 與 member 都可以。

    作者一律是發出請求的人，不從 body 讀——body 裡沒有 author 欄位可以讓人冒名。
    作者資料因此不必再查一次，就是 user。
    """
    comment = Comment(
        project_id=project.id,
        author_id=user.id,
        world_x=payload.world_x,
        world_y=payload.world_y,
        content=payload.content,
    )
    db.add(comment)
    await db.commit()
    # id / resolved / created_at / updated_at 都是 server default，要讀回來。
    await db.refresh(comment)
    return _out(comment, user, user.id)


@router.patch("/{comment_id}", response_model=CommentOut)
async def update_comment(
    comment_id: uuid.UUID,
    payload: CommentUpdate,
    project: AccessibleProject,
    user: CurrentUser,
    db: DbSession,
) -> CommentOut:
    """修改內容或切換已解決狀態。

    兩個欄位的授權不同：
      content  → 只有作者
      resolved → 任何成員。它是協作狀態，只有作者能改的話，其他人無法處理別人的留言。

    同時帶兩個欄位而請求者不是作者時，整個請求 403、什麼都不改。只套用他有權限的
    那一半會讓回應是 200，但 content 沒變，呼叫端無從得知。

    授權看的是「這次請求帶了哪些欄位」（model_fields_set），所以判斷在 UPDATE 之前。
    """
    author = await _load_author(db, project.id, comment_id)

    changes = payload.model_dump(exclude_unset=True)
    if "content" in changes and not _is_author(author.author_id, user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="只有留言的作者能修改內容"
        )

    row = (
        await db.execute(
            update(Comment)
            # 再帶一次 project_id：授權已經完成，這不是授權點，而是讓這條 UPDATE
            # 單獨拿出來看也不可能動到別的專案的留言。
            .where(Comment.id == comment_id, Comment.project_id == project.id)
            # updated_at 必須明確帶上：server_default 只作用於 INSERT。
            .values(**changes, updated_at=func.now())
            .returning(*_COMMENT_COLUMNS)
            .execution_options(synchronize_session=False)
        )
    ).one_or_none()
    if row is None:
        # 上面查到之後、UPDATE 之前，留言被作者刪掉了。
        raise _comment_not_found()

    await db.commit()
    return _out(row, author, user.id)


@router.delete("/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(
    comment_id: uuid.UUID, project: AccessibleProject, user: CurrentUser, db: DbSession
) -> None:
    """刪除留言。只有作者可以。

    專案 owner 沒有額外的刪除權限：v1 沒有 moderation，加了就是替 RBAC 鋪路。

    硬刪除，理由同 delete_project。
    """
    author = await _load_author(db, project.id, comment_id)
    if not _is_author(author.author_id, user.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="只有留言的作者能刪除")

    result = await db.execute(
        delete(Comment).where(Comment.id == comment_id, Comment.project_id == project.id)
    )
    if result.rowcount == 0:
        # 上面查到之後、DELETE 之前，留言被另一個請求刪掉了（同一個作者開兩個分頁
        # 就做得到）。204 的意思是「這個請求把它刪掉了」，沒刪到任何列就不能這樣回。
        # 與 update_comment 的同一種情況語意相同。
        raise _comment_not_found()
    await db.commit()
