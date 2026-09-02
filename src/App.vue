<script setup lang="ts">
// 全域樣式留在這裡而不是搬進 EditorView：登入、註冊等頁面同樣需要它。
import '@/styles/global.scss'
import AppBootSplash from '@/components/app/AppBootSplash.vue'
import { useAuthStore } from '@/store/auth'

const auth = useAuthStore()
</script>

<template>
  <!--
    router guard 會 await bootstrap 才放行導航，在那之前 RouterView 什麼都不會
    渲染。冷啟動時那是一段最長 60 秒的白畫面，所以這裡先擋一層載入畫面。

    刻意不包 wrapper 元素：global.scss 的 .app-layout 以 #app 為定位基準，
    多一層 div 會改變高度計算。
  -->
  <AppBootSplash v-if="!auth.ready" />
  <RouterView v-else />
</template>
