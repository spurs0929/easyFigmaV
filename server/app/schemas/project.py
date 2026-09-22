import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# 資料庫裡沒有這個型別對應的欄位。owner 的真相是 projects.owner_id，其餘出現在
# project_members 的都是 member；role 只是回應上的投影。
ProjectRole = Literal["owner", "member"]


class ProjectSummary(BaseModel):
    """列表用。刻意不含 document——那可能有數百 KB，列表不需要。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    document_version: int
    created_at: datetime
    updated_at: datetime

    # 相對於發出請求的人，不是專案的屬性：同一個專案，owner 看到 "owner"，
    # 被邀請的人看到 "member"。前端靠它區分「我的 / 參與中」並決定刪除與成員
    # 管理入口的可見性。
    #
    # ⚠️ 這是 UI 提示，不是授權。後端每支端點仍各自判斷權限，前端拿到什麼
    # role 都不影響——把它當成授權依據就是把判斷交給了客戶端。
    #
    # 刻意不回傳 owner_id：前端只需要知道「是不是我」，不需要知道是誰。
    role: ProjectRole


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
