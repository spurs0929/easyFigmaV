# 集中 import，讓 Alembic autogenerate 能看到所有 model。
# 新增 model 後記得加進來，否則 autogenerate 會以為那張表該被刪掉。
from app.models.project import Project
from app.models.refresh_token import RefreshToken
from app.models.user import User

__all__ = ["Project", "RefreshToken", "User"]