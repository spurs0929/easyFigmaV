<script setup lang="ts">
import { onUnmounted, ref } from 'vue'

// Render 免費方案閒置後會 spin down，冷啟動可能需要數十秒。
// 載入時間較長時顯示提示，避免使用者誤以為應用程式無回應。
const SLOW_HINT_DELAY_MS = 5000

const showSlowHint = ref(false)
const timer = setTimeout(() => {
  showSlowHint.value = true
}, SLOW_HINT_DELAY_MS)

onUnmounted(() => clearTimeout(timer))
</script>

<template>
  <div class="boot-splash" role="status" aria-live="polite">
    <div class="boot-splash-inner">
      <span class="boot-splash-spinner" aria-hidden="true" />
      <p class="boot-splash-label">載入中</p>
      <p v-if="showSlowHint" class="boot-splash-hint">
        伺服器正在啟動，首次連線可能需要 30 至 60 秒。
      </p>
    </div>
  </div>
</template>

<style src="./AppBootSplash.scss" scoped lang="scss" />
