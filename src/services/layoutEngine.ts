import {
  type LayoutNode,
  type SizeMode,
  type HConstraint,
  type VConstraint,
  type JustifyContent,
  type AlignItems,
  type ResolvedLayout,
  clamp,
} from '@/types/layout'

// ─────────────────────────────────────────────────────────────────────────────
//  LayoutEngine  (Singleton)
//
//  純 TypeScript 雙 Pass 佈局演算法。
//  不碰 DOM / CSS —— 回傳 ResolvedLayout（nodeId → ResolvedBox），
//  由 Konva 渲染器直接讀取。輸入樹保持 immutable。
//
//  ┌─────────────────────────────────────────────────────────────────────────┐
//  │  Pass 1 · 由下而上（Measure）                                            │
//  │    • 先遞迴到最深層，再往上累積。                                         │
//  │    • FIXED  → 使用宣告尺寸，套用 [min, max] 限制。                       │
//  │    • HUG    → 由子元素 bounding box + padding 決定。                     │
//  │    • FILL   → 暫存 tentative size；Pass 2 修正。                        │
//  ├─────────────────────────────────────────────────────────────────────────┤
//  │  Pass 2 · 由上而下（Layout）                                             │
//  │    • 父層已知自身尺寸 → 可分配 FILL 剩餘空間。                            │
//  │    • flexGrow 控制 FILL 的比例分配。                                     │
//  │    • isAbsolute 子元素跳出流式佈局，改用 Constraint 定位。               │
//  │    • 每次尺寸寫入都套用 min/max clamp。                                  │
//  └─────────────────────────────────────────────────────────────────────────┘
//
//  已知限制：
//  • HUG 容器內放 FILL 子元素會造成循環依賴（同 Figma 限制）。
//    引擎會將該 FILL 子元素的 tentative size 設為 0，並在 DEV 模式下警告。
//  • 巢狀 FILL-in-FILL：Pass 2 修正父層尺寸後，孫層不會重新 measure，
//    需要第三 Pass 或迭代收斂才能完全正確，目前不支援。
// ─────────────────────────────────────────────────────────────────────────────

/** 引擎內部使用的可變版本，計算完成後以 ResolvedLayout（唯讀）對外公開。 */
type WorkingBox = { x: number; y: number; width: number; height: number }
type WorkingMap = Map<string, WorkingBox>

class LayoutEngine {
  private static _instance: LayoutEngine

  private _dirty = true
  private _cached: ResolvedLayout | null = null

  private constructor() {}

  static getInstance(): LayoutEngine {
    if (!LayoutEngine._instance) {
      LayoutEngine._instance = new LayoutEngine()
    }
    return LayoutEngine._instance
  }

  // ── 公開 API ─────────────────────────────────────────────────────────────

  /**
   * 將節點樹標記為需要重新計算。
   * 每當樹的輸入資料（尺寸、方向、子元素）發生變化時呼叫。
   */
  invalidate(): void {
    this._dirty = true
  }

  /**
   * 執行雙 Pass 佈局計算，回傳 immutable 的 ResolvedLayout。
   * 若自上次 compute 後未呼叫 invalidate()，直接回傳快取結果。
   *
   * @param root       根節點（如 Frame / Page）
   * @param containerW 根節點的可用寬度（視窗 / 畫板寬度）
   * @param containerH 根節點的可用高度
   */
  compute(root: LayoutNode, containerW: number, containerH: number): ResolvedLayout {
    if (!this._dirty && this._cached !== null) return this._cached

    const working: WorkingMap = new Map()
    this._measure(root, containerW, containerH, working, false, false)
    this._layout(root, 0, 0, working)

    this._cached = working as ResolvedLayout
    this._dirty = false
    return this._cached
  }

  // ── Pass 1：Measure（由下而上）─────────────────────────────────────────

  private _measure(
    node: LayoutNode,
    availW: number,
    availH: number,
    working: WorkingMap,
    /** 父層是否為 HUG width：此時子層的 FILL width 會造成循環依賴 */
    parentIsHugW: boolean,
    parentIsHugH: boolean,
  ): void {
    const padW = node.padding.left + node.padding.right
    const padH = node.padding.top + node.padding.bottom
    const innerW = Math.max(0, availW - padW)
    const innerH = Math.max(0, availH - padH)

    // DEV：偵測 HUG 容器內的 FILL 子元素（循環依賴）
    if (import.meta.env.DEV) {
      if (node.widthMode === 'HUG') {
        const hasFillW = node.children.some(c => !c.isAbsolute && c.widthMode === 'FILL')
        if (hasFillW) {
          console.warn(
            `[LayoutEngine] 節點 "${node.id}"：HUG width 容器含有 FILL width 子元素，` +
              `形成循環依賴。FILL 子元素的 width 將設為 0。`,
          )
        }
      }
      if (node.heightMode === 'HUG') {
        const hasFillH = node.children.some(c => !c.isAbsolute && c.heightMode === 'FILL')
        if (hasFillH) {
          console.warn(
            `[LayoutEngine] 節點 "${node.id}"：HUG height 容器含有 FILL height 子元素，` +
              `形成循環依賴。FILL 子元素的 height 將設為 0。`,
          )
        }
      }
    }

    // 先遞迴子層，讓子層有 tentative size 後再做 HUG 計算
    for (const child of node.children) {
      this._measure(child, innerW, innerH, working, node.widthMode === 'HUG', node.heightMode === 'HUG')
    }

    // 修正一：FILL 子元素在 HUG 父層中，tentative size = 0（避免循環依賴）
    const rw =
      parentIsHugW && node.widthMode === 'FILL'
        ? clamp(0, node.minWidth, node.maxWidth)
        : this._resolveSize(node.widthMode, node.width, availW, node.minWidth, node.maxWidth)

    const rh =
      parentIsHugH && node.heightMode === 'FILL'
        ? clamp(0, node.minHeight, node.maxHeight)
        : this._resolveSize(node.heightMode, node.height, availH, node.minHeight, node.maxHeight)

    let finalW = rw
    let finalH = rh

    // HUG：用子元素的 bounding box 覆蓋 tentative size
    if (node.widthMode === 'HUG' || node.heightMode === 'HUG') {
      const bounds = this._measureChildren(node, working)
      if (node.widthMode === 'HUG') finalW = clamp(bounds.width + padW, node.minWidth, node.maxWidth)
      if (node.heightMode === 'HUG') finalH = clamp(bounds.height + padH, node.minHeight, node.maxHeight)
    }

    working.set(node.id, { x: 0, y: 0, width: finalW, height: finalH })
  }

  /**
   * 根據佈局方向計算子元素的 bounding box。
   *
   * 修正二：direction === 'NONE' 時，只有 LEFT / TOP 約束的子元素能提供
   * 確定的邊界；RIGHT / CENTER / SCALE / STRETCH 的座標依賴父層尺寸，
   * 在 HUG 父層中無法確定（循環依賴），因此排除在外。
   */
  private _measureChildren(
    node: LayoutNode,
    working: WorkingMap,
  ): { width: number; height: number } {
    const getBox = (c: LayoutNode): WorkingBox => working.get(c.id) ?? { x: 0, y: 0, width: 0, height: 0 }
    const flow = node.children.filter(c => !c.isAbsolute)
    if (flow.length === 0) return { width: 0, height: 0 }

    if (node.direction === 'HORIZONTAL') {
      const w = flow.reduce((s, c) => s + getBox(c).width, 0) + node.gap * (flow.length - 1)
      const h = Math.max(...flow.map(c => getBox(c).height))
      return { width: w, height: h }
    }

    if (node.direction === 'VERTICAL') {
      const w = Math.max(...flow.map(c => getBox(c).width))
      const h = flow.reduce((s, c) => s + getBox(c).height, 0) + node.gap * (flow.length - 1)
      return { width: w, height: h }
    }

    // NONE：僅計算 LEFT / TOP 約束的子元素（其餘依賴父層尺寸，無法在此確定）
    let maxX = 0
    let maxY = 0
    for (const c of flow) {
      const box = getBox(c)
      if (c.hConstraint === 'LEFT') maxX = Math.max(maxX, c.x + box.width)
      if (c.vConstraint === 'TOP') maxY = Math.max(maxY, c.y + box.height)
    }
    return { width: maxX, height: maxY }
  }

  // ── Pass 2：Layout（由上而下）───────────────────────────────────────────

  private _layout(node: LayoutNode, parentX: number, parentY: number, working: WorkingMap): void {
    const box = working.get(node.id)!
    box.x = parentX
    box.y = parentY

    if (node.direction === 'NONE') {
      this._layoutAbsolute(node, working)
    } else {
      this._layoutAuto(node, working)
    }
  }

  /** 絕對定位佈局（parent.direction === 'NONE'）。 */
  private _layoutAbsolute(parent: LayoutNode, working: WorkingMap): void {
    const parentBox = working.get(parent.id)!
    const cx = parentBox.x + parent.padding.left
    const cy = parentBox.y + parent.padding.top
    const cw = parentBox.width - parent.padding.left - parent.padding.right
    const ch = parentBox.height - parent.padding.top - parent.padding.bottom

    for (const child of parent.children) {
      const childBox = working.get(child.id)!
      if (child.widthMode === 'FILL') childBox.width = clamp(cw, child.minWidth, child.maxWidth)
      if (child.heightMode === 'FILL') childBox.height = clamp(ch, child.minHeight, child.maxHeight)

      const pos = this._applyConstraints(child, cx, cy, cw, ch, working)
      this._layout(child, pos.x, pos.y, working)
    }
  }

  /** 自動佈局（parent.direction === 'HORIZONTAL' | 'VERTICAL'）。 */
  private _layoutAuto(parent: LayoutNode, working: WorkingMap): void {
    const parentBox = working.get(parent.id)!
    const isH = parent.direction === 'HORIZONTAL'
    const cx = parentBox.x + parent.padding.left
    const cy = parentBox.y + parent.padding.top
    const cw = parentBox.width - parent.padding.left - parent.padding.right
    const ch = parentBox.height - parent.padding.top - parent.padding.bottom

    const flow = parent.children.filter(c => !c.isAbsolute)
    const abs = parent.children.filter(c => c.isAbsolute)

    // ── 修正橫軸 FILL（Pass 2 覆蓋 tentative size）────────────────────────
    // 注意：此修正不會重新 measure 孫層，巢狀 FILL-in-FILL 需額外處理。
    for (const child of flow) {
      const box = working.get(child.id)!
      if (isH && child.heightMode === 'FILL') box.height = clamp(ch, child.minHeight, child.maxHeight)
      if (!isH && child.widthMode === 'FILL') box.width = clamp(cw, child.minWidth, child.maxWidth)
    }

    // ── 主軸 FILL 分配（依 flexGrow 等比例）──────────────────────────────
    const mainSize = (c: LayoutNode) => {
      const b = working.get(c.id)!
      return isH ? b.width : b.height
    }
    const mainAvail = isH ? cw : ch
    const fixedTotal = flow
      .filter(c => (isH ? c.widthMode : c.heightMode) !== 'FILL')
      .reduce((s, c) => s + mainSize(c), 0)
    const gapTotal = flow.length > 1 ? parent.gap * (flow.length - 1) : 0
    const remaining = Math.max(0, mainAvail - fixedTotal - gapTotal)

    const fillChildren = flow.filter(c => (isH ? c.widthMode : c.heightMode) === 'FILL')
    const totalFlexGrow = fillChildren.reduce((s, c) => s + (c.flexGrow || 1), 0)

    for (const child of fillChildren) {
      const box = working.get(child.id)!
      const grow = child.flexGrow || 1
      const size = totalFlexGrow > 0 ? remaining * (grow / totalFlexGrow) : 0
      if (isH) box.width = clamp(size, child.minWidth, child.maxWidth)
      else box.height = clamp(size, child.minHeight, child.maxHeight)
    }

    // ── 計算起始游標與項目間距 ────────────────────────────────────────────
    const totalMain = flow.reduce((s, c) => s + mainSize(c), 0) + gapTotal
    const { cursor: startCursor, itemGap } = this._justifyParams(
      isH ? cx : cy,
      isH ? cw : ch,
      totalMain,
      flow.length,
      parent.justifyContent,
      parent.gap,
    )

    // ── 放置流式子元素 ────────────────────────────────────────────────────
    let cursor = startCursor
    for (const child of flow) {
      const childBox = working.get(child.id)!
      const crossStart = isH ? cx : cy
      const crossAvail = isH ? ch : cw
      const crossSize = isH ? childBox.height : childBox.width
      const cross = this._alignCross(crossStart, crossAvail, crossSize, parent.alignItems)

      this._layout(child, isH ? cursor : cross, isH ? cross : cursor, working)
      cursor += mainSize(child) + itemGap
    }

    // ── 放置絕對定位子元素（Constraint 定位，不參與流式佈局）────────────────
    for (const child of abs) {
      const childBox = working.get(child.id)!
      if (child.widthMode === 'FILL') childBox.width = clamp(cw, child.minWidth, child.maxWidth)
      if (child.heightMode === 'FILL') childBox.height = clamp(ch, child.minHeight, child.maxHeight)
      const pos = this._applyConstraints(child, cx, cy, cw, ch, working)
      this._layout(child, pos.x, pos.y, working)
    }
  }

  // ── Constraint 解析 ────────────────────────────────────────────────────────

  private _applyConstraints(
    child: LayoutNode,
    px: number,
    py: number,
    pw: number,
    ph: number,
    working: WorkingMap,
  ): { x: number; y: number } {
    const box = working.get(child.id)!
    let x = px + child.x
    let y = py + child.y

    switch (child.hConstraint as HConstraint) {
      case 'LEFT':
        x = px + child.x
        break
      case 'RIGHT':
        x = px + pw - child.x - box.width
        break
      case 'CENTER':
        x = px + (pw - box.width) / 2
        break
      case 'SCALE':
        x = px + (child.x / 1000) * pw
        // 修正三：不覆蓋 HUG 節點的尺寸（HUG 由子元素 bounding box 決定）
        if (child.widthMode !== 'HUG') {
          box.width = clamp((child.width / 1000) * pw, child.minWidth, child.maxWidth)
        }
        break
      case 'STRETCH':
        // 注意：STRETCH 模式下，child.x = 左邊距，child.width = 右邊距（語義轉換）
        x = px + child.x
        if (child.widthMode !== 'HUG') {
          box.width = clamp(pw - child.x - child.width, child.minWidth, child.maxWidth)
        }
        break
    }

    switch (child.vConstraint as VConstraint) {
      case 'TOP':
        y = py + child.y
        break
      case 'BOTTOM':
        y = py + ph - child.y - box.height
        break
      case 'CENTER':
        y = py + (ph - box.height) / 2
        break
      case 'SCALE':
        y = py + (child.y / 1000) * ph
        if (child.heightMode !== 'HUG') {
          box.height = clamp((child.height / 1000) * ph, child.minHeight, child.maxHeight)
        }
        break
      case 'STRETCH':
        // 注意：STRETCH 模式下，child.y = 上邊距，child.height = 下邊距（語義轉換）
        y = py + child.y
        if (child.heightMode !== 'HUG') {
          box.height = clamp(ph - child.y - child.height, child.minHeight, child.maxHeight)
        }
        break
    }

    return { x, y }
  }

  // ── Justify / Align 輔助 ────────────────────────────────────────────────────

  private _justifyParams(
    start: number,
    available: number,
    totalMain: number,
    count: number,
    justify: JustifyContent,
    declaredGap: number,
  ): { cursor: number; itemGap: number } {
    switch (justify) {
      case 'START':
        return { cursor: start, itemGap: declaredGap }
      case 'END':
        return { cursor: start + available - totalMain, itemGap: declaredGap }
      case 'CENTER':
        return { cursor: start + (available - totalMain) / 2, itemGap: declaredGap }
      case 'SPACE_BETWEEN':
        return {
          cursor: start,
          // 修正四：子元素總寬超出容器時，itemGap 可能為負（重疊），用 Math.max(0) 保護
          itemGap:
            count > 1
              ? Math.max(0, (available - (totalMain - declaredGap * (count - 1))) / (count - 1))
              : 0,
        }
    }
  }

  private _alignCross(start: number, available: number, size: number, align: AlignItems): number {
    switch (align) {
      case 'START':
        return start
      case 'END':
        return start + available - size
      case 'CENTER':
        return start + (available - size) / 2
    }
  }

  // ── 尺寸解析 ────────────────────────────────────────────────────────────────

  private _resolveSize(mode: SizeMode, declared: number, available: number, min: number, max: number): number {
    switch (mode) {
      case 'FIXED':
        return clamp(declared, min, max)
      case 'FILL':
        return clamp(available, min, max) // tentative；Pass 2 修正
      case 'HUG':
        return clamp(declared, min, max) // placeholder；_measure 後由 bounding box 覆蓋
    }
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const layoutEngine = LayoutEngine.getInstance()
