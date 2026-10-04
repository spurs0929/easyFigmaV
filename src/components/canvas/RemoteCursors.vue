<script setup lang="ts">
/**
 * RemoteCursors — 其他在線使用者的游標
 *
 * 純顯示：資料直接來自 presence store，這裡只做 world → 螢幕的換算。
 *
 * 用 DOM 覆疊層而不是 Konva layer：游標因此在結構上就不屬於畫布內容——
 * 不會被選取、變形或 hit-test 到，也不可能進到文件快照與 undo 歷史。
 * 定位方式與 CommentOverlay 相同（Teleport 到 body、以 canvasRect 對齊 Stage、
 * overflow: hidden 裁切），但兩者各自獨立：留言有互動與自己的生命週期，
 * 游標沒有。
 */
import { computed } from 'vue'
import { useAuthStore } from '@/store/auth'
import { usePresenceStore } from '@/store/presence'
import type { Viewport } from '@/store/viewport'

const props = defineProps<{
  /** 目前畫布的 viewport（scale / x / y），用於世界座標 → 螢幕座標轉換。 */
  viewport: Viewport
  /** 畫布容器相對瀏覽器視窗的位置與尺寸，與 CommentOverlay 共用同一份。 */
  canvasRect: {
    left: number
    top: number
    width: number
    height: number
  }
}>()

const UNNAMED_USER = '未命名使用者'
/** 色相的數量。相鄰色相差 30°，兩個人撞色時仍然有名字可以分辨。 */
const HUE_STEPS = 12

const auth = useAuthStore()
const presence = usePresenceStore()

/**
 * 由 user_id 決定顏色：同一個人在每個人的畫面上、每次連線都是同一個顏色，
 * 不需要 server 分配，也不需要保存。
 */
function colorOf(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  }
  return `hsl(${(hash % HUE_STEPS) * (360 / HUE_STEPS)} 85% 60%)`
}

const cursors = computed(() => {
  const { x: offsetX, y: offsetY, scale } = props.viewport
  const visible = []
  // 以名單為主體：游標一定屬於某個在線的人，名字也從名單來。
  for (const user of presence.users) {
    // server 不會把自己的游標送回來（包含自己的其他分頁）；這裡再擋一次，
    // 畫面上出現第二個自己的游標比少畫一個更令人困惑。
    if (user.user_id === auth.user?.id) continue
    const point = presence.cursors.get(user.user_id)
    if (!point) continue
    visible.push({
      userId: user.user_id,
      name: user.display_name?.trim() || UNNAMED_USER,
      color: colorOf(user.user_id),
      // world → 覆疊層內的座標。viewport 是 reactive 的，自己 pan / zoom 時
      // 別人的游標會跟著畫布一起移動，仍然指著同一個 world 位置。
      x: point.x * scale + offsetX,
      y: point.y * scale + offsetY,
    })
  }
  return visible
})
</script>

<template>
  <Teleport to="body">
    <!-- 純裝飾：游標位置對輔助技術沒有意義，誰在線已經由 PresenceMembers 表達 -->
    <div
      class="remote-cursors"
      aria-hidden="true"
      :style="{
        left: `${canvasRect.left}px`,
        top: `${canvasRect.top}px`,
        width: `${canvasRect.width}px`,
        height: `${canvasRect.height}px`,
      }"
    >
      <div
        v-for="cursor in cursors"
        :key="cursor.userId"
        class="remote-cursor"
        :style="{
          transform: `translate(${cursor.x}px, ${cursor.y}px)`,
          '--cursor-color': cursor.color,
        }"
        data-testid="remote-cursor"
      >
        <!-- 箭頭尖端在 (0, 0)，也就是對方游標實際指的位置 -->
        <svg class="remote-cursor__arrow" width="16" height="20" viewBox="0 0 16 20" fill="none">
          <path
            d="M1 1L1 16L5 12.2L7.8 18.6L10.4 17.5L7.6 11.2L13 11.2L1 1Z"
            stroke="#1e1e1e"
            stroke-width="1"
            stroke-linejoin="round"
          />
        </svg>
        <span class="remote-cursor__label">{{ cursor.name }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style src="./RemoteCursors.scss" lang="scss"></style>
