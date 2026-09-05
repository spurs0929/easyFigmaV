<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Toolbar from '@/components/toolbar/Toolbar.vue'
import LayerPanel from '@/components/LayerPanel/LayerPanel.vue'
import CanvasArea from '@/components/canvas/canvas.vue'
import PropertiesPanel from '@/components/properties/PropertiesPanel.vue'
import DesktopOnlyNotice from '@/components/editor/DesktopOnlyNotice.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { createCloudDocumentBackend, localDocumentBackend } from '@/services/documentBackend'
import { useDocumentStore } from '@/store/document'

const route = useRoute()
const router = useRouter()
const documentStore = useDocumentStore()

// 一次取值而不是 computed：同一個元件實例同時只服務一個專案，
// 而 /p/a → /p/b 的元件重用由 App.vue 的 RouterView key 排除。
const projectId = typeof route.params.id === 'string' ? route.params.id : null

// 900px 是三個側邊面板加上可用畫布的下限。低於這個寬度不是「版面擠一點」，
// 而是根本沒有空間；觸控裝置還多了縮放手勢與畫布縮放衝突的問題。
// 顯示明確的說明，而不是讓版面破掉。
const isEditorSupported = useMediaQuery('(min-width: 900px)')

// 不論尺寸都啟動持久化：使用者可能從窄視窗拉寬，若在這裡加條件，
// 就要處理「拉寬之後才補啟動」的時序，徒增出錯機會。
// 未渲染畫布時這些 watcher 幾乎沒有成本。
onMounted(() => {
  void documentStore.startPersistence(
    projectId ? createCloudDocumentBackend(projectId) : localDocumentBackend,
  )
})

onUnmounted(() => {
  documentStore.stopPersistence()
})
</script>

<template>
  <div v-if="isEditorSupported" class="app-layout" @contextmenu.prevent>
    <Toolbar />
    <LayerPanel />
    <CanvasArea />
    <PropertiesPanel />
  </div>

  <DesktopOnlyNotice v-else />

  <!--
    衝突對話框刻意不可關閉，也刻意不提供「強制覆蓋」。
    強制覆蓋等於把樂觀鎖關掉，後端那段 compare-and-set 就失去意義了。
  -->
  <Dialog
    :visible="documentStore.saveState === 'conflict'"
    modal
    :closable="false"
    :close-on-escape="false"
    header="無法儲存"
    :style="{ width: 'min(420px, 92vw)' }"
  >
    <p>這個專案已在其他視窗被修改，目前的變更無法存回雲端。</p>
    <p>重新載入會取得最新版本，這個視窗尚未儲存的變更將會遺失。</p>
    <template #footer>
      <Button label="回到專案列表" text @click="router.push({ name: 'projects' })" />
      <Button label="重新載入" @click="documentStore.reloadFromBackend()" />
    </template>
  </Dialog>
</template>
