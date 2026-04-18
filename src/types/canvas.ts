import type Konva from 'konva'
import type { Point } from '@/components/canvas/strategies/ShapeRendererStrategy'
import type { VectorPoint } from '@/types/element'

export interface PenDraftPoint extends VectorPoint {}

export type SelectionCornerHandle = 'tl' | 'tr' | 'br' | 'bl'

export type GestureState =
  | { kind: 'idle' }
  | { kind: 'panning'; stageX: number; stageY: number; px: number; py: number }
  | { kind: 'dragging'; startWorld: Point; starts: Array<{ id: string; x: number; y: number }> }
  | {
    kind: 'resizing'
    id: string
    handle: SelectionCornerHandle
    origin: { x: number; y: number; width: number; height: number }
  }
  | { kind: 'marquee'; start: Point; rect: Konva.Rect }
  | { kind: 'drawing'; start: Point; ghost: Konva.Shape }
  | {
    kind: 'pen'
    points: PenDraftPoint[]
    path: Konva.Shape
    controls: Konva.Group
    pointerDown: boolean
    activeIndex: number
    dragOrigin: Point
    hoverPoint: Point | null
    closing: boolean
  }
  | {
    kind: 'pencil'
    points: PenDraftPoint[]
    path: Konva.Shape
    hoverPoint: Point
  }

export interface ContextMenuState {
  x: number
  y: number
  hasSelection: boolean
  canGroup: boolean
  canUngroup: boolean
}
