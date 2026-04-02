import Konva from 'konva'
import type { CanvasElement, Paint } from '@/types/element'
import {
  ElementKind,
  ELEMENT_DEFAULT_FILL,
  ELEMENT_DEFAULT_STROKE,
  ELEMENT_DEFAULT_FONT_FAMILY,
  ELEMENT_DEFAULT_FONT_SIZE,
  POLYGON_DEFAULT_SIDES,
} from '@/types/element'
import { ToolType } from '@/types/tool'
import { COLOR_GHOST_FILL, COLOR_SELECTION } from '@/constants/canvas'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Point { x: number; y: number }

/**
 * Konva 需要的形狀屬性（fill / stroke 已由 Paint 轉為顏色字串）。
 * `selected` 驅動條件渲染（Frame dash、Group border）但不傳入 Konva.setAttrs。
 */
export interface BaseShapeAttrs {
  readonly id:          string
  readonly fill:        string  // 已由 paintColor() 轉換的 CSS 顏色字串
  readonly stroke:      string
  readonly strokeWidth: number
  readonly opacity:     number
  readonly rotation:    number
  readonly selected:    boolean
}

/**
 * 所有形狀共用的基礎 strategy 介面。
 * build / patch 用於 diff render；createElement 用於確認繪製手勢。
 */
export interface ShapeRenderer {
  readonly konvaClassName: string
  readonly elementKinds:   ReadonlyArray<ElementKind>
  readonly toolTypes:      ReadonlyArray<ToolType>
  build(el: CanvasElement, attrs: BaseShapeAttrs): Konva.Shape
  patch(shape: Konva.Shape, el: CanvasElement, attrs: BaseShapeAttrs): void
  createElement(tool: ToolType, start: Point, end: Point): Omit<CanvasElement, 'id' | 'name'> | null
}

/**
 * 可繪製形狀的 strategy 介面（extends ShapeRenderer）。
 * 只有 ALL_DRAWABLES 中的 renderer 實作此介面；GroupRenderer 不實作。
 * RENDERER_BY_TOOL 的值型別為 DrawableRenderer，呼叫端無需額外 type guard。
 *
 * @param strokeW 世界單位線寬（呼叫端通常傳入 1 / viewport.scale，使 ghost 在螢幕上恆定粗細）。
 */
export interface DrawableRenderer extends ShapeRenderer {
  buildGhost(start: Point, strokeW: number): Konva.Shape
  updateGhost(ghost: Konva.Shape, start: Point, current: Point): void
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * 將 Paint 轉為 Konva / CSS 顏色字串。
 * 目前只支援 SolidPaint（type: 'solid'），其他 type 回傳 fallback 並在 DEV 發出警告。
 */
export function paintColor(paint: Paint | undefined, fallback = 'transparent'): string {
  if (!paint) return fallback
  if (paint.type === 'solid') return paint.color
  if (import.meta.env.DEV) {
    console.warn(`[paintColor] unsupported Paint type: ${(paint as Paint).type}`)
  }
  return fallback
}

const GHOST_STYLE = {
  fill: COLOR_GHOST_FILL, stroke: COLOR_SELECTION, listening: false,
} as const

interface RectGeom { x: number; y: number; width: number; height: number }

function rectGeom(start: Point, end: Point): RectGeom {
  return {
    x:      Math.min(start.x, end.x),
    y:      Math.min(start.y, end.y),
    width:  Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

/**
 * 移除 `selected` 再傳入 Konva.setAttrs。
 * 回傳物件包含 fill；若 renderer 需覆蓋 fill（如 LineRenderer），
 * 必須在 spread 之後再指定，確保覆蓋順序正確。
 */
function konvaAttrs({ selected: _, ...rest }: BaseShapeAttrs) { return rest }

function elementDefaults(): Pick<
  CanvasElement,
  'rotation' | 'scaleX' | 'scaleY' | 'opacity' | 'visible' | 'locked' | 'childIds' | 'parentId'
> {
  return { rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, visible: true, locked: false, childIds: [], parentId: undefined }
}

/**
 * 所有矩形邊界形狀的共用 createElement 邏輯。
 * 門檻：width < 2 **且** height < 2 才拒絕，允許細長形狀（如 divider）。
 */
function rectBoundedElement(
  kind:  ElementKind,
  start: Point,
  end:   Point,
  fill:  Paint = ELEMENT_DEFAULT_FILL,
): Omit<CanvasElement, 'id' | 'name'> | null {
  const { x, y, width, height } = rectGeom(start, end)
  if (width < 2 && height < 2) return null
  return { ...elementDefaults(), kind, x, y, width, height, fill, stroke: ELEMENT_DEFAULT_STROKE, strokeWidth: 1 }
}

function buildMap<K, V>(entries: [K, V][], label: string): Map<K, V> {
  const map = new Map<K, V>()
  for (const [k, v] of entries) {
    if (import.meta.env.DEV && map.has(k)) {
      console.warn(`[ShapeRenderer] duplicate key in ${label}:`, k)
    }
    map.set(k, v)
  }
  return map
}

// ── Rect / Frame ───────────────────────────────────────────────────────────────

class RectFrameRenderer implements DrawableRenderer {
  readonly konvaClassName = 'Rect'
  readonly elementKinds   = [ElementKind.Rect, ElementKind.Frame] as const
  readonly toolTypes      = [ToolType.Rect,    ToolType.Frame   ] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return {
      ...konvaAttrs(attrs),
      x: el.x, y: el.y, width: el.width, height: el.height,
      cornerRadius: el.cornerRadius ?? 0,
      // Frame：未選取時顯示虛線邊框；必須明確傳 [] 清除，Konva.setAttrs 不自動重設省略的屬性。
      // TODO: 升級 Konva 版本時驗證 dash: [] 能正確清除（部分舊版需傳 undefined）。
      dash: el.kind === ElementKind.Frame && !attrs.selected ? [6, 3] : [],
    }
  }

  build(el: CanvasElement, attrs: BaseShapeAttrs): Konva.Shape { return new Konva.Rect(this.toConfig(el, attrs)) }
  patch(shape: Konva.Shape, el: CanvasElement, attrs: BaseShapeAttrs): void { shape.setAttrs(this.toConfig(el, attrs)) }
  buildGhost(start: Point, strokeW: number): Konva.Shape {
    return new Konva.Rect({ ...GHOST_STYLE, x: start.x, y: start.y, width: 0, height: 0, strokeWidth: strokeW })
  }
  updateGhost(ghost: Konva.Shape, start: Point, current: Point): void { ghost.setAttrs(rectGeom(start, current)) }
  createElement(tool: ToolType, start: Point, end: Point) {
    return rectBoundedElement(tool === ToolType.Frame ? ElementKind.Frame : ElementKind.Rect, start, end)
  }
}

// ── Ellipse ────────────────────────────────────────────────────────────────────

class EllipseRenderer implements DrawableRenderer {
  readonly konvaClassName = 'Ellipse'
  readonly elementKinds   = [ElementKind.Ellipse] as const
  readonly toolTypes      = [ToolType.Ellipse   ] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return {
      ...konvaAttrs(attrs),
      x: el.x + el.width / 2, y: el.y + el.height / 2,
      radiusX: el.width / 2,  radiusY: el.height / 2,
    }
  }

  build(el: CanvasElement, attrs: BaseShapeAttrs): Konva.Shape { return new Konva.Ellipse(this.toConfig(el, attrs)) }
  patch(shape: Konva.Shape, el: CanvasElement, attrs: BaseShapeAttrs): void { shape.setAttrs(this.toConfig(el, attrs)) }
  buildGhost(start: Point, strokeW: number): Konva.Shape {
    return new Konva.Ellipse({ ...GHOST_STYLE, x: start.x, y: start.y, radiusX: 0, radiusY: 0, strokeWidth: strokeW })
  }
  updateGhost(ghost: Konva.Shape, start: Point, current: Point): void {
    const { x, y, width, height } = rectGeom(start, current)
    ghost.setAttrs({ x: x + width / 2, y: y + height / 2, radiusX: width / 2, radiusY: height / 2 })
  }
  createElement(_tool: ToolType, start: Point, end: Point) { return rectBoundedElement(ElementKind.Ellipse, start, end) }
}

// ── Line ───────────────────────────────────────────────────────────────────────

class LineRenderer implements DrawableRenderer {
  readonly konvaClassName = 'Line'
  readonly elementKinds   = [ElementKind.Line] as const
  readonly toolTypes      = [ToolType.Line   ] as const

  /**
   * ⚠️ fill 必須為 ''，且放在 spread 之後覆蓋。
   * Konva.Line 有 fill 時自動閉合成多邊形；明確覆蓋防止繼承 attrs.fill 的顏色。
   */
  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return { ...konvaAttrs(attrs), fill: '', x: el.x, y: el.y, points: [0, 0, el.width, el.height] }
  }

  build(el: CanvasElement, attrs: BaseShapeAttrs): Konva.Shape { return new Konva.Line(this.toConfig(el, attrs)) }
  patch(shape: Konva.Shape, el: CanvasElement, attrs: BaseShapeAttrs): void { shape.setAttrs(this.toConfig(el, attrs)) }
  buildGhost(start: Point, strokeW: number): Konva.Shape {
    return new Konva.Line({ stroke: COLOR_SELECTION, strokeWidth: strokeW, listening: false, points: [start.x, start.y, start.x, start.y] })
  }
  updateGhost(ghost: Konva.Shape, start: Point, current: Point): void {
    ghost.setAttrs({ points: [start.x, start.y, current.x, current.y] })
  }
  createElement(_tool: ToolType, start: Point, end: Point): Omit<CanvasElement, 'id' | 'name'> | null {
    const dw = end.x - start.x, dh = end.y - start.y
    if (Math.hypot(dw, dh) < 2) return null
    return { ...elementDefaults(), kind: ElementKind.Line, x: start.x, y: start.y, width: dw, height: dh, fill: { type: 'solid', color: 'transparent' }, stroke: ELEMENT_DEFAULT_STROKE, strokeWidth: 1 }
  }
}

// ── Polygon ────────────────────────────────────────────────────────────────────

class PolygonRenderer implements DrawableRenderer {
  readonly konvaClassName = 'RegularPolygon'
  readonly elementKinds   = [ElementKind.Polygon] as const
  readonly toolTypes      = [ToolType.Polygon   ] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return { ...konvaAttrs(attrs), x: el.x + el.width / 2, y: el.y + el.height / 2, sides: POLYGON_DEFAULT_SIDES, radius: Math.min(el.width, el.height) / 2 }
  }

  build(el: CanvasElement, attrs: BaseShapeAttrs): Konva.Shape { return new Konva.RegularPolygon(this.toConfig(el, attrs)) }
  patch(shape: Konva.Shape, el: CanvasElement, attrs: BaseShapeAttrs): void { shape.setAttrs(this.toConfig(el, attrs)) }
  buildGhost(start: Point, strokeW: number): Konva.Shape {
    return new Konva.RegularPolygon({ ...GHOST_STYLE, x: start.x, y: start.y, sides: POLYGON_DEFAULT_SIDES, radius: 0, strokeWidth: strokeW })
  }
  updateGhost(ghost: Konva.Shape, start: Point, current: Point): void {
    const { x, y, width, height } = rectGeom(start, current)
    ghost.setAttrs({ x: x + width / 2, y: y + height / 2, radius: Math.min(width, height) / 2 })
  }
  createElement(_tool: ToolType, start: Point, end: Point) { return rectBoundedElement(ElementKind.Polygon, start, end) }
}

// ── Text ───────────────────────────────────────────────────────────────────────

class TextRenderer implements DrawableRenderer {
  readonly konvaClassName = 'Text'
  readonly elementKinds   = [ElementKind.Text] as const
  readonly toolTypes      = [ToolType.Text   ] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return {
      ...konvaAttrs(attrs), x: el.x, y: el.y, width: el.width,
      text: el.text ?? 'Text', fontSize: el.fontSize ?? ELEMENT_DEFAULT_FONT_SIZE, fontFamily: el.fontFamily ?? ELEMENT_DEFAULT_FONT_FAMILY,
    }
  }

  build(el: CanvasElement, attrs: BaseShapeAttrs): Konva.Shape { return new Konva.Text(this.toConfig(el, attrs)) }
  patch(shape: Konva.Shape, el: CanvasElement, attrs: BaseShapeAttrs): void { shape.setAttrs(this.toConfig(el, attrs)) }
  buildGhost(start: Point, strokeW: number): Konva.Shape {
    return new Konva.Rect({ ...GHOST_STYLE, x: start.x, y: start.y, width: 0, height: 0, strokeWidth: strokeW })
  }
  updateGhost(ghost: Konva.Shape, start: Point, current: Point): void { ghost.setAttrs(rectGeom(start, current)) }
  createElement(_tool: ToolType, start: Point, end: Point): Omit<CanvasElement, 'id' | 'name'> | null {
    return rectBoundedElement(ElementKind.Text, start, end, { type: 'solid', color: 'transparent' })
  }
}

// ── Group ──────────────────────────────────────────────────────────────────────

/**
 * GroupRenderer 只實作 ShapeRenderer，不實作 DrawableRenderer。
 * toolTypes 為空，不加入 ALL_DRAWABLES，RENDERER_BY_TOOL 中不存在 Group，
 * 從型別與資料層面同時防止誤呼叫 buildGhost。
 */
class GroupRenderer implements ShapeRenderer {
  readonly konvaClassName = 'Rect'
  readonly elementKinds   = [ElementKind.Group] as const
  readonly toolTypes      = [] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return {
      id: attrs.id, x: el.x, y: el.y, width: el.width, height: el.height,
      opacity: el.opacity, rotation: el.rotation, fill: '',
      stroke:      attrs.selected ? COLOR_SELECTION : 'rgba(148,163,184,0.4)',
      strokeWidth: attrs.strokeWidth,
      dash:        attrs.selected ? [] : [4, 4],
      listening:   false,
    }
  }

  build(el: CanvasElement, attrs: BaseShapeAttrs): Konva.Shape { return new Konva.Rect(this.toConfig(el, attrs)) }
  patch(shape: Konva.Shape, el: CanvasElement, attrs: BaseShapeAttrs): void { shape.setAttrs(this.toConfig(el, attrs)) }
  createElement(_tool: ToolType, _start: Point, _end: Point): null { return null }
}

// ── Auto-registration ──────────────────────────────────────────────────────────

/**
 * 可繪製形狀列表（實作 DrawableRenderer）。
 * 型別由編譯器驗證，無需 as 斷言，防止日後誤加未實作 DrawableRenderer 的 renderer。
 */
const ALL_DRAWABLES: DrawableRenderer[] = [
  new RectFrameRenderer(),
  new EllipseRenderer(),
  new LineRenderer(),
  new PolygonRenderer(),
  new TextRenderer(),
]

/** 所有形狀（含不可繪製的 Group）。 */
const ALL_RENDERERS: ShapeRenderer[] = [
  ...ALL_DRAWABLES,
  new GroupRenderer(),
]

/** 依 ElementKind 查詢（diff render 的 build / patch）。 */
export const RENDERER_BY_KIND = buildMap<ElementKind, ShapeRenderer>(
  ALL_RENDERERS.flatMap(r => r.elementKinds.map(k => [k, r] as const)),
  'RENDERER_BY_KIND',
)

/**
 * 依 ToolType 查詢（繪製手勢的 buildGhost / updateGhost / createElement）。
 * 值型別為 DrawableRenderer，編譯器保證不含 GroupRenderer。
 */
export const RENDERER_BY_TOOL = buildMap<ToolType, DrawableRenderer>(
  ALL_DRAWABLES.flatMap(r => r.toolTypes.map(t => [t, r] as const)),
  'RENDERER_BY_TOOL',
)
