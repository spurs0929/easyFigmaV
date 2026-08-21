from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import get_db

router = APIRouter(tags=["Health"])

DbSession = Annotated[AsyncSession, Depends(get_db)]

@router.get("/health")
async def liveness():
    """確認程式是否存活。"""
    return { "status": "ok", "environment": settings.environment }

@router.get("/health/ready")
async def readiness(response: Response, db: DbSession):
    """檢查外部依賴（目前只有資料庫）是否可用。"""
    try:
        await db.execute(text("SELECT 1"))
    except Exception:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "degraded", "database": "unreachable"}

    return {"status": "ok", "database": "ok"}