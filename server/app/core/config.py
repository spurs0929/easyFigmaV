from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    cors_origins: list[str] = ["http://localhost:5173"]
    environment: str = "development"

    @field_validator("database_url")
    @classmethod
    def _to_asyncpg(cls, v: str) -> str:
        """把平台給的連線字串正規化成 asyncpg 能吃的格式。

        Render 提供的是 postgresql://，SQLAlchemy 會據此去找同步 driver；
        另外 asyncpg 不認得 libpq 的 sslmode 參數，要濾掉。
        """
        parts = urlsplit(v)
        scheme = (
            "postgresql+asyncpg"
            if parts.scheme in ("postgres", "postgresql")
            else parts.scheme
        )
        query = urlencode([(k, x) for k, x in parse_qsl(parts.query) if k != "sslmode"])
        return urlunsplit((scheme, parts.netloc, parts.path, query, parts.fragment))


settings = Settings()