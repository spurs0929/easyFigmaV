<script setup lang="ts">
import { computed } from 'vue'

/**
 * 使用者縮寫頭像：圓形、固定尺寸、名字的第一個字。
 *
 * 只負責幾何與字體。背景色、外框等依情境不同的外觀由呼叫端用 class 決定
 * （scoped style 會套到子元件的 root），不做成 prop。
 */
const props = defineProps<{
  name: string
}>()

// Array.from 以 code point 切字：emoji 等 surrogate pair 不會被切成半個字元。
const initial = computed(() => (Array.from(props.name.trim())[0] ?? '?').toUpperCase())
</script>

<template>
  <span class="user-avatar">{{ initial }}</span>
</template>

<style scoped lang="scss">
.user-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: #e8e8e8;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}
</style>
