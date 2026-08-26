import ssl
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# asyncpg 不吃 libpq 的連線參數，要從 query string 濾掉，改用 connect_args 表達
_LIBPQ_ONLY = {"sslmode", "sslrootcert", "sslcert", "sslkey", "channel_binding", "options"}

# 這些 host 視為本機開發，預設不強制 TLS
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "db", "host.docker.internal"}

_SSL_MODES = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}


def _build_ssl(mode: str) -> bool | ssl.SSLContext:
    """把 libpq 的 sslmode 語意翻成 asyncpg 要的 ssl 參數。"""
    if mode == "disable":
        return False

    ctx = ssl.create_default_context()
    if mode in ("allow", "prefer", "require"):
        # libpq 語意：加密，但不驗證憑證
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    elif mode == "verify-ca":
        ctx.check_hostname = False
    return ctx


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    # 覆寫 DATABASE_URL 裡的 sslmode。留空時：本機 host → disable，其餘 → verify-full
    db_sslmode: str | None = None
    db_connect_timeout: int = 15

    cors_origins: list[str] = ["http://localhost:5173"]
    environment: str = "development"

    # ── 以下由 _resolve 填好，不要從環境變數設定 ──────────────
    sqlalchemy_url: str = ""
    db_host: str = ""
    db_uses_pgbouncer: bool = False
    _ssl: bool | ssl.SSLContext = False

    @model_validator(mode="after")
    def _resolve(self) -> "Settings":
        """把供應商差異全部收斂在這裡。

        換 Render / Neon / 本機 compose 只該動環境變數，不該動 session.py 或
        alembic/env.py。所以這裡做三件事：

        1. scheme 正規化成 asyncpg。平台給的是 postgresql://，SQLAlchemy 會據此
           去找同步 driver。
        2. sslmode 不是丟掉，是翻譯成 SSLContext。丟掉的話 asyncpg 會用自己的
           預設，結果是「有加密但不驗憑證」的靜默降級——最難發現的那種錯。
        3. 認出 pgbouncer host，讓 session.py 關掉 prepared statement 快取。
        """
        parts = urlsplit(self.database_url)
        params = dict(parse_qsl(parts.query))

        scheme = (
            "postgresql+asyncpg"
            if parts.scheme in ("postgres", "postgresql")
            else parts.scheme
        )
        query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if k not in _LIBPQ_ONLY])
        self.sqlalchemy_url = urlunsplit((scheme, parts.netloc, parts.path, query, parts.fragment))

        host = parts.hostname or ""
        self.db_host = host
        is_local = host in _LOCAL_HOSTS

        # 解析順序：DB_SSLMODE > 預設值。URL 裡的 sslmode 只當作「需要 TLS」的訊號，
        # 不直接採用——Neon 複製給你的字串是 require，而 require 不驗憑證。
        mode = self.db_sslmode or ("disable" if is_local else "verify-full")
        if mode not in _SSL_MODES:
            raise ValueError(f"DB_SSLMODE 不合法：{mode}，可用值 {sorted(_SSL_MODES)}")
        if is_local and params.get("sslmode") in ("require", "verify-ca", "verify-full"):
            mode = params["sslmode"]  # 本機明確要求 TLS 時尊重它

        self._ssl = _build_ssl(mode)

        # Neon 的 pooled endpoint 是 -pooler.，Supabase 的 transaction pooler 是 6543 埠
        self.db_uses_pgbouncer = "-pooler." in host or parts.port == 6543
        return self

    @property
    def connect_args(self) -> dict:
        return {
            "ssl": self._ssl,
            "timeout": self.db_connect_timeout,  # Neon scale-to-zero 冷啟動要等
            "server_settings": {"application_name": f"easyfigmav-{self.environment}"},
        }


settings = Settings()