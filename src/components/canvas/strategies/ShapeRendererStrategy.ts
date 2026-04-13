import Konva from 'konva'
import type { CanvasElement, Paint, VectorPoint } from '@/types/element'
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

export interface Point {
  x: number
  y: number
}

export interface BaseShapeAttrs {
  readonly id: string
  readonly fill: string
  readonly stroke: string
  readonly strokeWidth: number
  readonly opacity: number
  readonly rotation: number
  readonly selected: boolean
}

export interface ShapeRenderer {
  readonly konvaClassName: string
  readonly elementKinds: ReadonlyArray<ElementKind>
  readonly toolTypes: ReadonlyArray<ToolType>
  build(el: CanvasElement, attrs: BaseShapeAttrs): Konva.Shape
  patch(shape: Konva.Shape, el: CanvasElement, attrs: BaseShapeAttrs): void
  createElement(tool: ToolType, start: Point, end: Point): Omit<CanvasElement, 'id' | 'name'> | null
}

export interface DrawableRenderer extends ShapeRenderer {
  buildGhost(start: Point, strokeW: number): Konva.Shape
  updateGhost(ghost: Konva.Shape, start: Point, current: Point): void
}

export function paintColor(paint: Paint | undefined, fallback = 'transparent'): string {
  if (!paint) return fallback
  if (paint.type === 'solid') return paint.color
  if (import.meta.env.DEV) {
    console.warn(`[paintColor] unsupported Paint type: ${String((paint as Paint).type)}`)
  }
  return fallback
}

const GHOST_STYLE = {
  fill: COLOR_GHOST_FILL,
  stroke: COLOR_SELECTION,
  listening: false,
} as const

const LINE_HIT_STROKE_W = 8

interface RectGeom {
  x: number
  y: number
  width: number
  height: number
}

function rectGeom(start: Point, end: Point): RectGeom {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

function konvaAttrs({ selected: _, ...rest }: BaseShapeAttrs) {
  return rest
}

function elementDefaults(): Pick<
  CanvasElement,
  'rotation' | 'scaleX' | 'scaleY' | 'opacity' | 'visible' | 'locked' | 'childIds' | 'parentId'
> {
  return {
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    visible: true,
    locked: false,
    childIds: [],
    parentId: undefined,
  }
}

function rectBoundedElement(
  kind: ElementKind,
  start: Point,
  end: Point,
  fill: Paint = ELEMENT_DEFAULT_FILL,
): Omit<CanvasElement, 'id' | 'name'> | null {
  const { x, y, width, height } = rectGeom(start, end)
  if (width < 2 && height < 2) return null
  return { ...elementDefaults(), kind, x, y, width, height, fill, stroke: ELEMENT_DEFAULT_STROKE, strokeWidth: 1 }
}

function buildMap<K, V>(entries: ReadonlyArray<readonly [K, V]>, label: string): Map<K, V> {
  const map = new Map<K, V>()
  for (const [k, v] of entries) {
    if (import.meta.env.DEV && map.has(k)) {
      console.warn(`[ShapeRenderer] duplicate key in ${label}:`, k)
    }
    map.set(k, v)
  }
  return map
}

function hasBezierHandle(point: VectorPoint | undefined, key: 'handleIn' | 'handleOut'): boolean {
  const handle = point?.[key]
  if (!point || !handle) return false
  return handle.x !== point.x || handle.y !== point.y
}

export function traceVectorPath(
  ctx: Konva.Context,
  points: VectorPoint[],
  closed: boolean,
  previewEnd?: Point | null,
): void {
  // 統一路徑描邊邏輯：正式 Vector 與 Pen 預覽都走同一套 path 組裝，避免兩邊行為漂移。
  if (points.length === 0) return

  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const curr = points[i]
    const cp1 = prev.handleOut ?? prev
    const cp2 = curr.handleIn ?? curr

    if (hasBezierHandle(prev, 'handleOut') || hasBezierHandle(curr, 'handleIn')) {
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, curr.x, curr.y)
    } else {
      ctx.lineTo(curr.x, curr.y)
    }
  }

  if (previewEnd) {
    const last = points.at(-1)!
    const cp1 = last.handleOut ?? last
    if (hasBezierHandle(last, 'handleOut')) {
      ctx.bezierCurveTo(cp1.x, cp1.y, previewEnd.x, previewEnd.y, previewEnd.x, previewEnd.y)
    } else {
      ctx.lineTo(previewEnd.x, previewEnd.y)
    }
  }

  if (closed && points.length > 1) {
    const last = points.at(-1)!
    const first = points[0]
    const cp1 = last.handleOut ?? last
    const cp2 = first.handleIn ?? first
    if (hasBezierHandle(last, 'handleOut') || hasBezierHandle(first, 'handleIn')) {
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, first.x, first.y)
    } else {
      ctx.lineTo(first.x, first.y)
    }
    ctx.closePath()
  }
}

class RectFrameRenderer implements DrawableRenderer {
  readonly konvaClassName = 'Rect'
  readonly elementKinds = [ElementKind.Rect, ElementKind.Frame] as const
  readonly toolTypes = [ToolType.Rect, ToolType.Frame] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return {
      ...konvaAttrs(attrs),
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      cornerRadius: el.cornerRadius ?? 0,
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

class EllipseRenderer implements DrawableRenderer {
  readonly konvaClassName = 'Ellipse'
  readonly elementKinds = [ElementKind.Ellipse] as const
  readonly toolTypes = [ToolType.Ellipse] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return {
      ...konvaAttrs(attrs),
      x: el.x + el.width / 2,
      y: el.y + el.height / 2,
      radiusX: el.width / 2,
      radiusY: el.height / 2,
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

class LineRenderer implements DrawableRenderer {
  readonly konvaClassName = 'Line'
  readonly elementKinds = [ElementKind.Line] as const
  readonly toolTypes = [ToolType.Line] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return {
      ...konvaAttrs(attrs),
      fill: '',
      x: el.x,
      y: el.y,
      points: [0, 0, el.width, el.height],
      hitStrokeWidth: Math.max(el.strokeWidth, LINE_HIT_STROKE_W),
    }
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
    const dw = end.x - start.x
    const dh = end.y - start.y
    if (Math.hypot(dw, dh) < 2) return null
    return {
      ...elementDefaults(),
      kind: ElementKind.Line,
      x: start.x,
      y: start.y,
      width: dw,
      height: dh,
      fill: { type: 'solid', color: 'transparent' },
      stroke: ELEMENT_DEFAULT_STROKE,
      strokeWidth: 1,
    }
  }
}

class PolygonRenderer implements DrawableRenderer {
  readonly konvaClassName = 'RegularPolygon'
  readonly elementKinds = [ElementKind.Polygon] as const
  readonly toolTypes = [ToolType.Polygon] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return {
      ...konvaAttrs(attrs),
      x: el.x + el.width / 2,
      y: el.y + el.height / 2,
      sides: POLYGON_DEFAULT_SIDES,
      radius: Math.min(el.width, el.height) / 2,
    }
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

class VectorRenderer implements DrawableRenderer {
  readonly konvaClassName = 'Shape'
  readonly elementKinds = [ElementKind.Vector] as const
  readonly toolTypes = [ToolType.Pen] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    const points = el.vectorPoints ?? []
    return {
      ...konvaAttrs(attrs),
      x: el.x,
      y: el.y,
      // 開放路徑不應填色，閉合路徑才套用 fill，這與 Figma 的 Vector 行為一致。
      fill: el.closed ? attrs.fill : '',
      hitStrokeWidth: Math.max(el.strokeWidth, LINE_HIT_STROKE_W),
      sceneFunc: (ctx: Konva.Context, shape: Konva.Shape) => {
        traceVectorPath(ctx, points, Boolean(el.closed))
        ctx.fillStrokeShape(shape)
      },
    }
  }

  build(el: CanvasElement, attrs: BaseShapeAttrs): Konva.Shape { return new Konva.Shape(this.toConfig(el, attrs)) }
  patch(shape: Konva.Shape, el: CanvasElement, attrs: BaseShapeAttrs): void { shape.setAttrs(this.toConfig(el, attrs)) }
  buildGhost(start: Point, strokeW: number): Konva.Shape {
    return new Konva.Shape({
      ...GHOST_STYLE,
      x: 0,
      y: 0,
      strokeWidth: strokeW,
      vectorPoints: [{ x: start.x, y: start.y }],
      previewEnd: null,
      closed: false,
      // 預覽 shape 也重用 traceVectorPath，讓 hover/closing feedback 與正式渲染保持一致。
      sceneFunc: (ctx: Konva.Context, shape: Konva.Shape) => {
        traceVectorPath(
          ctx,
          (shape.getAttr('vectorPoints') as VectorPoint[]) ?? [],
          Boolean(shape.getAttr('closed')),
          (shape.getAttr('previewEnd') as Point | null) ?? null,
        )
        ctx.fillStrokeShape(shape)
      },
    })
  }
  updateGhost(ghost: Konva.Shape, start: Point, current: Point): void {
    ghost.setAttrs({ vectorPoints: [{ x: start.x, y: start.y }], previewEnd: current })
  }
  createElement(_tool: ToolType, start: Point, end: Point): Omit<CanvasElement, 'id' | 'name'> | null {
    if (Math.hypot(end.x - start.x, end.y - start.y) < 2) return null
    const minY = Math.min(start.y, end.y)
    const height = Math.abs(end.y - start.y)
    return {
      ...elementDefaults(),
      kind: ElementKind.Vector,
      x: start.x,
      y: minY,
      width: Math.abs(end.x - start.x),
      height,
      vectorPoints: [
        { x: 0, y: start.y <= end.y ? 0 : height },
        { x: end.x - start.x, y: start.y <= end.y ? height : 0 },
      ],
      closed: false,
      fill: { type: 'solid', color: 'transparent' },
      stroke: ELEMENT_DEFAULT_STROKE,
      strokeWidth: 1,
    }
  }
}

class TextRenderer implements DrawableRenderer {
  readonly konvaClassName = 'Text'
  readonly elementKinds = [ElementKind.Text] as const
  readonly toolTypes = [ToolType.Text] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return {
      ...konvaAttrs(attrs),
      x: el.x,
      y: el.y,
      width: el.width,
      text: el.text ?? 'Text',
      fontSize: el.fontSize ?? ELEMENT_DEFAULT_FONT_SIZE,
      fontFamily: el.fontFamily ?? ELEMENT_DEFAULT_FONT_FAMILY,
    }
  }

  build(el: CanvasElement, attrs: BaseShapeAttrs): Konva.Shape { return new Konva.Text(this.toConfig(el, attrs)) }
  patch(shape: Konva.Shape, el: CanvasElement, attrs: BaseShapeAttrs): void { shape.setAttrs(this.toConfig(el, attrs)) }
  buildGhost(start: Point, strokeW: number): Konva.Shape {
    return new Konva.Rect({ ...GHOST_STYLE, x: start.x, y: start.y, width: 0, height: 0, strokeWidth: strokeW })
  }
  updateGhost(ghost: Konva.Shape, start: Point, current: Point): void { ghost.setAttrs(rectGeom(start, current)) }
  createElement(_tool: ToolType, start: Point, end: Point): Omit<CanvasElement, 'id' | 'name'> | null {
    const { x, y, width, height } = rectGeom(start, end)
    if (width < 2 && height < 2) {
      return {
        ...elementDefaults(),
        kind: ElementKind.Text,
        x: start.x,
        y: start.y,
        width: 200,
        height: ELEMENT_DEFAULT_FONT_SIZE * 1.5,
        text: 'Text',
        // Text 的 fill 是實際字色，不能像一般圖形預設透明，否則一旦失去選取就會看起來消失。
        fill: ELEMENT_DEFAULT_FILL,
        stroke: ELEMENT_DEFAULT_STROKE,
        strokeWidth: 0,
      }
    }
    return {
      ...elementDefaults(),
      kind: ElementKind.Text,
      x,
      y,
      width,
      height,
      text: 'Text',
      fill: ELEMENT_DEFAULT_FILL,
      stroke: ELEMENT_DEFAULT_STROKE,
      strokeWidth: 0,
    }
  }
}

class GroupRenderer implements ShapeRenderer {
  readonly konvaClassName = 'Rect'
  readonly elementKinds = [ElementKind.Group] as const
  readonly toolTypes = [] as const

  private toConfig(el: CanvasElement, attrs: BaseShapeAttrs) {
    return {
      id: attrs.id,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      opacity: el.opacity,
      rotation: el.rotation,
      fill: '',
      stroke: attrs.selected ? COLOR_SELECTION : 'rgba(148,163,184,0.4)',
      strokeWidth: attrs.strokeWidth,
      dash: attrs.selected ? [] : [4, 4],
      listening: true,
    }
  }

  build(el: CanvasElement, attrs: BaseShapeAttrs): Konva.Shape { return new Konva.Rect(this.toConfig(el, attrs)) }
  patch(shape: Konva.Shape, el: CanvasElement, attrs: BaseShapeAttrs): void { shape.setAttrs(this.toConfig(el, attrs)) }
  createElement(_tool: ToolType, _start: Point, _end: Point): null { return null }
}

const ALL_DRAWABLES: DrawableRenderer[] = [
  new RectFrameRenderer(),
  new EllipseRenderer(),
  new LineRenderer(),
  new PolygonRenderer(),
  new VectorRenderer(),
  new TextRenderer(),
]

const ALL_RENDERERS: ShapeRenderer[] = [
  ...ALL_DRAWABLES,
  new GroupRenderer(),
]

export const RENDERER_BY_KIND = buildMap<ElementKind, ShapeRenderer>(
  ALL_RENDERERS.flatMap((renderer) => renderer.elementKinds.map((kind) => [kind, renderer] as const)),
  'RENDERER_BY_KIND',
)

export const RENDERER_BY_TOOL = buildMap<ToolType, DrawableRenderer>(
  ALL_DRAWABLES.flatMap((renderer) => renderer.toolTypes.map((tool) => [tool, renderer] as const)),
  'RENDERER_BY_TOOL',
)
