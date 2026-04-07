import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  type CanvasElement,
  type ElementStore,
  ElementKind,
  ZOrderDirection,
  newElementId,
  rotatedCorners,
  computeGroupBounds,
  assertStoreIntegrity,
  ELEMENT_HISTORY_MAX,
  ELEMENT_DEFAULT_STROKE,
  GROUP_DEFAULT_NAME,
} from '@/types/element'

export const useElementStore = defineStore('element', () => {
  // ── State ──────────────────────────────────────────────────────────────────

  const _store      = ref<ElementStore>({ byId: {}, rootIds: [] })
  const _selectedIds = ref<ReadonlySet<string>>(new Set())

  // History 不需響應式；直接用普通陣列，避免 Pinia 追蹤大量快照
  let _history:      ElementStore[] = [{ byId: {}, rootIds: [] }]
  let _historyIndex: number         = 0

  // ── Public Computed ────────────────────────────────────────────────────────

  /** O(1) 元素查詢表（供全域使用）。 */
  const byId = computed(() => _store.value.byId)

  /** 有序 root 元素列表（index 0 = bottommost）。 */
  const rootElements = computed<CanvasElement[]>(() => {
    const { byId, rootIds } = _store.value
    return rootIds.map(id => byId[id]).filter((el): el is CanvasElement => !!el)
  })

  /** 當前選取的 id 集合（唯讀）。 */
  const selectedIds = computed(() => _selectedIds.value)

  /** 當前選取的元素物件列表。 */
  const selectedElements = computed<CanvasElement[]>(() => {
    const ids    = _selectedIds.value
    const { byId } = _store.value
    return [...ids].map(id => byId[id]).filter((el): el is CanvasElement => !!el)
  })

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** O(1) 單一元素查詢。 */
  function get(id: string): CanvasElement | undefined {
    return _store.value.byId[id]
  }

  /** 取得某 parent 的有序子元素列表；parentId 為 undefined 時回傳根元素。 */
  function childrenOf(parentId?: string): CanvasElement[] {
    const { byId } = _store.value
    if (!parentId) return rootElements.value
    const parent = byId[parentId]
    if (!parent) return []
    return parent.childIds.map(id => byId[id]).filter((el): el is CanvasElement => !!el)
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  /** 新增單一元素，若有 parentId 則自動掛載至父節點。 */
  function add(el: CanvasElement): void {
    const s = _store.value
    const newById: Record<string, CanvasElement> = { ...s.byId, [el.id]: el }

    if (el.parentId) {
      const parent = s.byId[el.parentId]
      if (parent) {
        newById[parent.id] = { ...parent, childIds: [...parent.childIds, el.id] }
      }
    }

    _store.value = {
      byId:    newById,
      rootIds: el.parentId ? s.rootIds : [...s.rootIds, el.id],
    }

    _pushSnapshot()
    assertStoreIntegrity(_store.value)
  }

  /**
   * 更新單一元素的部分屬性。
   * 拖曳過程中高頻呼叫，故不推 snapshot（由 mouseup 的操作方呼叫 commitUpdate）。
   */
  function update(id: string, patch: Partial<CanvasElement>): void {
    const s  = _store.value
    const el = s.byId[id]
    if (!el) return
    _store.value = { ...s, byId: { ...s.byId, [id]: { ...el, ...patch } } }
  }

  /**
   * 同 update，但同時推入 undo 快照。
   * 用於拖曳結束、屬性面板確認等「使用者完成一次操作」的時機。
   */
  function commitUpdate(id: string, patch: Partial<CanvasElement>): void {
    update(id, patch)
    _pushSnapshot()
    assertStoreIntegrity(_store.value)
  }

  /**
   * 刪除元素（遞迴刪除其子樹）。
   * 同時從 selectedIds 移除已刪除的 id。
   */
  function remove(id: string): void {
    const s  = _store.value
    const el = s.byId[id]
    if (!el) return

    const newById = { ...s.byId }

    const deleteTree = (elId: string): void => {
      const elem = newById[elId]
      if (!elem) return
      for (const childId of elem.childIds) deleteTree(childId)
      delete newById[elId]
    }
    deleteTree(id)

    let newRootIds = s.rootIds
    if (el.parentId) {
      const parent = newById[el.parentId]
      if (parent) {
        newById[parent.id] = {
          ...parent,
          childIds: parent.childIds.filter(cid => cid !== id),
        }
      }
    } else {
      newRootIds = s.rootIds.filter(rid => rid !== id)
    }

    _store.value = { byId: newById, rootIds: newRootIds }

    _selectedIds.value = (() => {
      const next = new Set(_selectedIds.value)
      next.delete(id)
      return next
    })()

    _pushSnapshot()
    assertStoreIntegrity(_store.value)
  }

  /** 以完整元素陣列取代 store（用於載入專案）。 */
  function setAll(elements: CanvasElement[]): void {
    const byId: Record<string, CanvasElement> = {}
    const rootIds: string[] = []
    for (const el of elements) {
      byId[el.id] = el
      if (!el.parentId) rootIds.push(el.id)
    }
    _store.value = { byId, rootIds }
    _pushSnapshot()
    assertStoreIntegrity(_store.value)
  }

  /** 批次新增多個元素（單次 snapshot，效能優於多次 add）。 */
  function addAll(elements: CanvasElement[]): void {
    const s      = _store.value
    const byId   = { ...s.byId }
    const rootIds = [...s.rootIds]
    for (const el of elements) {
      byId[el.id] = el
      if (!el.parentId) rootIds.push(el.id)
    }
    _store.value = { byId, rootIds }
    _pushSnapshot()
    assertStoreIntegrity(_store.value)
  }

  // ── Group 邊界同步 ─────────────────────────────────────────────────────────

  /**
   * 在子元素移動 / 縮放後呼叫，將 Group 的 x, y, width, height 同步至最新 AABB。
   * 操作方（如拖曳結束、resizing 完成）負責呼叫此 action。
   */
  function syncGroupBounds(groupId: string): void {
    const s     = _store.value
    const group = s.byId[groupId]
    if (!group || group.kind !== ElementKind.Group) return

    const bounds = computeGroupBounds(group, s)
    _store.value = {
      ...s,
      byId: { ...s.byId, [groupId]: { ...group, ...bounds } },
    }
  }

  // ── Group / Ungroup ────────────────────────────────────────────────────────

  /**
   * 將指定的 root-level 元素包進一個新 Group。
   * 子元素座標轉換為相對於 Group 原點（子 local → parent local）。
   *
   * 回傳新 Group 的 id；若元素數量 < 2 則不執行並回傳空字串。
   */
  function group(ids: string[]): string {
    const s = _store.value

    // 只處理 root-level 元素
    const elements = ids
      .map(id => s.byId[id])
      .filter((el): el is CanvasElement => !!el && !el.parentId)
    if (elements.length < 2) return ''

    const groupId  = newElementId()
    const idSet    = new Set(ids)
    // 保留原始 z-order（rootIds 中的順序）
    const orderedIds = s.rootIds.filter(id => idSet.has(id))

    // 使用 rotatedCorners 計算正確的 AABB（含 rotation）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const el of elements) {
      for (const [px, py] of rotatedCorners(el)) {
        if (px < minX) minX = px
        if (py < minY) minY = py
        if (px > maxX) maxX = px
        if (py > maxY) maxY = py
      }
    }

    const newById = { ...s.byId }

    // 子元素座標轉為相對於 Group 原點
    for (const id of orderedIds) {
      const child = newById[id]
      newById[id] = { ...child, parentId: groupId, x: child.x - minX, y: child.y - minY }
    }

    newById[groupId] = {
      id:          groupId,
      kind:        ElementKind.Group,
      name:        GROUP_DEFAULT_NAME,
      x:           minX,
      y:           minY,
      width:       maxX - minX,
      height:      maxY - minY,
      rotation:    0,
      scaleX:      1,
      scaleY:      1,
      opacity:     1,
      fill:        { type: 'solid', color: '' },
      stroke:      ELEMENT_DEFAULT_STROKE,
      strokeWidth: 0,
      visible:     true,
      locked:      false,
      parentId:    undefined,
      childIds:    orderedIds,
    }

    // rootIds：以 Group 取代被打包的元素（維持 z-order 插入位置）
    let inserted = false
    const newRootIds = s.rootIds.reduce<string[]>((acc, id) => {
      if (idSet.has(id)) {
        if (!inserted) { acc.push(groupId); inserted = true }
        // 被打包的元素已移入 Group，不再出現於 rootIds
      } else {
        acc.push(id)
      }
      return acc
    }, [])

    _store.value = { byId: newById, rootIds: newRootIds }
    _pushSnapshot()
    assertStoreIntegrity(_store.value)

    return groupId
  }

  /**
   * 解散 Group，將其子元素移回 root level。
   * 子元素座標轉換回絕對座標（child local → world）。
   *
   * 回傳被還原的子元素 id 列表，供呼叫方重新選取。
   */
  function ungroup(id: string): string[] {
    const s     = _store.value
    const group = s.byId[id]
    if (!group || group.kind !== ElementKind.Group) return []

    const childIds = [...group.childIds]
    const groupIdx = s.rootIds.indexOf(id)
    if (groupIdx === -1) return []

    const newById = { ...s.byId }
    delete newById[id]

    // 子元素座標還原為絕對座標
    for (const childId of childIds) {
      const child = newById[childId]
      if (child) {
        newById[childId] = {
          ...child,
          parentId: undefined,
          x: child.x + group.x,
          y: child.y + group.y,
        }
      }
    }

    // 以子元素取代 Group 的位置（維持 z-order）
    const newRootIds = [...s.rootIds]
    newRootIds.splice(groupIdx, 1, ...childIds)

    _store.value = { byId: newById, rootIds: newRootIds }

    _selectedIds.value = (() => {
      const next = new Set(_selectedIds.value)
      next.delete(id)
      return next
    })()

    _pushSnapshot()
    assertStoreIntegrity(_store.value)

    return childIds
  }

  // ── Z-Order ────────────────────────────────────────────────────────────────

  function bringToFront(id: string): void { _reorder(id, ZOrderDirection.Front) }
  function sendToBack(id: string):   void { _reorder(id, ZOrderDirection.Back)  }
  function moveUp(id: string):       void { _reorder(id, ZOrderDirection.Up)    }
  function moveDown(id: string):     void { _reorder(id, ZOrderDirection.Down)  }

  function _reorder(id: string, dir: ZOrderDirection): void {
    const s  = _store.value
    const el = s.byId[id]
    if (!el) return

    const isRoot = !el.parentId
    const list   = isRoot
      ? [...s.rootIds]
      : [...(s.byId[el.parentId!]?.childIds ?? [])]
    const idx = list.indexOf(id)
    if (idx === -1) return

    list.splice(idx, 1)
    switch (dir) {
      case ZOrderDirection.Front: list.push(id);                                      break
      case ZOrderDirection.Back:  list.unshift(id);                                   break
      case ZOrderDirection.Up:    list.splice(Math.min(idx + 1, list.length), 0, id); break
      case ZOrderDirection.Down:  list.splice(Math.max(idx - 1, 0),           0, id); break
    }

    if (isRoot) {
      _store.value = { ...s, rootIds: list }
    } else {
      const parent = s.byId[el.parentId!]
      _store.value = {
        ...s,
        byId: { ...s.byId, [parent.id]: { ...parent, childIds: list } },
      }
    }
  }

  // ── Undo / Redo ────────────────────────────────────────────────────────────

  function _pushSnapshot(): void {
    const current = _store.value
    _history = _history.slice(0, _historyIndex + 1)
    _history.push(current)
    if (_history.length > ELEMENT_HISTORY_MAX) {
      _history.shift()
    } else {
      _historyIndex++
    }
  }

  function undo(): void {
    if (_historyIndex > 0) {
      _historyIndex--
      _store.value = _history[_historyIndex]
      clearSelection()
    }
  }

  function redo(): void {
    if (_historyIndex < _history.length - 1) {
      _historyIndex++
      _store.value = _history[_historyIndex]
      clearSelection()
    }
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  /**
   * 選取單一元素；multi = true 時為多選（Shift+click）。
   * 再次點擊已選取的元素會取消選取（toggle）。
   */
  function select(id: string, multi = false): void {
    if (multi) {
      const next = new Set(_selectedIds.value)
      next.has(id) ? next.delete(id) : next.add(id)
      _selectedIds.value = next
    } else {
      _selectedIds.value = new Set([id])
    }
  }

  function selectAll(): void {
    _selectedIds.value = new Set(_store.value.rootIds)
  }

  function clearSelection(): void {
    _selectedIds.value = new Set()
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    // Computed (read-only)
    byId,
    rootElements,
    selectedIds,
    selectedElements,
    // Lookup
    get,
    childrenOf,
    // CRUD
    add,
    update,
    commitUpdate,
    remove,
    setAll,
    addAll,
    // Group
    syncGroupBounds,
    group,
    ungroup,
    // Z-Order
    bringToFront,
    sendToBack,
    moveUp,
    moveDown,
    // History
    undo,
    redo,
    pushSnapshot: _pushSnapshot,
    // Selection
    select,
    selectAll,
    clearSelection,
  }
})
