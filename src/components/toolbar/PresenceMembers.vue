<script setup lang="ts">
import { computed } from 'vue'
import UserAvatar from '@/components/common/UserAvatar.vue'
import { useAuthStore } from '@/store/auth'
import { usePresenceStore } from '@/store/presence'
import type { PresenceUser } from '@/types/presence'

/** 工具列只有 48px 寬，超過這個數量改顯示 +N。 */
const MAX_VISIBLE_AVATARS = 3
const UNNAMED_USER = '未命名使用者'
const ROLE_LABELS: Record<PresenceUser['role'], string> = {
  owner: '擁有者',
  member: '成員',
}

const auth = useAuthStore()
const presence = usePresenceStore()

const state = computed(() => presence.status.state)
const visibleUsers = computed(() => presence.users.slice(0, MAX_VISIBLE_AVATARS))
const hiddenUsers = computed(() => presence.users.slice(MAX_VISIBLE_AVATARS))

function nameOf(user: PresenceUser): string {
  return user.display_name?.trim() || UNNAMED_USER
}

function labelOf(user: PresenceUser): string {
  const self = user.user_id === auth.user?.id ? '（你）' : ''
  return `${nameOf(user)}${self} · ${ROLE_LABELS[user.role]}`
}

const summary = computed(() => {
  switch (state.value) {
    case 'reconnecting':
      return '在線成員：重新連線中…'
    case 'stopped':
      return '在線成員目前無法取得'
    case 'connecting':
      return '在線成員：連線中…'
    default:
      return `在線 ${presence.users.length} 人`
  }
})
</script>

<template>
  <!--
    presence 是輔助資訊：任何狀態都只在工具列裡佔一小塊，不遮畫布、不擋操作。
    idle（本機草稿、尚未連線、已離開）時完全不渲染。
  -->
  <div
    v-if="state !== 'idle'"
    class="presence-members"
    :class="`is-${state}`"
    role="group"
    :aria-label="summary"
    data-testid="presence-members"
  >
    <hr class="divider" />

    <UserAvatar
      v-for="user in visibleUsers"
      :key="user.user_id"
      v-tooltip.right="{ value: labelOf(user), showDelay: 300, pt: { root: 'toolbar-tooltip' } }"
      :name="nameOf(user)"
      class="presence-avatar"
      :class="{ 'is-owner': user.role === 'owner' }"
      :aria-label="labelOf(user)"
      data-testid="presence-avatar"
    />

    <span
      v-if="hiddenUsers.length"
      v-tooltip.right="{
        value: hiddenUsers.map(labelOf).join('\n'),
        showDelay: 300,
        pt: { root: 'toolbar-tooltip' },
      }"
      class="presence-overflow"
      :aria-label="`另外 ${hiddenUsers.length} 人`"
    >
      +{{ hiddenUsers.length }}
    </span>

    <span
      v-tooltip.right="{ value: summary, showDelay: 300, pt: { root: 'toolbar-tooltip' } }"
      class="presence-status"
      data-testid="presence-status"
    >
      <i v-if="state === 'reconnecting' || state === 'connecting'" class="pi pi-sync pi-spin" />
      <i v-else-if="state === 'stopped'" class="pi pi-users" />
      <template v-else>{{ presence.users.length }}</template>
    </span>
  </div>
</template>

<style src="./PresenceMembers.scss" scoped lang="scss" />
