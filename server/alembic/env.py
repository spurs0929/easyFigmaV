import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import context
from app.core.config import settings
from app.db.base import Base

# app.models 這行必須留著：import 之後 model 才會註冊到 Base.metadata，
# autogenerate 才看得到表。少了它 autogenerate 會產出「刪掉所有表」的 migration。
from app.models import *  # noqa: F401,F403

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _configure(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        # 讓 autogenerate 也會偵測欄位型別與 server_default 的變動，
        # 預設只比對「有沒有這個欄位」
        compare_type=True,
        compare_server_default=True,
    )


def run_migrations_offline() -> None:
    """離線模式：只產生 SQL，不連資料庫（alembic upgrade head --sql）。

    上線前想先看一眼會跑什麼 DDL 時很有用。
    """
    context.configure(
        url=settings.sqlalchemy_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def _do_run(connection: Connection) -> None:
    _configure(connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    connect_args = settings.connect_args
    if settings.db_uses_pgbouncer:
        connect_args["prepared_statement_cache_size"] = 0

    # NullPool：migration 是一次性短命程序，不需要連線池，
    # 用連線池反而會在程式結束時留下未關閉的連線警告
    engine = create_async_engine(
        settings.sqlalchemy_url,
        connect_args=connect_args,
        poolclass=pool.NullPool,
    )

    async with engine.connect() as connection:
        await connection.run_sync(_do_run)

    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())