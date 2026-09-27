<script setup lang="ts">
import Button from 'primevue/button'

withDefaults(
  defineProps<{
    secondaryLabel: string
    primaryLabel: string
    /** 主要動作進行中：主要按鈕顯示 loading（PrimeVue 會一併 disable），次要按鈕停用。 */
    loading?: boolean
  }>(),
  {
    loading: false,
  },
)

const emit = defineEmits<{
  secondary: []
  primary: []
}>()
</script>

<template>
  <!-- 不包外層容器：排列與間距沿用 PrimeVue Dialog footer 本身的 flex 設定。 -->
  <Button
    :label="secondaryLabel"
    severity="secondary"
    :disabled="loading"
    @click="emit('secondary')"
  />
  <Button :label="primaryLabel" :loading="loading" @click="emit('primary')" />
</template>
