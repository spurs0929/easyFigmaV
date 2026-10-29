import { describe, expect, it } from 'vitest'
import type { Viewport } from '@/store/viewport'
import { ElementKind, type CanvasElement } from '@/types/element'
import { cullingService } from './ViewportCullingService'

// ─────────────────────────────────────────────────────────────────────────────
//  cull 的座標空間：根元素是世界座標，群組的子元素是相對父群組的 local 座標。
//  這裡的群組故意放在遠離世界原點的位置，讓「把 local 座標當成世界座標比較」
//  的錯誤一定會表現出來（子元素被裁掉，或該裁掉的沒有裁掉）。
//
//  容器 800 × 600、margin 預設 64：scale 1 且未平移時，視窗加上 margin 的
//  世界範圍是 x ∈ [-64, 864]、y ∈ [-64, 664]。
// ─────────────────────────────────────────────────────────────────────────────

const W = 800
const H = 600
const ORIGIN: Viewport = { x: 0, y: 0, scale: 1 }

function rect(id: string, patch: Partial<CanvasElement> = {}): CanvasElement {
  return {
    id,
    kind: ElementKind.Rect,
    name: id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    fill: { type: 'solid', color: '#ffffff' },
    stroke: { type: 'solid', color: '#000000' },
    strokeWidth: 1,
    opacity: 1,
    visible: true,
    locked: false,
    parentId: undefined,
    childIds: [],
    ...patch,
  }
}

function group(id: string, childIds: string[], patch: Partial<CanvasElement> = {}): CanvasElement {
  return rect(id, { kind: ElementKind.Group, childIds, ...patch })
}

function byIdOf(...elements: CanvasElement[]): Record<string, CanvasElement> {
  return Object.fromEntries(elements.map((el) => [el.id, el]))
}

function cullIds(
  rootIds: string[],
  byId: Record<string, CanvasElement>,
  viewport: Viewport = ORIGIN,
): string[] {
  return cullingService.cull(rootIds, byId, viewport, W, H).map((el) => el.id)
}

describe('ViewportCullingService.cull：群組子元素以 local 座標換算', () => {
  it('平移：群組在視窗內、子元素的 local 座標落在視窗外 → 子元素保留', () => {
    // 視窗往右平移 1000：世界範圍 x ∈ [936, 1864]。
    // 群組在世界 x 1100；子元素 local x 0（世界 1100），local 範圍 [0, 100] 不在視窗內。
    const byId = byIdOf(
      group('g', ['a', 'b'], { x: 1100, y: 100, width: 250, height: 110 }),
      rect('a', { parentId: 'g', x: 0, y: 0, width: 130, height: 60 }),
      rect('b', { parentId: 'g', x: 150, y: 10 }),
    )

    expect(cullIds(['g'], byId, { x: -1000, y: 0, scale: 1 })).toEqual(['g', 'a', 'b'])
  })

  it('放大：以群組為中心放大 3 倍 → 子元素保留', () => {
    // 游標在螢幕 (625, 355)（群組中心），scale 1 → 3：
    // viewport = { scale: 3, x: 625 - 625 * 3, y: 355 - 355 * 3 }
    // 世界範圍約 x ∈ [416.7, 683.3]，加上 margin 後約 x ∈ [395.3, 704.7]；
    // 子元素的 local 範圍 x ∈ [0, 250] 完全在外。
    const byId = byIdOf(
      group('g', ['a', 'b'], { x: 500, y: 300, width: 250, height: 110 }),
      rect('a', { parentId: 'g', x: 0, y: 0, width: 130, height: 60 }),
      rect('b', { parentId: 'g', x: 150, y: 10 }),
    )
    const zoomed: Viewport = { scale: 3, x: 625 - 625 * 3, y: 355 - 355 * 3 }

    expect(cullIds(['g'], byId, zoomed)).toEqual(['g', 'a', 'b'])
  })

  it('三層巢狀群組：每一層都以父群組的 local 座標判斷，整棵樹保留', () => {
    // outer 在世界 3000；inner 在 outer 內 local 100（世界 3100）；
    // innermost 在 inner 內 local 50（世界 3150）；leaf 在 innermost 內 local 10（世界 3160）。
    const byId = byIdOf(
      group('outer', ['inner', 'c'], { x: 3000, y: 3000, width: 400, height: 400 }),
      group('inner', ['innermost'], { parentId: 'outer', x: 100, y: 100, width: 200, height: 200 }),
      group('innermost', ['leaf'], { parentId: 'inner', x: 50, y: 50, width: 120, height: 120 }),
      rect('leaf', { parentId: 'innermost', x: 10, y: 10 }),
      rect('c', { parentId: 'outer', x: 300, y: 0 }),
    )

    expect(cullIds(['outer'], byId, { x: -2900, y: -2900, scale: 1 })).toEqual([
      'outer',
      'inner',
      'innermost',
      'leaf',
      'c',
    ])
  })

  it('三層巢狀群組：最內層子元素的世界座標在視窗外 → 只裁掉它', () => {
    // 視窗世界範圍 x ∈ [-64, 864]。outer 在 0、inner 在 local 300（世界 300）、
    // innermost 在 local 400（世界 700）；near 在 local 0（世界 700）保留，
    // far 在 local 300（世界 1000）超出視窗。
    const byId = byIdOf(
      group('outer', ['inner'], { x: 0, y: 0, width: 1500, height: 100 }),
      group('inner', ['innermost'], { parentId: 'outer', x: 300, y: 0, width: 1200, height: 100 }),
      group('innermost', ['near', 'far'], {
        parentId: 'inner',
        x: 400,
        y: 0,
        width: 400,
        height: 100,
      }),
      rect('near', { parentId: 'innermost', x: 0 }),
      rect('far', { parentId: 'innermost', x: 300 }),
    )

    expect(cullIds(['outer'], byId)).toEqual(['outer', 'inner', 'innermost', 'near'])
  })

  it('反向誤判：子元素的 local 座標在視窗內、世界座標在視窗外 → 裁掉', () => {
    // 群組在世界 500；子元素 local x 500 → 世界 [1000, 1100]，超出 864。
    const byId = byIdOf(
      group('g', ['inside', 'outside'], { x: 500, y: 0, width: 1000, height: 100 }),
      rect('inside', { parentId: 'g', x: 0 }),
      rect('outside', { parentId: 'g', x: 500 }),
    )

    expect(cullIds(['g'], byId)).toEqual(['g', 'inside'])
  })

  it('反向誤判（y 方向）：子元素的世界座標在視窗下方 → 裁掉', () => {
    // 群組在世界 y 300；子元素 local y 450 → 世界 [750, 850]，超出 664。
    const byId = byIdOf(
      group('g', ['inside', 'below'], { x: 0, y: 300, width: 100, height: 1000 }),
      rect('inside', { parentId: 'g', y: 0 }),
      rect('below', { parentId: 'g', y: 450 }),
    )

    expect(cullIds(['g'], byId)).toEqual(['g', 'inside'])
  })

  it('margin：子元素的世界座標只差在 margin 內時保留', () => {
    // 群組在世界 700；子元素 local x 150 → 世界 [850, 950]，左緣 850 ≤ 864。
    const byId = byIdOf(
      group('g', ['edge'], { x: 700, y: 0, width: 250, height: 100 }),
      rect('edge', { parentId: 'g', x: 150 }),
    )

    expect(cullIds(['g'], byId)).toEqual(['g', 'edge'])
  })
})

describe('ViewportCullingService.cull：既有行為不變', () => {
  it('根元素：在視窗內或 margin 內保留，超出 margin 裁掉', () => {
    const byId = byIdOf(
      rect('inside', { x: 100 }),
      rect('margin', { x: 850 }),
      rect('beyond', { x: 870 }),
      rect('far', { x: 5000, y: 5000 }),
    )

    expect(cullIds(['inside', 'margin', 'beyond', 'far'], byId)).toEqual(['inside', 'margin'])
  })

  it('隱藏的元素不輸出；隱藏的群組連同子孫都不輸出', () => {
    const byId = byIdOf(
      group('g', ['shown', 'hidden'], { x: 100, y: 100, width: 300, height: 100 }),
      rect('shown', { parentId: 'g', x: 0 }),
      rect('hidden', { parentId: 'g', x: 200, visible: false }),
      group('hiddenGroup', ['child'], { x: 100, y: 300, visible: false }),
      rect('child', { parentId: 'hiddenGroup' }),
    )

    expect(cullIds(['g', 'hiddenGroup'], byId)).toEqual(['g', 'shown'])
  })

  it('群組整個在畫面外 → 子元素一起裁掉，即使子元素的 local 座標落在視窗內', () => {
    const byId = byIdOf(
      group('g', ['a'], { x: 5000, y: 5000, width: 200, height: 200 }),
      rect('a', { parentId: 'g', x: 0, y: 0 }),
    )

    expect(cullIds(['g'], byId)).toEqual([])
  })

  it('群組剪枝規則不變：群組框在畫面外時不檢查子元素，即使子元素的世界座標在視窗內', () => {
    // 群組框被縮小過、包不住子元素（例如被縮放把手改過尺寸的舊群組）：
    // 群組框在世界 [1000, 1010]，在視窗外；子元素 local x -900 → 世界 [100, 200]。
    // 剪枝以群組框為準，子元素不會被檢查。
    const byId = byIdOf(
      group('g', ['a'], { x: 1000, y: 100, width: 10, height: 10 }),
      rect('a', { parentId: 'g', x: -900, y: 0 }),
    )

    expect(cullIds(['g'], byId)).toEqual([])
  })

  it('輸出順序：前序走訪，父元素在子元素前，兄弟依 childIds / rootIds 的順序', () => {
    // 整棵樹放在遠處，同時確認順序在需要換算座標時也不變。
    const byId = byIdOf(
      rect('before', { x: 4100, y: 4100 }),
      group('g', ['c1', 'nested', 'c3'], { x: 4300, y: 4100, width: 400, height: 300 }),
      rect('c1', { parentId: 'g', x: 0, y: 0 }),
      group('nested', ['n1', 'n2'], { parentId: 'g', x: 150, y: 0, width: 200, height: 200 }),
      rect('n1', { parentId: 'nested', x: 100, y: 0 }),
      rect('n2', { parentId: 'nested', x: 0, y: 100 }),
      rect('c3', { parentId: 'g', x: 0, y: 200 }),
      rect('after', { x: 4100, y: 4300 }),
    )

    expect(cullIds(['before', 'g', 'after'], byId, { x: -4000, y: -4000, scale: 1 })).toEqual([
      'before',
      'g',
      'c1',
      'nested',
      'n1',
      'n2',
      'c3',
      'after',
    ])
  })
})

describe('ViewportCullingService.getRotatedBounds：群組的 rotation 不生效（Batch G）', () => {
  it('群組忽略 rotation，回傳未旋轉的框', () => {
    expect(
      cullingService.getRotatedBounds(
        group('g', [], { x: 0, y: 300, width: 600, height: 100, rotation: 90 }),
      ),
    ).toEqual({ left: 0, top: 300, right: 600, bottom: 400 })
  })

  it('一般矩形 rotation 30：以中心為軸的外接矩形維持原本的數值', () => {
    const bounds = cullingService.getRotatedBounds(rect('r', { rotation: 30 }))

    expect(bounds.left).toBeCloseTo(-18.3012701892219, 10)
    expect(bounds.top).toBeCloseTo(-18.3012701892219, 10)
    expect(bounds.right).toBeCloseTo(118.3012701892219, 10)
    expect(bounds.bottom).toBeCloseTo(118.3012701892219, 10)
  })

  it('已旋轉 90° 的長條群組：視窗只看到右半邊時，群組與畫面內的子元素保留', () => {
    // 視窗世界範圍 x ∈ [480, 1280]（加 margin 後 [416, 1344]）：r 在 [500, 600]，l 在 [0, 100]。
    const byId = byIdOf(
      group('g', ['l', 'r'], { x: 0, y: 300, width: 600, height: 100, rotation: 90 }),
      rect('l', { parentId: 'g', x: 0, y: 0 }),
      rect('r', { parentId: 'g', x: 500, y: 0 }),
    )

    expect(cullIds(['g'], byId, { x: -480, y: 0, scale: 1 })).toEqual(['g', 'r'])
  })
})
