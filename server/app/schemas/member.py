import uuid
from typing import Literal

from pydantic import BaseModel, EmailStr, field_validator


class MemberInvite(BaseModel):
    """用 email 邀請一個既有使用者。

    刻意不做 pending invitation：沒有邀請表、沒有邀請 token、沒有過期、沒有信件。
    查得到帳號就直接成為成員，查不到就回錯誤。這幾項每一項都會讓這週變兩週。
    """

    email: EmailStr

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        """一律轉小寫。users.email 本身也有 lowercase 的 CHECK。"""
        return v.strip().lower()


class ProjectMemberOut(BaseModel):
    """成員列表的一列。

    role 是推導出來的，不是欄位：owner 的真相是 projects.owner_id，其餘出現在
    project_members 的都是 member。資料庫裡沒有 role 欄位可以跟它說謊。
    """

    user_id: uuid.UUID
    # 輸出不重新驗證 email：它在註冊時就已經被 EmailStr 驗過並寫進資料庫。
    # 對已儲存的資料再驗一次不會擋掉任何壞資料，只會讓「資料庫裡有一筆邊界值」
    # 從一筆奇怪的紀錄變成一支 500。
    email: str
    display_name: str | None
    role: Literal["owner", "member"]