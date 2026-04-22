<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import Popover from 'primevue/popover'
import { useToolStore } from '@/store/tool'
import DocumentActions from './DocumentActions.vue'
import {
  TOOL_GROUPS,
  ToolGroup,
  ToolType,
  type ToolDef,
  type ShortcutKey,
  TYPING_TAGS,
  getActiveTool,
} from '@/types/tool'

// ── Store ─────────────────────────────────────────────────────────────────────

const toolStore = useToolStore()

// ── OS 偵測（快捷鍵 Badge 顯示 ⌘ 或 Ctrl）─────────────────────────────────────

const isMac = (() => {
  const uad = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData
  if (uad?.platform) return uad.platform.toLowerCase().includes('mac')
  return navigator.platform.toUpperCase().startsWith('MAC')
})()

// ── 工具群組清單 ──────────────────────────────────────────────────────────────

interface GroupEntry {
  group: ToolGroup
  tools: ToolDef[]
}

const groups: GroupEntry[] = (Object.entries(TOOL_GROUPS) as [ToolGroup, ToolDef[]][]).map(
  ([group, tools]) => ({ group, tools }),
)

/**
 * 每個群組當前顯示的主工具（computed 快取，避免模板三次 find()）。
 * 複用 getActiveTool，確保與 store.activateGroup 邏輯完全一致。
 */
const activeToolPerGroup = computed<Record<ToolGroup, ToolDef>>(() => {
  const sub = toolStore.activeSubTools
  return Object.fromEntries(
    groups.map(({ group }) => [group, getActiveTool(sub, group)]),
  ) as Record<ToolGroup, ToolDef>
})

// ── Popover 子工具下拉（單一實例，動態切換內容）──────────────────────────────

const popoverRef = ref<InstanceType<typeof Popover>>()
const popoverTools = ref<ToolDef[]>([])
const popoverGroup = ref<ToolGroup | null>(null)

/**
 * 切換邏輯：
 *  - 同群組再次點擊 → 關閉（onPopoverHide 會無條件清空 popoverGroup）
 *  - 切換到新群組 → 先清空狀態、hide 舊 Popover，nextTick 後再以新內容 show
 *    （自行清空 popoverGroup，不依賴 onPopoverHide 的非同步時序）
 */
async function toggleDropdown(group: ToolGroup, event: MouseEvent): Promise<void> {
  event.stopPropagation()

  // 修正：anchor 加 fallback，防止 .btn-row 不存在時傳入 null 造成 PrimeVue 內部錯誤
  const anchor =
    ((event.currentTarget as HTMLElement).closest('.btn-row') as HTMLElement) ??
    (event.currentTarget as HTMLElement)

  if (popoverGroup.value === group) {
    // 同群組 → 關閉；onPopoverHide 負責清空 popoverGroup
    popoverRef.value?.hide()
    return
  }

  if (popoverGroup.value !== null) {
    // 切換群組：自行清空（不等 onPopoverHide），避免狀態被非同步覆蓋
    popoverGroup.value = null
    popoverRef.value?.hide()
    await nextTick()
  }

  popoverTools.value = TOOL_GROUPS[group]
  popoverGroup.value = group
  popoverRef.value?.show(event, anchor)
}

/**
 * 修正：無條件清空 popoverGroup。
 * popoverRef 在元件存活期間永遠非 falsy，舊的 !popoverRef.value 條件永遠不成立。
 */
function onPopoverHide(): void {
  popoverGroup.value = null
}

function selectSubTool(type: ToolType): void {
  toolStore.setTool(type)
  popoverRef.value?.hide()
}

// ── 樣板輔助 ──────────────────────────────────────────────────────────────────

function isGroupActive(group: ToolGroup): boolean {
  return TOOL_GROUPS[group].some((t) => t.type === toolStore.activeTool)
}

function buildShortcutLabel(sc: ShortcutKey): string {
  const ctrl = sc.ctrl ? (isMac ? '⌘' : 'Ctrl+') : ''
  const shift = sc.shift ? (isMac ? '⇧' : 'Shift+') : ''
  return ctrl + shift + sc.key.toUpperCase()
}

function tooltipValue(tool: ToolDef): string {
  const sc = tool.shortcuts[0]
  if (!sc) return tool.label
  return `${tool.label}  ${buildShortcutLabel(sc)}`
}

function shortcutBadge(tool: ToolDef): string {
  const sc = tool.shortcuts[0]
  return sc ? buildShortcutLabel(sc) : ''
}

// ── 鍵盤事件（document 層級，跟隨元件生命週期）───────────────────────────────

function onKeydown(e: KeyboardEvent): void {
  if (TYPING_TAGS.has((e.target as HTMLElement).tagName)) return
  toolStore.handleKeydown(e)
}

function onKeyup(e: KeyboardEvent): void {
  toolStore.handleKeyup(e)
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('keyup', onKeyup)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('keyup', onKeyup)
})
</script>

<template>
  <aside class="toolbar">
    <template v-for="(entry, index) in groups" :key="entry.group">
      <div class="tool-group">
        <div class="btn-row">
          <!-- 主工具按鈕 -->
          <button
            v-tooltip.right="{
              value: tooltipValue(activeToolPerGroup[entry.group]),
              showDelay: 400,
              pt: { root: 'toolbar-tooltip' },
            }"
            class="tool-btn"
            :class="{ active: isGroupActive(entry.group) }"
            @click="toolStore.activateGroup(entry.group)"
          >
            <!-- stroke 完全依賴 CSS currentColor，不 hardcode hex -->
            <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor">
              <path
                :d="activeToolPerGroup[entry.group].icon"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>

            <span v-if="shortcutBadge(activeToolPerGroup[entry.group])" class="shortcut-badge">
              {{ shortcutBadge(activeToolPerGroup[entry.group]) }}
            </span>
          </button>

          <!-- 展開箭頭（多子工具群組才顯示）
               修正：.stop.prevent 同時阻止冒泡與預設行為（防止 Space 觸發頁面捲動） -->
          <button
            v-if="entry.tools.length > 1"
            class="arrow-btn"
            :class="{ open: popoverGroup === entry.group }"
            :aria-label="`更多 ${entry.group} 工具`"
            @click="toggleDropdown(entry.group, $event)"
            @keydown.space.stop.prevent
          >
            <svg viewBox="0 0 8 8" width="8" height="8" fill="none">
              <path
                d="M1 2.5 L4 5.5 L7 2.5"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <!-- v-if 控制最後一組不渲染分隔線，
           取代 :last-child（Popover 佔最後一個 DOM 節點導致選取失效） -->
      <hr v-if="index < groups.length - 1" class="divider" />
    </template>

    <!-- PrimeVue Popover：單一實例，動態切換子工具內容 -->
    <Popover ref="popoverRef" :dismissable="true" class="toolbar-popover" @hide="onPopoverHide">
      <div class="dropdown" role="menu">
        <button
          v-for="tool in popoverTools"
          :key="tool.type"
          role="menuitem"
          class="dropdown-item"
          :class="{ active: toolStore.activeTool === tool.type }"
          v-tooltip.right="{
            value: tooltipValue(tool),
            showDelay: 400,
            pt: { root: 'toolbar-tooltip' },
          }"
          @click="selectSubTool(tool.type)"
        >
          <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor">
            <path
              :d="tool.icon"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="label">{{ tool.label }}</span>
          <span v-if="shortcutBadge(tool)" class="shortcut-badge">
            {{ shortcutBadge(tool) }}
          </span>
        </button>
      </div>
    </Popover>

    <DocumentActions />
  </aside>
</template>

<style src="./Toolbar.scss" lang="scss" />
