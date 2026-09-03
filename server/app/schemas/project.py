import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProjectSummary(BaseModel):
    """列表用。刻意不含 document——那可能有數百 KB，列表不需要。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    document_version: int
    created_at: datetime
    updated_at: datetime


class ProjectDetail(ProjectSummary):
    document: dict[str, Any]


class ProjectCreate(BaseModel):
    name: str = Field(default="未命名專案", max_length=120)
    # 必填：空文件的結構由前端定義，後端不知道該給什麼。
    document: dict[str, Any]

    @field_validator("name")
    @classmethod
    def normalize_name(cls, v: str) -> str:
        name = v.strip()
        if not name:
            raise ValueError("名稱不可為空白")
        return name



class ProjectRename(BaseModel):
    name: str = Field(max_length=120)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, v: str) -> str:
        name = v.strip()
        if not name:
            raise ValueError("名稱不可為空白")
        return name


class DocumentUpdate(BaseModel):
    """存檔。document_version 是客戶端讀取當下的版本，用來做樂觀鎖。"""

    document_version: int = Field(ge=1)
    document: dict[str, Any]



class DocumentSaved(BaseModel):
    """存檔成功後只回版本與時間，不回傳整包 document。"""

    document_version: int
    updated_at: datetime