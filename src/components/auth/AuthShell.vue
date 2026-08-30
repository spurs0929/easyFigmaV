<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<template>
  <div class="auth-shell">
    <div class="auth-card">
      <header class="auth-header">
        <h1>{{ title }}</h1>
        <p v-if="subtitle">{{ subtitle }}</p>
      </header>

      <slot />

      <footer class="auth-footer">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<style src="./AuthShell.scss" scoped lang="scss" />
