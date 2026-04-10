<script setup lang="ts">
import { ref, computed, watch, watchEffect, onMounted, onUnmounted, nextTick } from 'vue'
import Konva from 'konva'
import { useElementStore } from '@/store/element'
import { useViewportStore } from '@/store/viewport'
import { useToolStore } from '@/store/tool'
import {
  type CanvasElement, ElementKind, newElementId,
  ELEMENT_DEFAULT_FONT_SIZE, ELEMENT_DEFAULT_FONT_FAMILY,
} from '@/types/element'
import { ToolType } from '@/types/tool'
import { isTypingTarget, getDeepActiveElement } from '@/constants/canvas'
import type { GestureState, ContextMenuState } from '@/types/canvas'
import {
  ZOOM_STEP,
  MIN_STROKE_SCREEN_PX, SELECTION_STROKE_SCREEN_PX,
  GRID_SCREEN_STEP, GRID_MAJOR_EVERY,
  COLOR_SELECTION, COLOR_MARQUEE_FILL,
  COLOR_GRID_MAJOR, COLOR_GRID_MINOR,
  niceStep,
  initGridVisible, resolveGridVisible,
} from '@/constants/canvas'
import {
  type Point, type BaseShapeAttrs,
  RENDERER_BY_KIND, RENDERER_BY_TOOL, paintColor,
} from './strategies/ShapeRendererStrategy'
import { cullingService } from './services/ViewportCullingService'
import { measurementService } from './services/MeasurementService'

// ── Stores ─────────────────────────────────────────────────────────────────────

const elementStore  = useElementStore()
const viewportStore = useViewportStore()
const toolStore     = useToolStore()

// ── Container ref ──────────────────────────────────────────────────────────────

const containerRef = ref<HTMLDivElement | null>(null)

// ── Konva objects ──────────────────────────────────────────────────────────────

let stage:     Konva.Stage
let gridLayer: Konva.Layer
let mainLayer: Konva.Layer
let uiLayer:   Konva.Layer

// ── Shape pool（O(k) diff） ───────────────────────────────────────────────────

const _pool = new Map<string, Konva.Shape>()

// ── Z-order snapshot ──────────────────────────────────────────────────────────

let _zOrderSnapshot: string[] = []

// ── Gesture State Machine ─────────────────────────────────────────────────────

let _gesture: GestureState = { kind: 'idle' }

// marquee 完成後抑制 stage click → clearSelection（Konva 不知道我們在手動拖曳）
let _suppressNextStageClick = false

// ── Grid 可見性（hysteresis） ─────────────────────────────────────────────────

let _gridVisible = initGridVisible(viewportStore.viewport.scale)

// ── Measurement overlay 狀態 ──────────────────────────────────────────────────

/** 拖曳進行中旗標；由 watchEffect 讀取以決定是否更新覆蓋層。 */
let _isDragging = false
/** Alt 鍵是否按下；用於 Alt+Hover 距離量測功能。 */
let _altHeld    = false

// ── Text Editing ───────────────────────────────────────────────────────────────

const editingTextId = ref<string | null>(null)
const textareaRef   = ref<HTMLTextAreaElement | null>(null)
/**
 * 進入編輯前的原始文字，供 cancelTextEdit 還原用。
 * ⚠️ 假設：編輯期間不會有任何中間寫入 store 的操作（onTextareaInput 只調整高度）。
 * 若未來加入「即時預覽」，cancelTextEdit 須改為主動 update(id, _editOldText)。
 */
let _editOldText = ''

const editingTextStyle = computed(() => {
  const id = editingTextId.value
  if (!id) return {}
  // elementStore.get 存取 _store.value.byId[id]（reactive ref 屬性），
  // Vue 自動追蹤依賴，rotation / fontSize 等屬性變更都會觸發此 computed 重算。
  const el = elementStore.get(id)
  if (!el) return {}
  const vp     = viewportStore.viewport
  const absEl  = absoluteCoords(el)
  const fontPx = (el.fontSize ?? ELEMENT_DEFAULT_FONT_SIZE) * vp.scale
  const style: Record<string, string> = {
    left:       `${absEl.x * vp.scale + vp.x}px`,
    top:        `${absEl.y * vp.scale + vp.y}px`,
    // 動態下限：至少 fontPx * 2，避免縮放後 textarea 幾乎不可見
    width:      `${Math.max(absEl.width * vp.scale, fontPx * 2)}px`,
    minHeight:  `${fontPx * 1.5}px`,
    fontSize:   `${fontPx}px`,
    fontFamily: el.fontFamily ?? ELEMENT_DEFAULT_FONT_FAMILY,
    fontWeight: String(el.fontWeight ?? 400),
    lineHeight: '1.5',
  }
  if (el.rotation) {
    style.transform       = `rotate(${el.rotation}deg)`
    style.transformOrigin = 'top left'
  }
  return style
})

function _exitTextEdit(id: string): void {
  // editingTextId 先清空，再執行 DOM 副作用。
  // Vue ref 賦值同步，_exitTextEdit 返回後才 flush DOM 並移除 textarea。
  // 若移除 textarea 觸發 blur → commitTextEdit，此時 editingTextId 已為 null，
  // commitTextEdit 開頭守衛 `if (!id) return` 立即截斷，不重複執行。
  editingTextId.value = null
  _editOldText        = ''
  _pool.get(id)?.show()
  mainLayer.batchDraw()
}

function startTextEdit(elId: string): void {
  // 若有正在進行的編輯，先 commit 避免靜默丟棄。
  // commitTextEdit → _exitTextEdit 已清空 editingTextId，
  // 若因此觸發 blur → 第二次 commitTextEdit，守衛會攔截，不構成遞迴。
  if (editingTextId.value !== null) commitTextEdit()

  const el = elementStore.get(elId)
  if (!el || el.kind !== ElementKind.Text) return

  _editOldText        = el.text ?? ''
  editingTextId.value = elId
  _pool.get(elId)?.hide()
  mainLayer.batchDraw()

  nextTick(() => {
    const ta = textareaRef.value
    if (!ta) return
    ta.value = _editOldText
    _autoResizeTextarea(ta)
    ta.focus()
    ta.select()
  })
}

function commitTextEdit(): void {
  const id = editingTextId.value
  if (!id) return
  const newText = textareaRef.value?.value ?? ''
  // 只在文字實際改變且元素仍存在時才更新 store 並推 snapshot
  if (newText !== _editOldText && elementStore.get(id)) {
    elementStore.update(id, { text: newText })
    elementStore.pushSnapshot()
  }
  _exitTextEdit(id)
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

function onTextareaKeydown(e: KeyboardEvent): void {
  e.stopPropagation()
  if (e.key === 'Escape') { e.preventDefault(); cancelTextEdit() }
}

function onTextareaInput(e: Event): void {
  _autoResizeTextarea(e.target as HTMLTextAreaElement)
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
  const vp  = viewportStore.viewport
  return { x: (ptr.x - vp.x) / vp.scale, y: (ptr.y - vp.y) / vp.scale }
}

/** 組裝 Konva 所需的 shape 屬性（含 Paint→string 轉換）。 */
function buildShapeAttrs(
  el:          CanvasElement,
  selectedIds: ReadonlySet<string>,
  scale:       number,
): BaseShapeAttrs {
  const selected  = selectedIds.has(el.id)
  const minStroke = MIN_STROKE_SCREEN_PX / scale
  const strokeW   = selected
    ? SELECTION_STROKE_SCREEN_PX / scale
    : Math.max(minStroke, el.strokeWidth)
  return {
    id:          el.id,
    fill:        paintColor(el.fill),
    stroke:      selected ? COLOR_SELECTION : paintColor(el.stroke),
    strokeWidth: strokeW,
    opacity:     el.opacity,
    rotation:    el.rotation,
    selected,
  }
}

// ── Diff Renderer ─────────────────────────────────────────────────────────────

function diffRender(
  elements:    CanvasElement[],
  selectedIds: ReadonlySet<string>,
  scale:       number,
): void {
  const nextIds = new Set(elements.map(e => e.id))

  // 移除已不存在的 shape
  for (const [id, shape] of _pool) {
    if (!nextIds.has(id)) { shape.destroy(); _pool.delete(id) }
  }

  for (const el of elements) {
    const absEl   = absoluteCoords(el)
    const attrs   = buildShapeAttrs(absEl, selectedIds, scale)
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
    if (!e.evt.shiftKey) elementStore.clearSelection()
    elementStore.select(selectId, e.evt.shiftKey)
  })
  shape.on('dblclick', () => {
    const el = elementStore.get(elId)
    if (el?.kind === ElementKind.Text) startTextEdit(elId)
  })
}

/**
 * Z-order 同步：以 snapshot 比對，只在順序真的改變時重排，
 * 避免每幀 O(n²) 的 zIndex 操作。
 */
function syncZOrder(elements: CanvasElement[]): void {
  const newOrder = elements.map(e => e.id)
  const changed  = newOrder.length !== _zOrderSnapshot.length
    || newOrder.some((id, i) => id !== _zOrderSnapshot[i])
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

  const vp       = viewportStore.viewport
  const bounds   = cullingService.getBounds(vp, containerW, containerH)
  const worldStep = niceStep(GRID_SCREEN_STEP / scale)
  const lineW    = 1 / scale

  const startX = Math.floor(bounds.left / worldStep) * worldStep
  const startY = Math.floor(bounds.top  / worldStep) * worldStep
  let xi = Math.round(startX / worldStep)

  for (let x = startX; x <= bounds.right; x += worldStep, xi++) {
    gridLayer.add(new Konva.Line({
      points:      [x, bounds.top, x, bounds.bottom],
      stroke:      xi % GRID_MAJOR_EVERY === 0 ? COLOR_GRID_MAJOR : COLOR_GRID_MINOR,
      strokeWidth: lineW, listening: false,
    }))
  }
  let yi = Math.round(startY / worldStep)
  for (let y = startY; y <= bounds.bottom; y += worldStep, yi++) {
    gridLayer.add(new Konva.Line({
      points:      [bounds.left, y, bounds.right, y],
      stroke:      yi % GRID_MAJOR_EVERY === 0 ? COLOR_GRID_MAJOR : COLOR_GRID_MINOR,
      strokeWidth: lineW, listening: false,
    }))
  }
}

// ── Stage Init ─────────────────────────────────────────────────────────────────

let _resizeObserver: ResizeObserver | null = null

function initStage(): void {
  const el = containerRef.value!
  const w  = el.clientWidth
  const h  = el.clientHeight
  viewportStore.setContainerSize(w, h)

  stage     = new Konva.Stage({ container: el, width: w, height: h })
  gridLayer = new Konva.Layer({ listening: false })
  mainLayer = new Konva.Layer()
  uiLayer   = new Konva.Layer({ listening: false })
  stage.add(gridLayer, mainLayer, uiLayer)
  measurementService.init(uiLayer)

  registerStageEvents()

  _resizeObserver = new ResizeObserver(entries => {
    const r = entries[0].contentRect
    stage.width(r.width)
    stage.height(r.height)
    viewportStore.setContainerSize(r.width, r.height)
  })
  _resizeObserver.observe(el)
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
  stage.on('mouseup',   () => onMouseUp())

  // 點擊 stage 空白區域 → 清除選取（marquee 結束後跳過，避免覆蓋框選結果）
  stage.on('click', (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (_suppressNextStageClick) { _suppressNextStageClick = false; return }
    if (e.evt.button === 0 && e.target === stage) elementStore.clearSelection()
  })

}

// ── Gesture Handlers ───────────────────────────────────────────────────────────

function onMouseDown(e: Konva.KonvaEventObject<MouseEvent>): void {
  if (e.evt.button !== 0 && e.evt.button !== 1) return
  const tool  = toolStore.activeTool
  const world = pointerWorld()

  // 中鍵 or Hand 工具 → 平移
  if (e.evt.button === 1 || tool === ToolType.Hand) { startPanning(); return }
  // Move 工具點擊 shape → 拖曳
  if (tool === ToolType.Move && e.target !== stage)  { startDragging(e, world); return }
  // Move / RegionSelect 點擊空白 → 選取框
  if (tool === ToolType.Move || tool === ToolType.RegionSelect) { startMarquee(world); return }
  // 其餘工具 → 繪製
  startDrawing(tool, world)
}

function startPanning(): void {
  const ptr = stage.getPointerPosition()!
  const vp  = viewportStore.viewport
  _gesture  = { kind: 'panning', stageX: vp.x, stageY: vp.y, px: ptr.x, py: ptr.y }
  stage.container().style.cursor = 'grabbing'
}

function startDragging(e: Konva.KonvaEventObject<MouseEvent>, world: Point): void {
  const elId = (e.target as Konva.Shape).id()
  const el   = elId ? elementStore.get(elId) : undefined
  if (!el) return

  // 子元素一律提升至父群組，確保拖曳時移動整個群組
  const dragId = rootSelectableId(el.id)

  if (!elementStore.selectedIds.has(dragId)) {
    if (!e.evt.shiftKey) elementStore.clearSelection()
    elementStore.select(dragId, e.evt.shiftKey)
  }

  const starts = [...elementStore.selectedIds].map(id => {
    const elem = elementStore.get(id)!
    return { id, x: elem.x, y: elem.y }
  })
  _isDragging = true
  _gesture    = { kind: 'dragging', startWorld: world, starts }
}

function startMarquee(world: Point): void {
  const scale  = viewportStore.viewport.scale
  const dashLen = 4 / scale
  const rect   = new Konva.Rect({
    x: world.x, y: world.y, width: 0, height: 0,
    fill: COLOR_MARQUEE_FILL, stroke: COLOR_SELECTION,
    strokeWidth: 1 / scale, dash: [dashLen, dashLen], listening: false,
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
    const dx    = world.x - g.startWorld.x
    const dy    = world.y - g.startWorld.y
    for (const s of g.starts) {
      elementStore.update(s.id, { x: s.x + dx, y: s.y + dy })
    }
    // 更新吸附線與尺寸標籤覆蓋層
    const vp          = viewportStore.viewport
    const selIds      = elementStore.selectedIds
    const absSelected = elementStore.selectedElements.map(absoluteCoords)
    const absOthers   = elementStore.rootElements.filter(el => !selIds.has(el.id))
    measurementService.showDragging(absSelected, absOthers, vp.scale)
    uiLayer.batchDraw()
    return
  }

  if (g.kind === 'marquee') {
    const world = pointerWorld()
    const x     = Math.min(g.start.x, world.x)
    const y     = Math.min(g.start.y, world.y)
    g.rect.setAttrs({ x, y, width: Math.abs(world.x - g.start.x), height: Math.abs(world.y - g.start.y) })
    uiLayer.batchDraw()
    return
  }

  if (g.kind === 'drawing') {
    RENDERER_BY_TOOL.get(toolStore.activeTool)
      ?.updateGhost(g.ghost, g.start, pointerWorld())
    uiLayer.batchDraw()
    return
  }

  // 閒置狀態 + Alt 按下：顯示游標所指元素與選取框之間的距離
  if (_altHeld && elementStore.selectedIds.size > 0) {
    const ptr = stage.getPointerPosition()
    const hit = ptr ? stage.getIntersection(ptr) as Konva.Shape | null : null
    const hitId = hit?.id()
    if (hitId && !elementStore.selectedIds.has(hitId)) {
      const hoverEl = elementStore.get(rootSelectableId(hitId))
      if (hoverEl) {
        const absSelected = elementStore.selectedElements.map(absoluteCoords)
        measurementService.showDistanceTo(absSelected, absoluteCoords(hoverEl), viewportStore.viewport.scale)
        uiLayer.batchDraw()
        return
      }
    }
    // 游標移到選取元素上或空白處：退回純尺寸標籤顯示
    const absSelected = elementStore.selectedElements.map(absoluteCoords)
    measurementService.showIdle(absSelected, viewportStore.viewport.scale)
    uiLayer.batchDraw()
  }
}

function onMouseUp(): void {
  const g = _gesture
  stage.container().style.cursor = toolStore.cursor

  if (g.kind === 'panning') { _gesture = { kind: 'idle' }; return }

  if (g.kind === 'dragging') {
    if (g.starts.length > 0) elementStore.pushSnapshot()
    _isDragging = false
    _gesture    = { kind: 'idle' }
    // 拖曳結束：清除吸附線，退回純尺寸標籤
    measurementService.hide()
    return
  }

  if (g.kind === 'marquee') { _suppressNextStageClick = true; commitMarquee(g); return }

  if (g.kind === 'drawing') {
    const newEl = commitDraw(g)
    if (newEl) elementStore.add(newEl)
    g.ghost.destroy()
    uiLayer.batchDraw()
    _gesture = { kind: 'idle' }
    toolStore.setTool(ToolType.Move)
    // 繪製文字元素後自動進入編輯模式（nextTick 等 watchEffect 建立 Konva shape 後再 hide）
    if (newEl?.kind === ElementKind.Text) {
      nextTick(() => startTextEdit(newEl.id))
    }
  }
}

function commitMarquee(g: Extract<GestureState, { kind: 'marquee' }>): void {
  if (g.rect.width() > 2 && g.rect.height() > 2) {
    const bounds = {
      left:   g.rect.x(),
      top:    g.rect.y(),
      right:  g.rect.x() + g.rect.width(),
      bottom: g.rect.y() + g.rect.height(),
    }
    elementStore.clearSelection()
    for (const el of elementStore.rootElements) {
      const aabb   = cullingService.getRotatedBounds(el)
      const inside = !(
        aabb.right < bounds.left || aabb.left > bounds.right ||
        aabb.bottom < bounds.top || aabb.top  > bounds.bottom
      )
      if (inside) elementStore.select(el.id, true)
    }
  }
  g.rect.destroy()
  uiLayer.batchDraw()
  _gesture = { kind: 'idle' }
}

function commitDraw(g: Extract<GestureState, { kind: 'drawing' }>): CanvasElement | null {
  const tool     = toolStore.activeTool
  const renderer = RENDERER_BY_TOOL.get(tool)
  if (!renderer) return null
  const data = renderer.createElement(tool, g.start, pointerWorld())
  if (!data) return null
  return { id: newElementId(), name: `${data.kind} ${Date.now()}`, ...data }
}

// ── Canvas Actions ─────────────────────────────────────────────────────────────

function deleteSelected(): void {
  const ids = [...elementStore.selectedIds]
  if (ids.length === 0) return
  for (const id of ids) elementStore.remove(id)
}

/** 從目前選取集合中取出 root-level 元素 ID（group() 只接受 root-level）。 */
function rootLevelSelectedIds(): string[] {
  return [...elementStore.selectedIds].filter(id => {
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
  const groups = elementStore.selectedElements
    .filter(el => el.kind === ElementKind.Group)
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
  const rootCopyIds: string[]      = []

  for (const el of selected) {
    if (el.kind === ElementKind.Group) {
      const newGroupId   = newElementId()
      const childIdRemap = new Map(el.childIds.map(cid => [cid, newElementId()]))

      allCopies.push({
        ...el,
        id:       newGroupId,
        name:     `${el.name} copy`,
        x:        el.x + 10,
        y:        el.y + 10,
        childIds: el.childIds.map(cid => childIdRemap.get(cid)!),
      })
      rootCopyIds.push(newGroupId)

      for (const childId of el.childIds) {
        const child = elementStore.get(childId)
        if (child) {
          allCopies.push({ ...child, id: childIdRemap.get(childId)!, parentId: newGroupId })
        }
      }
    } else {
      const copy = { ...el, id: newElementId(), name: `${el.name} copy`, x: el.x + 10, y: el.y + 10 }
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
  const rect      = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const stagePos  = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  const hit       = stage.getIntersection(stagePos) as Konva.Shape | null
  const elId      = hit?.id() ?? null

  // 右鍵點擊未選取的元素 → 先選取（提升至父群組）
  // 右鍵點擊空白區域 → 保留現有選取，讓選單仍能對已選元素操作
  if (elId) {
    const selectId = rootSelectableId(elId)
    if (!elementStore.selectedIds.has(selectId)) {
      elementStore.clearSelection()
      elementStore.select(selectId)
    }
  }

  const selectedIds  = elementStore.selectedIds
  const selectedEls  = elementStore.selectedElements
  const rootSelected = selectedEls.filter(el => !el.parentId)

  contextMenu.value = {
    x:            e.clientX,
    y:            e.clientY,
    hasSelection: selectedIds.size > 0,
    canGroup:     rootSelected.length >= 2,
    canUngroup:   selectedEls.some(el => el.kind === ElementKind.Group),
  }
}

function closeContextMenu(): void {
  contextMenu.value = null
}

// ── Keyboard ───────────────────────────────────────────────────────────────────

function keyCombo(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.shiftKey)              parts.push('shift')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

const _keyCommands = new Map<string, (e: KeyboardEvent) => void>([
  ['delete',        (e) => { e.preventDefault(); deleteSelected() }],
  ['backspace',     (e) => { e.preventDefault(); deleteSelected() }],
  ['ctrl+z',        (e) => { e.preventDefault(); elementStore.undo() }],
  ['ctrl+y',        (e) => { e.preventDefault(); elementStore.redo() }],
  ['ctrl+shift+z',  (e) => { e.preventDefault(); elementStore.redo() }],
  ['ctrl+d',        (e) => { e.preventDefault(); duplicateSelected() }],
  ['ctrl+g',        (e) => { e.preventDefault(); groupSelected() }],
  ['ctrl+shift+g',  (e) => { e.preventDefault(); ungroupSelected() }],
  ['ctrl+a',        (e) => { e.preventDefault(); elementStore.selectAll() }],
  [']',             (e) => { e.preventDefault(); [...elementStore.selectedIds].forEach(id => elementStore.bringToFront(id)); elementStore.pushSnapshot() }],
  ['[',             (e) => { e.preventDefault(); [...elementStore.selectedIds].forEach(id => elementStore.sendToBack(id)); elementStore.pushSnapshot() }],
])

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Alt') { e.preventDefault(); _altHeld = true; return }
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
    const vp          = viewportStore.viewport
    const elements    = elementStore.rootElements
    const selectedIds = elementStore.selectedIds
    const { w, h }    = viewportStore.containerSize

    stage.position({ x: vp.x, y: vp.y })
    stage.scale({ x: vp.scale, y: vp.scale })

    const visible = cullingService.cull(
      elements.map(e => e.id),
      elementStore.byId,
      vp, w, h,
    )
    diffRender(visible, selectedIds, vp.scale)
    drawGrid(vp.scale, w, h)

    // 閒置狀態下同步尺寸標籤；拖曳中由 onMouseMove 直接更新（含吸附線），此處跳過
    if (!_isDragging) {
      const absSelected = elementStore.selectedElements.map(absoluteCoords)
      measurementService.showIdle(absSelected, vp.scale)
    }

    stage.batchDraw()
  })

  // cursor 追蹤：工具切換 → 更新 stage container cursor
  watch(() => toolStore.cursor, (cursor) => {
    if (stage && _gesture.kind !== 'panning') {
      stage.container().style.cursor = cursor
    }
  })

  document.addEventListener('keydown', onKeydown)
  document.addEventListener('keyup',   onKeyup)
  document.addEventListener('click',   closeContextMenu)
})

onUnmounted(() => {
  _resizeObserver?.disconnect()
  measurementService.destroy()
  stage?.destroy()
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('keyup',   onKeyup)
  document.removeEventListener('click',   closeContextMenu)
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
        <li class="ctx-item" @click="elementStore.bringToFront([...elementStore.selectedIds][0]); closeContextMenu()">
          Bring to Front <kbd>]</kbd>
        </li>
        <li class="ctx-item" @click="[...elementStore.selectedIds].forEach(id => elementStore.moveUp(id)); closeContextMenu()">
          Move Up
        </li>
        <li class="ctx-item" @click="[...elementStore.selectedIds].forEach(id => elementStore.moveDown(id)); closeContextMenu()">
          Move Down
        </li>
        <li class="ctx-item" @click="elementStore.sendToBack([...elementStore.selectedIds][0]); closeContextMenu()">
          Send to Back <kbd>[</kbd>
        </li>
        <li class="ctx-sep" />
        <li v-if="contextMenu.canGroup" class="ctx-item" @click="groupSelected(); closeContextMenu()">
          Group <kbd>Ctrl G</kbd>
        </li>
        <li v-if="contextMenu.canUngroup" class="ctx-item" @click="ungroupSelected(); closeContextMenu()">
          Ungroup <kbd>Ctrl Shift G</kbd>
        </li>
        <li class="ctx-sep" />
        <li class="ctx-item" @click="duplicateSelected(); closeContextMenu()">
          Duplicate <kbd>Ctrl D</kbd>
        </li>
        <li class="ctx-sep" />
        <li class="ctx-item ctx-item--danger" @click="deleteSelected(); closeContextMenu()">
          Delete <kbd>Del</kbd>
        </li>
      </template>
      <template v-else>
        <li class="ctx-item" @click="elementStore.selectAll(); closeContextMenu()">
          Select All <kbd>Ctrl A</kbd>
        </li>
      </template>
    </ul>
    </Teleport>

    <!-- 文字編輯 overlay：絕對定位於 canvas container，跟隨 viewport 座標即時更新 -->
    <textarea
      v-if="editingTextId"
      ref="textareaRef"
      class="text-edit-overlay"
      :style="editingTextStyle"
      @blur="commitTextEdit"
      @keydown="onTextareaKeydown"
      @input="onTextareaInput"
    />

  </div>
</template>

<style src="./canvas.scss" lang="scss" scoped />
