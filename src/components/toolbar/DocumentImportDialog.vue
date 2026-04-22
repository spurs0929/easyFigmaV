<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'

const props = withDefaults(
  defineProps<{
    visible: boolean
    loading?: boolean
    errorMessage?: string
  }>(),
  {
    loading: false,
    errorMessage: '',
  },
)

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'choose-file': []
}>()

const visibleModel = computed({
  get: () => props.visible,
  set: (value: boolean) => {
    if (props.loading && !value) return
    emit('update:visible', value)
  },
})

function closeDialog(): void {
  if (props.loading) return
  visibleModel.value = false
}

function chooseFile(): void {
  emit('choose-file')
}
</script>

<template>
  <Dialog
    v-model:visible="visibleModel"
    modal
    header="匯入 JSON"
    class="document-import-dialog"
    :closable="!loading"
    :dismissable-mask="!loading"
    :draggable="false"
  >
    <div class="document-import-dialog__body">
      <p class="document-import-dialog__text">
        匯入 JSON 快照後，會直接取代目前的畫布與留言內容。
      </p>
      <p class="document-import-dialog__hint">
        請選擇從此工作區匯出的 `DocumentSnapshot` JSON 檔案。
      </p>
      <p
        v-if="errorMessage"
        class="document-import-dialog__error"
        role="alert"
      >
        {{ errorMessage }}
      </p>
    </div>

    <template #footer>
      <div class="document-import-dialog__footer">
        <Button
          label="取消"
          severity="secondary"
          :disabled="loading"
          @click="closeDialog"
        />
        <Button
          label="選擇 JSON 檔案"
          :loading="loading"
          @click="chooseFile"
        />
      </div>
    </template>
  </Dialog>
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

.document-import-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

:deep(.document-import-dialog) {
  width: min(30rem, calc(100vw - 2rem));
}

:deep(.document-import-dialog .p-dialog-content) {
  padding-top: 0.25rem;
}
</style>
