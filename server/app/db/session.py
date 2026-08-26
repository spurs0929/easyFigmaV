from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

connect_args = settings.connect_args
if settings.db_uses_pgbouncer:
    # pgbouncer 的 transaction mode 不支援 named prepared statement，
    # 而 asyncpg 預設會用，於是出現間歇性的 DuplicatePreparedStatementError。
    # 這是 asyncpg dialect 從 connect_args 讀取的專屬參數，不能塞進
    # create_async_engine() 的頂層 kwargs（那樣會被當成未知參數而拋錯）。
    connect_args["prepared_statement_cache_size"] = 0

engine = create_async_engine(
    settings.sqlalchemy_url,
    connect_args=connect_args,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=5,
    # Neon 閒置一段時間會把 compute 收掉，長命連線會變成死連線；
    # pool_pre_ping 能擋掉，但主動回收可以少一次 round trip
    pool_recycle=300,
)

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session