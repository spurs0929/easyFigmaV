"""create project_members

Revision ID: b41c7d9e2f05
Revises: 53fb7b046394
Create Date: 2026-09-21 06:12:44.318902

"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = 'b41c7d9e2f05'
down_revision: str | None = '53fb7b046394'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('project_members',
    sa.Column('project_id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name=op.f('fk_project_members_project_id_projects'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_project_members_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('project_id', 'user_id', name=op.f('pk_project_members'))
    )
    op.create_index('ix_project_members_user_id', 'project_members', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_project_members_user_id', table_name='project_members')
    op.drop_table('project_members')