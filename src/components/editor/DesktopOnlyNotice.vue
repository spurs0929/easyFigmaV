<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Message from 'primevue/message'
import { useAuthStore } from '@/store/auth'

const router = useRouter()
const auth = useAuthStore()
const loggingOut = ref(false)

function goToLogin(): void {
  void router.push({ name: 'login' })
}

function goToProjects(): void {
  void router.push({ name: 'projects' })
}

// 登出後刻意不導頁，與桌面版 Toolbar 的行為一致。
async function handleLogout(): Promise<void> {
  loggingOut.value = true
  try {
    await auth.logout()
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <!-- router guard 已 await bootstrap，此處 auth 狀態必定已就緒，不會閃 guest UI。 -->
  <div class="desktop-only">
    <div class="desktop-only-inner">
      <h1>請用電腦開啟編輯器</h1>
      <p>畫布的縮放、拖曳與控制點操作需要滑鼠與較大的螢幕，目前尚未支援觸控裝置。</p>

      <!-- 觸控裝置沒有 Toolbar，因此已登入使用者仍需保留出口。 -->
      <template v-if="auth.isAuthenticated">
        <p class="desktop-only-sub">目前登入身分：{{ auth.displayName }}</p>

        <Message v-if="auth.error" severity="error" :closable="false">
          {{ auth.error }}
        </Message>

        <Button label="查看我的專案" outlined @click="goToProjects" />

        <Button
          label="登出"
          severity="secondary"
          text
          :loading="loggingOut"
          @click="handleLogout"
        />
      </template>

      <template v-else>
        <p class="desktop-only-sub">帳號相關的功能在觸控裝置上可以正常使用。</p>
        <Button label="登入 / 註冊" outlined @click="goToLogin" />
      </template>
    </div>
  </div>
</template>

<style src="./DesktopOnlyNotice.scss" scoped lang="scss" />
