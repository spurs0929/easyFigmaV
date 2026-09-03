<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import { useAuthStore } from '@/store/auth'
import { useProjectsStore } from '@/store/projects'
import type { ProjectSummary } from '@/services/projects'

const router = useRouter()
const auth = useAuthStore()
const projects = useProjectsStore()

const renaming = ref<ProjectSummary | null>(null)
const renameInput = ref('')
const deleting = ref<ProjectSummary | null>(null)

onMounted(() => {
  projects.clearError()
  void projects.fetchAll()
})

const dateFormatter = new Intl.DateTimeFormat('zh-TW', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatTime(iso: string): string {
  return dateFormatter.format(new Date(iso))
}

function openProject(project: ProjectSummary): void {
  void router.push(`/p/${project.id}`)
}

function startRename(project: ProjectSummary): void {
  renaming.value = project
  renameInput.value = project.name
}

async function confirmRename(): Promise<void> {
  const target = renaming.value
  if (!target) return
  if (await projects.rename(target.id, renameInput.value.trim())) {
    renaming.value = null
  }
}

async function confirmDelete(): Promise<void> {
  const target = deleting.value
  if (!target) return
  if (await projects.remove(target.id)) {
    deleting.value = null
  }
}
</script>

<template>
  <div class="projects">
    <header class="projects-header">
      <div>
        <h1>我的專案</h1>
        <p class="projects-user">{{ auth.displayName }}</p>
      </div>
      <Button label="回到編輯器" text size="small" @click="router.push('/')" />
    </header>

    <Message v-if="projects.error" severity="error" :closable="false">
      {{ projects.error }}
    </Message>

    <p v-if="projects.pending && !projects.loaded" class="projects-state">載入中…</p>

    <p v-else-if="projects.isEmpty" class="projects-state">
      還沒有雲端專案。在編輯器裡按「存到雲端」就會出現在這裡。
    </p>

    <ul v-else class="projects-list">
      <li v-for="project in projects.items" :key="project.id" class="projects-item">
        <button class="projects-open" type="button" @click="openProject(project)">
          <span class="projects-name">{{ project.name }}</span>
          <span class="projects-meta">
            版本 {{ project.document_version }}・{{ formatTime(project.updated_at) }}
          </span>
        </button>

        <div class="projects-actions">
          <Button label="重新命名" text size="small" @click="startRename(project)" />
          <Button label="刪除" text severity="danger" size="small" @click="deleting = project" />
        </div>
      </li>
    </ul>

    <Dialog
      :visible="renaming !== null"
      modal
      header="重新命名"
      :style="{ width: 'min(360px, 92vw)' }"
      @update:visible="renaming = null"
    >
      <InputText v-model="renameInput" maxlength="120" fluid autofocus />
      <template #footer>
        <Button label="取消" text @click="renaming = null" />
        <Button
          label="儲存"
          :disabled="!renameInput.trim()"
          :loading="projects.pending"
          @click="confirmRename"
        />
      </template>
    </Dialog>

    <Dialog
      :visible="deleting !== null"
      modal
      header="刪除專案"
      :style="{ width: 'min(360px, 92vw)' }"
      @update:visible="deleting = null"
    >
      <p class="projects-confirm">確定要刪除「{{ deleting?.name }}」嗎？此操作無法復原。</p>
      <template #footer>
        <Button label="取消" text @click="deleting = null" />
        <Button label="刪除" severity="danger" :loading="projects.pending" @click="confirmDelete" />
      </template>
    </Dialog>
  </div>
</template>

<style src="./ProjectsView.scss" scoped lang="scss" />
