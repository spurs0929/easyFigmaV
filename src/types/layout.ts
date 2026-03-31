// ── 原始型別 ───────────────────────────────────────────────────────────

export type SizeMode =
  | 'FIXED' // 固定尺寸：明確的寬度 / 高度
  | 'HUG' // 適應內容：根據子元素撐開（由下而上）
  | 'FILL' // 填滿剩餘空間：等比例填滿父層（由上而下，使用 flexGrow）

export type HConstraint = 'LEFT' | 'RIGHT' | 'CENTER' | 'SCALE' | 'STRETCH'
export type VConstraint = 'TOP' | 'BOTTOM' | 'CENTER' | 'SCALE' | 'STRETCH'

export type LayoutDir = 'HORIZONTAL' | 'VERTICAL' | 'NONE'

export type JustifyContent = 'START' | 'CENTER' | 'END' | 'SPACE_BETWEEN'
export type AlignItems = 'START' | 'CENTER' | 'END'

// ── 數學工具 ────────────────────────────────────────────────────────────

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

// ── 輔助工具 ───────────────────────────────────────────────────────────────────

export interface EdgeInsets {
  top: number
  right: number
  bottom: number
  left: number
}

export function uniformInsets(v: number): EdgeInsets {
  return { top: v, right: v, bottom: v, left: v }
}

// ── Core Node ─────────────────────────────────────────────────────────────────

export interface LayoutNode {
  id: string

  /** 在父層中的偏移量 —— 僅在 parent.direction === 'NONE' 時使用 */
  x: number
  y: number

  /** 明確的尺寸 —— 當 widthMode / heightMode 為 'FIXED' 時使用 */
  width: number
  height: number

  widthMode: SizeMode
  heightMode: SizeMode

  /**
   * FILL 模式下的比例權重（預設為 1）
   * 例如：flexGrow=2 的節點會分配到兩倍於 flexGrow=1 的剩餘空間
   */
  flexGrow: number

  /**
   * 尺寸最終限制（在所有 SizeMode 計算後應用）
   * 防止 HUG 或 FILL 產生不合理的尺寸
   */
  minWidth: number // 預設 0
  maxWidth: number // 預設 Infinity
  minHeight: number // 預設 0
  maxHeight: number // 預設 Infinity

  rotation: number

  direction: LayoutDir
  padding: EdgeInsets
  gap: number
  justifyContent: JustifyContent
  alignItems: AlignItems

  /** 當 parent.direction === 'NONE' 時使用的約束（絕對定位 / 約束佈局） */
  hConstraint: HConstraint
  vConstraint: VConstraint

  /**
   * 當在自動佈局（Auto-layout）父層中為 true 時，此子元素會脫離流式佈局，
   * 改由 Constraints（約束）進行定位（類似 Figma 的 "Absolute position" 開關）。
   */
  isAbsolute: boolean

  children: LayoutNode[]
}

// ── 佈局引擎輸出（唯讀，與輸入樹分離） ──────────────────────────────────────

/** 單個節點的計算後幾何資訊（畫布座標）。 */
export interface ResolvedBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** compute() 回傳的完整佈局結果：nodeId → ResolvedBox。 */
export type ResolvedLayout = ReadonlyMap<string, ResolvedBox>
