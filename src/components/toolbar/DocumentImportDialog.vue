<script setup lang="ts">
import AppDialog from '@/components/common/AppDialog.vue'
import DialogActions from '@/components/common/DialogActions.vue'

const props = withDefaults(
  defineProps<{
    loading?: boolean
    errorMessage?: string
  }>(),
  {
    loading: false,
    errorMessage: '',
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
      <p class="document-import-dialog__text">匯入 JSON 快照後，會直接取代目前的畫布與留言內容。</p>
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

<style scoped lang="scss">
.document-import-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.document-import-dialog__text,
.document-import-dialog__hint,
.document-import-dialog__error {
  margin: 0;
  line-height: 1.5;
}

.document-import-dialog__hint {
  color: #6b7280;
  font-size: 0.95rem;
}

.document-import-dialog__error {
  color: #ef4444;
  font-size: 0.95rem;
}
</style>
