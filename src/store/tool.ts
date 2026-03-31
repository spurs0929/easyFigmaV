import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  ToolType,
  ToolGroup,
  type ToolDef,
  type ActiveSubTools,
  TOOL_GROUPS,
  matchShortcut,
  getActiveTool,
} from '@/types/tool'

// ── O(1) 查找表（模組載入時建立一次） ──────────────────────────────────────────

const TOOL_BY_TYPE = new Map<ToolType, ToolDef>()
const GROUP_BY_TYPE = new Map<ToolType, ToolGroup>()
const TOOLS_IN_GROUP = new Map<ToolGroup, ToolDef[]>()

for (const [group, tools] of Object.entries(TOOL_GROUPS) as [ToolGroup, ToolDef[]][]) {
  TOOLS_IN_GROUP.set(group, tools)
  for (const tool of tools) {
    TOOL_BY_TYPE.set(tool.type, tool)
    GROUP_BY_TYPE.set(tool.type, group)
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useToolStore = defineStore('tool', () => {
  /**
   * 工具堆疊：頂端為當前啟用工具。
   * 最底層永遠是「基礎工具」（使用者主動選擇）；
   * 上層是暫時覆蓋（例如按住 Space 切換到 Hand）。
   */
  const _toolStack = ref<ToolType[]>([ToolType.Move])

  /** 各群組記憶的最後使用工具 */
  const _activeSubTools = ref<ActiveSubTools>({
    [ToolGroup.Move]: ToolType.Move,
    [ToolGroup.Region]: ToolType.RegionSelect,
    [ToolGroup.Shape]: ToolType.Rect,
    [ToolGroup.Creation]: ToolType.Frame,
    [ToolGroup.Text]: ToolType.Text,
    [ToolGroup.Comment]: ToolType.Comment,
    [ToolGroup.Hand]: ToolType.Hand,
  })

  // ── 計算屬性 ──────────────────────────────────────────────────────────────

  /**
   * 當前啟用的工具類型（堆疊頂端）。
   * 使用 .at(-1) 防禦堆疊意外清空，回退至預設的 Move。
   */
  const activeTool = computed<ToolType>(() => _toolStack.value.at(-1) ?? ToolType.Move)

  /**
   * 當前啟用工具的完整定義（O(1)）。
   * _toolStack 只存合法 ToolType，TOOL_BY_TYPE 涵蓋所有類型，
   * ! 斷言安全；setTool 入口有 runtime 防禦確保不會存入非法值。
   */
  const activeToolDef = computed<ToolDef>(() => TOOL_BY_TYPE.get(activeTool.value)!)

  /** 畫布 CSS cursor（供 canvas 元素直接綁定） */
  const cursor = computed(() => activeToolDef.value.cursor)

  /** 各群組子工具狀態（唯讀對外公開） */
  const activeSubTools = computed(() => _activeSubTools.value)

  // ── 公開 API ──────────────────────────────────────────────────────────────

  /**
   * 永久切換工具（取代堆疊底層，保留上方的暫時覆蓋）。
   * 入口 runtime 防禦：確保只存入查找表中有記錄的合法 ToolType。
   */
  function setTool(type: ToolType): void {
    if (!TOOL_BY_TYPE.has(type)) {
      console.warn(`[useToolStore] 嘗試切換至未知工具類型：${type}，操作被忽略。`)
      return
    }
    _toolStack.value = [type, ..._toolStack.value.slice(1)]
    _persistSubTool(type)
  }

  /** 點擊工具群組圖示：啟用該群組最後使用的子工具 */
  function activateGroup(group: ToolGroup): void {
    setTool(getActiveTool(_activeSubTools.value, group).type)
  }

  // ── 鍵盤事件處理 ─────────────────────────────────────────────────────────

  function handleKeydown(event: KeyboardEvent): void {
    // Space → 暫時切換到 Hand（不影響底層基礎工具）
    // 修正：檢查堆疊頂端而非 activeTool，防止快速雙按 Space 導致 Hand 被 push 兩次
    if (event.code === 'Space' && !event.repeat) {
      if (_toolStack.value.at(-1) !== ToolType.Hand) {
        _pushTemporary(ToolType.Hand)
      }
      event.preventDefault()
      return
    }

    const matched = matchShortcut(event, TOOL_GROUPS)
    if (matched.length === 0) return

    event.preventDefault()

    const currentTool = activeTool.value
    const currentGroup = GROUP_BY_TYPE.get(currentTool)
    const firstMatch = matched[0]
    const matchedGroup = GROUP_BY_TYPE.get(firstMatch.type)

    // 同群組、已是當前工具 → 在相同快捷鍵的工具之間循環切換
    // 修正：使用 matchShortcut 回傳的完整清單（ToolDef[]）做循環，
    //       而非重新過濾，確保循環邏輯與匹配邏輯一致。
    if (
      currentGroup &&
      matchedGroup &&
      currentGroup === matchedGroup &&
      firstMatch.type === currentTool &&
      matched.length > 1
    ) {
      const idx = matched.findIndex((t) => t.type === currentTool)
      setTool(matched[(idx + 1) % matched.length].type)
    } else {
      setTool(firstMatch.type)
    }
  }

  function handleKeyup(event: KeyboardEvent): void {
    // 放開 Space → 彈出暫時的 Hand 工具
    if (event.code === 'Space') {
      _popTemporary(ToolType.Hand)
    }
  }

  // ── 私有輔助 ──────────────────────────────────────────────────────────────

  function _pushTemporary(type: ToolType): void {
    _toolStack.value = [..._toolStack.value, type]
  }

  function _popTemporary(type: ToolType): void {
    const stack = _toolStack.value
    if (stack.length > 1 && stack.at(-1) === type) {
      _toolStack.value = stack.slice(0, -1)
    }
  }

  function _persistSubTool(type: ToolType): void {
    const group = GROUP_BY_TYPE.get(type)
    if (group) {
      // 直接 mutate Proxy：避免 spread 產生新物件，對低頻操作無差異，
      // 但為未來高頻場景保留彈性。
      _activeSubTools.value[group] = type
    }
  }

  return {
    activeTool,
    activeToolDef,
    cursor,
    activeSubTools,
    setTool,
    activateGroup,
    handleKeydown,
    handleKeyup,
  }
})
