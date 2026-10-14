import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import Konva from 'konva'
import { useElementStore } from '@/store/element'
import { useToolStore } from '@/store/tool'
import { useViewportStore } from '@/store/viewport'
import { ELEMENT_HISTORY_MAX, ElementKind, type CanvasElement } from '@/types/element'
import { ToolType } from '@/types/tool'
import CanvasArea from './CanvasArea.vue'

// ─────────────────────────────────────────────────────────────────────────────
//  測的是 CanvasArea 的滑鼠手勢生命週期，所以事件一律走真正的路徑：
//  DOM MouseEvent → Konva 綁在 stage.content 上的 listener → stage.on('mouse*')。
//
//  jsdom 缺的東西才替換：
//  • canvas 2D context：jsdom 沒有實作，Konva 一畫就會丟例外，換成什麼都不做的假 context。
//  • 命中測試：Konva 靠讀 hit canvas 的像素判斷滑鼠下是哪個 shape，假 context 讀不到，
//    改成用 shape 的 client rect 判斷（越晚加入的越上層）。
//  • 容器尺寸、ResizeObserver：jsdom 沒有版面，不給尺寸的話所有元素都會被視窗裁掉。
// ─────────────────────────────────────────────────────────────────────────────

const CANVAS_W = 800
const CANVAS_H = 600

type Store = ReturnType<typeof useElementStore>

function rect(id: string, patch: Partial<CanvasElement> = {}): CanvasElement {
  return {
    id,
    kind: ElementKind.Rect,
    name: id,
    x: 100,
    y: 100,
    width: 100,
    height: 100,
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

function fakeContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const result = {
    width: 0,
    data: new Uint8ClampedArray(4),
    addColorStop: () => undefined,
  }
  const state: Record<PropertyKey, unknown> = { canvas }
  return new Proxy(state, {
    get: (target, prop) => (prop in target ? target[prop] : () => result),
    set: (target, prop, value) => {
      target[prop] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

function hitTest(stage: Konva.Stage, pos: { x: number; y: number }): Konva.Shape | null {
  const shapes = stage.find((node: Konva.Node) => node instanceof Konva.Shape) as Konva.Shape[]
  for (const shape of shapes.reverse()) {
    if (!shape.isListening() || !shape.isVisible()) continue
    const r = shape.getClientRect()
    if (pos.x >= r.x && pos.x <= r.x + r.width && pos.y >= r.y && pos.y <= r.y + r.height) {
      return shape
    }
  }
  return null
}

const restores: Array<() => void> = []

beforeAll(() => {
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(function (this: HTMLCanvasElement) {
      return fakeContext(this)
    } as unknown as typeof HTMLCanvasElement.prototype.getContext)
  restores.push(() => getContext.mockRestore())

  const intersection = vi
    .spyOn(Konva.Stage.prototype, 'getIntersection')
    .mockImplementation(function (this: Konva.Stage, pos) {
      return pos ? hitTest(this, pos) : null
    })
  restores.push(() => intersection.mockRestore())

  for (const [prop, value] of [
    ['clientWidth', CANVAS_W],
    ['clientHeight', CANVAS_H],
  ] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value })
    restores.push(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, prop, original)
    })
  }

  const hadResizeObserver = 'ResizeObserver' in globalThis
  const originalResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  restores.push(() => {
    if (hadResizeObserver) globalThis.ResizeObserver = originalResizeObserver
    else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  })
})

afterAll(() => {
  while (restores.length) restores.pop()?.()
})

// ── 掛載與事件 ────────────────────────────────────────────────────────────────

let pinia: Pinia
let wrapper: VueWrapper | null = null
let stage: Konva.Stage

async function mountCanvas(elements: CanvasElement[] = []): Promise<Store> {
  const store = useElementStore()
  store.loadSnapshot({
    byId: Object.fromEntries(elements.map((el) => [el.id, el])),
    rootIds: elements.map((el) => el.id),
  })
  wrapper = mount(CanvasArea, {
    global: {
      plugins: [pinia],
      stubs: { CommentOverlay: true, RemoteCursors: true, SelectionContextMenu: true },
    },
    attachTo: document.body,
  })
  stage = Konva.stages.at(-1)!
  await nextTick()
  return store
}

function mouse(target: EventTarget, type: string, x: number, y: number, init: MouseEventInit = {}) {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: type !== 'mouseleave',
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      ...init,
    }),
  )
}

const content = () => stage.content
const press = (x: number, y: number, init?: MouseEventInit) =>
  mouse(content(), 'mousedown', x, y, init)
const move = (x: number, y: number, init?: MouseEventInit) =>
  mouse(content(), 'mousemove', x, y, init)
/** 在畫布上放開：Konva 會依序送出 mouseup 與（同一個 shape 上按下時的）click。 */
const releaseOnStage = (x: number, y: number, init?: MouseEventInit) =>
  mouse(content(), 'mouseup', x, y, init)
/** 拖出畫布：Stage 收到 mouseleave，之後就收不到 mousemove / mouseup。 */
const leave = (x: number, y: number) => mouse(content(), 'mouseleave', x, y)
/** 在畫布外放開：mouseup 只會送到滑鼠底下的元素（這裡是 body），Stage 收不到。 */
const releaseOutside = (x: number, y: number, init?: MouseEventInit) =>
  mouse(document.body, 'mouseup', x, y, init)
/** 放開滑鼠鍵之後回到畫布上移動。 */
const hover = (x: number, y: number) => move(x, y, { buttons: 0 })
/** 等這次事件派發（含 window 層延後的確認）全部跑完。 */
const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 模擬其他 listener 在 capture 階段攔下 mouseup，Konva 綁在 Stage 上的 listener 收不到。 */
function blockMouseUpBeforeStage(): () => void {
  const block = (e: MouseEvent) => e.stopPropagation()
  document.addEventListener('mouseup', block, true)
  return () => document.removeEventListener('mouseup', block, true)
}

function key(k: string, init: KeyboardEventInit = {}) {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  )
}
const pressUndo = () => key('z', { ctrlKey: true })
const pressRedo = () => key('z', { ctrlKey: true, shiftKey: true })

/** 目前 history 位置往回能 undo 幾步（量完會 redo 回原位）。 */
function undoDepth(store: Store): number {
  let steps = 0
  for (let i = 0; i < ELEMENT_HISTORY_MAX; i++) {
    const revision = store.documentRevision
    store.undo()
    if (store.documentRevision === revision) break
    steps++
  }
  for (let i = 0; i < steps; i++) store.redo()
  return steps
}

function box(store: Store, id: string) {
  const el = store.get(id)!
  return { x: el.x, y: el.y, width: el.width, height: el.height }
}

function vectors(store: Store): CanvasElement[] {
  return Object.values(store.byId).filter((el) => el.kind === ElementKind.Vector)
}

/** 選取一個元素，等選取框（含四角縮放把手）畫出來。 */
async function selectAndRender(store: Store, id: string) {
  store.select(id)
  await nextTick()
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

// ── Dragging ─────────────────────────────────────────────────────────────────

describe('CanvasArea：拖曳的 mouseup', () => {
  it('在畫布上放開：只建立一筆 Undo，Undo / Redo 都能還原', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(170, 180)
    releaseOnStage(170, 180)

    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
    expect(undoDepth(store)).toBe(1)

    pressUndo()
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    pressRedo()
    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
  })

  it('在畫布外放開：結束拖曳並只建立一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(780, 150)
    leave(805, 150)
    releaseOutside(1000, 150)

    // 停在使用者最後在畫布上看到的位置：不用 mouseleave 的座標，也不用畫布外的放開點。
    expect(box(store, 'a')).toMatchObject({ x: 730, y: 100 })
    expect(undoDepth(store)).toBe(1)
  })

  it('在畫布外放開後回到畫布：元素不再跟著滑鼠移動', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(780, 150)
    leave(805, 150)
    releaseOutside(1000, 150)
    hover(400, 400)

    expect(box(store, 'a')).toMatchObject({ x: 730, y: 100 })
  })

  it('在畫布外放開後手勢回到 idle：Undo / Redo 立即可用', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(780, 150)
    leave(805, 150)
    releaseOutside(1000, 150)

    // 手勢進行中 Undo 會被忽略（Batch 2C-1），能 Undo 就代表已回到 idle。
    pressUndo()
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    pressRedo()
    expect(box(store, 'a')).toMatchObject({ x: 730, y: 100 })
  })

  it('在畫布外放開後的下一次拖曳，各自是一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(780, 150)
    leave(805, 150)
    releaseOutside(1000, 150)

    // 讓畫面依新位置重繪，下一次按下才點得到元素（瀏覽器裡兩次操作之間一定會重繪）。
    await nextTick()
    press(750, 150)
    move(750, 250)
    releaseOnStage(750, 250)

    expect(box(store, 'a')).toMatchObject({ x: 730, y: 200 })
    expect(undoDepth(store)).toBe(2)
    pressUndo()
    expect(box(store, 'a')).toMatchObject({ x: 730, y: 100 })
    pressUndo()
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
  })

  it('Stage 與 window 都看得到同一個 mouseup：只 commit 一次', async () => {
    const store = await mountCanvas([rect('a')])
    const push = vi.spyOn(store, 'pushSnapshot')

    press(150, 150)
    move(170, 180)
    // 在畫布上放開的 mouseup 會冒泡到 window；window 層不能再處理一次。
    releaseOnStage(170, 180)
    // 之後多出來的 mouseup（例如另一顆按鍵）也不能再 commit。
    releaseOutside(1000, 150)
    // window 層對落在 Stage 上的 mouseup 會延後確認一次；確認跑完也不能再 commit。
    await macrotask()

    expect(push).toHaveBeenCalledTimes(1)
    expect(undoDepth(store)).toBe(1)
  })

  it('沒有移動就在畫布外放開：不新增空白 History', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    leave(805, 150)
    releaseOutside(1000, 150)

    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    expect(undoDepth(store)).toBe(0)
  })
})

// ── Resizing ─────────────────────────────────────────────────────────────────

describe('CanvasArea：縮放的 mouseup', () => {
  it('在畫布上放開：只建立一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])
    await selectAndRender(store, 'a')

    press(200, 200) // 右下角把手
    move(260, 250)
    releaseOnStage(260, 250)

    expect(box(store, 'a')).toEqual({ x: 100, y: 100, width: 160, height: 150 })
    expect(undoDepth(store)).toBe(1)
  })

  it('在畫布外放開：結束縮放、只建立一筆 Undo，Undo / Redo 都能還原', async () => {
    const store = await mountCanvas([rect('a')])
    await selectAndRender(store, 'a')

    press(200, 200)
    move(260, 590)
    leave(260, 605)
    releaseOutside(260, 900)
    hover(300, 300)

    expect(box(store, 'a')).toEqual({ x: 100, y: 100, width: 160, height: 490 })
    expect(undoDepth(store)).toBe(1)

    pressUndo()
    expect(box(store, 'a')).toEqual({ x: 100, y: 100, width: 100, height: 100 })
    pressRedo()
    expect(box(store, 'a')).toEqual({ x: 100, y: 100, width: 160, height: 490 })
  })

  it('沒有移動就在畫布外放開：不新增空白 History', async () => {
    const store = await mountCanvas([rect('a')])
    await selectAndRender(store, 'a')

    press(200, 200)
    leave(200, 605)
    releaseOutside(200, 900)

    expect(box(store, 'a')).toEqual({ x: 100, y: 100, width: 100, height: 100 })
    expect(undoDepth(store)).toBe(0)
  })
})

// ── Panning ──────────────────────────────────────────────────────────────────

describe('CanvasArea：平移的 mouseup', () => {
  it('在畫布外放開：停止平移、還原游標，不產生 History', async () => {
    const store = await mountCanvas([rect('a')])
    const viewport = useViewportStore()
    useToolStore().setTool(ToolType.Hand)
    await nextTick()

    press(400, 300)
    move(500, 350)
    leave(805, 350)
    releaseOutside(1000, 350)
    hover(100, 100)

    expect(viewport.viewport).toMatchObject({ x: 100, y: 50 })
    expect(stage.container().style.cursor).toBe(useToolStore().cursor)
    expect(undoDepth(store)).toBe(0)
  })
})

// ── Marquee ──────────────────────────────────────────────────────────────────

describe('CanvasArea：框選的 mouseup', () => {
  it('在畫布外放開：以最後畫面上的框完成選取，框不殘留', async () => {
    const store = await mountCanvas([rect('a'), rect('b', { x: 600, y: 100 })])

    press(50, 50)
    move(300, 300)
    leave(300, 605)
    releaseOutside(300, 900)
    hover(790, 590)

    expect([...store.selectedIds]).toEqual(['a'])
    const marquees = stage.find((n: Konva.Node) => n instanceof Konva.Rect && n.dash().length > 0)
    expect(marquees.filter((n) => !store.get(n.id()))).toHaveLength(0)
    expect(undoDepth(store)).toBe(0)
  })
})

// ── Drawing ──────────────────────────────────────────────────────────────────

describe('CanvasArea：繪製的 mouseup', () => {
  it('在畫布外放開：以最後畫面上的預覽建立元素，只建立一筆 Undo', async () => {
    const store = await mountCanvas()
    useToolStore().setTool(ToolType.Rect)
    await nextTick()

    press(600, 400)
    move(780, 500)
    leave(805, 500)
    releaseOutside(1000, 700)

    const created = Object.values(store.byId)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ x: 600, y: 400, width: 180, height: 100 })
    expect(useToolStore().activeTool).toBe(ToolType.Move)
    expect(undoDepth(store)).toBe(1)

    pressUndo()
    expect(Object.keys(store.byId)).toHaveLength(0)
    pressRedo()
    expect(Object.keys(store.byId)).toHaveLength(1)
  })
})

// ── Pencil ───────────────────────────────────────────────────────────────────

describe('CanvasArea：Pencil 的 mouseup', () => {
  it('在畫布外放開：以畫布上取樣到的點完成筆畫，只建立一筆 Undo', async () => {
    const store = await mountCanvas()
    useToolStore().setTool(ToolType.Pencil)
    await nextTick()

    press(100, 100)
    move(200, 100)
    move(300, 150)
    leave(300, 605)
    releaseOutside(300, 900)
    hover(500, 500)

    const [vector] = vectors(store)
    expect(vectors(store)).toHaveLength(1)
    // 不把 mouseleave / 畫布外的座標補成最後一點。
    expect(vector).toMatchObject({ x: 100, y: 100, width: 200, height: 50 })
    expect(undoDepth(store)).toBe(1)
  })
})

// ── Pen ──────────────────────────────────────────────────────────────────────

describe('CanvasArea：Pen 的 mouseup', () => {
  it('在畫布外放開：只結束這次按壓，Pen 草稿保留，回到畫布移動不再拉把手', async () => {
    const store = await mountCanvas()
    useToolStore().setTool(ToolType.Pen)
    await nextTick()

    press(100, 100)
    move(150, 100) // 拉出第一個錨點的出把手
    leave(805, 100)
    releaseOutside(1000, 100)
    hover(400, 400)

    const preview = stage.findOne((n: Konva.Node) => Array.isArray(n.getAttr('vectorPoints')))!
    expect(preview.getAttr('vectorPoints')[0].handleOut).toEqual({ x: 150, y: 100 })

    // Pen 是多步驟手勢：放開滑鼠不代表結束，下一次點擊繼續加錨點。
    press(300, 100)
    releaseOnStage(300, 100)
    key('Enter')

    expect(vectors(store)).toHaveLength(1)
    expect(undoDepth(store)).toBe(1)
  })
})

// ── 合成 click ───────────────────────────────────────────────────────────────

describe('CanvasArea：mouseup 之後的 stage click', () => {
  async function clickEmptyWithHand(store: Store) {
    useToolStore().setTool(ToolType.Hand)
    await nextTick()
    press(700, 500)
    releaseOnStage(700, 500)
    return [...store.selectedIds]
  }

  it('對照組：一般點擊空白處會清除選取', async () => {
    const store = await mountCanvas([rect('a')])
    store.select('a')

    expect(await clickEmptyWithHand(store)).toEqual([])
  })

  it('Pencil 在畫布外放開後，下一次點擊不會被吃掉', async () => {
    const store = await mountCanvas()
    useToolStore().setTool(ToolType.Pencil)
    await nextTick()

    press(100, 100)
    move(200, 100)
    leave(805, 100)
    releaseOutside(1000, 100)
    expect(store.selectedIds.size).toBe(1)

    expect(await clickEmptyWithHand(store)).toEqual([])
  })

  it('框選在畫布外放開後，下一次點擊不會被吃掉', async () => {
    const store = await mountCanvas([rect('a')])

    press(50, 50)
    move(300, 300)
    leave(300, 605)
    releaseOutside(300, 900)
    expect([...store.selectedIds]).toEqual(['a'])

    expect(await clickEmptyWithHand(store)).toEqual([])
  })

  it('框選在畫布上放開，緊接的那一次 click 仍會被抑制（既有行為不變）', async () => {
    const store = await mountCanvas([rect('a')])

    press(50, 50)
    move(300, 300)
    releaseOnStage(300, 300)

    expect([...store.selectedIds]).toEqual(['a'])
  })
})

// ── 按鍵交錯 ─────────────────────────────────────────────────────────────────

describe('CanvasArea：其他按鍵的 mouseup', () => {
  /** 左鍵拖曳到 x=400 後，回到畫布繼續拖到 x=500，最後在畫布外放開左鍵。 */
  async function finishDragAndExpectOneUndo(store: Store) {
    // 左鍵還按著：回到畫布繼續拖曳。
    move(500, 150, { buttons: 1 })
    expect(box(store, 'a')).toMatchObject({ x: 450, y: 100 })
    expect(undoDepth(store)).toBe(0)

    // 左鍵在畫布外放開才結束，而且只有一筆 Undo。
    leave(805, 150)
    releaseOutside(1000, 150)
    await macrotask()
    hover(300, 300)
    expect(box(store, 'a')).toMatchObject({ x: 450, y: 100 })
    expect(undoDepth(store)).toBe(1)
  }

  it('左鍵拖曳中在畫布上按右鍵、到畫布外放開右鍵：不結束拖曳', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(400, 150)
    press(400, 150, { button: 2, buttons: 3 })
    leave(805, 150)
    releaseOutside(1000, 150, { button: 2, buttons: 1 })
    // 右鍵放開不是左鍵放開：拖曳還沒結束，所以還沒有 History。
    expect(undoDepth(store)).toBe(0)

    await finishDragAndExpectOneUndo(store)
  })

  it.each([
    ['右鍵', 2, 2],
    ['中鍵', 1, 4],
  ])('左鍵拖曳到畫布外後按放%s：不結束拖曳', async (_label, button, mask) => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(400, 150)
    leave(805, 150)
    mouse(document.body, 'mousedown', 1000, 150, { button, buttons: 1 | mask })
    releaseOutside(1000, 150, { button, buttons: 1 })
    // 其他按鍵放開不是左鍵放開：拖曳還沒結束，所以還沒有 History。
    expect(undoDepth(store)).toBe(0)

    await finishDragAndExpectOneUndo(store)
  })

  it('中鍵平移在畫布外放開左鍵：不結束平移', async () => {
    const store = await mountCanvas([rect('a')])
    const viewport = useViewportStore()

    press(400, 300, { button: 1, buttons: 4 })
    move(450, 300, { buttons: 4 })
    leave(805, 300)
    releaseOutside(1000, 300, { button: 0, buttons: 4 })
    move(500, 300, { buttons: 4 })
    expect(viewport.viewport).toMatchObject({ x: 100, y: 0 })

    releaseOutside(1000, 300, { button: 1, buttons: 0 })
    hover(100, 100)
    expect(viewport.viewport).toMatchObject({ x: 100, y: 0 })
    expect(undoDepth(store)).toBe(0)
  })
})

// ── 畫布上的按鍵交錯 ─────────────────────────────────────────────────────────

describe('CanvasArea：畫布上的按鍵交錯', () => {
  /** 原本的鍵（held）還按著時，在畫布上按下又放開另一顆鍵。 */
  function otherClickOnStage(x: number, y: number, button: number, mask: number, held = 1) {
    press(x, y, { button, buttons: held | mask })
    releaseOnStage(x, y, { button, buttons: held })
  }

  it.each([
    ['中鍵', 1, 4],
    ['右鍵', 2, 2],
  ])('左鍵拖曳中在畫布上按放%s：拖曳繼續、只建立一筆 Undo', async (_label, button, mask) => {
    const store = await mountCanvas([rect('a')])
    const viewport = useViewportStore()

    press(150, 150)
    move(200, 150)
    otherClickOnStage(200, 150, button, mask)
    // 不被平移蓋掉，也不因為另一顆鍵放開而結束。
    expect(undoDepth(store)).toBe(0)

    move(250, 150, { buttons: 1 })
    expect(box(store, 'a')).toMatchObject({ x: 200, y: 100 })
    expect(viewport.viewport).toMatchObject({ x: 0, y: 0 })

    releaseOnStage(250, 150)
    await macrotask()
    expect(undoDepth(store)).toBe(1)
    pressUndo()
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    pressRedo()
    expect(box(store, 'a')).toMatchObject({ x: 200, y: 100 })
  })

  it('縮放中在畫布上按放中鍵：縮放繼續、只建立一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])
    await selectAndRender(store, 'a')

    press(200, 200)
    move(230, 230)
    otherClickOnStage(230, 230, 1, 4)
    move(260, 250, { buttons: 1 })
    releaseOnStage(260, 250)
    await macrotask()

    expect(box(store, 'a')).toEqual({ x: 100, y: 100, width: 160, height: 150 })
    expect(undoDepth(store)).toBe(1)
  })

  it('繪製中在畫布上按放中鍵：只建立一個元素、一筆 Undo', async () => {
    const store = await mountCanvas()
    useToolStore().setTool(ToolType.Rect)
    await nextTick()

    press(600, 400)
    move(650, 450)
    otherClickOnStage(650, 450, 1, 4)
    move(700, 500, { buttons: 1 })
    releaseOnStage(700, 500)
    await macrotask()

    const created = Object.values(store.byId)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ x: 600, y: 400, width: 100, height: 100 })
    expect(useViewportStore().viewport).toMatchObject({ x: 0, y: 0 })
    expect(undoDepth(store)).toBe(1)
  })

  it('Pencil 中在畫布上按放中鍵：只建立一條筆畫、一筆 Undo', async () => {
    const store = await mountCanvas()
    useToolStore().setTool(ToolType.Pencil)
    await nextTick()

    press(100, 100)
    move(200, 100)
    otherClickOnStage(200, 100, 1, 4)
    move(300, 150, { buttons: 1 })
    releaseOnStage(300, 150)
    await macrotask()

    expect(vectors(store)).toHaveLength(1)
    expect(vectors(store)[0]).toMatchObject({ x: 100, y: 100, width: 200, height: 50 })
    expect(undoDepth(store)).toBe(1)
  })

  it('框選中在畫布上按放中鍵：框選結果正確、不產生 History', async () => {
    const store = await mountCanvas([rect('a'), rect('b', { x: 600, y: 100 })])

    press(50, 50)
    move(150, 150)
    otherClickOnStage(150, 150, 1, 4)
    move(300, 300, { buttons: 1 })
    releaseOnStage(300, 300)
    await macrotask()

    expect([...store.selectedIds]).toEqual(['a'])
    expect(useViewportStore().viewport).toMatchObject({ x: 0, y: 0 })
    expect(undoDepth(store)).toBe(0)
  })

  it('中鍵平移中在畫布上按放左鍵：平移繼續，不開始拖曳', async () => {
    const store = await mountCanvas([rect('a')])
    const viewport = useViewportStore()

    press(400, 300, { button: 1, buttons: 4 })
    move(450, 300, { buttons: 4 })
    // 平移 50 之後，元素在螢幕上的 x 範圍是 150–250：在元素上按放左鍵。
    otherClickOnStage(200, 150, 0, 1, 4)
    move(500, 300, { buttons: 4 })
    expect(viewport.viewport).toMatchObject({ x: 100, y: 0 })

    releaseOnStage(500, 300, { button: 1, buttons: 0 })
    await macrotask()
    hover(100, 100)

    expect(viewport.viewport).toMatchObject({ x: 100, y: 0 })
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    expect(undoDepth(store)).toBe(0)
  })

  it('mouseup 遺失後再按同一顆鍵：先替上一次收尾，畫布不會卡住', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(170, 180)
    // 放開的 mouseup 沒送到任何地方（例如拖曳中切換視窗）。
    await nextTick()

    press(200, 200)
    expect(undoDepth(store)).toBe(1)
    move(200, 300)
    releaseOnStage(200, 300)
    await macrotask()

    expect(box(store, 'a')).toMatchObject({ x: 120, y: 230 })
    expect(undoDepth(store)).toBe(2)
  })

  it('mouseup 遺失後按其他鍵：原本的鍵已放開，先替上一次收尾再開始新手勢', async () => {
    const store = await mountCanvas([rect('a')])
    const viewport = useViewportStore()

    press(150, 150)
    move(170, 180)
    // buttons 只剩中鍵：左鍵其實已經放開，只是 mouseup 沒送到。
    press(400, 300, { button: 1, buttons: 4 })
    expect(undoDepth(store)).toBe(1)

    move(450, 300, { buttons: 4 })
    releaseOnStage(450, 300, { button: 1, buttons: 0 })
    await macrotask()

    expect(viewport.viewport).toMatchObject({ x: 50, y: 0 })
    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
    expect(undoDepth(store)).toBe(1)
  })

  it('被攔下的 mouseup 留下的延後確認，不會結束下一次還按著的按壓', async () => {
    const store = await mountCanvas([rect('a')])

    const unblock = blockMouseUpBeforeStage()
    press(150, 150)
    move(170, 180)
    releaseOnStage(170, 180)
    unblock()
    await nextTick()

    // 馬上再按住同一個元素，按著的期間讓延後確認的時間點過去。
    press(200, 200)
    await macrotask()
    move(200, 300)
    expect(box(store, 'a')).toMatchObject({ x: 120, y: 230 })

    releaseOnStage(200, 300)
    await macrotask()
    expect(undoDepth(store)).toBe(2)
  })

  it('被攔下的 mouseup 還沒補收尾就按下中鍵：先結束左鍵，再開始平移', async () => {
    const store = await mountCanvas([rect('a')])
    const viewport = useViewportStore()

    const unblock = blockMouseUpBeforeStage()
    press(150, 150)
    move(170, 180)
    releaseOnStage(170, 180)
    unblock()

    press(400, 300, { button: 1, buttons: 4 })
    move(450, 300, { buttons: 4 })
    releaseOnStage(450, 300, { button: 1, buttons: 0 })
    await macrotask()

    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
    expect(viewport.viewport).toMatchObject({ x: 50, y: 0 })
    expect(undoDepth(store)).toBe(1)
  })
})

// ── Stage 沒收到落在畫布上的 mouseup ─────────────────────────────────────────

describe('CanvasArea：落在畫布上的 mouseup 被攔下', () => {
  it('事件派發結束後補收尾：手勢回到 idle、只建立一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])
    const unblock = blockMouseUpBeforeStage()

    press(150, 150)
    move(170, 180)
    releaseOnStage(170, 180)
    unblock()
    await macrotask()

    hover(400, 400)
    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
    expect(undoDepth(store)).toBe(1)
    pressUndo()
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
  })

  it('補收尾之前就再次按下：先結束上一次，兩次操作各一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])

    const unblock = blockMouseUpBeforeStage()
    press(150, 150)
    move(170, 180)
    releaseOnStage(170, 180)
    unblock()

    // 不等延後的確認，馬上開始下一次框選：上一次拖曳要先以一筆 Undo 收尾。
    press(10, 10)
    move(50, 50)
    releaseOnStage(50, 50)
    await macrotask()

    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
    expect(undoDepth(store)).toBe(1)
  })
})

// ── Listener 清理 ────────────────────────────────────────────────────────────

describe('CanvasArea：window mouseup listener', () => {
  it('unmount 時移除，之後的 mouseup 不再觸發手勢處理', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const store = await mountCanvas([rect('a')])

    const registered = add.mock.calls.filter(([type]) => type === 'mouseup')
    expect(registered).toHaveLength(1)
    const [, handler, options] = registered[0]

    press(150, 150)
    move(170, 180)
    const push = vi.spyOn(store, 'pushSnapshot')
    wrapper!.unmount()
    wrapper = null

    expect(remove).toHaveBeenCalledWith('mouseup', handler, options)
    releaseOutside(1000, 150)
    expect(push).not.toHaveBeenCalled()

    add.mockRestore()
    remove.mockRestore()
  })

  it('unmount 時取消尚未執行的延後確認', async () => {
    const store = await mountCanvas([rect('a')])
    const unblock = blockMouseUpBeforeStage()

    press(150, 150)
    move(170, 180)
    releaseOnStage(170, 180)
    unblock()
    const push = vi.spyOn(store, 'pushSnapshot')
    wrapper!.unmount()
    wrapper = null
    await macrotask()

    expect(push).not.toHaveBeenCalled()
  })
})
