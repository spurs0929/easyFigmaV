<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/store/auth'
import { useDocumentStore } from '@/store/document'
import { useProjectsStore } from '@/store/projects'
import type { ProjectDocument } from '@/services/projects'
import DocumentImportDialog from './DocumentImportDialog.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const documentStore = useDocumentStore()
const projects = useProjectsStore()
const uploading = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const importDialogVisible = ref(false)
const importInProgress = ref(false)
const importErrorMessage = ref('')

/** 根據 saveState 產生對外提示文案，供 toolbar status dot tooltip 顯示。 */
const statusTooltip = computed(() => {
  if (!documentStore.persistenceAvailable) {
    return '此瀏覽器無法使用 IndexedDB，但仍可匯入與匯出 JSON。'
  }

  const target = documentStore.isCloud ? '雲端' : '本機'

  switch (documentStore.saveState) {
    case 'loading':
      return `正在從${target}載入文件。`
    case 'saving':
      return `正在將目前文件自動儲存到${target}。`
    case 'saved':
      return documentStore.lastSavedAt
        ? `已於 ${new Date(documentStore.lastSavedAt).toLocaleTimeString()} 自動儲存到${target}。`
        : `已自動儲存到${target}。`
    case 'conflict':
      return '這個專案已在其他視窗被修改，需重新載入才能繼續儲存。'
    case 'error':
      return documentStore.errorMessage || '文件儲存失敗。'
    default:
      return '自動儲存已就緒。'
  }
})

/**
 * 存到雲端：一次性複製，不是持續同步。
 * 建立成功後就導向 /p/:id，之後的自動儲存由雲端 backend 接手，
 * 本機草稿留在 IndexedDB 不動——兩條路徑各自獨立，沒有合併問題。
 */
async function saveToCloud(): Promise<void> {
  if (!auth.isAuthenticated) {
    void router.push({ name: 'login', query: { redirect: route.fullPath } })
    return
  }

  uploading.value = true
  try {
    const snapshot = documentStore.buildSnapshot()
    const id = await projects.create(snapshot as unknown as ProjectDocument)
    if (id) void router.push(`/p/${id}`)
  } finally {
    uploading.value = false
  }
}

function openImportDialog(): void {
  importErrorMessage.value = ''
  importDialogVisible.value = true
}

function chooseImportFile(): void {
  fileInputRef.value?.click()
}

async function onImportChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 清空 input.value，避免連續選同一個檔案時不觸發 change。
  input.value = ''
  if (!file) return

  importInProgress.value = true
  importErrorMessage.value = ''
  try {
    const imported = await documentStore.importFile(file)
    if (imported) {
      importDialogVisible.value = false
      return
    }
    importErrorMessage.value = documentStore.errorMessage || '匯入失敗。'
  } finally {
    importInProgress.value = false
  }
}
</script>

<template>
  <div class="toolbar-actions">
    <hr class="divider" />

    <button
      v-tooltip.right="{
        value: '匯出目前文件為 JSON',
        showDelay: 400,
        pt: { root: 'toolbar-tooltip' },
      }"
      class="tool-btn"
      aria-label="匯出文件 JSON"
      @click="documentStore.exportJson()"
    >
      <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <path
          d="M8 2.5v7m0 0l-2.5-2.5M8 9.5l2.5-2.5M3 11.5v1.5h10v-1.5"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <button
      v-tooltip.right="{
        value: '匯入 DocumentSnapshot JSON 檔案',
        showDelay: 400,
        pt: { root: 'toolbar-tooltip' },
      }"
      class="tool-btn"
      aria-label="匯入文件 JSON"
      @click="openImportDialog"
    >
      <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <path
          d="M8 13.5v-7m0 0l-2.5 2.5M8 6.5 10.5 9M3 4.5V3h10v1.5"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <button
      v-if="!documentStore.isCloud"
      v-tooltip.right="{
        value: '把目前的草稿複製一份到雲端專案',
        showDelay: 400,
        pt: { root: 'toolbar-tooltip' },
      }"
      class="tool-btn"
      aria-label="存到雲端"
      :disabled="uploading"
      @click="saveToCloud"
    >
      <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <path
          d="M4.5 12.5h6a2.5 2.5 0 0 0 .3-4.98A3.5 3.5 0 0 0 4.2 6.6 2.95 2.95 0 0 0 4.5 12.5Z"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M8 10.5v-4m0 0L6.6 7.9M8 6.5l1.4 1.4"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <div
      v-tooltip.right="{
        value: statusTooltip,
        showDelay: 300,
        pt: { root: 'toolbar-tooltip' },
      }"
      class="document-status"
      :class="`is-${documentStore.saveState}`"
      aria-hidden="true"
    />

    <DocumentImportDialog
      v-model:visible="importDialogVisible"
      :loading="importInProgress"
      :error-message="importErrorMessage"
      @choose-file="chooseImportFile"
    />

    <input
      ref="fileInputRef"
      class="document-file-input"
      type="file"
      accept="application/json,.json"
      @change="onImportChange"
    />
  </div>
</template>
