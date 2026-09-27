<script setup lang="ts">
import Button from 'primevue/button'

defineProps<{
  secondaryLabel: string
  primaryLabel: string
}>()

const emit = defineEmits<{
  secondary: []
  primary: []
}>()
</script>

<template>
  <!-- 不包外層容器：排列與間距沿用 PrimeVue Dialog footer 本身的 flex 設定。 -->
  <Button :label="secondaryLabel" severity="secondary" @click="emit('secondary')" />
  <Button :label="primaryLabel" @click="emit('primary')" />
</template>
