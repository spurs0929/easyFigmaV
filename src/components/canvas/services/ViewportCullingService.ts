import type { CanvasElement } from '@/types/element'
import type { Viewport } from '@/store/viewport'

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * 軸對齊矩形（world coords）。
 * ViewportBounds 與 AABB 結構完全相同，統一為 Rect 避免維護兩個 interface。
 */
export interface Rect {
  left:   number
  top:    number
  right:  number
  bottom: number
}

export type ViewportBounds = Rect

// ── Quadtree constants ─────────────────────────────────────────────────────────

const QT_MAX_ITEMS = 8
const QT_MAX_DEPTH = 10
/** Quadtree 根節點的最小邊長，防止零面積 worldBounds 造成退化遞迴直至 QT_MAX_DEPTH。 */
const QT_MIN_SIZE  = 1

// ── ViewportCullingService ─────────────────────────────────────────────────────

class ViewportCullingService {

  // ── Viewport Bounds ──────────────────────────────────────────────────────────

  /**
   * 螢幕 viewport → 世界空間 bounding box。
   * containerW / containerH 非有限值，或 scale 為 0 時，回傳空矩形。
   */
  getBounds(viewport: Viewport, containerW: number, containerH: number): ViewportBounds {
    if (!isFinite(containerW) || !isFinite(containerH)) return { left: 0, top: 0, right: 0, bottom: 0 }
    const { x, y, scale } = viewport
    if (scale === 0) return { left: 0, top: 0, right: 0, bottom: 0 }
    return {
      left:   -x / scale,
      top:    -y / scale,
      right:  (containerW - x) / scale,
      bottom: (containerH - y) / scale,
    }
  }

  // ── Rotated AABB ─────────────────────────────────────────────────────────────

  /**
   * 取得（可能旋轉的）元素的軸對齊最小外接矩形（AABB）。
   *
   * Fast-path（rotation 非有限值 或 ≈ 0）：
   * - NaN rotation 統一走 fast-path，避免傳播 NaN 導致元素永遠可見。
   * - 負寬高在 fast-path 以 min/max 正規化；旋轉路徑已透過 corners min/max 自然處理。
   */
  getRotatedBounds(el: CanvasElement): Rect {
    const rot = el.rotation
    if (!isFinite(rot) || Math.abs(rot % 360) < 0.001) {
      return {
        left:   Math.min(el.x, el.x + el.width),
        top:    Math.min(el.y, el.y + el.height),
        right:  Math.max(el.x, el.x + el.width),
        bottom: Math.max(el.y, el.y + el.height),
      }
    }

    const rad = (rot * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const cx  = el.x + el.width  / 2
    const cy  = el.y + el.height / 2
    const hw  = el.width  / 2
    const hh  = el.height / 2

    const corners: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

    for (const [dx, dy] of corners) {
      const rx = cx + dx * cos - dy * sin
      const ry = cy + dx * sin + dy * cos
      if (rx < minX) minX = rx; if (rx > maxX) maxX = rx
      if (ry < minY) minY = ry; if (ry > maxY) maxY = ry
    }

    return { left: minX, top: minY, right: maxX, bottom: maxY }
  }

  // ── Layer A: Linear Cull ─────────────────────────────────────────────────────

  /**
   * O(n) 線性剔除，含 group 遞迴剪枝。
   *
   * 設計取捨（margin 與 group 剪枝的互動）：
   * expandRect 在進入遞迴前展開一次（避免每個元素重複配置物件），
   * 整個遞迴使用同一個 expanded rect 進行元素比對與 group 剪枝。
   * 因此距離視窗不超過 margin 的 group 仍會被遞迴，可能保留少量視窗外子元素。
   * 這是以少量多渲染換取零 per-element 物件配置的取捨。
   */
  cull(
    rootIds:    string[],
    byId:       Readonly<Record<string, CanvasElement>>,
    viewport:   Viewport,
    containerW: number,
    containerH: number,
    margin = 64,
  ): CanvasElement[] {
    const vp       = this.getBounds(viewport, containerW, containerH)
    const expanded = expandRect(vp, margin)
    const result: CanvasElement[] = []
    this._cullBranch(rootIds, byId, expanded, result)
    return result
  }

  private _cullBranch(
    ids:      string[],
    byId:     Readonly<Record<string, CanvasElement>>,
    expanded: Rect,
    result:   CanvasElement[],
  ): void {
    for (const id of ids) {
      const el = byId[id]
      if (!el || !el.visible) continue
      if (!rectOverlaps(this.getRotatedBounds(el), expanded)) continue
      result.push(el)
      if (el.childIds.length > 0) this._cullBranch(el.childIds, byId, expanded, result)
    }
  }

  // ── Layer B: Quadtree ────────────────────────────────────────────────────────

  /**
   * 由元素列表建構 Quadtree。
   *
   * worldBounds 防禦：
   * - 任一邊界為 NaN / Infinity → 回傳最小有效 Quadtree，防止靜默失效。
   * - 座標反轉（right < left）→ 正規化。
   * - 零面積（point）→ 強制最小邊長 QT_MIN_SIZE。
   */
  buildQuadtree(elements: CanvasElement[], worldBounds: Rect): Quadtree {
    const { left, top, right, bottom } = worldBounds
    if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) {
      return new Quadtree({ left: 0, top: 0, right: QT_MIN_SIZE, bottom: QT_MIN_SIZE }, 0)
    }
    const l = Math.min(left,  right)
    const t = Math.min(top,   bottom)
    const r = Math.max(left,  right)
    const b = Math.max(top,   bottom)
    const bounds: Rect = {
      left:   l,
      top:    t,
      right:  r - l < QT_MIN_SIZE ? l + QT_MIN_SIZE : r,
      bottom: b - t < QT_MIN_SIZE ? t + QT_MIN_SIZE : b,
    }
    const qt = new Quadtree(bounds, 0)
    for (const el of elements) {
      if (!el.visible) continue
      qt.insert(el, this.getRotatedBounds(el))
    }
    return qt
  }

  /** 查詢 Quadtree 中位於 viewport 內的元素 ID（以 Set 去重）。 */
  queryCulled(
    qt:         Quadtree,
    viewport:   Viewport,
    containerW: number,
    containerH: number,
    margin = 64,
  ): Set<string> {
    const vp     = this.getBounds(viewport, containerW, containerH)
    const padded = expandRect(vp, margin)
    const result = new Set<string>()
    qt.query(padded, result)
    return result
  }
}

// ── Quadtree ───────────────────────────────────────────────────────────────────
//
// 不變式：已分裂（_children !== null）的節點，_items 永遠為空陣列。
// insert 在 _children 存在時直接往子節點遞迴，不寫入 _items，
// 因此 query 不會在分裂節點的 _items 與 _children 中看到重複元素。

export class Quadtree {
  private _items:    Array<{ el: CanvasElement; aabb: Rect }> = []
  private _children: [Quadtree, Quadtree, Quadtree, Quadtree] | null = null

  constructor(
    private readonly _bounds: Rect,
    private readonly _depth:  number,
  ) {}

  insert(el: CanvasElement, aabb: Rect): void {
    if (!rectOverlaps(aabb, this._bounds)) return
    if (this._children) {
      for (const c of this._children) c.insert(el, aabb)
      return
    }
    this._items.push({ el, aabb })
    if (this._items.length > QT_MAX_ITEMS && this._depth < QT_MAX_DEPTH) {
      this._subdivide()
    }
  }

  query(vp: ViewportBounds, result: Set<string>): void {
    if (!rectOverlaps(this._bounds, vp)) return
    for (const { el, aabb } of this._items) {
      if (rectOverlaps(aabb, vp)) result.add(el.id)
    }
    if (this._children) for (const c of this._children) c.query(vp, result)
  }

  private _subdivide(): void {
    const { left, top, right, bottom } = this._bounds
    const mx = (left + right)  / 2
    const my = (top  + bottom) / 2
    const d  = this._depth + 1
    this._children = [
      new Quadtree({ left, top,    right: mx, bottom: my }, d), // NW
      new Quadtree({ left: mx, top, right, bottom: my    }, d), // NE
      new Quadtree({ left, top: my, right: mx, bottom    }, d), // SW
      new Quadtree({ left: mx, top: my, right, bottom    }, d), // SE
    ]
    const items = this._items
    this._items  = []  // 清空，維持分裂後 _items 恆為空的不變式
    for (const { el, aabb } of items) for (const c of this._children) c.insert(el, aabb)
  }
}

// ── Pure geometry helpers ──────────────────────────────────────────────────────

/** 判斷兩個 Rect 是否重疊（含邊界接觸）。 */
function rectOverlaps(a: Rect, b: Rect): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom)
}

/** 將 Rect 四邊各向外展開 margin 個單位，回傳新物件。 */
function expandRect(r: Rect, margin: number): Rect {
  return { left: r.left - margin, top: r.top - margin, right: r.right + margin, bottom: r.bottom + margin }
}

// ── Singleton export ───────────────────────────────────────────────────────────

export const cullingService = new ViewportCullingService()
