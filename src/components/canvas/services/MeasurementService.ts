import Konva from 'konva'
import type { CanvasElement } from '@/types/element'

// ── 顏色常數 ──────────────────────────────────────────────────────────────────

export const COLOR_SNAP    = '#ff4d4f'
export const COLOR_MEASURE = '#1890ff'

/** 對齊吸附偵測閾值（螢幕像素）。 */
const SNAP_THRESHOLD_PX = 5
/** 尺寸標籤距選取框底部的垂直偏移（螢幕像素）。 */
const LABEL_OFFSET_PX   = 8
/** 吸附線超出最外側邊緣的延伸長度（螢幕像素）。 */
const SNAP_EXT_PX       = 24
/** 節點池初始大小；超出時自動成長；收縮由 hide() 延遲觸發。 */
const SNAP_POOL_INIT    = 16

/**
 * 吸附線 Map key 的捨入精度（= 1 / SNAP_KEY_PREC 世界單位 = 0.01）。
 *
 * 設計推理：
 * - 若太精細（如 10000）：浮點誤差仍可能讓幾乎相同的座標走不同 bucket。
 * - 若太粗糙（如 1）：1 世界單位在 scale = 10 時對應 10 螢幕像素，
 *   可能把視覺上明顯不同的線誤合併。
 * - 100（0.01 世界單位）在所有合理 scale 範圍（0.05 ~ 100）下均安全去重。
 */
const SNAP_KEY_PREC = 100

// ── BBox ──────────────────────────────────────────────────────────────────────

interface BBox {
  left: number; top: number; right: number; bottom: number
  cx: number; cy: number; w: number; h: number
}

/**
 * 計算元素的正規化包圍框。
 * 處理負寬高（翻轉元素），確保 left ≤ right、top ≤ bottom。
 */
function elBBox(el: CanvasElement): BBox {
  const left   = el.width  >= 0 ? el.x              : el.x + el.width
  const top    = el.height >= 0 ? el.y              : el.y + el.height
  const right  = el.width  >= 0 ? el.x + el.width  : el.x
  const bottom = el.height >= 0 ? el.y + el.height : el.y
  return { left, top, right, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2, w: right - left, h: bottom - top }
}

/**
 * 單次迴圈合併包圍框（避免 spread / map 產生多餘臨時陣列）。
 * 傳入空陣列時回傳零包圍框。
 */
function unionBBox(boxes: BBox[]): BBox {
  if (boxes.length === 0) {
    return { left: 0, top: 0, right: 0, bottom: 0, cx: 0, cy: 0, w: 0, h: 0 }
  }
  let { left, top, right, bottom } = boxes[0]
  for (let i = 1; i < boxes.length; i++) {
    const b = boxes[i]
    if (b.left   < left)   left   = b.left
    if (b.top    < top)    top    = b.top
    if (b.right  > right)  right  = b.right
    if (b.bottom > bottom) bottom = b.bottom
  }
  return { left, top, right, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2, w: right - left, h: bottom - top }
}

/**
 * 取得 src 邊界上最靠近 ref 的點。
 * 若兩框在某軸重疊，該軸回傳 src 的中心值，確保返回點永遠有效（不產生 NaN）。
 */
function closestEdgePoint(src: BBox, ref: BBox): { x: number; y: number } {
  const x = src.right  < ref.left   ? src.right
          : src.left   > ref.right  ? src.left
          : src.cx
  const y = src.bottom < ref.top    ? src.bottom
          : src.top    > ref.bottom ? src.top
          : src.cy
  return { x, y }
}

/**
 * 正規化角度至 [-90, 90)，確保標籤文字不會上下顛倒。
 * 統一使用「>= 90」與「< -90」，範圍兩側對稱。
 */
function normalizeAngle(deg: number): number {
  if (deg >= 90)  return deg - 180   // [90, 180] → [-90, 0]
  if (deg < -90) return deg + 180   // (-180, -90) → (0, 90)
  return deg                         // 結果域：[-90, 90)
}

// ── MeasurementService ────────────────────────────────────────────────────────

class MeasurementService {
  private layer: Konva.Layer | null = null
  private group: Konva.Group | null = null

  // 尺寸標籤節點（持久化，切換 visible 而非銷毀重建）
  private _sizeLabelNode: Konva.Label | null = null
  private _sizeLabelText: Konva.Text  | null = null

  // 距離指示器節點（持久化，切換 visible 而非銷毀重建）
  private _distLine:     Konva.Line           | null = null
  private _distDia1:     Konva.RegularPolygon | null = null
  private _distDia2:     Konva.RegularPolygon | null = null
  private _distLabel:    Konva.Label          | null = null
  private _distLabelTxt: Konva.Text           | null = null

  // 吸附線節點池（重複使用，避免每幀銷毀重建的 GC 壓力）
  private _snapPool:      Konva.Line[] = []
  private _snapUsed       = 0
  /** 記錄最近高水位，供 hide() 決定裁剪目標，避免節點池在閾值附近來回震盪。 */
  private _snapHighWater  = 0

  // ── 初始化 ────────────────────────────────────────────────────────────────

  /**
   * 綁定至 uiLayer。
   * - 傳入相同 layer：no-op。
   * - 傳入不同 layer（例如畫布重置）：自動先 destroy 再重建。
   */
  init(layer: Konva.Layer): void {
    if (this.layer === layer) return
    if (this.layer) this.destroy()
    this.layer = layer
    this.group = new Konva.Group({ listening: false })
    layer.add(this.group)
    this._buildNodes()
  }

  private _buildNodes(): void {
    const g = this.group!

    // 預先分配吸附線節點池
    for (let i = 0; i < SNAP_POOL_INIT; i++) {
      g.add(this._makeSnapLine())
    }

    // 尺寸標籤
    this._sizeLabelNode = new Konva.Label({ x: 0, y: 0, visible: false, listening: false })
    this._sizeLabelNode.add(new Konva.Tag({ fill: COLOR_MEASURE, cornerRadius: 2, listening: false }))
    this._sizeLabelText = new Konva.Text({
      text: '', fontSize: 10, fontFamily: 'Inter, sans-serif',
      fill: '#ffffff', padding: 3, listening: false,
    })
    this._sizeLabelNode.add(this._sizeLabelText)
    g.add(this._sizeLabelNode)

    // 距離線 + 菱形端點
    this._distLine = new Konva.Line({
      points: [0, 0, 0, 0], stroke: COLOR_MEASURE, strokeWidth: 1,
      listening: false, visible: false,
    })
    this._distDia1 = new Konva.RegularPolygon({
      x: 0, y: 0, sides: 4, radius: 4, fill: COLOR_MEASURE,
      rotation: 45, listening: false, visible: false,
    })
    this._distDia2 = new Konva.RegularPolygon({
      x: 0, y: 0, sides: 4, radius: 4, fill: COLOR_MEASURE,
      rotation: 45, listening: false, visible: false,
    })
    g.add(this._distLine, this._distDia1, this._distDia2)

    // 距離標籤
    this._distLabel = new Konva.Label({ x: 0, y: 0, visible: false, listening: false })
    this._distLabel.add(new Konva.Tag({ fill: COLOR_MEASURE, cornerRadius: 2, listening: false }))
    this._distLabelTxt = new Konva.Text({
      text: '', fontSize: 10, fontFamily: 'Inter, sans-serif',
      fill: '#ffffff', padding: 3, listening: false,
    })
    this._distLabel.add(this._distLabelTxt)
    g.add(this._distLabel)
  }

  private _makeSnapLine(): Konva.Line {
    const line = new Konva.Line({
      points: [0, 0, 0, 0], stroke: COLOR_SNAP, strokeWidth: 1,
      listening: false, visible: false,
    })
    this._snapPool.push(line)
    return line
  }

  // ── 隱藏輔助 ──────────────────────────────────────────────────────────────

  private _hideSizeLabel(): void { this._sizeLabelNode?.visible(false) }

  private _hideDistIndicator(): void {
    this._distLine?.visible(false)
    this._distDia1?.visible(false)
    this._distDia2?.visible(false)
    this._distLabel?.visible(false)
  }

  /**
   * 歸還吸附線池中所有使用中的節點（隱藏而非銷毀）。
   * 裁剪邏輯刻意不放在此處，以避免在拖曳熱路徑（每幀都呼叫）上批次銷毀節點。
   * 裁剪由 hide() 在拖曳結束後延遲執行。
   */
  private _releaseSnapLines(): void {
    for (let i = 0; i < this._snapUsed; i++) this._snapPool[i].visible(false)
    if (this._snapUsed > this._snapHighWater) this._snapHighWater = this._snapUsed
    this._snapUsed = 0
  }

  /**
   * 根據高水位裁剪節點池。
   * 只在 hide()（拖曳結束後）呼叫，避免在熱路徑上造成卡頓。
   * 裁剪目標為 max(SNAP_POOL_INIT, _snapHighWater)，
   * 防止畫布常態需要較多吸附線時反覆震盪。
   */
  private _trimSnapPool(): void {
    const target = Math.max(SNAP_POOL_INIT, this._snapHighWater)
    if (this._snapPool.length > target * 2) {
      for (let i = target; i < this._snapPool.length; i++) {
        this._snapPool[i].destroy()
      }
      this._snapPool.length = target
    }
    this._snapHighWater = 0
  }

  // ── 更新輔助 ──────────────────────────────────────────────────────────────

  private _updateSizeLabel(box: BBox, scale: number): void {
    const sl = this._sizeLabelNode
    const st = this._sizeLabelText
    if (!sl || !st) return

    st.fontSize(10 / scale)
    st.padding(3 / scale)
    st.text(`${Math.round(box.w)} × ${Math.round(box.h)}`);

    (sl.getChildren()[0] as Konva.Tag).cornerRadius(2 / scale)

    // Konva.Text.width()（未明確設定 width 時）= getTextWidth() + padding * 2，
    // 已含兩側 padding，可直接用於 offsetX 置中，無需再加回 padding。
    sl.x(box.cx)
    sl.y(box.bottom + LABEL_OFFSET_PX / scale)
    sl.offsetX(st.width() / 2)
    sl.offsetY(0)
    sl.rotation(0)
    sl.visible(true)
  }

  /**
   * 收集去重後的吸附線，再批次指派給節點池。
   *
   * 複雜度：O(N)，N = 非選取元素數量。
   * 內層迴圈只對固定 3 個邊值比較，命中後立即 break（每個 other 邊最多 1 次命中）。
   * Map key 做定點捨入，避免浮點誤差導致近似座標走不同 bucket 而繪製重疊線。
   */
  private _updateSnapLines(selBox: BBox, others: CanvasElement[], scale: number): void {
    const thresh = SNAP_THRESHOLD_PX / scale
    const lw     = 1 / scale
    const ext    = SNAP_EXT_PX / scale

    // hLines: 捨入後 y → { 實際 y, x 範圍 }；vLines: 捨入後 x → { 實際 x, y 範圍 }
    const hLines = new Map<number, { y: number; x0: number; x1: number }>()
    const vLines = new Map<number, { x: number; y0: number; y1: number }>()

    const selYs = [selBox.top, selBox.cy, selBox.bottom] as const
    const selXs = [selBox.left, selBox.cx, selBox.right] as const

    for (const el of others) {
      const ob = elBBox(el)

      // 水平對齊（y 值接近）
      for (const oy of [ob.top, ob.cy, ob.bottom] as const) {
        for (const sy of selYs) {
          if (Math.abs(sy - oy) < thresh) {
            const key = Math.round(oy * SNAP_KEY_PREC) / SNAP_KEY_PREC
            const x0  = Math.min(selBox.left, ob.left)   - ext
            const x1  = Math.max(selBox.right, ob.right) + ext
            const e   = hLines.get(key)
            if (e) { if (x0 < e.x0) e.x0 = x0; if (x1 > e.x1) e.x1 = x1 }
            else     hLines.set(key, { y: oy, x0, x1 })
            break   // 每個 oy 只需命中一個 sy
          }
        }
      }

      // 垂直對齊（x 值接近）
      for (const ox of [ob.left, ob.cx, ob.right] as const) {
        for (const sx of selXs) {
          if (Math.abs(sx - ox) < thresh) {
            const key = Math.round(ox * SNAP_KEY_PREC) / SNAP_KEY_PREC
            const y0  = Math.min(selBox.top, ob.top)       - ext
            const y1  = Math.max(selBox.bottom, ob.bottom) + ext
            const e   = vLines.get(key)
            if (e) { if (y0 < e.y0) e.y0 = y0; if (y1 > e.y1) e.y1 = y1 }
            else     vLines.set(key, { x: ox, y0, y1 })
            break
          }
        }
      }
    }

    // 批次指派至節點池（不足時自動成長）
    let idx = 0

    const assign = (pts: [number, number, number, number]) => {
      if (idx === this._snapPool.length) this.group!.add(this._makeSnapLine())
      const ln = this._snapPool[idx++]
      ln.points(pts)
      ln.strokeWidth(lw)
      ln.visible(true)
    }

    for (const { y, x0, x1 } of hLines.values()) assign([x0, y,  x1, y])
    for (const { x, y0, y1 } of vLines.values()) assign([x,  y0, x,  y1])

    // 隱藏池中剩餘未使用的節點
    for (let i = idx; i < this._snapPool.length; i++) this._snapPool[i].visible(false)
    if (idx > this._snapHighWater) this._snapHighWater = idx
    this._snapUsed = idx
  }

  /**
   * 更新距離指示器節點屬性。
   * 前置條件：必須在 init() 之後呼叫，destroy() 後呼叫會提前回傳（安全）。
   */
  private _updateDistIndicator(selBox: BBox, targetBox: BBox, scale: number): void {
    if (!this._distLine || !this._distDia1 || !this._distDia2 || !this._distLabel || !this._distLabelTxt) return

    const p1 = closestEdgePoint(selBox,    targetBox)
    const p2 = closestEdgePoint(targetBox, selBox)
    const dx = Math.abs(p2.x - p1.x)
    const dy = Math.abs(p2.y - p1.y)

    // 退化：兩框中心完全重合，距離為零，Math.atan2(0, 0) = 0（不是 NaN）但畫出長度 0 的線毫無意義
    if (dx < 1e-6 && dy < 1e-6) { this._hideDistIndicator(); return }

    const lw = 1 / scale
    const d  = 4 / scale

    this._distLine.points([p1.x, p1.y, p2.x, p2.y])
    this._distLine.strokeWidth(lw)
    this._distLine.visible(true)

    this._distDia1.x(p1.x); this._distDia1.y(p1.y); this._distDia1.radius(d); this._distDia1.visible(true)
    this._distDia2.x(p2.x); this._distDia2.y(p2.y); this._distDia2.radius(d); this._distDia2.visible(true)

    const dl  = this._distLabel
    const dlt = this._distLabelTxt

    dlt.fontSize(10 / scale)
    dlt.padding(3 / scale)
    dlt.text(`${Math.round(dx)} × ${Math.round(dy)}`);

    (dl.getChildren()[0] as Konva.Tag).cornerRadius(2 / scale)

    // 正規化角度至 [-90, 90) 確保文字不倒置；dlt.width() 同上，已含 padding。
    const angle = normalizeAngle(Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI)
    dl.x((p1.x + p2.x) / 2)
    dl.y((p1.y + p2.y) / 2)
    dl.rotation(angle)
    dl.offsetX(dlt.width() / 2)
    dl.offsetY(dlt.height() + 2 / scale)  // 局部座標系上移，視覺上位於連線上方
    dl.visible(true)
  }

  // ── 公開 API ──────────────────────────────────────────────────────────────

  /**
   * 顯示尺寸標籤（閒置 / 選取變更時）。
   * 元素必須已轉換為世界（絕對）座標。
   * 不呼叫 batchDraw，由 canvas.vue 的 watchEffect 或明確呼叫端負責觸發重繪。
   */
  showIdle(absEls: CanvasElement[], scale: number): void {
    if (!this.layer) return
    const s = Math.max(scale, 1e-4)
    this._releaseSnapLines()
    this._hideDistIndicator()
    if (absEls.length === 0) { this._hideSizeLabel(); return }
    this._updateSizeLabel(unionBBox(absEls.map(elBBox)), s)
  }

  /**
   * 顯示吸附線 + 尺寸標籤（拖曳時）。
   * 不呼叫 batchDraw，由呼叫端負責觸發重繪。
   */
  showDragging(absSelected: CanvasElement[], absOthers: CanvasElement[], scale: number): void {
    if (!this.layer) return
    const s = Math.max(scale, 1e-4)
    this._hideDistIndicator()
    if (absSelected.length === 0) {
      this._hideSizeLabel(); this._releaseSnapLines(); return
    }
    const selBox = unionBBox(absSelected.map(elBBox))
    this._updateSnapLines(selBox, absOthers, s)
    this._updateSizeLabel(selBox, s)
  }

  /**
   * 顯示距離線 + 尺寸標籤（Alt + Hover 時）。
   * 不呼叫 batchDraw，由呼叫端負責觸發重繪。
   */
  showDistanceTo(absSelected: CanvasElement[], absTarget: CanvasElement, scale: number): void {
    if (!this.layer) return
    const s = Math.max(scale, 1e-4)
    this._releaseSnapLines()
    if (absSelected.length === 0) {
      this._hideSizeLabel(); this._hideDistIndicator(); return
    }
    const selBox = unionBBox(absSelected.map(elBBox))
    this._updateDistIndicator(selBox, elBBox(absTarget), s)
    this._updateSizeLabel(selBox, s)
  }

  /**
   * 隱藏所有覆蓋層，並觸發節點池的延遲裁剪。
   * 不呼叫 batchDraw，由呼叫端負責觸發重繪。
   */
  hide(): void {
    if (!this.layer) return
    this._hideSizeLabel()
    this._releaseSnapLines()
    this._hideDistIndicator()
    this._trimSnapPool()
  }

  destroy(): void {
    this.group?.destroy()
    this.group          = null
    this.layer          = null
    this._sizeLabelNode = null; this._sizeLabelText = null
    this._distLine      = null; this._distDia1      = null; this._distDia2    = null
    this._distLabel     = null; this._distLabelTxt  = null
    this._snapPool      = []; this._snapUsed = 0; this._snapHighWater = 0
  }
}

export const measurementService = new MeasurementService()
