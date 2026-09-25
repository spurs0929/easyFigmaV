from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth import router as auth_router
from app.api.health import router as health_router
from app.api.members import router as members_router
from app.api.projects import router as projects_router
from app.core.body_limit import BodySizeLimitMiddleware
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.core.request_context import REQUEST_ID_HEADER, RequestContextMiddleware
from app.core.sentry import init_sentry
from app.db.session import engine

# 必須在任何模組開始寫 log 之前完成，所以放在 import 之後、建立 app 之前，
# 而不是 lifespan——lifespan 要等到 uvicorn 啟動流程走到一半才執行。
configure_logging(settings.log_level, settings.log_as_json)
init_sentry()

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("app_started", environment=settings.environment)
    yield
    await engine.dispose()
    logger.info("app_stopped")


app = FastAPI(title="easyFigmaV", version="0.1.0", lifespan=lifespan)

# 必須早於路由：FastAPI 在解析 body 之後才執行 dependency，
# 只有 ASGI middleware 攔得住尚未進入記憶體的資料。
app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.max_request_bytes)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # 跨網域時瀏覽器預設只讓 JS 讀到少數幾個 header。沒有這行，前端拿不到
    # X-Request-ID，回報問題時就沒有能對上後端日誌的識別碼。
    expose_headers=[REQUEST_ID_HEADER],
)

# 最後加入 = 最外層（add_middleware 是往前插）。刻意放在最外層，
# body 超限的 413 與 CORS preflight 才會一起被記錄到。
app.add_middleware(RequestContextMiddleware)

app.include_router(health_router)
# 業務 API 統一掛在 /api 底下：
#   1. 本機開發用 Vite proxy 把 /api 轉給後端，前後端同源，
#      cookie 就不是跨站，SameSite=Lax 才送得出去
#   2. 避免前端路由（/projects）與後端 API（/projects）撞名
# /health 維持在根路徑，Render 的健康檢查指向那裡。
app.include_router(auth_router, prefix="/api")
app.include_router(projects_router, prefix="/api")
app.include_router(members_router, prefix="/api")
