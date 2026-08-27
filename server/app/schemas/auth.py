import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class RegisterRequest(BaseModel):
    email: EmailStr
    # 上限不是為了安全而是為了效能：argon2 對超長輸入照樣會算，
    # 沒有上限就等於開放一個「送 1MB 密碼」的資源消耗管道。
    password: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=80)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        """一律轉小寫。資料庫還有一條 CHECK 擋著，這裡是第一道。"""
        return v.strip().lower()

    @field_validator("display_name")
    @classmethod
    def blank_to_none(cls, v: str | None) -> str | None:
        return v.strip() or None if v else None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        return v.strip().lower()


class UserResponse(BaseModel):
    # from_attributes 讓 ORM 物件能直接轉。但仍是明確白名單：
    # password_hash 不在這裡，就不可能被序列化出去。
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    display_name: str | None
    created_at: datetime


class TokenResponse(BaseModel):
    """refresh token 不在這裡——它只走 httpOnly cookie，永遠不進 response body。"""

    access_token: str
    token_type: str = "bearer" # noqa: S105
    expires_in: int  # 秒，給前端排程提前 refresh
    user: UserResponse
