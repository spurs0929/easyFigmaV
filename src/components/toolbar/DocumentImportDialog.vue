<script setup lang="ts">
import AppDialog from '@/components/common/AppDialog.vue'
import DialogActions from '@/components/common/DialogActions.vue'

const props = withDefaults(
  defineProps<{
    loading?: boolean
    errorMessage?: string
    /**
     * 目前是不是雲端專案。由 caller 傳入，這個元件不自己讀 store。
     *
     * 兩種專案匯入的範圍不同：本機草稿的留言在快照裡，會一起被取代；雲端專案的留言
     * 是後端的獨立資源，匯入不會動到它，檔案裡的留言也不會變成雲端留言。
     */
    cloud?: boolean
  }>(),
  {
    loading: false,
    errorMessage: '',
    cloud: false,
  },
)

const visible = defineModel<boolean>('visible', { required: true })

const emit = defineEmits<{
  'choose-file': []
}>()

/**
 * 取消鈕直接改 visible，不經過 AppDialog 的攔截，所以這裡自己擋。
 * loading 中按鈕本來就是 disabled，這行是保險。
 */
function closeDialog(): void {
  if (props.loading) return
  visible.value = false
}

function chooseFile(): void {
  emit('choose-file')
}
</script>

<template>
  <AppDialog
    v-model:visible="visible"
    header="匯入 JSON"
    :busy="loading"
    dismissable-mask
    width="min(30rem, calc(100vw - 2rem))"
  >
    <div class="document-import-dialog__body">
      <p v-if="cloud" class="document-import-dialog__text">
        匯入 JSON
        快照後，會直接取代目前的畫布內容。雲端專案的留言不受影響，檔案裡的留言也不會被匯入。
      </p>
      <p v-else class="document-import-dialog__text">
        匯入 JSON 快照後，會直接取代目前的畫布與留言內容。
      </p>
      <p class="document-import-dialog__hint">
        請選擇從此工作區匯出的 `DocumentSnapshot` JSON 檔案。
      </p>
      <p v-if="errorMessage" class="document-import-dialog__error" role="alert">
        {{ errorMessage }}
      </p>
    </div>

    <template #footer>
      <DialogActions
        secondary-label="取消"
        primary-label="選擇 JSON 檔案"
        :loading="loading"
        @secondary="closeDialog"
        @primary="chooseFile"
      />
    </template>
  </AppDialog>
</template>

<style src="./DocumentImportDialog.scss" lang="scss"></style>
