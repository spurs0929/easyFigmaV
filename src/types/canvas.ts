import type Konva from 'konva'
import type { Point } from '@/components/canvas/strategies/ShapeRendererStrategy'

// ── Gesture State Machine ──────────────────────────────────────────────────────

export type GestureState =
  | { kind: 'idle' }
  | { kind: 'panning';  stageX: number; stageY: number; px: number; py: number }
  | { kind: 'dragging'; startWorld: Point; starts: Array<{ id: string; x: number; y: number }> }
  | { kind: 'marquee';  start: Point; rect: Konva.Rect }
  | { kind: 'drawing';  start: Point; ghost: Konva.Shape }

// ── Context Menu ───────────────────────────────────────────────────────────────

export interface ContextMenuState {
  x:            number
  y:            number
  hasSelection: boolean
  canGroup:     boolean  // ≥2 elements selected
  canUngroup:   boolean  // ≥1 Group in selection
}
