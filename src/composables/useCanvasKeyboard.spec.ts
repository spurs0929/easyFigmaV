import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type Konva from 'konva'
import { useElementStore } from '@/store/element'
import { useCanvasKeyboard } from '@/composables/useCanvasKeyboard'
import { ELEMENT_HISTORY_MAX, ElementKind, type CanvasElement } from '@/types/element'
import type { GestureState } from '@/types/canvas'

type Store = ReturnType<typeof useElementStore>
type PenGesture = Extract<GestureState, { kind: 'pen' }>

function rect(id: string, patch: Partial<CanvasElement> = {}): CanvasElement {
  return {
    id,
    kind: ElementKind.Rect,
    name: id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
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

function ids(store: Store): string[] {
  return Object.keys(store.byId).sort()
}

/**
 * 一直 undo（或 redo）到 history 走到底，回傳實際走了幾步。
 * undo / redo 只有在 history 位置真的移動時才遞增 documentRevision。
 */
function drain(store: Store, step: () => void): number {
  let steps = 0
  for (let i = 0; i < ELEMENT_HISTORY_MAX * 2; i++) {
    const revision = store.documentRevision
    step()
    if (store.documentRevision === revision) break
    steps++
  }
  return steps
}

// 手勢裡的 Konva 物件只會被 CanvasArea 使用，鍵盤這一層不會碰到，測試用空物件代替。
const konvaShape = {} as Konva.Shape
const konvaRect = {} as Konva.Rect
const konvaGroup = {} as Konva.Group

function penGesture(pointCount: number, patch: Partial<PenGesture> = {}): PenGesture {
  return {
    kind: 'pen',
    points: Array.from({ length: pointCount }, (_, i) => ({ x: i * 10, y: i * 10 })),
    path: konvaShape,
    controls: konvaGroup,
    pointerDown: true,
    activeIndex: pointCount - 1,
    dragOrigin: { x: 0, y: 0 },
    hoverPoint: null,
    closing: true,
    ...patch,
  }
}

/** GestureState 裡所有不是 idle 的種類。新增手勢種類時這裡要跟著補。 */
const ACTIVE_GESTURES: Record<Exclude<GestureState['kind'], 'idle'>, () => GestureState> = {
  panning: () => ({ kind: 'panning', stageX: 0, stageY: 0, px: 0, py: 0 }),
  dragging: () => ({
    kind: 'dragging',
    startWorld: { x: 0, y: 0 },
    starts: [{ id: 'a', x: 0, y: 0 }],
  }),
  resizing: () => ({
    kind: 'resizing',
    id: 'a',
    handle: 'br',
    origin: { x: 0, y: 0, width: 10, height: 10 },
  }),
  marquee: () => ({ kind: 'marquee', start: { x: 0, y: 0 }, rect: konvaRect }),
  drawing: () => ({ kind: 'drawing', start: { x: 0, y: 0 }, ghost: konvaShape }),
  pen: () => penGesture(2),
  pencil: () => ({
    kind: 'pencil',
    points: [{ x: 0, y: 0 }],
    path: konvaShape,
    hoverPoint: { x: 0, y: 0 },
  }),
}
const ACTIVE_KINDS = Object.keys(ACTIVE_GESTURES) as Array<keyof typeof ACTIVE_GESTURES>

interface Shortcut {
  label: string
  init: KeyboardEventInit
  action: 'undo' | 'redo'
}

// Shift 按著時瀏覽器回報的 key 是大寫 Z。Cmd（metaKey）與 Ctrl 走同一條路徑。
const HISTORY_SHORTCUTS: Shortcut[] = [
  { label: 'Ctrl+Z', init: { key: 'z', ctrlKey: true }, action: 'undo' },
  { label: 'Cmd+Z', init: { key: 'z', metaKey: true }, action: 'undo' },
  { label: 'Ctrl+Y', init: { key: 'y', ctrlKey: true }, action: 'redo' },
  { label: 'Cmd+Y', init: { key: 'y', metaKey: true }, action: 'redo' },
  { label: 'Ctrl+Shift+Z', init: { key: 'Z', ctrlKey: true, shiftKey: true }, action: 'redo' },
  { label: 'Cmd+Shift+Z', init: { key: 'Z', metaKey: true, shiftKey: true }, action: 'redo' },
]

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { cancelable: true, ...init })
}

function createKeyboard(initial: GestureState = { kind: 'idle' }) {
  let gesture = initial
  const spies = {
    cancelPenGesture: vi.fn(),
    cancelPencilGesture: vi.fn(),
    finishPenGesture: vi.fn(),
    refreshPenGesture: vi.fn(),
    deleteSelected: vi.fn(),
    duplicateSelected: vi.fn(),
    groupSelected: vi.fn(),
    ungroupSelected: vi.fn(),
    onAltRelease: vi.fn(),
  }
  const keyboard = useCanvasKeyboard({
    // 與 CanvasArea 相同：每次按鍵都重新讀取當下的手勢。
    getGesture: () => gesture,
    pointerWorld: () => ({ x: 99, y: 88 }),
    ...spies,
  })
  return {
    keyboard,
    spies,
    setGesture: (next: GestureState) => {
      gesture = next
    },
    press: (init: KeyboardEventInit): KeyboardEvent => {
      const event = keydown(init)
      keyboard.onKeydown(event)
      return event
    },
  }
}

describe('useCanvasKeyboard：Undo / Redo 與進行中的手勢', () => {
  let store: Store

  /**
   * 建立 history：[空, a, a+b, a+b+c]，再 undo 一次停在 a+b。
   * 這個位置往回還有 2 步、往前還有 1 步，undo 與 redo 都有東西可以走。
   */
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useElementStore()
    store.add(rect('a'))
    store.add(rect('b'))
    store.add(rect('c'))
    store.undo()
    store.select('a')
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  describe('手勢進行中', () => {
    const cases = ACTIVE_KINDS.flatMap((kind) =>
      HISTORY_SHORTCUTS.map((shortcut) => ({ kind, ...shortcut })),
    )

    it.each(cases)('$kind 中按 $label：不執行 $action，但仍擋下瀏覽器預設行為', (c) => {
      const undo = vi.spyOn(store, 'undo')
      const redo = vi.spyOn(store, 'redo')
      const { press } = createKeyboard(ACTIVE_GESTURES[c.kind]())
      const revision = store.documentRevision

      const event = press(c.init)

      expect(event.defaultPrevented).toBe(true)
      expect(undo).not.toHaveBeenCalled()
      expect(redo).not.toHaveBeenCalled()
      // 文件、選取、自動存檔的觸發計數都不能動。
      expect(ids(store)).toEqual(['a', 'b'])
      expect([...store.selectedIds]).toEqual(['a'])
      expect(store.documentRevision).toBe(revision)
    })

    it.each(ACTIVE_KINDS)('%s 中按過三種快捷鍵之後，history 兩個方向都完整保留', (kind) => {
      const { press } = createKeyboard(ACTIVE_GESTURES[kind]())
      for (const shortcut of HISTORY_SHORTCUTS) press(shortcut.init)

      // 往前仍有 c 那一步；再往回可以一路走回空畫布（c、b、a 共 3 步）。
      expect(drain(store, () => store.redo())).toBe(1)
      expect(ids(store)).toEqual(['a', 'b', 'c'])
      expect(drain(store, () => store.undo())).toBe(3)
      expect(ids(store)).toEqual([])
    })

    it('拖曳到一半按 Ctrl+Z：其他元素不會消失，放開後這次拖曳是獨立的一筆 Undo', () => {
      // 重現步驟：畫兩個矩形 → 拖第一個、不放開按 Ctrl+Z → 繼續拖 → 放開。
      // 修正前 Ctrl+Z 會把 b 的建立復原，放開時推的快照再截斷 redo，b 永久消失。
      const { press, setGesture } = createKeyboard(ACTIVE_GESTURES.dragging())

      store.update('a', { x: 50 })
      press({ key: 'z', ctrlKey: true })
      store.update('a', { x: 80 })
      // mouseup：CanvasArea 推快照並回到 idle。
      store.pushSnapshot()
      setGesture({ kind: 'idle' })

      expect(ids(store)).toEqual(['a', 'b'])
      expect(store.get('a')?.x).toBe(80)

      press({ key: 'z', ctrlKey: true })
      expect(ids(store)).toEqual(['a', 'b'])
      expect(store.get('a')?.x).toBe(0)
    })

    it('Pen 繪製中按 Ctrl+Z：不復原文件，也不動 Pen 的錨點', () => {
      const gesture = penGesture(3)
      const { press, spies } = createKeyboard(gesture)

      press({ key: 'z', ctrlKey: true })

      expect(ids(store)).toEqual(['a', 'b'])
      expect(gesture.points).toHaveLength(3)
      expect(spies.cancelPenGesture).not.toHaveBeenCalled()
      expect(spies.finishPenGesture).not.toHaveBeenCalled()
      expect(spies.refreshPenGesture).not.toHaveBeenCalled()
    })
  })

  describe('idle', () => {
    it.each(HISTORY_SHORTCUTS.filter((s) => s.action === 'undo'))('$label 復原一步', (s) => {
      const { press } = createKeyboard()

      const event = press(s.init)

      expect(event.defaultPrevented).toBe(true)
      expect(ids(store)).toEqual(['a'])
      // undo 既有行為：清空選取。
      expect(store.selectedIds.size).toBe(0)
    })

    it.each(HISTORY_SHORTCUTS.filter((s) => s.action === 'redo'))('$label 重做一步', (s) => {
      const { press } = createKeyboard()

      const event = press(s.init)

      expect(event.defaultPrevented).toBe(true)
      expect(ids(store)).toEqual(['a', 'b', 'c'])
      expect(store.selectedIds.size).toBe(0)
    })

    it('手勢結束回到 idle 之後，同一組快捷鍵恢復作用', () => {
      const { press, setGesture } = createKeyboard(ACTIVE_GESTURES.dragging())

      press({ key: 'z', ctrlKey: true })
      expect(ids(store)).toEqual(['a', 'b'])

      setGesture({ kind: 'idle' })
      press({ key: 'z', ctrlKey: true })
      expect(ids(store)).toEqual(['a'])

      press({ key: 'y', ctrlKey: true })
      expect(ids(store)).toEqual(['a', 'b'])
    })
  })

  describe('輸入框聚焦', () => {
    function focusInput(): void {
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      expect(document.activeElement).toBe(input)
    }

    it.each(HISTORY_SHORTCUTS)('idle 時 $label 交給輸入框：不動文件、不擋預設行為', (s) => {
      focusInput()
      const { press } = createKeyboard()
      const revision = store.documentRevision

      const event = press(s.init)

      expect(event.defaultPrevented).toBe(false)
      expect(ids(store)).toEqual(['a', 'b'])
      expect(store.documentRevision).toBe(revision)
    })

    it.each(HISTORY_SHORTCUTS)('手勢進行中 $label 同樣交給輸入框', (s) => {
      focusInput()
      const { press } = createKeyboard(ACTIVE_GESTURES.dragging())

      const event = press(s.init)

      expect(event.defaultPrevented).toBe(false)
      expect(ids(store)).toEqual(['a', 'b'])
    })
  })

  describe('Pen / Pencil 既有快捷鍵不受影響', () => {
    it('Pen：Escape 取消草稿', () => {
      const { press, spies } = createKeyboard(penGesture(3))

      const event = press({ key: 'Escape' })

      expect(event.defaultPrevented).toBe(true)
      expect(spies.cancelPenGesture).toHaveBeenCalledTimes(1)
      expect(spies.finishPenGesture).not.toHaveBeenCalled()
    })

    it('Pen：Enter 以開放路徑完成', () => {
      const { press, spies } = createKeyboard(penGesture(3))

      const event = press({ key: 'Enter' })

      expect(event.defaultPrevented).toBe(true)
      expect(spies.finishPenGesture).toHaveBeenCalledTimes(1)
      expect(spies.finishPenGesture).toHaveBeenCalledWith(false)
      expect(spies.cancelPenGesture).not.toHaveBeenCalled()
    })

    it.each(['Backspace', 'Delete'])('Pen：%s 移除最後一個錨點，不刪除選取的元素', (key) => {
      const gesture = penGesture(3)
      const { press, spies } = createKeyboard(gesture)

      const event = press({ key })

      expect(event.defaultPrevented).toBe(true)
      expect(gesture.points).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ])
      expect(gesture.activeIndex).toBe(1)
      expect(gesture.pointerDown).toBe(false)
      expect(gesture.closing).toBe(false)
      expect(gesture.hoverPoint).toEqual({ x: 99, y: 88 })
      expect(spies.refreshPenGesture).toHaveBeenCalledWith(gesture)
      expect(spies.cancelPenGesture).not.toHaveBeenCalled()
      expect(spies.deleteSelected).not.toHaveBeenCalled()
    })

    it.each(['Backspace', 'Delete'])('Pen：只剩一個錨點時 %s 取消整個草稿', (key) => {
      const gesture = penGesture(1)
      const { press, spies } = createKeyboard(gesture)

      press({ key })

      expect(spies.cancelPenGesture).toHaveBeenCalledTimes(1)
      expect(spies.refreshPenGesture).not.toHaveBeenCalled()
      expect(spies.deleteSelected).not.toHaveBeenCalled()
    })

    it('Pencil：Escape 取消草稿', () => {
      const { press, spies } = createKeyboard(ACTIVE_GESTURES.pencil())

      const event = press({ key: 'Escape' })

      expect(event.defaultPrevented).toBe(true)
      expect(spies.cancelPencilGesture).toHaveBeenCalledTimes(1)
    })
  })
})
