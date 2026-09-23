<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { useMembersStore } from '@/store/members'
import type { ProjectMember } from '@/services/members'
import type { ProjectSummary } from '@/services/projects'

const props = defineProps<{ project: ProjectSummary | null }>()
const emit = defineEmits<{ close: [] }>()

const members = useMembersStore()
const inviteEmail = ref('')

/**
 * 只決定要不要畫出邀請與移除的入口。真正的授權在後端，非 owner 就算送出請求
 * 也只會拿到 403。
 */
const isOwner = computed(() => props.project?.role === 'owner')

watch(
  () => props.project?.id ?? null,
  (id) => {
    inviteEmail.value = ''
    if (id) void members.open(id)
    else members.close()
  },
  { immediate: true },
)

async function invite(): Promise<void> {
  if (!inviteEmail.value.trim()) return
  if (await members.invite(inviteEmail.value)) inviteEmail.value = ''
}

/**
 * 不另外跳確認框：移除是可逆的（重新用 email 邀請回來即可），
 * 與刪除專案不同。
 */
function remove(member: ProjectMember): void {
  void members.remove(member.user_id)
}
</script>

<template>
  <Dialog
    :visible="project !== null"
    modal
    :header="`成員・${project?.name ?? ''}`"
    :style="{ width: 'min(420px, 92vw)' }"
    @update:visible="emit('close')"
  >
    <Message v-if="members.error" severity="error" :closable="false">
      {{ members.error }}
    </Message>

    <div v-if="isOwner" class="members-invite">
      <InputText
        v-model="inviteEmail"
        placeholder="輸入對方的 email"
        type="email"
        autocomplete="off"
        fluid
        @keyup.enter="invite"
      />
      <Button
        label="邀請"
        size="small"
        :disabled="!inviteEmail.trim()"
        :loading="members.pending"
        @click="invite"
      />
    </div>
    <p v-else class="members-hint">只有專案擁有者可以邀請或移除成員。</p>

    <p v-if="!members.loaded" class="members-state">載入中…</p>

    <ul v-else class="members-list">
      <li v-for="member in members.items" :key="member.user_id" class="members-item">
        <span class="members-identity">
          <span class="members-email">{{ member.email }}</span>
          <span v-if="member.display_name" class="members-name">{{ member.display_name }}</span>
        </span>

        <span class="members-role">{{ member.role === 'owner' ? '擁有者' : '成員' }}</span>

        <Button
          v-if="isOwner && member.role !== 'owner'"
          label="移除"
          text
          severity="danger"
          size="small"
          :loading="members.pending"
          @click="remove(member)"
        />
      </li>
    </ul>

    <template #footer>
      <Button label="關閉" text @click="emit('close')" />
    </template>
  </Dialog>
</template>

<style src="./ProjectMembersDialog.scss" scoped lang="scss" />
