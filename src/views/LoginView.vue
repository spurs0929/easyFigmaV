<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Password from 'primevue/password'
import AuthShell from '@/components/auth/AuthShell.vue'
import { useAuthStore } from '@/store/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const email = ref('')
const password = ref('')

async function submit(): Promise<void> {
  if (!(await auth.login(email.value.trim(), password.value))) return

  const redirect = route.query.redirect
  await router.replace(typeof redirect === 'string' ? redirect : '/')
}
</script>

<template>
  <AuthShell title="登入" subtitle="登入後即可將專案儲存到雲端">
    <form class="auth-form" @submit.prevent="submit">
      <div class="auth-field">
        <label for="login-email">Email</label>
        <InputText
          id="login-email"
          v-model="email"
          type="email"
          autocomplete="email"
          required
          fluid
          @input="auth.clearError()"
        />
      </div>

      <div class="auth-field">
        <label for="login-password">密碼</label>
        <Password
          id="login-password"
          v-model="password"
          :feedback="false"
          toggle-mask
          autocomplete="current-password"
          required
          fluid
          @input="auth.clearError()"
        />
      </div>

      <Message v-if="auth.error" severity="error" :closable="false">
        {{ auth.error }}
      </Message>

      <Button type="submit" label="登入" :loading="auth.pending" fluid />
    </form>

    <template #footer>
      還沒有帳號？<RouterLink to="/register">註冊</RouterLink>
      <span class="auth-footer-divider">·</span>
      <RouterLink to="/">先不登入，直接使用</RouterLink>
    </template>
  </AuthShell>
</template>

<style src="./LoginView.scss" scoped lang="scss" />
