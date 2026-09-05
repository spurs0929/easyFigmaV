<script setup lang="ts">
// 全域樣式留在這裡而不是搬進 EditorView：登入、註冊等頁面同樣需要它。
import '@/styles/global.scss'
import AppBootSplash from '@/components/app/AppBootSplash.vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { useAuthStore } from '@/store/auth'

const auth = useAuthStore()

/**
 * 決定 route component 的 identity。
 *
 * 預設情況下 Vue Router 會重用同一個元件實例，/p/a → /p/b 因此不會重新
 * onMounted，持久化目標會停在前一個專案。只有這種「同元件不同參數」需要
 * 強制重建，所以 key 綁在專案 id 上，而不是整條 path——用 path 的話，
 * 之後加巢狀路由（例如 /account/profile → /account/security）會連帶
 * 重建共用的父層元件。
 */
function viewKey(route: RouteLocationNormalizedLoaded): string {
  if (route.name === 'project') return `project:${String(route.params.id)}`
  return String(route.name ?? route.path)
}
</script>

<template>
  <!--
    router guard 會 await bootstrap 才放行導航，在那之前 RouterView 什麼都不會
    渲染。冷啟動時那是一段最長 60 秒的白畫面，所以這裡先擋一層載入畫面。

    刻意不包 wrapper 元素：global.scss 的 .app-layout 以 #app 為定位基準，
    多一層 div 會改變高度計算。
  -->
  <AppBootSplash v-if="!auth.ready" />
  <RouterView v-else v-slot="{ Component, route }">
    <component :is="Component" :key="viewKey(route)" />
  </RouterView>
</template>
