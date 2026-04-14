<script setup lang="ts">
import { ref, computed, watch, watchEffect, onMounted, onUnmounted, nextTick } from 'vue'
import Konva from 'konva'
import { useElementStore } from '@/store/element'
import { useViewportStore } from '@/store/viewport'
import { useToolStore } from '@/store/tool'
import {
  type CanvasElement,
  type VectorPoint,
  ElementKind,
  newElementId,
  normalizeVectorPath,
  ELEMENT_DEFAULT_FONT_SIZE,
  ELEMENT_DEFAULT_FONT_FAMILY,
  ELEMENT_DEFAULT_FILL,
  ELEMENT_DEFAULT_FONT_WEIGHT,
  ELEMENT_DEFAULT_LINE_HEIGHT,
  ELEMENT_DEFAULT_LETTER_SPACING,
  ELEMENT_DEFAULT_TEXT_ALIGN,
  ELEMENT_DEFAULT_STROKE,
} from '@/types/element'
import { ToolType } from '@/types/tool'
import { isTypingTarget, getDeepActiveElement } from '@/constants/canvas'
import type { GestureState, ContextMenuState, PenDraftPoint } from '@/types/canvas'
import {
  ZOOM_STEP,
  MIN_STROKE_SCREEN_PX,
  SELECTION_STROKE_SCREEN_PX,
  GRID_SCREEN_STEP,
  GRID_MAJOR_EVERY,
  COLOR_SELECTION,
  COLOR_MARQUEE_FILL,
  COLOR_GRID_MAJOR,
  COLOR_GRID_MINOR,
  niceStep,
  initGridVisible,
  resolveGridVisible,
} from '@/constants/canvas'
import {
  type Point,
  type BaseShapeAttrs,
  RENDERER_BY_KIND,
  RENDERER_BY_TOOL,
  paintColor,
  traceVectorPath,
} from './strategies/ShapeRendererStrategy'
import { cullingService } from './services/ViewportCullingService'
import { measurementService } from './services/MeasurementService'
import { useCommentStore } from '@/store/comment'
import CommentOverlay from './CommentOverlay.vue'

// ── Stores ─────────────────────────────────────────────────────────────────────
const elementStore = useElementStore()
const viewportStore = useViewportStore()
const toolStore = useToolStore()
const commentStore = useCommentStore()

// ── Container ref ──────────────────────────────────────────────────────────────
const containerRef = ref<HTMLDivElement | null>(null)
/**
 * Konva Stage 容器相對瀏覽器視窗的位置與尺寸快照。
 * 由 ResizeObserver 維護，傳遞給 CommentOverlay 用於將覆疊層精確對齊 Stage。
 */
const commentOverlayRect = ref({ left: 0, top: 0, width: 0, height: 0 })

// ── Konva objects ──────────────────────────────────────────────────────────────

let stage: Konva.Stage
let gridLayer: Konva.Layer
let mainLayer: Konva.Layer
let uiLayer: Konva.Layer
let vectorOverlayGroup: Konva.Group

// ── Shape pool（O(k) diff） ───────────────────────────────────────────────────
const _pool = new Map<string, Konva.Shape>()

// ── Z-order snapshot ───────────────────────────────────────────────────────────
let _zOrderSnapshot: string[] = []

// ── Gesture State Machine ──────────────────────────────────────────────────────
let _gesture: GestureState = { kind: 'idle' }
// marquee 完成後抑制 stage click → clearSelection（Konva 不知道我們在手動拖曳）
let _suppressNextStageClick = false

// ── Grid 可見性（hysteresis） ─────────────────────────────────────────────────

let _gridVisible = initGridVisible(viewportStore.viewport.scale)

const PEN_CLOSE_DISTANCE_SCREEN_PX = 10
const PEN_HANDLE_MIN_DRAG_WORLD = 2
const PEN_CONTROL_RADIUS_SCREEN_PX = 4
const TEXT_ELEMENT_DEFAULT_WIDTH = 200
const TEXT_ELEMENT_DEFAULT_HEIGHT_RATIO = 1.5
const TEXT_OVERLAY_MIN_WIDTH_RATIO = 2
const TEXT_OVERLAY_MIN_HEIGHT_RATIO = 1.5
const TEXT_OVERLAY_POSITION = 'fixed'
const TEXT_OVERLAY_Z_INDEX = 2000

// ── Measurement overlay 狀態 ──────────────────────────────────────────────────
/** 拖曳進行中旗標；由 watchEffect 讀取以決定是否更新覆蓋層。 */
let _isDragging = false
/** Alt 鍵是否按下；用於 Alt+Hover 距離量測功能。 */
let _altHeld = false

// ── Comment Placement ──────────────────────────────────────────────────────────

/**
 * 最近一次新增的 comment id，用於讓對應 CommentPin 自動開啟 popover。
 * autoOpen 是 one-time flag（CommentPin 只在 onMounted 消費一次），
 * 因此不需主動清空：放置下一個評論時自然覆寫，舊 Pin 已 mounted 不受影響。
 */
const _autoOpenCommentId = ref<string | null>(null)

function placeComment(world: Point): void {
  const comment = commentStore.add(world.x, world.y)
  _autoOpenCommentId.value = comment.id
}

// ── Text Editing ───────────────────────────────────────────────────────────────
const editingTextId = ref<string | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
/**
 * 進入編輯前的原始文字，供 cancelTextEdit 還原用。
 * ⚠️ 假設：編輯期間不會有任何中間寫入 store 的操作（onTextareaInput 只調整高度）。
 * 若未來加入「即時預覽」，cancelTextEdit 須改為主動 update(id, _editOldText)。
 */
let _editOldText = ''
const editingTextDraft = ref('')
let _pendingTextEditTimer: number | null = null

const editingTextStyle = computed(() => {
  const id = editingTextId.value
  if (!id) return {}
  // elementStore.get 存取 _store.value.byId[id]（reactive ref 屬性），
  // Vue 自動追蹤依賴，rotation / fontSize 等屬性變更都會觸發此 computed 重算。
  const el = elementStore.get(id)
  if (!el) return {}
  const vp = viewportStore.viewport
  const absEl = absoluteCoords(el)
  const fontPx = (el.fontSize ?? ELEMENT_DEFAULT_FONT_SIZE) * vp.scale
  const style: Record<string, string> = {
    left: `${commentOverlayRect.value.left + absEl.x * vp.scale + vp.x}px`,
    top: `${commentOverlayRect.value.top + absEl.y * vp.scale + vp.y}px`,
    minHeight: `${fontPx * TEXT_OVERLAY_MIN_HEIGHT_RATIO}px`,
    width: `${Math.max(absEl.width * vp.scale, fontPx * TEXT_OVERLAY_MIN_WIDTH_RATIO)}px`,
    fontSize: `${fontPx}px`,
    fontFamily: el.fontFamily ?? ELEMENT_DEFAULT_FONT_FAMILY,
    fontWeight: String(el.fontWeight ?? ELEMENT_DEFAULT_FONT_WEIGHT),
    lineHeight: String(el.lineHeight ?? ELEMENT_DEFAULT_LINE_HEIGHT),
    letterSpacing: `${el.letterSpacing ?? ELEMENT_DEFAULT_LETTER_SPACING}px`,
    textAlign: el.textAlign ?? ELEMENT_DEFAULT_TEXT_ALIGN,
    position: TEXT_OVERLAY_POSITION,
    zIndex: String(TEXT_OVERLAY_Z_INDEX),
  }
  if (el.rotation) {
    style.transform = `rotate(${el.rotation}deg)`
    style.transformOrigin = 'top left'
  }
  return style
})

function _exitTextEdit(id: string): void {
  if (_pendingTextEditTimer !== null) {
    window.clearTimeout(_pendingTextEditTimer)
    _pendingTextEditTimer = null
  }
  // editingTextId 先清空，再執行 DOM 副作用。
  // Vue ref 賦值同步，_exitTextEdit 返回後才 flush DOM 並移除 textarea。
  // 若移除 textarea 觸發 blur → commitTextEdit，此時 editingTextId 已為 null，
  // commitTextEdit 開頭守衛 `if (!id) return` 立即截斷，不重複執行。
  editingTextId.value = null
  editingTextDraft.value = ''
  _editOldText = ''
  mainLayer.batchDraw()
}

function startTextEdit(elId: string): void {
  if (_pendingTextEditTimer !== null) {
    window.clearTimeout(_pendingTextEditTimer)
    _pendingTextEditTimer = null
  }

  if (editingTextId.value === elId) {
    nextTick(() => {
      textareaRef.value?.focus()
      textareaRef.value?.select()
    })
    return
  }

  // 若有正在進行的編輯，先 commit 避免靜默丟棄。
  // 切換到另一個 Text 時必須強制結束當前 session，不能被初始 blur 保護擋下。
  if (editingTextId.value !== null) commitTextEdit()

  const el = elementStore.get(elId)
  if (!el || el.kind !== ElementKind.Text) return

  // 對使用者來說，畫布上看到的是 renderer 的顯示值；編輯框也要以相同內容開啟，
  // 否則新建 Text 會顯示為空白、甚至在焦點抖動時像是直接消失。
  _editOldText = el.text ?? ''
  editingTextDraft.value = _editOldText
  editingTextId.value = elId
  // 新建文字與雙擊進入編輯時，瀏覽器可能還在處理同一串 click/dblclick 焦點事件；
  // 短時間內的 blur 視為雜訊，不應立刻結束編輯。
  mainLayer.batchDraw()

  nextTick(() => {
    const ta = textareaRef.value
    if (!ta) return
    ta.value = editingTextDraft.value
    _autoResizeTextarea(ta)
    window.requestAnimationFrame(() => {
      ta.focus()
      ta.select()
    })
  })
}

function commitTextEdit(): void {
  const id = editingTextId.value
  if (!id) return
  const newText = editingTextDraft.value
  const trimmedText = newText.trim()
  if (trimmedText.length === 0 && elementStore.get(id)) {
    _exitTextEdit(id)
    elementStore.remove(id)
    return
  }
  // 只在文字實際改變且元素仍存在時才更新 store 並推 snapshot
  if (newText !== _editOldText && elementStore.get(id)) {
    elementStore.update(id, { text: newText })
    elementStore.pushSnapshot()
  }
  _exitTextEdit(id)
}

function onTextareaBlur(): void {
  commitTextEdit()
}

/**
 * Escape 取消：不寫入 store，保持 _editOldText（進入編輯前的狀態）。
 * 前提：見 _editOldText 的 ⚠️ 說明。
 * Escape → cancelTextEdit → _exitTextEdit（清空 id）→ Vue flush → 移除 textarea
 * → blur → commitTextEdit 被守衛攔截。路徑安全，不需額外 flag。
 */
function cancelTextEdit(): void {
  const id = editingTextId.value
  if (!id) return
  _exitTextEdit(id)
}

function scheduleTextEdit(elId: string): void {
  // 新建文字後若只用 nextTick，常會撞上同一次 click 的後續事件，
  // 使 textarea 剛 focus 又立刻 blur。延到下一個 macrotask 再進入編輯可避開這個焦點競爭。
  if (_pendingTextEditTimer !== null) window.clearTimeout(_pendingTextEditTimer)
  _pendingTextEditTimer = window.setTimeout(() => {
    _pendingTextEditTimer = null
    startTextEdit(elId)
  }, 0)
}

function beginTextEdit(elId: string): void {
  const selectId = rootSelectableId(elId)
  elementStore.clearSelection()
  elementStore.select(selectId)
  _suppressNextStageClick = true
  scheduleTextEdit(elId)
}

function createTextElementAt(world: Point): CanvasElement {
  return {
    id: newElementId(),
    name: defaultElementName(ElementKind.Text),
    kind: ElementKind.Text,
    x: world.x,
    y: world.y,
    width: TEXT_ELEMENT_DEFAULT_WIDTH,
    height: ELEMENT_DEFAULT_FONT_SIZE * TEXT_ELEMENT_DEFAULT_HEIGHT_RATIO,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    visible: true,
    locked: false,
    childIds: [],
    parentId: undefined,
    text: '',
    fontSize: ELEMENT_DEFAULT_FONT_SIZE,
    fontFamily: ELEMENT_DEFAULT_FONT_FAMILY,
    fontWeight: ELEMENT_DEFAULT_FONT_WEIGHT,
    lineHeight: ELEMENT_DEFAULT_LINE_HEIGHT,
    letterSpacing: ELEMENT_DEFAULT_LETTER_SPACING,
    textAlign: ELEMENT_DEFAULT_TEXT_ALIGN,
    fill: ELEMENT_DEFAULT_FILL,
    stroke: ELEMENT_DEFAULT_STROKE,
    strokeWidth: 0,
  }
}

function onTextareaKeydown(e: KeyboardEvent): void {
  e.stopPropagation()
  if (e.key === 'Escape') {
    e.preventDefault()
    cancelTextEdit()
  }
}

function onTextareaInput(e: Event): void {
  const ta = e.target as HTMLTextAreaElement
  editingTextDraft.value = ta.value
  _autoResizeTextarea(ta)
}

function _autoResizeTextarea(ta: HTMLTextAreaElement): void {
  // 先歸零再讀 scrollHeight，確保縮小也能反映（部分瀏覽器在非零高度時 scrollHeight 不縮小）
  ta.style.height = '0'
  ta.style.height = `${ta.scrollHeight}px`
}

// ── Context Menu ───────────────────────────────────────────────────────────────
const contextMenu = ref<ContextMenuState | null>(null)

// ── Helpers ────────────────────────────────────────────────────────────────────

/** 子元素座標（相對 parent）→ 世界絕對座標，遞迴處理巢狀群組。 */
function absoluteCoords(el: CanvasElement): CanvasElement {
  if (!el.parentId) return el
  const parent = elementStore.get(el.parentId)
  if (!parent) return el
  const absParent = absoluteCoords(parent)
  return { ...el, x: el.x + absParent.x, y: el.y + absParent.y }
}

function rootSelectableId(id: string): string {
  let current = elementStore.get(id)
  while (current?.parentId) {
    const parent = elementStore.get(current.parentId)
    if (!parent) break
    current = parent
  }
  return current?.id ?? id
}

/** 螢幕指針位置 → 世界座標。 */
function pointerWorld(): Point {
  const ptr = stage.getPointerPosition()!
  const vp = viewportStore.viewport
  return { x: (ptr.x - vp.x) / vp.scale, y: (ptr.y - vp.y) / vp.scale }
}

function screenToWorld(px: number): number {
  return px / viewportStore.viewport.scale
}

function cloneDraftPoint(point: PenDraftPoint): PenDraftPoint {
  return {
    x: point.x,
    y: point.y,
    handleIn: point.handleIn ? { ...point.handleIn } : undefined,
    handleOut: point.handleOut ? { ...point.handleOut } : undefined,
  }
}

function isPointNear(a: Point, b: Point, maxDistance: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= maxDistance
}

function defaultElementName(kind: ElementKind): string {
  const prefix =
    kind === ElementKind.Vector ? 'Vector' : kind.charAt(0).toUpperCase() + kind.slice(1)
  const count = Object.values(elementStore.byId).filter((el) => el.kind === kind).length + 1
  return `${prefix} ${count}`
}

function vectorWorldPoints(el: CanvasElement): VectorPoint[] {
  return (el.vectorPoints ?? []).map((point) => ({
    x: el.x + point.x,
    y: el.y + point.y,
    handleIn: point.handleIn
      ? { x: el.x + point.handleIn.x, y: el.y + point.handleIn.y }
      : undefined,
    handleOut: point.handleOut
      ? { x: el.x + point.handleOut.x, y: el.y + point.handleOut.y }
      : undefined,
  }))
}

function buildPenPreviewShape(scale: number): Konva.Shape {
  return new Konva.Shape({
    x: 0,
    y: 0,
    fill: '',
    stroke: COLOR_SELECTION,
    strokeWidth: 1 / scale,
    listening: false,
    vectorPoints: [],
    previewEnd: null,
    closed: false,
    // 建立中的 Pen 不進 store；先用 uiLayer 預覽，完成後再一次性 commit 成真正元素。
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

function renderPenControls(group: Konva.Group, points: PenDraftPoint[], scale: number): void {
  group.destroyChildren()

  const anchorRadius = PEN_CONTROL_RADIUS_SCREEN_PX / scale
  const handleRadius = (PEN_CONTROL_RADIUS_SCREEN_PX - 1) / scale
  const guideWidth = 1 / scale

  for (let index = 0; index < points.length; index++) {
    const point = points[index]

    if (point.handleIn) {
      group.add(
        new Konva.Line({
          points: [point.x, point.y, point.handleIn.x, point.handleIn.y],
          stroke: COLOR_SELECTION,
          strokeWidth: guideWidth,
          listening: false,
        }),
      )
      group.add(
        new Konva.Circle({
          x: point.handleIn.x,
          y: point.handleIn.y,
          radius: handleRadius,
          fill: '#ffffff',
          stroke: COLOR_SELECTION,
          strokeWidth: guideWidth,
          listening: false,
        }),
      )
    }

    if (point.handleOut) {
      group.add(
        new Konva.Line({
          points: [point.x, point.y, point.handleOut.x, point.handleOut.y],
          stroke: COLOR_SELECTION,
          strokeWidth: guideWidth,
          listening: false,
        }),
      )
      group.add(
        new Konva.Circle({
          x: point.handleOut.x,
          y: point.handleOut.y,
          radius: handleRadius,
          fill: '#ffffff',
          stroke: COLOR_SELECTION,
          strokeWidth: guideWidth,
          listening: false,
        }),
      )
    }

    group.add(
      new Konva.Circle({
        x: point.x,
        y: point.y,
        radius: anchorRadius,
        fill: index === 0 ? '#ffffff' : COLOR_SELECTION,
        stroke: COLOR_SELECTION,
        strokeWidth: guideWidth,
        listening: false,
      }),
    )
  }
}

function renderSelectedVectorControls(): void {
  vectorOverlayGroup.destroyChildren()

  if (_gesture.kind === 'pen') return

  // 只有單選 Vector 時顯示控制點，避免多選或建立中手勢互相干擾。
  const selected = elementStore.selectedElements
  if (selected.length !== 1 || selected[0].kind !== ElementKind.Vector) {
    uiLayer.batchDraw()
    return
  }

  renderPenControls(
    vectorOverlayGroup,
    vectorWorldPoints(selected[0]),
    viewportStore.viewport.scale,
  )
  uiLayer.batchDraw()
}

function refreshPenGesture(g: Extract<GestureState, { kind: 'pen' }>): void {
  // Pen 的 path 與控制點都掛在 uiLayer，這裡集中同步，避免互動過程散落多處更新。
  g.path.setAttrs({
    vectorPoints: g.points.map(cloneDraftPoint),
    previewEnd: g.pointerDown ? null : g.hoverPoint,
    closed: g.closing,
    fill: g.closing ? 'rgba(99,102,241,0.08)' : '',
    strokeWidth: 1 / viewportStore.viewport.scale,
  })
  renderPenControls(g.controls, g.points, viewportStore.viewport.scale)
  uiLayer.batchDraw()
}

function destroyPenGesture(g: Extract<GestureState, { kind: 'pen' }>): void {
  g.path.destroy()
  g.controls.destroy()
  uiLayer.batchDraw()
}

function finishPenGesture(closePath: boolean): void {
  const g = _gesture
  if (g.kind !== 'pen') return

  const points = g.points.map(cloneDraftPoint)
  destroyPenGesture(g)
  _gesture = { kind: 'idle' }

  // 至少要兩個錨點才有意義；不足時視為取消，不建立空 Vector。
  if (points.length < 2) return

  const normalized = normalizeVectorPath(points)
  const el: CanvasElement = {
    id: newElementId(),
    name: defaultElementName(ElementKind.Vector),
    kind: ElementKind.Vector,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
    visible: true,
    locked: false,
    childIds: [],
    parentId: undefined,
    fill: closePath ? { type: 'solid', color: '#ffffff' } : { type: 'solid', color: 'transparent' },
    stroke: { type: 'solid', color: '#6366f1' },
    strokeWidth: 1,
    closed: closePath,
    ...normalized,
  }

  elementStore.add(el)
  elementStore.clearSelection()
  elementStore.select(el.id)
}

function cancelPenGesture(): void {
  const g = _gesture
  if (g.kind !== 'pen') return
  destroyPenGesture(g)
  _gesture = { kind: 'idle' }
}

function startPenGesture(world: Point): void {
  const path = buildPenPreviewShape(viewportStore.viewport.scale)
  const controls = new Konva.Group({ listening: false })
  uiLayer.add(path)
  uiLayer.add(controls)

  // 第一個點在 mousedown 就先建立，之後 mousemove 才能即時拉出第一段把手。
  _gesture = {
    kind: 'pen',
    points: [{ x: world.x, y: world.y }],
    path,
    controls,
    pointerDown: true,
    activeIndex: 0,
    dragOrigin: world,
    hoverPoint: world,
    closing: false,
  }
  refreshPenGesture(_gesture)
}

function extendPenGesture(world: Point): void {
  const g = _gesture
  if (g.kind !== 'pen') return

  const closeDistance = screenToWorld(PEN_CLOSE_DISTANCE_SCREEN_PX)
  // 點回第一個錨點時直接閉合，模擬 Figma Pen 的 close path 操作。
  if (g.points.length >= 2 && isPointNear(world, g.points[0], closeDistance)) {
    finishPenGesture(true)
    return
  }

  g.points = [...g.points, { x: world.x, y: world.y }]
  g.activeIndex = g.points.length - 1
  g.pointerDown = true
  g.dragOrigin = world
  g.hoverPoint = world
  g.closing = false
  refreshPenGesture(g)
}

/** 組裝 Konva 所需的 shape 屬性（含 Paint→string 轉換）。 */
function buildShapeAttrs(
  el: CanvasElement,
  selectedIds: ReadonlySet<string>,
  scale: number,
): BaseShapeAttrs {
  const selected = selectedIds.has(el.id)
  const minStroke = MIN_STROKE_SCREEN_PX / scale
  const strokeW = selected
    ? SELECTION_STROKE_SCREEN_PX / scale
    : Math.max(minStroke, el.strokeWidth)
  return {
    id: el.id,
    fill: paintColor(el.fill),
    stroke: selected ? COLOR_SELECTION : paintColor(el.stroke),
    strokeWidth: strokeW,
    opacity: el.opacity,
    rotation: el.rotation,
    selected,
  }
}

// ── Diff Renderer ────────────────────────────────────────────────────────────────

function diffRender(
  elements: CanvasElement[],
  selectedIds: ReadonlySet<string>,
  scale: number,
): void {
  const nextIds = new Set(elements.map((e) => e.id))

  // 移除已不存在的 shape
  for (const [id, shape] of _pool) {
    if (!nextIds.has(id)) {
      shape.destroy()
      _pool.delete(id)
    }
  }

  for (const el of elements) {
    const absEl = absoluteCoords(el)
    const attrs = buildShapeAttrs(absEl, selectedIds, scale)
    const renderer = RENDERER_BY_KIND.get(el.kind)
    if (!renderer) continue

    const existing = _pool.get(el.id)
    if (existing && existing.getClassName() === renderer.konvaClassName) {
      renderer.patch(existing, absEl, attrs)
    } else {
      existing?.destroy()
      const shape = renderer.build(absEl, attrs)
      registerShapeEvents(shape, el.id)
      mainLayer.add(shape)
      _pool.set(el.id, shape)
    }
  }

  syncZOrder(elements)
}

/** 將 Konva shape 點擊事件綁定至 elementStore。 */
function registerShapeEvents(shape: Konva.Shape, elId: string): void {
  shape.on('click', (e: Konva.KonvaEventObject<MouseEvent>) => {
    e.cancelBubble = true
    if (e.evt.button !== 0) return
    // 若元素屬於群組，第一次點擊選取群組而非子元素（Figma 行為）
    const selectId = rootSelectableId(elId)
    const selectedRootId = rootSelectableId(elId)
    if (!e.evt.shiftKey) elementStore.clearSelection()
    elementStore.select(selectedRootId, e.evt.shiftKey)
  })
}

/**
 * Z-order 同步：以 snapshot 比對，只在順序真的改變時重排，
 * 避免每幀 O(n²) 的 zIndex 操作。
 */
function syncZOrder(elements: CanvasElement[]): void {
  const newOrder = elements.map((e) => e.id)
  const changed =
    newOrder.length !== _zOrderSnapshot.length ||
    newOrder.some((id, i) => id !== _zOrderSnapshot[i])
  if (!changed) return
  _zOrderSnapshot = newOrder
  for (let i = 0; i < elements.length; i++) {
    _pool.get(elements[i].id)?.zIndex(i)
  }
}

// ── Grid ───────────────────────────────────────────────────────────────────────
function drawGrid(scale: number, containerW: number, containerH: number): void {
  gridLayer.destroyChildren()

  _gridVisible = resolveGridVisible(scale, _gridVisible)
  if (!_gridVisible) return

  const vp = viewportStore.viewport
  const bounds = cullingService.getBounds(vp, containerW, containerH)
  const worldStep = niceStep(GRID_SCREEN_STEP / scale)
  const lineW = 1 / scale

  const startX = Math.floor(bounds.left / worldStep) * worldStep
  const startY = Math.floor(bounds.top / worldStep) * worldStep
  let xi = Math.round(startX / worldStep)

  for (let x = startX; x <= bounds.right; x += worldStep, xi++) {
    gridLayer.add(
      new Konva.Line({
        points: [x, bounds.top, x, bounds.bottom],
        stroke: xi % GRID_MAJOR_EVERY === 0 ? COLOR_GRID_MAJOR : COLOR_GRID_MINOR,
        strokeWidth: lineW,
        listening: false,
      }),
    )
  }
  let yi = Math.round(startY / worldStep)
  for (let y = startY; y <= bounds.bottom; y += worldStep, yi++) {
    gridLayer.add(
      new Konva.Line({
        points: [bounds.left, y, bounds.right, y],
        stroke: yi % GRID_MAJOR_EVERY === 0 ? COLOR_GRID_MAJOR : COLOR_GRID_MINOR,
        strokeWidth: lineW,
        listening: false,
      }),
    )
  }
}

// ── Stage Init ─────────────────────────────────────────────────────────────────

let _resizeObserver: ResizeObserver | null = null

function initStage(): void {
  const el = containerRef.value!
  const w = el.clientWidth
  const h = el.clientHeight
  viewportStore.setContainerSize(w, h)
  syncCommentOverlayRect()

  stage = new Konva.Stage({ container: el, width: w, height: h })
  gridLayer = new Konva.Layer({ listening: false })
  mainLayer = new Konva.Layer()
  uiLayer = new Konva.Layer({ listening: false })
  vectorOverlayGroup = new Konva.Group({ listening: false })
  stage.add(gridLayer, mainLayer, uiLayer)
  measurementService.init(uiLayer)
  uiLayer.add(vectorOverlayGroup)

  registerStageEvents()

  _resizeObserver = new ResizeObserver((entries) => {
    const r = entries[0].contentRect
    stage.width(r.width)
    stage.height(r.height)
    viewportStore.setContainerSize(r.width, r.height)
    syncCommentOverlayRect()
  })
  _resizeObserver.observe(el)
}

function syncCommentOverlayRect(): void {
  const el = containerRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  commentOverlayRect.value = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  }
}

// ── Stage Events ───────────────────────────────────────────────────────────────

function registerStageEvents(): void {
  stage.on('wheel', (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const { deltaX, deltaY, ctrlKey, metaKey } = e.evt
    const ptr = stage.getPointerPosition()!
    if (ctrlKey || metaKey) {
      viewportStore.zoom(deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, ptr.x, ptr.y)
    } else {
      viewportStore.pan(-deltaX, -deltaY)
    }
  })

  stage.on('mousedown', (e: Konva.KonvaEventObject<MouseEvent>) => onMouseDown(e))
  stage.on('mousemove', () => onMouseMove())
  stage.on('mouseup', () => onMouseUp())

  // 點擊 stage 空白區域 → 清除選取（marquee 結束後跳過，避免覆蓋框選結果）
  stage.on('click', (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (_suppressNextStageClick) {
      _suppressNextStageClick = false
      return
    }
    if (e.evt.button === 0 && e.target === stage) elementStore.clearSelection()
  })
}

function onContainerWheel(e: WheelEvent): void {
  e.preventDefault()
}

// ── Gesture Handlers ───────────────────────────────────────────────────────────

function onMouseDown(e: Konva.KonvaEventObject<MouseEvent>): void {
  if (e.evt.button !== 0 && e.evt.button !== 1) return
  const tool = toolStore.activeTool
  const world = pointerWorld()
  const targetId = e.target !== stage ? (e.target as Konva.Shape).id() : null
  const targetEl = targetId ? elementStore.get(targetId) : undefined

  // 中鍵 or Hand 工具 → 平移
  if (e.evt.button === 1 || tool === ToolType.Hand) {
    startPanning()
    return
  }
  if (tool === ToolType.Text && targetEl?.kind === ElementKind.Text) {
    toolStore.setTool(ToolType.Move)
    beginTextEdit(targetEl.id)
    return
  }
  if (tool === ToolType.Move && targetEl?.kind === ElementKind.Text && e.evt.detail >= 2) {
    beginTextEdit(targetEl.id)
    return
  }
  // Move 工具點擊 shape → 拖曳
  if (tool === ToolType.Move && e.target !== stage) {
    startDragging(e, world)
    return
  }
  if (tool === ToolType.Move || tool === ToolType.RegionSelect) {
    startMarquee(world)
    return
  }
  // Comment 工具 → 放置釘針
  if (tool === ToolType.Comment) {
    placeComment(world)
    return
  }
  if (tool === ToolType.Text) {
    if (e.target !== stage) return

    const newEl = createTextElementAt(world)
    elementStore.add(newEl)
    toolStore.setTool(ToolType.Move)
    beginTextEdit(newEl.id)
    return
  }
  if (tool === ToolType.Pen) {
    _suppressNextStageClick = true
    // Pen 是多步驟手勢：第一次進入建立模式，後續點擊則追加節點。
    if (_gesture.kind === 'pen') extendPenGesture(world)
    else startPenGesture(world)
    return
  }
  // 其餘工具 → 繪製
  startDrawing(tool, world)
}

function startPanning(): void {
  const ptr = stage.getPointerPosition()!
  const vp = viewportStore.viewport
  _gesture = { kind: 'panning', stageX: vp.x, stageY: vp.y, px: ptr.x, py: ptr.y }
  stage.container().style.cursor = 'grabbing'
}

function startDragging(e: Konva.KonvaEventObject<MouseEvent>, world: Point): void {
  const elId = (e.target as Konva.Shape).id()
  const el = elId ? elementStore.get(elId) : undefined
  if (!el) return

  // 子元素一律提升至父群組，確保拖曳時移動整個群組
  const dragId = rootSelectableId(el.id)

  if (!elementStore.selectedIds.has(dragId)) {
    if (!e.evt.shiftKey) elementStore.clearSelection()
    elementStore.select(dragId, e.evt.shiftKey)
  }

  const starts = [...elementStore.selectedIds].map((id) => {
    const elem = elementStore.get(id)!
    return { id, x: elem.x, y: elem.y }
  })
  _isDragging = true
  _gesture = { kind: 'dragging', startWorld: world, starts }
}

function startMarquee(world: Point): void {
  const scale = viewportStore.viewport.scale
  const dashLen = 4 / scale
  const rect = new Konva.Rect({
    x: world.x,
    y: world.y,
    width: 0,
    height: 0,
    fill: COLOR_MARQUEE_FILL,
    stroke: COLOR_SELECTION,
    strokeWidth: 1 / scale,
    dash: [dashLen, dashLen],
    listening: false,
  })
  uiLayer.add(rect)
  _gesture = { kind: 'marquee', start: world, rect }
}

function startDrawing(tool: ToolType, world: Point): void {
  const renderer = RENDERER_BY_TOOL.get(tool)
  if (!renderer) return
  const ghost = renderer.buildGhost(world, 1 / viewportStore.viewport.scale)
  uiLayer.add(ghost)
  _gesture = { kind: 'drawing', start: world, ghost }
}

function onMouseMove(): void {
  const g = _gesture

  if (g.kind === 'panning') {
    const ptr = stage.getPointerPosition()!
    viewportStore.setPan(g.stageX + ptr.x - g.px, g.stageY + ptr.y - g.py)
    return
  }

  if (g.kind === 'dragging') {
    const world = pointerWorld()
    const dx = world.x - g.startWorld.x
    const dy = world.y - g.startWorld.y
    for (const s of g.starts) {
      elementStore.update(s.id, { x: s.x + dx, y: s.y + dy })
    }
    // 更新吸附線與尺寸標籤覆蓋層
    const vp = viewportStore.viewport
    const selIds = elementStore.selectedIds
    const absSelected = elementStore.selectedElements.map(absoluteCoords)
    const absOthers = elementStore.rootElements.filter((el) => !selIds.has(el.id))
    measurementService.showDragging(absSelected, absOthers, vp.scale)
    uiLayer.batchDraw()
    return
  }

  if (g.kind === 'marquee') {
    const world = pointerWorld()
    const x = Math.min(g.start.x, world.x)
    const y = Math.min(g.start.y, world.y)
    g.rect.setAttrs({
      x,
      y,
      width: Math.abs(world.x - g.start.x),
      height: Math.abs(world.y - g.start.y),
    })
    uiLayer.batchDraw()
    return
  }

  if (g.kind === 'drawing') {
    RENDERER_BY_TOOL.get(toolStore.activeTool)?.updateGhost(g.ghost, g.start, pointerWorld())
    uiLayer.batchDraw()
    return
  }

  if (g.kind === 'pen') {
    const world = pointerWorld()
    g.hoverPoint = world
    if (g.pointerDown) {
      const point = g.points[g.activeIndex]
      const dx = world.x - g.dragOrigin.x
      const dy = world.y - g.dragOrigin.y
      if (Math.hypot(dx, dy) >= PEN_HANDLE_MIN_DRAG_WORLD) {
        if (g.activeIndex === 0 && g.points.length === 1) {
          // 第一個點只有出把手，沒有入把手；避免建立出不存在的前一段曲線。
          point.handleOut = { x: point.x + dx, y: point.y + dy }
        } else {
          // 後續節點預設建立對稱把手，先提供接近 Figma 的平滑節點體驗。
          point.handleIn = { x: point.x - dx, y: point.y - dy }
          point.handleOut = { x: point.x + dx, y: point.y + dy }
        }
      }
    } else if (g.points.length >= 2) {
      g.closing = isPointNear(world, g.points[0], screenToWorld(PEN_CLOSE_DISTANCE_SCREEN_PX))
    }
    refreshPenGesture(g)
    return
  }

  // 閒置狀態 + Alt 按下：顯示游標所指元素與選取框之間的距離
  if (_altHeld && elementStore.selectedIds.size > 0) {
    const ptr = stage.getPointerPosition()
    const hit = ptr ? (stage.getIntersection(ptr) as Konva.Shape | null) : null
    const hitId = hit?.id()
    if (hitId && !elementStore.selectedIds.has(hitId)) {
      const hoverEl = elementStore.get(rootSelectableId(hitId))
      if (hoverEl) {
        const absSelected = elementStore.selectedElements.map(absoluteCoords)
        measurementService.showDistanceTo(
          absSelected,
          absoluteCoords(hoverEl),
          viewportStore.viewport.scale,
        )
        uiLayer.batchDraw()
        return
      }
    }
    // 游標移到空白區域：顯示尺寸標籤
    const absSelected = elementStore.selectedElements.map(absoluteCoords)
    measurementService.showIdle(absSelected, viewportStore.viewport.scale)
    uiLayer.batchDraw()
  }
}

function onMouseUp(): void {
  const g = _gesture
  stage.container().style.cursor = toolStore.cursor

  if (g.kind === 'panning') {
    _gesture = { kind: 'idle' }
    return
  }

  if (g.kind === 'dragging') {
    if (g.starts.length > 0) elementStore.pushSnapshot()
    _isDragging = false
    _gesture = { kind: 'idle' }
    // 拖曳結束：清除吸附線，退回純尺寸標籤
    measurementService.hide()
    return
  }

  if (g.kind === 'marquee') {
    _suppressNextStageClick = true
    commitMarquee(g)
    return
  }

  if (g.kind === 'drawing') {
    const newEl = commitDraw(g)
    if (newEl) elementStore.add(newEl)
    g.ghost.destroy()
    uiLayer.batchDraw()
    _gesture = { kind: 'idle' }
    if (newEl?.kind === ElementKind.Text) _suppressNextStageClick = true
    toolStore.setTool(ToolType.Move)
    // 繪製文字元素後自動進入編輯模式。
    // 這裡不能只用 nextTick，否則可能被同一次 click 事件的焦點變更立刻打斷。
    if (newEl?.kind === ElementKind.Text) {
      nextTick(() => scheduleTextEdit(newEl.id))
    }
    return
  }

  if (g.kind === 'pen') {
    g.pointerDown = false
    g.hoverPoint = pointerWorld()
    const point = g.points[g.activeIndex]
    // 如果拖曳距離太短，移除殘留把手，避免單擊節點被誤判成曲線點。
    if (point.handleIn && !point.handleOut) point.handleIn = undefined
    if (point.handleOut && !point.handleIn && g.activeIndex !== 0) point.handleOut = undefined
    refreshPenGesture(g)
  }
}

function commitMarquee(g: Extract<GestureState, { kind: 'marquee' }>): void {
  if (g.rect.width() > 2 && g.rect.height() > 2) {
    const bounds = {
      left: g.rect.x(),
      top: g.rect.y(),
      right: g.rect.x() + g.rect.width(),
      bottom: g.rect.y() + g.rect.height(),
    }
    elementStore.clearSelection()
    for (const el of elementStore.rootElements) {
      const aabb = cullingService.getRotatedBounds(el)
      const inside = !(
        aabb.right < bounds.left ||
        aabb.left > bounds.right ||
        aabb.bottom < bounds.top ||
        aabb.top > bounds.bottom
      )
      if (inside) elementStore.select(el.id, true)
    }
  }
  g.rect.destroy()
  uiLayer.batchDraw()
  _gesture = { kind: 'idle' }
}

function commitDraw(g: Extract<GestureState, { kind: 'drawing' }>): CanvasElement | null {
  const tool = toolStore.activeTool
  const renderer = RENDERER_BY_TOOL.get(tool)
  if (!renderer) return null
  const data = renderer.createElement(tool, g.start, pointerWorld())
  if (!data) return null
  return { id: newElementId(), name: defaultElementName(data.kind), ...data }
}

// ── Canvas Actions ─────────────────────────────────────────────────────────────
function deleteSelected(): void {
  const ids = [...elementStore.selectedIds]
  if (ids.length === 0) return
  for (const id of ids) elementStore.remove(id)
}

/** 從目前選取集合中取出 root-level 元素 ID（group() 只接受 root-level）。 */
function rootLevelSelectedIds(): string[] {
  return [...elementStore.selectedIds].filter((id) => {
    const el = elementStore.get(id)
    return el && !el.parentId
  })
}

function groupSelected(): void {
  const ids = rootLevelSelectedIds()
  if (ids.length < 2) return
  const groupId = elementStore.group(ids)
  if (!groupId) return
  elementStore.clearSelection()
  elementStore.select(groupId)
}

function ungroupSelected(): void {
  const groups = elementStore.selectedElements.filter((el) => el.kind === ElementKind.Group)
  if (groups.length === 0) return
  elementStore.clearSelection()
  for (const group of groups) {
    for (const childId of elementStore.ungroup(group.id)) {
      elementStore.select(childId, true)
    }
  }
}

function duplicateSelected(): void {
  const selected = elementStore.selectedElements
  if (selected.length === 0) return

  const allCopies: CanvasElement[] = []
  const rootCopyIds: string[] = []

  for (const el of selected) {
    if (el.kind === ElementKind.Group) {
      const newGroupId = newElementId()
      const childIdRemap = new Map(el.childIds.map((cid) => [cid, newElementId()]))

      allCopies.push({
        ...el,
        id: newGroupId,
        name: `${el.name} copy`,
        x: el.x + 10,
        y: el.y + 10,
        childIds: el.childIds.map((cid) => childIdRemap.get(cid)!),
      })
      rootCopyIds.push(newGroupId)

      for (const childId of el.childIds) {
        const child = elementStore.get(childId)
        if (child) {
          allCopies.push({ ...child, id: childIdRemap.get(childId)!, parentId: newGroupId })
        }
      }
    } else {
      const copy = {
        ...el,
        id: newElementId(),
        name: `${el.name} copy`,
        x: el.x + 10,
        y: el.y + 10,
      }
      allCopies.push(copy)
      rootCopyIds.push(copy.id)
    }
  }

  elementStore.addAll(allCopies)
  elementStore.clearSelection()
  for (const id of rootCopyIds) elementStore.select(id, true)
}

// ── Context Menu ───────────────────────────────────────────────────────────────

/**
 * Native DOM contextmenu handler（綁在 container div）。
 * 使用 DOM 事件而非 stage.on('contextmenu')，確保右鍵在任何子節點皆可靠觸發；
 * 再透過 stage.getIntersection 做 Konva hit-test。
 */
function onContainerContextMenu(e: MouseEvent): void {
  if (!stage) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const stagePos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  const hit = stage.getIntersection(stagePos) as Konva.Shape | null
  const elId = hit?.id() ?? null

  // 右鍵點擊未選取的元素 → 先選取（提升至父群組）
  // 右鍵點擊空白區域 → 保留現有選取，讓選單仍能對已選元素操作
  if (elId) {
    const selectId = rootSelectableId(elId)
    if (!elementStore.selectedIds.has(selectId)) {
      elementStore.clearSelection()
      elementStore.select(selectId)
    }
  }

  const selectedIds = elementStore.selectedIds
  const selectedEls = elementStore.selectedElements
  const rootSelected = selectedEls.filter((el) => !el.parentId)

  contextMenu.value = {
    x: e.clientX,
    y: e.clientY,
    hasSelection: selectedIds.size > 0,
    canGroup: rootSelected.length >= 2,
    canUngroup: selectedEls.some((el) => el.kind === ElementKind.Group),
  }
}

function closeContextMenu(): void {
  contextMenu.value = null
}

// ── Keyboard ───────────────────────────────────────────────────────────────────
function keyCombo(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.shiftKey) parts.push('shift')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

const _keyCommands = new Map<string, (e: KeyboardEvent) => void>([
  [
    'delete',
    (e) => {
      e.preventDefault()
      deleteSelected()
    },
  ],
  [
    'backspace',
    (e) => {
      e.preventDefault()
      deleteSelected()
    },
  ],
  [
    'ctrl+z',
    (e) => {
      e.preventDefault()
      elementStore.undo()
    },
  ],
  [
    'ctrl+y',
    (e) => {
      e.preventDefault()
      elementStore.redo()
    },
  ],
  [
    'ctrl+shift+z',
    (e) => {
      e.preventDefault()
      elementStore.redo()
    },
  ],
  [
    'ctrl+d',
    (e) => {
      e.preventDefault()
      duplicateSelected()
    },
  ],
  [
    'ctrl+g',
    (e) => {
      e.preventDefault()
      groupSelected()
    },
  ],
  [
    'ctrl+shift+g',
    (e) => {
      e.preventDefault()
      ungroupSelected()
    },
  ],
  [
    'ctrl+a',
    (e) => {
      e.preventDefault()
      elementStore.selectAll()
    },
  ],
  [
    ']',
    (e) => {
      e.preventDefault()
      ;[...elementStore.selectedIds].forEach((id) => elementStore.bringToFront(id))
      elementStore.pushSnapshot()
    },
  ],
  [
    '[',
    (e) => {
      e.preventDefault()
      ;[...elementStore.selectedIds].forEach((id) => elementStore.sendToBack(id))
      elementStore.pushSnapshot()
    },
  ],
])

function onKeydown(e: KeyboardEvent): void {
  if (_gesture.kind === 'pen') {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelPenGesture()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      finishPenGesture(false)
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      if (_gesture.points.length <= 1) {
        cancelPenGesture()
      } else {
        _gesture.points = _gesture.points.slice(0, -1)
        _gesture.activeIndex = _gesture.points.length - 1
        _gesture.pointerDown = false
        _gesture.hoverPoint = pointerWorld()
        _gesture.closing = false
        refreshPenGesture(_gesture)
      }
      return
    }
  }

  if (e.key === 'Alt') {
    e.preventDefault()
    _altHeld = true
    return
  }
  if (isTypingTarget(getDeepActiveElement())) return
  _keyCommands.get(keyCombo(e))?.(e)
}

function onKeyup(e: KeyboardEvent): void {
  if (e.key !== 'Alt') return
  _altHeld = false
  // Alt 放開：清除距離線，退回純尺寸標籤
  const absSelected = elementStore.selectedElements.map(absoluteCoords)
  measurementService.showIdle(absSelected, viewportStore.viewport.scale)
  uiLayer.batchDraw()
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────
onMounted(() => {
  initStage()

  // 渲染迴圈：追蹤 viewport / elements / selection，任一變動即重繪
  watchEffect(() => {
    if (!stage) return
    const vp = viewportStore.viewport
    const elements = elementStore.rootElements
    const selectedIds = elementStore.selectedIds
    const { w, h } = viewportStore.containerSize

    stage.position({ x: vp.x, y: vp.y })
    stage.scale({ x: vp.scale, y: vp.scale })

    const visible = cullingService.cull(
      elements.map((e) => e.id),
      elementStore.byId,
      vp,
      w,
      h,
    )
    diffRender(visible, selectedIds, vp.scale)
    drawGrid(vp.scale, w, h)

    // 閒置狀態下同步尺寸標籤；拖曳中由 onMouseMove 直接更新（含吸附線），此處跳過
    if (!_isDragging) {
      const absSelected = elementStore.selectedElements.map(absoluteCoords)
      measurementService.showIdle(absSelected, vp.scale)
    }

    renderSelectedVectorControls()
    stage.batchDraw()
  })

  // cursor 追蹤：工具切換 → 更新 stage container cursor
  watch(
    () => toolStore.cursor,
    (cursor) => {
      if (stage && _gesture.kind !== 'panning') {
        stage.container().style.cursor = cursor
      }
    },
  )

  watch(
    () => toolStore.activeTool,
    (tool, prevTool) => {
      if (prevTool === ToolType.Pen && tool !== ToolType.Pen && _gesture.kind === 'pen') {
        // 使用者切走工具時自動收尾，避免畫面留下一個無法操作的 Pen 草稿。
        finishPenGesture(false)
      }
    },
  )

  document.addEventListener('keydown', onKeydown)
  document.addEventListener('keyup', onKeyup)
  document.addEventListener('click', closeContextMenu)
  window.addEventListener('resize', syncCommentOverlayRect)
  window.addEventListener('scroll', syncCommentOverlayRect, true)
  containerRef.value?.addEventListener('wheel', onContainerWheel, { passive: false })
})

onUnmounted(() => {
  commentStore.flush()
  _resizeObserver?.disconnect()
  measurementService.destroy()
  stage?.destroy()
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('keyup', onKeyup)
  document.removeEventListener('click', closeContextMenu)
  window.removeEventListener('resize', syncCommentOverlayRect)
  window.removeEventListener('scroll', syncCommentOverlayRect, true)
  containerRef.value?.removeEventListener('wheel', onContainerWheel)
})
</script>

<template>
  <div ref="containerRef" class="canvas-container" @contextmenu.prevent="onContainerContextMenu">
    <!-- 右鍵選單：Teleport 至 body 避免與 Konva DOM 衝突 -->
    <Teleport to="body">
      <ul
        v-if="contextMenu"
        class="ctx-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        @click.stop
      >
        <template v-if="contextMenu.hasSelection">
          <li
            class="ctx-item"
            @click="elementStore.bringToFront([...elementStore.selectedIds][0]); closeContextMenu()"
          >
            Bring to Front <kbd>]</kbd>
          </li>
          <li
            class="ctx-item"
            @click="[...elementStore.selectedIds].forEach((id) => elementStore.moveUp(id)); closeContextMenu()"
          >
            Move Up
          </li>
          <li
            class="ctx-item"
            @click="[...elementStore.selectedIds].forEach((id) => elementStore.moveDown(id)); closeContextMenu()"
          >
            Move Down
          </li>
          <li
            class="ctx-item"
            @click="elementStore.sendToBack([...elementStore.selectedIds][0]); closeContextMenu()"
          >
            Send to Back <kbd>[</kbd>
          </li>
          <li class="ctx-sep" />
          <li
            v-if="contextMenu.canGroup"
            class="ctx-item"
            @click="groupSelected(); closeContextMenu()"
          >
            Group <kbd>Ctrl G</kbd>
          </li>
          <li
            v-if="contextMenu.canUngroup"
            class="ctx-item"
            @click="ungroupSelected(); closeContextMenu()"
          >
            Ungroup <kbd>Ctrl Shift G</kbd>
          </li>
          <li class="ctx-sep" />
          <li
            class="ctx-item"
            @click="duplicateSelected(); closeContextMenu()"
          >
            Duplicate <kbd>Ctrl D</kbd>
          </li>
          <li class="ctx-sep" />
          <li
            class="ctx-item ctx-item--danger"
            @click="deleteSelected(); closeContextMenu()"
          >
            Delete <kbd>Del</kbd>
          </li>
        </template>
        <template v-else>
          <li
            class="ctx-item"
            @click="elementStore.selectAll(); closeContextMenu()"
          >
            Select All <kbd>Ctrl A</kbd>
          </li>
        </template>
      </ul>
    </Teleport>

    <!-- Comment overlay：每個評論渲染一個釘針，跟隨 viewport 座標 -->
    <CommentOverlay
      :comments="commentStore.comments"
      :viewport="viewportStore.viewport"
      :auto-open-comment-id="_autoOpenCommentId"
      :canvas-rect="commentOverlayRect"
      @update-text="commentStore.updateText"
      @toggle-resolved="commentStore.toggleResolved"
      @delete="commentStore.remove"
    />

    <!-- 文字編輯 overlay：絕對定位於 canvas container，跟隨 viewport 座標更新 -->
    <Teleport to="body">
      <textarea
        v-if="editingTextId"
        ref="textareaRef"
        class="text-edit-overlay"
        :style="editingTextStyle"
        :value="editingTextDraft"
        autofocus
        @mousedown.stop
        @click.stop
        @blur="onTextareaBlur"
        @keydown="onTextareaKeydown"
        @input="onTextareaInput"
      />
    </Teleport>
  </div>
</template>

<style src="./canvas.scss" lang="scss" scoped />
