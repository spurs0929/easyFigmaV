<script setup lang="ts">
import Button from 'primevue/button'
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <div class="notfound">
    <h1>404</h1>
    <p>找不到這個頁面。</p>
    <Button label="回到編輯器" @click="router.replace('/')" />
  </div>
</template>

<style src="./NotFoundView.scss" scoped lang="scss" />
