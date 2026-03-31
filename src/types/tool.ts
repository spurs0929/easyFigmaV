// ── 工具類型 ──────────────────────────────────────────────────────────────────

export enum ToolType {
  // 移動群組
  Move         = 'move',
  Scale        = 'scale',
  // 區域群組
  RegionSelect = 'region-select',
  // 形狀群組
  Rect         = 'rect',
  Ellipse      = 'ellipse',
  Line         = 'line',
  Polygon      = 'polygon',
  // 建立群組
  Frame        = 'frame',
  Pen          = 'pen',
  Slice        = 'slice',
  Component    = 'component',
  // 文字群組
  Text         = 'text',
  // 評論群組
  Comment      = 'comment',
  // 手形群組
  Hand         = 'hand',
}

export enum ToolGroup {
  Move     = 'move',
  Region   = 'region',
  Shape    = 'shape',
  Creation = 'creation',
  Text     = 'text',
  Comment  = 'comment',
  Hand     = 'hand',
}

// ── 快捷鍵定義 ────────────────────────────────────────────────────────────────

export interface ShortcutKey {
  key: string
  /** 明確設為 true 才檢查 Shift 狀態；undefined 表示「不在意 Shift」 */
  shift?: boolean
  /** 明確設為 true 才檢查 Ctrl/Cmd 狀態；undefined 表示「不在意 Ctrl」 */
  ctrl?: boolean
}

// ── 工具定義 ──────────────────────────────────────────────────────────────────

export interface ToolDef {
  type: ToolType
  label: string
  shortcuts: ShortcutKey[]
  group: ToolGroup
  /** SVG path d 屬性字串 */
  icon: string
  /** 畫布上的 CSS cursor 值 */
  cursor: string
}

// ── 工具群組與定義 ────────────────────────────────────────────────────────────

export const TOOL_GROUPS: Record<ToolGroup, ToolDef[]> = {
  [ToolGroup.Move]: [
    {
      type: ToolType.Move, label: 'Move', group: ToolGroup.Move,
      shortcuts: [{ key: 'v' }],
      icon: 'M0,0 L0,14 L3.5,10.5 L6,16 L8,15 L5.5,9 L10,9 Z',
      cursor: 'default',
    },
    {
      type: ToolType.Scale, label: 'Scale', group: ToolGroup.Move,
      // 修正：明確標記 ctrl: false，避免與 Component 的 Ctrl+K 發生匹配歧義
      shortcuts: [{ key: 'k', ctrl: false }],
      icon: 'M0,0 L6,0 L6,1.5 L1.5,1.5 L1.5,6 L0,6 Z M10,10 L10,16 L4,16 L4,14.5 L8.5,14.5 L8.5,10 Z',
      cursor: 'nwse-resize',
    },
  ],
  [ToolGroup.Region]: [
    {
      type: ToolType.RegionSelect, label: 'Region Select', group: ToolGroup.Region,
      /** 無快捷鍵（刻意留空，避免與繪圖工具衝突） */
      shortcuts: [],
      icon: 'M1,1 L7,1 L7,2.5 L2.5,2.5 L2.5,7 L1,7 Z M9,9 L15,9 L15,15 L9,15 Z',
      cursor: 'crosshair',
    },
  ],
  [ToolGroup.Shape]: [
    {
      type: ToolType.Rect, label: 'Rectangle', group: ToolGroup.Shape,
      shortcuts: [{ key: 'r' }],
      icon: 'M1,1 H15 V15 H1 Z',
      cursor: 'crosshair',
    },
    {
      type: ToolType.Ellipse, label: 'Ellipse', group: ToolGroup.Shape,
      shortcuts: [{ key: 'o' }],
      // 修正：使用兩段半圓弧，避免起終點相同導致的跨瀏覽器渲染不一致問題
      icon: 'M8,1 A7,7 0 1,0 8,15 A7,7 0 1,0 8,1 Z',
      cursor: 'crosshair',
    },
    {
      type: ToolType.Line, label: 'Line', group: ToolGroup.Shape,
      shortcuts: [{ key: 'l' }],
      icon: 'M2,14 L14,2',
      cursor: 'crosshair',
    },
    {
      type: ToolType.Polygon, label: 'Polygon', group: ToolGroup.Shape,
      /** 無快捷鍵（刻意留空，待後續版本規劃） */
      shortcuts: [],
      icon: 'M8,1 L15,6 L12,14 L4,14 L1,6 Z',
      cursor: 'crosshair',
    },
  ],
  [ToolGroup.Creation]: [
    {
      type: ToolType.Frame, label: 'Frame', group: ToolGroup.Creation,
      shortcuts: [{ key: 'f' }],
      icon: 'M1,4 L4,4 L4,1 M12,1 L15,1 L15,4 M15,12 L15,15 L12,15 M4,15 L1,15 L1,12',
      cursor: 'crosshair',
    },
    {
      type: ToolType.Pen, label: 'Pen', group: ToolGroup.Creation,
      shortcuts: [{ key: 'p' }],
      icon: 'M2,14 Q4,10 8,8 Q12,6 14,2 L12,4 Q10,8 6,10 Z',
      cursor: 'crosshair',
    },
    {
      type: ToolType.Slice, label: 'Slice', group: ToolGroup.Creation,
      shortcuts: [{ key: 's' }],
      icon: 'M1,1 L15,15 M1,8 L8,1 M8,15 L15,8',
      cursor: 'crosshair',
    },
    {
      type: ToolType.Component, label: 'Component', group: ToolGroup.Creation,
      shortcuts: [{ key: 'k', ctrl: true }],
      icon: 'M8,1 L15,8 L8,15 L1,8 Z',
      cursor: 'default',
    },
  ],
  [ToolGroup.Text]: [
    {
      type: ToolType.Text, label: 'Text', group: ToolGroup.Text,
      shortcuts: [{ key: 't' }],
      icon: 'M1,2 H15 M8,2 V14 M5,14 H11',
      cursor: 'text',
    },
  ],
  [ToolGroup.Comment]: [
    {
      type: ToolType.Comment, label: 'Comment', group: ToolGroup.Comment,
      shortcuts: [{ key: 'c' }],
      icon: 'M2,2 H14 V10 H8 L5,14 L5,10 H2 Z',
      cursor: 'default',
    },
  ],
  [ToolGroup.Hand]: [
    {
      type: ToolType.Hand, label: 'Hand', group: ToolGroup.Hand,
      shortcuts: [{ key: 'h' }],
      icon: 'M7,1 V8 M10,3 V8 M13,5 V8 M4,6 V8 L1,12 Q1,15 5,15 H11 Q15,15 15,11 V8 L13,8 L10,8 L7,8',
      cursor: 'grab',
    },
  ],
}

// ── 子工具狀態（各群組記憶最後使用的工具） ────────────────────────────────────

export type ActiveSubTools = Partial<Record<ToolGroup, ToolType>>

/**
 * 取得指定群組目前的啟用工具定義。
 * 若群組尚無記憶，回傳該群組的第一個工具。
 */
export function getActiveTool(state: ActiveSubTools, group: ToolGroup): ToolDef {
  const remembered = state[group]
  const tools = TOOL_GROUPS[group]
  return tools.find(t => t.type === remembered) ?? tools[0]
}

// ── 輸入元素標籤（這些元素中不觸發快捷鍵） ───────────────────────────────────

export const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA'])

// ── 快捷鍵比對 ────────────────────────────────────────────────────────────────

/**
 * 從鍵盤事件比對所有符合的 ToolDef（可能多個，用於循環切換）。
 *
 * 比對規則：
 *   1. 具體度高（有修飾鍵限制）的工具優先排在結果陣列前面，
 *      確保 Ctrl+K 不被純 K 的工具搶先。
 *   2. shift / ctrl 若在 ShortcutKey 中為 undefined，表示「不在意該修飾鍵」。
 *   3. 若事件來自輸入框（INPUT / TEXTAREA），回傳空陣列。
 *
 * 回傳 ToolDef[]（空陣列表示無匹配），讓呼叫方決定取第一個或循環切換。
 */
export function matchShortcut(
  event: KeyboardEvent,
  groups: Record<ToolGroup, ToolDef[]>,
): ToolDef[] {
  // 輸入框中不觸發工具切換
  if (TYPING_TAGS.has((event.target as Element)?.tagName)) return []

  const key   = event.key.toLowerCase()
  const shift = event.shiftKey
  const ctrl  = event.ctrlKey || event.metaKey

  // 攤平所有工具，具體度高（有修飾鍵限制）的排前，避免低具體度搶先匹配
  const allTools = Object.values(groups).flat()
  const sorted   = [...allTools].sort((a, b) => _specificity(b) - _specificity(a))

  const matched: ToolDef[] = []
  for (const tool of sorted) {
    for (const sc of tool.shortcuts) {
      if (
        sc.key === key &&
        (sc.shift === undefined || sc.shift === shift) &&
        (sc.ctrl  === undefined || sc.ctrl  === ctrl)
      ) {
        matched.push(tool)
        break // 同一工具只加一次
      }
    }
  }
  return matched
}

/** 計算快捷鍵的「具體度」：修飾鍵越多越具體，優先排前。 */
function _specificity(tool: ToolDef): number {
  return tool.shortcuts.reduce((max, sc) => {
    const score = (sc.ctrl === true ? 2 : 0) + (sc.shift === true ? 1 : 0)
    return Math.max(max, score)
  }, 0)
}
