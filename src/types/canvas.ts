import type Konva from 'konva'
import type { Point } from '@/components/canvas/strategies/ShapeRendererStrategy'
import type { VectorPoint } from '@/types/element'
import type { ElementStoreCheckpoint } from '@/store/element'

export type PenDraftPoint = VectorPoint

export type SelectionCornerHandle = 'tl' | 'tr' | 'br' | 'bl'

export type GestureState =
  | { kind: 'idle' }
  | { kind: 'panning'; stageX: number; stageY: number; px: number; py: number }
  | {
      kind: 'dragging'
      startWorld: Point
      starts: Array<{ id: string; x: number; y: number }>
      /** 按下時的文件。放開時內容若與它相同（拖回原位），就不產生 History。 */
      checkpoint: ElementStoreCheckpoint
    }
  | {
      kind: 'resizing'
      id: string
      handle: SelectionCornerHandle
      origin: { x: number; y: number; width: number; height: number }
      /** 按下時的文件。放開時內容若與它相同（縮放回原尺寸），就不產生 History。 */
      checkpoint: ElementStoreCheckpoint
    }
  | { kind: 'marquee'; start: Point; rect: Konva.Rect }
  | {
      kind: 'drawing'
      start: Point
      /** 預覽最後一次更新到的點。在畫布外放開時拿不到可信的放開座標，改用它建立元素。 */
      current: Point
      ghost: Konva.Shape
    }
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
