"""decode_access_token 面對惡意輸入的行為。

分成兩類，目的不同：

1. 應用層保證（GHSA-8wjv-2p76-3863）
   header 深層巢狀的 token 會讓 PyJWT < 2.14.0 在驗簽之前解析 header 時丟出
   RecursionError。它不是 PyJWTError，會穿過 decode_access_token 的 except，
   讓未登入的請求變成 500。這是在 easyFigmaV 實際重現過的問題。

2. 依賴行為契約
   簽章段夾帶非 Base64URL 字元、header 帶不認得的 crit：這兩種在 easyFigmaV
   都不可利用——前者需要「以 token 原始字串當撤銷或防重放的鍵」，我們沒有；
   後者需要用 SECRET_KEY 簽出合法簽章。這裡測的是 PyJWT 的行為本身，目的是
   日後 PyJWT 被降版或換版時，寬鬆的解析不會悄悄回來。

不需要資料庫：decode_access_token 是純函式。
"""

import base64
import uuid
from datetime import UTC, datetime, timedelta

import jwt

from app.core.config import settings
from app.core.security import ALGORITHM, create_access_token, decode_access_token

# 實測觸發門檻約 10,000 層（Python 3.12）；取兩倍留餘裕，不依賴確切的遞迴上限。
NESTING_DEPTH = 20_000


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def deeply_nested_header_token() -> str:
    """header 是 [[[...]]] 的 token。簽章段是隨便的值：解析 header 在驗簽之前。"""
    header = ("[" * NESTING_DEPTH + "]" * NESTING_DEPTH).encode()
    return f"{_b64url(header)}.{_b64url(b'{}')}.{_b64url(b'x' * 32)}"


def _access_payload(user_id: uuid.UUID) -> dict[str, object]:
    """與 create_access_token 相同的 claims，讓測試能自訂 header。"""
    now = datetime.now(UTC)
    return {
        "sub": str(user_id),
        "iat": now,
        "exp": now + timedelta(minutes=5),
        "jti": "test-jti",
        "typ": "access",
    }


# ── 1. 應用層保證 ─────────────────────────────────────────────────────────


def test_deeply_nested_header_is_rejected_not_raised():
    """必須回 None（呼叫端轉成 401），而不是讓 RecursionError 往外拋。"""
    assert decode_access_token(deeply_nested_header_token()) is None


# ── 2. 依賴行為契約 ───────────────────────────────────────────────────────


def test_signature_with_non_base64url_characters_is_rejected():
    user_id = uuid.uuid4()
    token, _ = create_access_token(user_id)

    # 對照組：原本的 token 是有效的，拒絕確實來自附加的字元
    assert decode_access_token(token) == user_id
    # 附加的字元不改變解碼出的簽章位元組，寬鬆的解析器會照樣接受
    assert decode_access_token(token + "!!!!") is None


def test_unknown_critical_header_is_rejected():
    """RFC 7515 §4.1.11：crit 列出的擴充欄位不被理解時，整個 JWS 無效。"""
    user_id = uuid.uuid4()
    payload = _access_payload(user_id)

    # 對照組：同一份 claims、同一把金鑰，不帶 crit 時是有效的
    plain = jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)
    assert decode_access_token(plain) == user_id

    with_crit = jwt.encode(
        payload,
        settings.secret_key,
        algorithm=ALGORITHM,
        headers={"crit": ["x-unknown-extension"], "x-unknown-extension": True},
    )
    assert decode_access_token(with_crit) is None
