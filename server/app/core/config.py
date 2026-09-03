import ssl
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# asyncpg 不吃 libpq 的連線參數，要從 query string 濾掉，改用 connect_args 表達
_LIBPQ_ONLY = {"sslmode", "sslrootcert", "sslcert", "sslkey", "channel_binding", "options"}

# 這些 host 視為本機開發，預設不強制 TLS
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "db", "host.docker.internal"}

_SSL_MODES = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}

# secrets.token_urlsafe(32) 的輸出長度，對應 256 bits 熵
_MIN_SECRET_LENGTH = 43
# 擋掉 "aaaa...a" 這類長度夠但熵趨近於零的字串
_MIN_SECRET_DISTINCT_CHARS = 10
# .env.example 裡的佔位值，不可以直接拿去上線
_PLACEHOLDER_SECRETS = {
    "change_me",
    "changeme",
    "secret",
    "your-secret-key-here",
    "replace-me",
}


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


def _assert_strong_secret(value: str, field: str) -> None:
    """字串本身無法測量熵，只能做啟發式檢查。

    真正的要求寫在 .env.example：必須由 CSPRNG 產生，至少 32 random bytes
    （python -c "import secrets; print(secrets.token_urlsafe(32))"）。
    這裡擋的是「明顯不合格」的值，不是「證明合格」。
    """
    if value.strip().lower() in _PLACEHOLDER_SECRETS:
        raise ValueError(f"{field} 仍是範例佔位值，正式環境必須換掉")
    if len(value) < _MIN_SECRET_LENGTH:
        raise ValueError(
            f"{field} 長度不足（{len(value)} < {_MIN_SECRET_LENGTH}）。"
            '請用 python -c "import secrets; print(secrets.token_urlsafe(32))" 產生'
        )
    if len(set(value)) < _MIN_SECRET_DISTINCT_CHARS:
        raise ValueError(f"{field} 字元變化過少，看起來不是由 CSPRNG 產生")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        # 預設是 None，等同用系統 locale（繁中 Windows 為 cp950），
        # .env 裡有中文註解就會 UnicodeDecodeError
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str
    # 覆寫 DATABASE_URL 裡的 sslmode。留空時：本機 host → disable，其餘 → verify-full
    db_sslmode: str | None = None
    db_connect_timeout: int = 15

    cors_origins: list[str] = ["http://localhost:5173"]

    # 用 Literal 而非 str：打錯字或漏設會直接啟動失敗，而不是靜默降級成
    # development、把底下的安全檢查一起繞過（fail closed）
    environment: Literal["development", "test", "production"] = "development"

    # ── 認證 ──────────────────────────────────────────────────
    # 兩把鑰匙刻意分開，才能各自獨立輪換：
    #   secret_key           → 簽 JWT。換掉只讓現有 access token 失效（最多 15 分鐘）
    #   refresh_token_pepper → HMAC refresh token。換掉會讓所有人重新登入
    # 若共用同一把，就永遠不能單獨輪換 JWT 簽章金鑰。
    secret_key: str
    refresh_token_pepper: str

    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 7
    # family 的絕對壽命上限。沒有這個，每次輪替都往後推 7 天 = 無限續命。
    refresh_family_max_days: int = 30
    # 已被輪替掉的 token 在這幾秒內再次出現，視為多分頁競態而非重放攻擊。
    # 窗內只回可重試的錯誤，不發新 token——發新 token 會讓重放偵測永久失效。
    refresh_reuse_grace_seconds: int = 10

    # 同時進行的 argon2 運算上限。19MB × N 的記憶體壓力在小 instance 上會讓
    # 延遲超線性惡化（實測 4 並行 = 14 倍單次耗時），必須設上限。
    password_hash_concurrency: int = 2

    # 單一 document 的大小上限。autosave 送的是整包 document，沒有上限的話
    # bug 或惡意請求可以持續把巨型 JSON 塞進 Postgres。
    max_document_bytes: int = 2 * 1024 * 1024

    # 專案列表一次最多回傳幾筆。沒有分頁，但也不能無上限。
    max_projects_per_page: int = 100

    # 登入 / 註冊的速率限制（單機記憶體實作，多實例需改 Redis）
    auth_rate_limit_attempts: int = 10
    auth_rate_limit_window_seconds: int = 300

    # ── 以下由 _resolve 填好，不要從環境變數設定 ──────────────
    sqlalchemy_url: str = ""
    db_host: str = ""
    db_uses_pgbouncer: bool = False
    _ssl: bool | ssl.SSLContext = False

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

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

        # 開發環境放行弱 secret 方便本機起服務；正式環境一律擋下
        if self.is_production:
            _assert_strong_secret(self.secret_key, "SECRET_KEY")
            _assert_strong_secret(self.refresh_token_pepper, "REFRESH_TOKEN_PEPPER")
            if self.secret_key == self.refresh_token_pepper:
                raise ValueError("SECRET_KEY 與 REFRESH_TOKEN_PEPPER 不可相同")

        return self

    @property
    def connect_args(self) -> dict:
        return {
            "ssl": self._ssl,
            "timeout": self.db_connect_timeout,  # Neon scale-to-zero 冷啟動要等
            "server_settings": {"application_name": f"easyfigmav-{self.environment}"},
        }


settings = Settings()