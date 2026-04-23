import { isCanvasComment, type CanvasComment } from '@/types/comment'
import { ElementKind, type CanvasElement, type ElementStore, type VectorPoint } from '@/types/element'

/** 快照格式版本號；未來若結構破壞性變更時遞增，舊資料可拒絕載入。 */
export const DOCUMENT_SNAPSHOT_VERSION = 1 as const

/** 完整的專案快照：elements + comments 二合一，用於 IndexedDB 存檔與 JSON 匯出入。 */
export interface DocumentSnapshot {
  version: typeof DOCUMENT_SNAPSHOT_VERSION
  savedAt: number
  elements: ElementStore
  comments: CanvasComment[]
}

// 預先建立 Set 以 O(1) 查詢合法值，避免每次驗證都呼叫 Array.includes（O(n)）。
const FONT_WEIGHTS = new Set([100, 200, 300, 400, 500, 600, 700, 800, 900])
const TEXT_ALIGNMENTS = new Set(['left', 'center', 'right'])
const ELEMENT_KINDS = new Set(Object.values(ElementKind))

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOpacity(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

function isNonNegative(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber)
}

function isVectorHandle(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y)
}

function isVectorPoint(value: unknown): value is VectorPoint {
  if (!isRecord(value)) return false
  return (
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    (value.handleIn === undefined || isVectorHandle(value.handleIn)) &&
    (value.handleOut === undefined || isVectorHandle(value.handleOut))
  )
}

function isSolidPaint(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    value.type === 'solid' &&
    typeof value.color === 'string' &&
    (value.opacity === undefined || isOpacity(value.opacity))
  )
}

function cloneSolidPaint(paint: CanvasElement['fill']): CanvasElement['fill'] {
  return paint.opacity === undefined
    ? { type: 'solid', color: paint.color }
    : { type: 'solid', color: paint.color, opacity: paint.opacity }
}

function cloneVectorHandle(handle: VectorPoint['handleIn']): VectorPoint['handleIn'] {
  return handle ? { x: handle.x, y: handle.y } : undefined
}

function cloneVectorPoint(point: VectorPoint): VectorPoint {
  return {
    x: point.x,
    y: point.y,
    handleIn: cloneVectorHandle(point.handleIn),
    handleOut: cloneVectorHandle(point.handleOut),
  }
}

/**
 * 依 DocumentSnapshot schema 白名單複製單一元素，主動忽略任何 runtime / 額外欄位，
 * 避免暫時掛在 store 上的 Window、DOM、Konva attrs 等不可序列化資料污染匯出。
 */
export function cloneCanvasElementSnapshot(element: CanvasElement): CanvasElement {
  const snapshot: CanvasElement = {
    id: element.id,
    kind: element.kind,
    name: element.name,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    rotation: element.rotation,
    scaleX: element.scaleX,
    scaleY: element.scaleY,
    fill: cloneSolidPaint(element.fill),
    stroke: cloneSolidPaint(element.stroke),
    strokeWidth: element.strokeWidth,
    opacity: element.opacity,
    visible: element.visible,
    locked: element.locked,
    parentId: element.parentId,
    childIds: [...element.childIds],
  }

  if (element.text !== undefined) snapshot.text = element.text
  if (element.fontSize !== undefined) snapshot.fontSize = element.fontSize
  if (element.fontFamily !== undefined) snapshot.fontFamily = element.fontFamily
  if (element.fontWeight !== undefined) snapshot.fontWeight = element.fontWeight
  if (element.lineHeight !== undefined) snapshot.lineHeight = element.lineHeight
  if (element.letterSpacing !== undefined) snapshot.letterSpacing = element.letterSpacing
  if (element.textAlign !== undefined) snapshot.textAlign = element.textAlign
  if (element.points !== undefined) snapshot.points = [...element.points]
  if (element.vectorPoints !== undefined) snapshot.vectorPoints = element.vectorPoints.map(cloneVectorPoint)
  if (element.closed !== undefined) snapshot.closed = element.closed
  if (element.cornerRadius !== undefined) snapshot.cornerRadius = element.cornerRadius
  if (element.componentId !== undefined) snapshot.componentId = element.componentId

  return snapshot
}

export function cloneElementStoreSnapshot(store: ElementStore): ElementStore {
  const byId: Record<string, CanvasElement> = {}
  for (const [id, element] of Object.entries(store.byId)) {
    byId[id] = cloneCanvasElementSnapshot(element)
  }
  return {
    byId,
    rootIds: [...store.rootIds],
  }
}

export function cloneCommentSnapshot(comment: CanvasComment): CanvasComment {
  return {
    id: comment.id,
    worldX: comment.worldX,
    worldY: comment.worldY,
    text: comment.text,
    resolved: comment.resolved,
    createdAt: comment.createdAt,
  }
}

export function cloneCommentSnapshots(comments: readonly CanvasComment[]): CanvasComment[] {
  return comments.map(cloneCommentSnapshot)
}

export function cloneDocumentSnapshot(snapshot: DocumentSnapshot): DocumentSnapshot {
  return {
    version: DOCUMENT_SNAPSHOT_VERSION,
    savedAt: snapshot.savedAt,
    elements: cloneElementStoreSnapshot(snapshot.elements),
    comments: cloneCommentSnapshots(snapshot.comments),
  }
}

/** 驗證單一 CanvasElement 的所有必要欄位與型別；選填欄位（text、points 等）允許 undefined。 */
export function isCanvasElementSnapshot(value: unknown): value is CanvasElement {
  if (!isRecord(value)) return false

  return (
    typeof value.id === 'string' &&
    ELEMENT_KINDS.has(value.kind as ElementKind) &&
    typeof value.name === 'string' &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isNonNegative(value.width) &&
    isNonNegative(value.height) &&
    isFiniteNumber(value.rotation) &&
    isFiniteNumber(value.scaleX) &&
    isFiniteNumber(value.scaleY) &&
    isOpacity(value.opacity) &&
    isSolidPaint(value.fill) &&
    isSolidPaint(value.stroke) &&
    isNonNegative(value.strokeWidth) &&
    typeof value.visible === 'boolean' &&
    typeof value.locked === 'boolean' &&
    (value.parentId === undefined || typeof value.parentId === 'string') &&
    isStringArray(value.childIds) &&
    (value.text === undefined || typeof value.text === 'string') &&
    (value.fontSize === undefined || isPositive(value.fontSize)) &&
    (value.fontFamily === undefined || typeof value.fontFamily === 'string') &&
    (value.fontWeight === undefined || FONT_WEIGHTS.has(value.fontWeight as number)) &&
    (value.lineHeight === undefined || isPositive(value.lineHeight)) &&
    (value.letterSpacing === undefined || isFiniteNumber(value.letterSpacing)) &&
    (value.textAlign === undefined || TEXT_ALIGNMENTS.has(value.textAlign as string)) &&
    (value.points === undefined || isFiniteNumberArray(value.points)) &&
    (value.vectorPoints === undefined || (Array.isArray(value.vectorPoints) && value.vectorPoints.every(isVectorPoint))) &&
    (value.closed === undefined || typeof value.closed === 'boolean') &&
    (value.cornerRadius === undefined || isNonNegative(value.cornerRadius)) &&
    (value.componentId === undefined || typeof value.componentId === 'string')
  )
}

/**
 * 驗證整個 ElementStore 的結構完整性：
 * - 每個元素的 parentId / childIds 必須指向 byId 內存在的 id，避免孤兒節點。
 * - 所有 parentId === undefined 的元素必須出現在 rootIds 中（反向一致性）。
 * - rootIds 不允許重複。
 */
export function isElementStoreSnapshot(value: unknown): value is ElementStore {
  if (!isRecord(value) || !isRecord(value.byId) || !isStringArray(value.rootIds)) return false

  const byIdEntries = Object.entries(value.byId)
  const allIds = new Set(byIdEntries.map(([id]) => id))

  for (const [id, element] of byIdEntries) {
    if (!isCanvasElementSnapshot(element)) return false
    if (element.id !== id) return false
    if (element.parentId !== undefined && !allIds.has(element.parentId)) return false
    if (!element.childIds.every((childId) => allIds.has(childId))) return false
  }

  const rootIdSet = new Set(value.rootIds)

  // rootIds 不允許重複
  if (rootIdSet.size !== value.rootIds.length) return false

  for (const rootId of rootIdSet) {
    // rootIds 中的每個 id 必須存在且 parentId === undefined（已通過上方 isCanvasElementSnapshot）
    const root = value.byId[rootId] as CanvasElement | undefined
    if (!root || root.parentId !== undefined) return false
  }

  // parentId === undefined 的元素必須全數出現在 rootIds，防止孤兒根節點
  for (const [, element] of byIdEntries) {
    if ((element as CanvasElement).parentId === undefined && !rootIdSet.has((element as CanvasElement).id)) {
      return false
    }
  }

  return true
}

export function isDocumentSnapshot(value: unknown): value is DocumentSnapshot {
  if (!isRecord(value)) return false
  return (
    value.version === DOCUMENT_SNAPSHOT_VERSION &&
    isFiniteNumber(value.savedAt) &&
    isElementStoreSnapshot(value.elements) &&
    Array.isArray(value.comments) &&
    value.comments.every(isCanvasComment)
  )
}

/**
 * 對外安全入口：驗證通過才返回深拷貝，失敗返回 null。
 * structuredClone 確保呼叫端持有的快照與來源物件完全隔離，防止意外共用參考。
 */
export function parseDocumentSnapshot(value: unknown): DocumentSnapshot | null {
  return isDocumentSnapshot(value) ? cloneDocumentSnapshot(value) : null
}
