<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Password from 'primevue/password'
import AuthShell from '@/components/auth/AuthShell.vue'
import { useAuthStore } from '@/store/auth'

const auth = useAuthStore()
const router = useRouter()

// 錯誤訊息存在 store 裡而 store 是單例，離開頁面不會自動清除。
onMounted(() => auth.clearError())

const email = ref('')
const password = ref('')
const displayName = ref('')

// 與後端的 RegisterRequest 一致：8 到 128 字元。
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128

const passwordHint = computed(() => {
  if (!password.value) return `至少 ${MIN_PASSWORD_LENGTH} 個字元`
  if (password.value.length < MIN_PASSWORD_LENGTH) {
    return `還差 ${MIN_PASSWORD_LENGTH - password.value.length} 個字元`
  }
  return ''
})

const canSubmit = computed(
  () =>
    email.value.trim().length > 0 &&
    password.value.length >= MIN_PASSWORD_LENGTH &&
    password.value.length <= MAX_PASSWORD_LENGTH,
)

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  const created = await auth.register(email.value.trim(), password.value, displayName.value.trim())
  if (created) await router.replace('/')
}
</script>

<template>
  <AuthShell title="註冊" subtitle="建立帳號以在多個裝置間同步專案">
    <form class="auth-form" @submit.prevent="submit">
      <div class="auth-field">
        <label for="register-email">Email</label>
        <InputText
          id="register-email"
          v-model="email"
          type="email"
          autocomplete="email"
          required
          fluid
          @input="auth.clearError()"
        />
      </div>

      <div class="auth-field">
        <label for="register-password">密碼</label>
        <Password
          id="register-password"
          v-model="password"
          :feedback="false"
          toggle-mask
          autocomplete="new-password"
          required
          fluid
          @input="auth.clearError()"
        />
        <small v-if="passwordHint" class="auth-hint">{{ passwordHint }}</small>
      </div>

      <div class="auth-field">
        <label for="register-name">顯示名稱<span class="auth-optional">（選填）</span></label>
        <InputText
          id="register-name"
          v-model="displayName"
          maxlength="80"
          autocomplete="nickname"
          fluid
        />
        <small class="auth-hint">留空則使用 Email 的前綴。這是其他協作者會看到的名稱。</small>
      </div>

      <Message v-if="auth.error" severity="error" :closable="false">
        {{ auth.error }}
      </Message>

      <Button type="submit" label="建立帳號" :loading="auth.pending" :disabled="!canSubmit" fluid />
    </form>

    <template #footer> 已經有帳號了？<RouterLink to="/login">登入</RouterLink> </template>
  </AuthShell>
</template>

<style src="./RegisterView.scss" scoped lang="scss" />
