<script setup lang="ts">
import Button from 'primevue/button'
import { useAuthStore } from '@/store/auth'

const emit = defineEmits<{
  /** 登入成功。導向哪裡由各頁面決定（登入頁要回 redirect，註冊頁回首頁）。 */
  'signed-in': []
}>()

const auth = useAuthStore()

async function signIn(): Promise<void> {
  if (await auth.loginWithGoogle()) emit('signed-in')
}
</script>

<template>
  <div class="google-sign-in">
    <Button
      type="button"
      severity="secondary"
      :loading="auth.pending"
      fluid
      aria-label="使用 Google 帳號登入"
      @click="signIn"
    >
      <svg class="google-logo" viewBox="0 0 48 48" aria-hidden="true">
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
      <span>使用 Google 登入</span>
    </Button>

    <div class="auth-divider" role="separator"><span>或使用 Email</span></div>
  </div>
</template>

<style scoped lang="scss">
.google-sign-in {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 16px;
}

.google-logo {
  width: 18px;
  height: 18px;
  margin-right: 8px;
}

// 不叫 .divider：EditorToolbar.scss 有一個全域的 .divider（寬 24px 的工具列分隔線），
// 先開過編輯器再進登入頁時會套到這裡，把整條分隔線縮成 24px 寬。
.auth-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: #6a6a6a;

  &::before,
  &::after {
    content: '';
    flex: 1;
    height: 1px;
    background: #2a2a2a;
  }

  span {
    flex-shrink: 0;
    white-space: nowrap;
  }
}
</style>
