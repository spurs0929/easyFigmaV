<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Toolbar from '@/components/toolbar/EditorToolbar.vue'
import LayerPanel from '@/components/LayerPanel/LayerPanel.vue'
import CanvasArea from '@/components/canvas/CanvasArea.vue'
import PropertiesPanel from '@/components/properties/PropertiesPanel.vue'
import DesktopOnlyNotice from '@/components/editor/DesktopOnlyNotice.vue'
import AppDialog from '@/components/common/AppDialog.vue'
import DialogActions from '@/components/common/DialogActions.vue'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { createCloudDocumentBackend, localDocumentBackend } from '@/services/documentBackend'
import { useCommentStore } from '@/store/comment'
import { useDocumentStore } from '@/store/document'
import { usePresenceStore } from '@/store/presence'

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

const presenceStore = usePresenceStore()
const commentStore = useCommentStore()
let unmounted = false

// 不論尺寸都啟動持久化：使用者可能從窄視窗拉寬，若在這裡加條件，
// 就要處理「拉寬之後才補啟動」的時序，徒增出錯機會。
// 未渲染畫布時這些 watcher 幾乎沒有成本。
onMounted(async () => {
  if (!projectId) {
    // 本機草稿沒有「其他人」，不建立 presence 連線。
    void documentStore.startPersistence(localDocumentBackend)
    return
  }

  // presence 等專案成功載入才連：專案不存在、沒有權限或內容壞掉時，
  // 開一條註定被 4404 拒絕的 socket 沒有意義。
  const loaded = await documentStore.startPersistence(createCloudDocumentBackend(projectId))
  if (!loaded || unmounted) return

  presenceStore.connect(projectId)
  // 留言是專案底下的獨立資源，不跟著 document 一起回來，要自己載入。
  // 與 presence 同一個時機、同一個理由：文件載入成功才代表專案存在而且有權限。
  // 不 await：留言載入失敗不該擋住編輯器，錯誤由 comment store 自己呈現。
  void commentStore.load(projectId)
})

onUnmounted(() => {
  unmounted = true
  // 留言不需要另外清：stopPersistence 離開雲端時會把 comment store 換回本機來源，
  // 那一步會清掉雲端留言並讓飛行中的留言請求作廢。
  documentStore.stopPersistence()
  if (projectId) presenceStore.disconnect()
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
  <AppDialog
    :visible="documentStore.saveState === 'conflict'"
    :dismissible="false"
    header="無法儲存"
  >
    <p>這個專案已在其他視窗被修改，目前的變更無法存回雲端。</p>
    <p>重新載入會取得最新版本，這個視窗尚未儲存的變更將會遺失。</p>
    <template #footer>
      <DialogActions
        secondary-label="回到專案列表"
        primary-label="重新載入"
        @secondary="router.push({ name: 'projects' })"
        @primary="documentStore.reloadFromBackend()"
      />
    </template>
  </AppDialog>
</template>
