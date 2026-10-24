"""get_current_user 的 regression：token 驗證抽成 user_from_token() 之後，
REST 端的行為必須維持原樣——每一種失敗都是同一個 401，並帶 WWW-Authenticate。
"""

from datetime import UTC, datetime, timedelta

import jwt
import pytest

from app.core.config import settings
from app.core.security import ALGORITHM
from tests.test_access_token import deeply_nested_header_token

URL = "/api/projects"


async def test_valid_token_is_accepted(client, make_user, auth):
    user = await make_user()

    response = await client.get(URL, headers=auth(user))

    assert response.status_code == 200


@pytest.mark.parametrize(
    "header",
    ["Token abc", "Bearer", "Bearer not-a-jwt"],
    ids=["wrong-scheme", "empty-bearer", "invalid-token"],
)
async def test_bad_authorization_header_gets_401(client, header):
    response = await client.get(URL, headers={"Authorization": header})

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


async def test_expired_token_gets_401(client, make_user):
    user = await make_user()
    past = datetime.now(UTC) - timedelta(minutes=5)
    token = jwt.encode(
        {"sub": str(user.id), "iat": past, "exp": past, "typ": "access"},
        settings.secret_key,
        algorithm=ALGORITHM,
    )

    response = await client.get(URL, headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401


async def test_deleted_user_gets_401(client, make_user, auth, db_session):
    user = await make_user()
    headers = auth(user)
    await db_session.delete(user)
    await db_session.flush()

    response = await client.get(URL, headers=headers)

    assert response.status_code == 401


async def test_deeply_nested_header_gets_401_not_500(client):
    """GHSA-8wjv-2p76-3863：未登入的請求不能用偽造的 token 打出 500。

    打 /api/auth/me 而不是 URL：這是實際重現問題的端點。失敗時必須跟其他壞
    token 一樣是 401 + WWW-Authenticate。
    """
    response = await client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {deeply_nested_header_token()}"},
    )

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
