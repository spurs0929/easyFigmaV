"""後端測試的共用 fixture。

⚠️ 本檔案的 import 順序是刻意的。`app.core.config` 在 import 當下就會實例化
`Settings()`，所以環境變數必須在任何 `app.*` import 之前設定完成，否則測試會
連上開發用的資料庫。ruff 的 E402 已於 pyproject.toml 對本檔案關閉。
"""

import asyncio
import os
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable, Iterator
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVER_ROOT = Path(__file__).resolve().parents[1]

# 與 app/core/config.py 的 _LOCAL_HOSTS 相同，刻意複製而不是 import：本模組必須
# 在 import app.core.config 之前決定要連哪個資料庫，而該模組在 import 當下就會用
# 開發用的 DATABASE_URL 實例化 Settings()。兩邊若要調整必須一起改。
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "db", "host.docker.internal"})

_POSTGRES_DEFAULT_PORT = 5432


class _DevEnv(BaseSettings):
    """只讀出 DATABASE_URL，用來推導測試資料庫。

    刻意用 pydantic-settings 而不是自己 parse .env：解析規則與優先序（環境變數
    蓋過 .env）必須跟 app.core.config 完全一致，否則測試連到的會是另一個地方。
    env_file 用絕對路徑，讓 pytest 從 repo 根目錄或 server/ 執行都一樣。
    """

    model_config = SettingsConfigDict(
        env_file=SERVER_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = ""


def _is_local(url: str) -> bool:
    return (urlsplit(url).hostname or "") in _LOCAL_HOSTS


def _identity(url: str) -> tuple[str, int, str]:
    """判斷兩個 URL 是否指向同一個資料庫用的比較鍵。

    兩處正規化，兩處都是安全閥漏判的來源：

    1. 本機主機名稱收斂成同一個 token——localhost 與 127.0.0.1 是同一台機器。
    2. 省略的埠號補成 5432——`//localhost/db` 與 `//localhost:5432/db` 是同一個
       資料庫，不補的話一邊是 None、一邊是 5432，比較結果會是「不同」。

    這個 harness 只支援 PostgreSQL，所以直接寫死預設埠號。
    """
    parts = urlsplit(url)
    host = parts.hostname or ""
    return (
        "<local>" if host in _LOCAL_HOSTS else host,
        parts.port or _POSTGRES_DEFAULT_PORT,
        parts.path.lstrip("/"),
    )


def _derive_test_url(dev_url: str) -> str:
    """把開發資料庫名稱加上 _test 後綴。

    這樣就不需要任何額外設定：能跑起服務的機器就能跑測試。
    """
    parts = urlsplit(dev_url)
    name = parts.path.lstrip("/")
    if not name:
        raise RuntimeError(f"DATABASE_URL 沒有資料庫名稱：{dev_url}")
    if name.endswith("_test"):
        return dev_url
    return urlunsplit((parts.scheme, parts.netloc, f"/{name}_test", parts.query, parts.fragment))


_dev_url = _DevEnv().database_url
_explicit_test_url = os.environ.get("TEST_DATABASE_URL")

# 優先序：明確指定的 TEST_DATABASE_URL > 由 DATABASE_URL 推導。
# TEST_DATABASE_URL 必須能單獨使用——CI 用 service container 時不會有 .env。
if _explicit_test_url:
    TEST_DATABASE_URL = _explicit_test_url
elif _dev_url:
    # 只有「自動推導」限制在本機。這個 harness 會對目標 CREATE DATABASE 再
    # drop_all，對遠端資料庫（Neon、Render）猜錯目標的代價無法承受。
    # 遠端不是禁止，是要求透過 TEST_DATABASE_URL 明確指定可拋棄的測試資料庫——
    # 那是使用者親口指定的目標，就不再代他判斷。
    if not _is_local(_dev_url):
        raise RuntimeError(
            f"DATABASE_URL 指向遠端主機（{urlsplit(_dev_url).hostname}），"
            "拒絕自動推導測試資料庫——這個 harness 會對目標執行 drop_all。"
            "請明確設定 TEST_DATABASE_URL 指向可拋棄的資料庫。"
        )
    TEST_DATABASE_URL = _derive_test_url(_dev_url)
else:
    raise RuntimeError(
        f"找不到資料庫設定。請由 .env.example 複製一份 {SERVER_ROOT / '.env'}，"
        "或設定 TEST_DATABASE_URL 環境變數。"
    )

# 安全閥。指到開發資料庫的代價是清空本機資料，寧可讓測試起不來。
# 比較的是 (host, port, database)，不是字串——localhost 與 127.0.0.1 要視為同一台。
if _dev_url and _identity(TEST_DATABASE_URL) == _identity(_dev_url):
    raise RuntimeError(
        "測試資料庫與 DATABASE_URL 指向同一個資料庫，拒絕執行（測試會清空 schema）："
        f"{urlsplit(_dev_url).hostname}/{urlsplit(_dev_url).path.lstrip('/')}"
    )


def _url_source() -> str:
    return "TEST_DATABASE_URL" if os.environ.get("TEST_DATABASE_URL") else "由 DATABASE_URL 推導"


def _describe_target() -> str:
    parts = urlsplit(TEST_DATABASE_URL)
    return f"{parts.path.lstrip('/')} @ {parts.hostname}:{parts.port}（{_url_source()}）"


os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ["ENVIRONMENT"] = "test"
# environment=test 不會觸發 _assert_strong_secret，這兩個值只需存在。
os.environ.setdefault("SECRET_KEY", "test-only-secret-not-used-anywhere-else")
os.environ.setdefault("REFRESH_TOKEN_PEPPER", "test-only-pepper-not-used-anywhere-else")

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
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


async def _ensure_database() -> None:
    """測試資料庫不存在就建立，不必先手動 createdb。

    CREATE DATABASE 不能在交易內執行，所以連到 maintenance 資料庫並用
    AUTOCOMMIT。名稱來自本機設定而非使用者輸入，但仍用識別字引號包起來。
    """
    parts = urlsplit(TEST_DATABASE_URL)
    db_name = parts.path.lstrip("/")
    admin_url = urlunsplit((parts.scheme, parts.netloc, "/postgres", parts.query, parts.fragment))

    admin = create_async_engine(
        admin_url,
        connect_args=settings.connect_args,
        poolclass=NullPool,
        isolation_level="AUTOCOMMIT",
    )
    try:
        async with admin.connect() as conn:
            exists = await conn.scalar(
                text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": db_name}
            )
            if not exists:
                # 名稱來自本機設定而非使用者輸入，但識別字裡的雙引號仍要跳脫，
                # 否則含引號的資料庫名稱會直接破壞這段 SQL。
                quoted = db_name.replace('"', '""')
                await conn.execute(text(f'CREATE DATABASE "{quoted}"'))
    except Exception as exc:
        # -q 會吃掉 pytest 的 report header，所以把目標與來源直接寫進例外訊息，
        # 否則使用者只會看到「密碼錯誤」而不知道它連去了哪。
        raise RuntimeError(
            f"測試資料庫準備失敗：{_describe_target()}。"
            "若這不是你預期的位置，多半是 shell session 裡殘留了 TEST_DATABASE_URL"
            "（PowerShell：Remove-Item Env:TEST_DATABASE_URL）。"
        ) from exc
    finally:
        await admin.dispose()


async def _create_schema(engine: AsyncEngine) -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)


@pytest.fixture(scope="session")
def engine() -> Iterator[AsyncEngine]:
    """整個 session 共用一個 engine。

    poolclass=NullPool 是必要的，不是效能取捨：asyncpg 的連線綁定在建立它的
    event loop 上，而 pytest-asyncio 預設每個測試一個 loop。連線一旦被 pool
    留下來跨測試重用，就會在別的 loop 上被操作。NullPool 讓每次 connect() 都
    開新連線，engine 物件本身不持有連線，跨 loop 共用才安全。

    schema 用 asyncio.run 建立而不是做成 async fixture，是為了完全避開
    pytest-asyncio 的 fixture loop scope 語意——那是版本間變動最頻繁的部分。
    """
    asyncio.run(_ensure_database())
    eng = create_async_engine(
        settings.sqlalchemy_url,
        connect_args=settings.connect_args,
        poolclass=NullPool,
    )
    asyncio.run(_create_schema(eng))
    yield eng
    # NullPool 之下 dispose() 幾乎是 no-op（沒有連線被保留），但不依賴這個
    # 前提：pool 策略若哪天改掉，這裡不該變成洩漏點。
    asyncio.run(eng.dispose())


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


def pytest_report_header() -> list[str]:
    """每次執行都印出實際連到的測試資料庫。

    連錯地方是這個 harness 最容易發生、也最難察覺的錯誤：環境變數會留在 shell
    session 裡跨次數生效，而失敗訊息只會說密碼錯，不會說它連去了哪。
    只印資料庫、主機、來源，不印使用者與密碼。
    """
    return [f"test database: {_describe_target()}"]