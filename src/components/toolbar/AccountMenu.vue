<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import { useRouter } from 'vue-router'
import Popover from 'primevue/popover'
import { useAuthStore } from '@/store/auth'

const auth = useAuthStore()
const router = useRouter()
const popoverRef = useTemplateRef<InstanceType<typeof Popover>>('popover')
const loggingOut = ref(false)

const initial = computed(() => (auth.displayName.trim()[0] ?? '?').toUpperCase())

function togglePopover(event: Event): void {
  popoverRef.value?.toggle(event)
}

async function goLogin(): Promise<void> {
  await router.push({ name: 'login' })
}

async function goProjects(): Promise<void> {
  popoverRef.value?.hide()
  await router.push({ name: 'projects' })
}

async function handleLogout(): Promise<void> {
  loggingOut.value = true
  try {
    await auth.logout()
  } finally {
    loggingOut.value = false
    popoverRef.value?.hide()
  }
}
</script>

<template>
  <!-- 等 bootstrap 完成再渲染，否則已登入的使用者會先看到一瞬間的「登入」圖示 -->
  <div v-if="auth.ready" class="account-menu">
    <hr class="divider" />

    <button
      v-if="!auth.isAuthenticated"
      v-tooltip.right="{ value: '登入或註冊', showDelay: 400, pt: { root: 'toolbar-tooltip' } }"
      class="tool-btn"
      aria-label="登入或註冊"
      @click="goLogin"
    >
      <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <path
          d="M8 8.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM3 13.5c0-2.2 2.2-3.5 5-3.5s5 1.3 5 3.5"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <button
      v-else
      v-tooltip.right="{ value: auth.displayName, showDelay: 400, pt: { root: 'toolbar-tooltip' } }"
      class="tool-btn account-btn"
      :aria-label="`帳號：${auth.displayName}`"
      @click="togglePopover"
    >
      <span class="account-avatar">{{ initial }}</span>
    </button>

    <Popover ref="popover" :dismissable="true" class="toolbar-popover">
      <div class="account-panel">
        <p class="account-name">{{ auth.displayName }}</p>
        <p v-if="auth.user?.email" class="account-email">{{ auth.user.email }}</p>

        <p v-if="auth.error" class="account-error">{{ auth.error }}</p>

        <button class="account-action" @click="goProjects">我的專案</button>

        <button class="account-action" :disabled="loggingOut" @click="handleLogout">
          {{ loggingOut ? '登出中…' : '登出' }}
        </button>
      </div>
    </Popover>
  </div>
</template>

<style src="./AccountMenu.scss" scoped lang="scss" />
