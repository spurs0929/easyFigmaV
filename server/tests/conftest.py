"""後端測試的共用 fixture。

⚠️ 本檔案的 import 順序是刻意的。`app.core.config` 在 import 當下就會實例化
`Settings()`，所以環境變數必須在任何 `app.*` import 之前設定完成，否則測試會
連上開發用的資料庫。ruff 的 E402 已於 pyproject.toml 對本檔案關閉。
"""

import asyncio
import os
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable

# 預設指向本機 compose 起的另一個 database；CI 由 service container 覆寫。
# 刻意不重用 DATABASE_URL：測試會 drop_all，指錯資料庫的代價是清空開發資料。
TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5432/easyfigma_test",
)

os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ["ENVIRONMENT"] = "test"
# environment=test 不會觸發 _assert_strong_secret，這兩個值只需存在。
os.environ.setdefault("SECRET_KEY", "test-only-secret-not-used-anywhere-else")
os.environ.setdefault("REFRESH_TOKEN_PEPPER", "test-only-pepper-not-used-anywhere-else")

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.security import create_access_token, hash_password_sync  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.session import get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Project, User  # noqa: E402

TEST_PASSWORD = "correct-horse-battery-staple"

# 後端對 document 是不透明的，測試只需要一個結構上合法的空文件。
EMPTY_DOCUMENT: dict = {
    "version": 1,
    "savedAt": 0,
    "elements": {"byId": {}, "rootIds": []},
    "comments": [],
}


async def _create_schema(engine: AsyncEngine) -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)


@pytest.fixture(scope="session")
def engine() -> AsyncEngine:
    """整個 session 共用一個 engine。

    poolclass=NullPool 是必要的，不是效能取捨：asyncpg 的連線綁定在建立它的
    event loop 上，而 pytest-asyncio 預設每個測試一個 loop。連線一旦被 pool
    留下來跨測試重用，就會在別的 loop 上被操作。NullPool 讓每次 connect() 都
    開新連線，engine 物件本身不持有連線，跨 loop 共用才安全。

    schema 用 asyncio.run 建立而不是做成 async fixture，是為了完全避開
    pytest-asyncio 的 fixture loop scope 語意——那是版本間變動最頻繁的部分。
    """
    eng = create_async_engine(
        settings.sqlalchemy_url,
        connect_args=settings.connect_args,
        poolclass=NullPool,
    )
    asyncio.run(_create_schema(eng))
    return eng


@pytest_asyncio.fixture
async def db_session(engine: AsyncEngine) -> AsyncGenerator[AsyncSession, None]:
    """每個測試一個交易，結束時 rollback，測試之間不互相汙染。

    join_transaction_mode="create_savepoint" 是關鍵：端點程式碼裡有真的
    `await db.commit()`，若不做這個設定，第一次 commit 就會把外層交易提交掉，
    隔離失效。設定之後 session 的 commit 只會釋放 SAVEPOINT，外層交易仍在，
    最後由這裡整個 rollback。

    這也表示：測試不會驗證「commit 之後資料真的落地」，只驗證交易內的可見性。
    對授權測試來說足夠；若日後要驗 crash recovery 之類的行為，需要另一種夾具。
    """
    async with engine.connect() as conn:
        await conn.begin()
        maker = async_sessionmaker(
            bind=conn,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
        async with maker() as session:
            yield session
        await conn.rollback()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """覆寫 get_db，讓端點與測試共用同一個 session（也就是同一個交易）。"""

    async def _override_get_db() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def make_user(db_session: AsyncSession) -> Callable[..., Awaitable[User]]:
    """建立使用者。

    刻意不走 /api/auth/register：註冊端點有速率限制（單機記憶體實作，會跨測試
    累積），而且 argon2 每次約數十毫秒。授權測試不該為了拿一個 user 付這些成本。
    """

    async def _make(email: str | None = None) -> User:
        user = User(
            email=email or f"{uuid.uuid4().hex}@example.test",
            password_hash=hash_password_sync(TEST_PASSWORD),
        )
        db_session.add(user)
        await db_session.flush()
        return user

    return _make


@pytest_asyncio.fixture
async def make_project(db_session: AsyncSession) -> Callable[..., Awaitable[Project]]:
    async def _make(owner: User, name: str = "測試專案") -> Project:
        project = Project(owner_id=owner.id, name=name, document=EMPTY_DOCUMENT)
        db_session.add(project)
        await db_session.flush()
        # document_version 是 server_default，flush 之後 Python 端還是空的
        await db_session.refresh(project)
        return project

    return _make


@pytest.fixture
def auth() -> Callable[[User], dict[str, str]]:
    """直接簽一個 access token，不走登入流程。"""

    def _header(user: User) -> dict[str, str]:
        token, _ = create_access_token(user.id)
        return {"Authorization": f"Bearer {token}"}

    return _header