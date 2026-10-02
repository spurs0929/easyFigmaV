import uuid
from datetime import datetime
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.comment import COMMENT_CONTENT_MAX_LENGTH

# 世界座標。兩個設定各擋一件事：
#   allow_inf_nan=False：NaN / Infinity 在 PostgreSQL 的 double precision 是存得進去
#     的，但前端拿去算螢幕位置會得到一個永遠畫不出來的 pin。
#   strict=True：不把 "12"、true 這類值轉成數字。座標來自前端的計算結果，收到字串
#     代表呼叫端有 bug，替它轉型只是把問題往後推。JSON 的整數仍然接受。
WorldCoordinate = Annotated[float, Field(strict=True, allow_inf_nan=False)]


def _normalize_content(value: str) -> str:
    """去掉前後空白，再檢查長度。

    存進資料庫的是 trim 之後的內容——與專案名稱的處理一致。內容中間的換行與空白
    原樣保留，多行留言是合法的。

    這裡比資料庫的 CHECK 寬：str.strip() 會去掉所有 Unicode 空白（全形空白 U+3000、
    U+00A0……），CHECK 只認 ASCII 的六個。所以「只由空白組成」的完整判斷在這一層，
    CHECK 是第二道。

    長度量的是 trim 之後的字元數，因此不能用 Field(max_length=...)：它檢查的是
    trim 之前的原始輸入，前後帶空白的合法內容會被誤拒。
    """
    # U+0000 是合法的 JSON 字串內容，但 PostgreSQL 的文字欄位存不了它。
    # 不在這裡擋的話，要到 INSERT 才會失敗，而那是一個 500。
    if "\x00" in value:
        raise ValueError("留言內容包含不允許的字元")
    content = value.strip()
    if not content:
        raise ValueError("留言內容不可為空白")
    if len(content) > COMMENT_CONTENT_MAX_LENGTH:
        raise ValueError(f"留言內容不可超過 {COMMENT_CONTENT_MAX_LENGTH} 個字元")
    return content


class CommentCreate(BaseModel):
    world_x: WorldCoordinate
    world_y: WorldCoordinate
    content: str

    @field_validator("content")
    @classmethod
    def normalize_content(cls, v: str) -> str:
        return _normalize_content(v)


class CommentUpdate(BaseModel):
    """部分更新。只有 content 與 resolved 可以改。

    兩個欄位的授權不同（content 只有作者能改，resolved 任何成員都能改），所以端點
    需要知道「這次請求到底帶了哪些欄位」——用的是 model_fields_set，不是「值是不是
    None」。

    extra="forbid"：座標不可修改。預設行為是忽略多餘欄位，那樣送 world_x 過來會
    拿到 200 而位置沒變，呼叫端無從得知它的修改被丟掉了。
    """

    model_config = ConfigDict(extra="forbid")

    content: str | None = None
    resolved: Annotated[bool, Field(strict=True)] | None = None

    @field_validator("content")
    @classmethod
    def normalize_content(cls, v: str | None) -> str | None:
        return None if v is None else _normalize_content(v)

    @model_validator(mode="after")
    def require_a_real_change(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("至少要提供 content 或 resolved 其中之一")
        # 明確送 null 不等於「沒送」。兩個欄位在資料庫都是 NOT NULL，null 沒有
        # 合法的意思；當成沒送會讓 {"content": null} 變成一個什麼都沒做的 200。
        for name in self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"{name} 不可為 null")
        return self


class CommentAuthor(BaseModel):
    user_id: uuid.UUID
    display_name: str | None
    # 輸出不重新驗證 email，理由同 ProjectMemberOut。
    # 揭露範圍也相同：同專案的成員互相看得到 email，但它不得進入 log。
    email: str


class CommentOut(BaseModel):
    id: uuid.UUID
    world_x: float
    world_y: float
    content: str
    resolved: bool
    created_at: datetime
    updated_at: datetime
    author: CommentAuthor

    # 相對於發出請求的人，不是留言的屬性：同一則留言，作者看到 true，其他人看到 false。
    #
    # ⚠️ 這是 UI 提示，不是授權，性質同 ProjectSummary.role。端點各自判斷權限，
    # 前端拿到什麼值都不影響。
    #
    # resolved 沒有對應的欄位：任何看得到這則留言的成員都能切換它。
    can_edit: bool
    can_delete: bool
