// ── Paint（填色 / 描邊抽象） ──────────────────────────────────────────────────
// 提早抽象避免未來 breaking change。
// 目前只有 SolidPaint；之後加 GradientPaint / ImagePaint 只需擴充此聯集，
// 不需修改 CanvasElement 介面。

export interface SolidPaint {
  type:     'solid'
  color:    string   // CSS hex / rgb，例 '#ffffff'
  /**
   * 填色本身的不透明度（0–1）。
   * 最終渲染不透明度 = CanvasElement.opacity × SolidPaint.opacity。
   * undefined 視為 1（完全不透明）。
   */
  opacity?: number
}

export type Paint = SolidPaint // | GradientPaint | ImagePaint（未來擴充）

// ── 字重 ──────────────────────────────────────────────────────────────────────
// CSS 合法字重為 100–900 的整百數；使用聯集型別避免傳入任意數字
// 導致渲染 fallback 到瀏覽器預設值而難以除錯。

export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900

export interface VectorHandle {
  x: number
  y: number
}

export interface VectorPoint {
  x: number
  y: number
  // 以錨點自身為基準儲存入/出控制把手，讓 Vector 可表達 Bezier 曲線。
  handleIn?: VectorHandle
  handleOut?: VectorHandle
}

// ── 元素種類 ──────────────────────────────────────────────────────────────────

export enum ElementKind {
  Rect      = 'rect',
  Ellipse   = 'ellipse',
  Line      = 'line',
  Polygon   = 'polygon',
  Vector    = 'vector',
  Text      = 'text',
  Frame     = 'frame',
  Group     = 'group',
  Component = 'component',
  Slice     = 'slice',
}

// ── 畫布元素 ──────────────────────────────────────────────────────────────────
//
// ⚠️ 設計說明：Component / Slice 的 kind-specific 欄位目前以 optional 形式掛在
// 同一個 interface 上（componentId, exportSettings）。若未來這兩個 kind 的欄位
// 大量增加，應重構為 discriminated union（RectElement | EllipseElement | ...）
// 以消除 "optional 地獄"。現階段為保持渲染管線的統一性，暫維持扁平結構。

export interface CanvasElement {
  id:   string
  kind: ElementKind
  name: string

  // ── Transform ─────────────────────────────────────────────────────────────
  x:        number
  y:        number
  /**
   * Group：由子元素 AABB 推導而來（見 computeGroupBounds）。
   * 渲染時請透過 computeGroupBounds 取得最新值，勿在業務邏輯中直接寫入。
   * 工廠 / group() action 建立時負責初始化此值。
   */
  width:    number
  /** 同 width 說明。 */
  height:   number
  rotation: number  // degrees，順時針
  scaleX:   number  // 預設 1；-1 = 水平翻轉（Flip H）
  scaleY:   number  // 預設 1；-1 = 垂直翻轉（Flip V）

  // ── Appearance ────────────────────────────────────────────────────────────
  fill:        Paint
  stroke:      Paint
  /**
   * 描邊寬度（≥ 0）。入口請用 clampStrokeWidth()，負值在 Canvas/SVG 行為未定義。
   */
  strokeWidth: number
  /**
   * 整體不透明度（0–1）。
   * 最終渲染不透明度 = element.opacity × fill.opacity（若 fill 有 opacity）。
   * 入口請用 clampOpacity() 確保合法範圍。
   */
  opacity: number

  // ── State ─────────────────────────────────────────────────────────────────
  visible: boolean
  locked:  boolean

  // ── Tree（Adjacency List — 正規化，不嵌套子元素）──────────────────────────
  // 不變式（由 assertStoreIntegrity 在開發環境驗證）：
  //   el.parentId === undefined  ⟺  rootIds.includes(el.id)
  parentId?: string   // undefined = root element
  childIds:  string[] // z-order：index 0 = bottommost（最底層）

  // ── Kind-specific: Text ───────────────────────────────────────────────────
  text?:       string
  fontSize?:   number
  fontFamily?: string
  fontWeight?: FontWeight

  // ── Kind-specific: Line / Polygon ─────────────────────────────────────────
  /**
   * Local coords，相對於元素自身的 (x, y) 起點。
   * 格式：[x0, y0, x1, y1, ...]
   * - Line：至少 4 個數字（2 個點）。
   * - Polygon：至少 6 個數字（3 個點）。
   * 空陣列 [] 視為無效，建立時應拒絕或給預設值。
   */
  points?: number[]
  // Pen 專用的向量節點資料；與 Line/Polygon 的 points 分開，避免互相污染語意。
  vectorPoints?: VectorPoint[]
  // true 代表路徑首尾相接，可套用 fill。
  closed?: boolean

  // ── Kind-specific: Rect ───────────────────────────────────────────────────
  /**
   * 圓角半徑。渲染時必須 clamp 至 min(width, height) / 2，防止超出圓角上限。
   */
  cornerRadius?: number

  // ── Kind-specific: Component ─────────────────────────────────────────────
  /**
   * 指向 master Component 的 id。
   * Instance 元素需帶此欄位；master 本身不帶（undefined）。
   */
  componentId?: string

  // ── Kind-specific: Slice ──────────────────────────────────────────────────
  /**
   * 匯出設定（預留，待需求確定後再具體型別化）。
   */
  exportSettings?: unknown
}

// ── 正規化 Store 型別 ─────────────────────────────────────────────────────────

export interface ElementStore {
  byId:    Readonly<Record<string, CanvasElement>>
  rootIds: string[] // z-order：index 0 = bottommost root element
}

// ── Z-order 方向 ──────────────────────────────────────────────────────────────

export enum ZOrderDirection {
  Front = 'front',
  Back  = 'back',
  Up    = 'up',
  Down  = 'down',
}

// ── 數學工具 ──────────────────────────────────────────────────────────────────

/** 不透明度合法範圍保護（0–1）。 */
export function clampOpacity(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** 描邊寬度下限保護（≥ 0）。 */
export function clampStrokeWidth(v: number): number {
  return Math.max(0, v)
}

/**
 * 取得元素在父座標空間中的四個角落，已套用 rotation。
 * 供 computeGroupBounds 及 group() action 共用，避免重複實作幾何邏輯。
 *
 * 注意：scaleX / scaleY 為 ±1（翻轉），不影響 AABB 大小，故不需額外處理。
 */
export function rotatedCorners(el: CanvasElement): [number, number][] {
  const cx  = el.x + el.width  / 2
  const cy  = el.y + el.height / 2
  const rad = (el.rotation * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)

  const corners: [number, number][] = [
    [el.x,             el.y            ],
    [el.x + el.width,  el.y            ],
    [el.x + el.width,  el.y + el.height],
    [el.x,             el.y + el.height],
  ]

  return corners.map(([px, py]) => [
    cx + (px - cx) * cos - (py - cy) * sin,
    cy + (px - cx) * sin + (py - cy) * cos,
  ])
}

/**
 * 計算 Group 的實際 bounding box（包含子元素的 rotation）。
 *
 * 回傳值含 x, y，Group 的位置應以此同步，確保 Group 不會因子元素變動而漂移。
 *
 * 限制：
 * - 巢狀 Group 子元素的 rotation 不會遞迴展開（使用 stored width/height 近似）。
 *   如需精確結果，請由葉節點往上逐層呼叫。
 * - Line / Polygon 的實際範圍以 width/height 近似，不從 points 計算。
 */
export function computeGroupBounds(
  group: CanvasElement,
  store: ElementStore,
): { x: number; y: number; width: number; height: number } {
  const children = group.childIds
    .map(id => store.byId[id])
    .filter((el): el is CanvasElement => !!el)

  if (children.length === 0) {
    return { x: group.x, y: group.y, width: 0, height: 0 }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  for (const child of children) {
    for (const [px, py] of rotatedCorners(child)) {
      if (px < minX) minX = px
      if (py < minY) minY = py
      if (px > maxX) maxX = px
      if (py > maxY) maxY = py
    }
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// ── 開發環境不變式驗證 ────────────────────────────────────────────────────────

/**
 * 在開發環境下驗證 ElementStore 的結構完整性。
 * 請在每次 store mutation 後呼叫（production 環境會立即 return）。
 *
 * 驗證項目：
 *   1. rootIds 中的每個 id 存在於 byId 且 parentId === undefined
 *   2. parentId !== undefined 的元素必須出現在 parent.childIds 中
 *   3. childIds 中的每個 id 存在於 byId
 *   4. rootIds 中的 id 不應同時出現為任何元素的 childId
 *   5. 無循環 parentId 參照
 */
function vectorPointBounds(points: VectorPoint[]): { x: number; y: number; width: number; height: number } {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  const visit = (pt: VectorHandle | VectorPoint | undefined): void => {
    if (!pt) return
    if (pt.x < minX) minX = pt.x
    if (pt.y < minY) minY = pt.y
    if (pt.x > maxX) maxX = pt.x
    if (pt.y > maxY) maxY = pt.y
  }

  for (const point of points) {
    visit(point)
    visit(point.handleIn)
    visit(point.handleOut)
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function normalizeVectorPath(points: VectorPoint[]): {
  x: number
  y: number
  width: number
  height: number
  vectorPoints: VectorPoint[]
} {
  // 將世界座標的節點正規化成元素區域座標，讓 x/y/width/height 能維持既有元素系統的一致性。
  const bounds = vectorPointBounds(points)
  return {
    ...bounds,
    vectorPoints: points.map((point) => ({
      x: point.x - bounds.x,
      y: point.y - bounds.y,
      handleIn: point.handleIn ? { x: point.handleIn.x - bounds.x, y: point.handleIn.y - bounds.y } : undefined,
      handleOut: point.handleOut ? { x: point.handleOut.x - bounds.x, y: point.handleOut.y - bounds.y } : undefined,
    })),
  }
}

export function assertStoreIntegrity(store: ElementStore): void {
  if (import.meta.env.PROD) return

  const { byId, rootIds } = store
  const tag = '[assertStoreIntegrity]'

  // 1. rootIds 存在且 parentId === undefined
  for (const id of rootIds) {
    if (!byId[id]) {
      console.error(`${tag} rootId "${id}" 不存在於 byId`)
      continue
    }
    if (byId[id].parentId !== undefined) {
      console.error(`${tag} rootId "${id}" 卻有 parentId "${byId[id].parentId}"`)
    }
  }

  // 2 & 3. 所有元素的 parentId / childIds 一致性
  for (const [id, el] of Object.entries(byId)) {
    if (el.parentId !== undefined) {
      const parent = byId[el.parentId]
      if (!parent) {
        console.error(`${tag} "${id}" 的 parentId "${el.parentId}" 不存在於 byId`)
      } else if (!parent.childIds.includes(id)) {
        console.error(`${tag} "${id}" 未出現在 parent "${el.parentId}".childIds 中`)
      }
    }

    for (const childId of el.childIds) {
      if (!byId[childId]) {
        console.error(`${tag} "${id}".childIds 包含不存在的 id "${childId}"`)
      }
    }
  }

  // 4. rootIds 不應同時是子元素
  const allChildIds = new Set(Object.values(byId).flatMap(el => el.childIds))
  for (const id of rootIds) {
    if (allChildIds.has(id)) {
      console.error(`${tag} rootId "${id}" 同時出現在某個元素的 childIds 中`)
    }
  }

  // 5. 無循環 parentId 參照
  for (const startId of Object.keys(byId)) {
    const visited = new Set<string>()
    let current: string | undefined = startId
    while (current !== undefined) {
      if (visited.has(current)) {
        console.error(`${tag} 從 "${startId}" 追溯 parentId 時發現循環參照（含 "${current}"）`)
        break
      }
      visited.add(current)
      current = byId[current]?.parentId
    }
  }
}

// ── 唯一 ID ───────────────────────────────────────────────────────────────────

/** 瀏覽器安全的 UUID（crypto.randomUUID，不依賴外部套件）。 */
export function newElementId(): string {
  return crypto.randomUUID()
}

// ── 預設值 ────────────────────────────────────────────────────────────────────

export const GROUP_DEFAULT_NAME:          string     = 'Group'
export const ELEMENT_DEFAULT_FILL:        Paint      = { type: 'solid', color: '#ffffff' }
export const ELEMENT_DEFAULT_STROKE:      Paint      = { type: 'solid', color: '#6366f1' }
export const ELEMENT_DEFAULT_FONT_FAMILY: string     = 'Inter'
export const ELEMENT_DEFAULT_FONT_SIZE:   number     = 14
export const ELEMENT_DEFAULT_FONT_WEIGHT: FontWeight = 400
export const POLYGON_DEFAULT_SIDES:       number     = 5
export const ELEMENT_HISTORY_MAX:         number     = 50
