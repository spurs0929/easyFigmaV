from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth import router as auth_router
from app.api.health import router as health_router
from app.core.config import settings
from app.db.session import engine


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await engine.dispose()

app = FastAPI(title="easyFigmaV", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
# 業務 API 統一掛在 /api 底下：
#   1. 本機開發用 Vite proxy 把 /api 轉給後端，前後端同源，
#      cookie 就不是跨站，SameSite=Lax 才送得出去
#   2. 避免前端路由（/projects）與後端 API（/projects）撞名
# /health 維持在根路徑，Render 的健康檢查指向那裡。
app.include_router(auth_router, prefix="/api")