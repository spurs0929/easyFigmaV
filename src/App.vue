<script setup lang="ts">
// 全域樣式留在這裡而不是搬進 EditorView：登入、註冊等頁面同樣需要它。
import '@/styles/global.scss'
</script>

<template>
  <!--
    刻意不包任何 wrapper 元素。global.scss 的 .app-layout 大概率是以
    #app 為定位基準做滿版佈局，多一層 div 會改變高度計算。
  -->
  <RouterView />
</template>
