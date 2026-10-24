import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import Konva from 'konva'
import { useClipboardStore } from '@/store/clipboard'
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

// ── 拖曳 / 縮放回到原狀（U3C）────────────────────────────────────────────────

describe('CanvasArea：拖曳回到原位不產生 History（U3C）', () => {
  it('拖出去再拖回原位、在畫布上放開：位置不變、不新增 History', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(300, 260)
    move(150, 150)
    releaseOnStage(150, 150)

    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    expect(undoDepth(store)).toBe(0)
  })

  it('拖回原位不清掉 Redo：之後 Ctrl+Shift+Z 仍能重做上一次拖曳', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(170, 180)
    releaseOnStage(170, 180)
    pressUndo()
    await nextTick()

    press(150, 150)
    move(400, 400)
    move(150, 150)
    releaseOnStage(150, 150)

    pressRedo()
    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
  })

  it('拖回原位後 Ctrl+Z：直接 Undo 上一次真正的拖曳', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(170, 180)
    releaseOnStage(170, 180)
    await nextTick()

    press(170, 180)
    move(300, 300)
    move(170, 180)
    releaseOnStage(170, 180)

    expect(undoDepth(store)).toBe(1)
    pressUndo()
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
  })

  it('拖回原位之後再純點擊：仍不新增空白 History', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(300, 260)
    move(150, 150)
    releaseOnStage(150, 150)
    await nextTick()
    press(150, 150)
    releaseOnStage(150, 150)

    expect(undoDepth(store)).toBe(0)
  })

  it('拖回原位後在畫布外放開：不新增 History', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(400, 300)
    move(150, 150)
    leave(-5, 150)
    releaseOutside(-100, 150)

    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    expect(undoDepth(store)).toBe(0)
  })

  it('拖回原位、mouseup 遺失（回到畫布的 mousemove 發現已放開）：不新增 History', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(400, 300)
    move(150, 150)
    hover(500, 500)

    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    expect(undoDepth(store)).toBe(0)
  })

  it('多選拖出去再拖回原位：不新增 History', async () => {
    const store = await mountCanvas([rect('a'), rect('b', { x: 300 })])
    store.select('a')
    store.select('b', true)
    await nextTick()

    press(150, 150)
    move(220, 260)
    move(150, 150)
    releaseOnStage(150, 150)

    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    expect(box(store, 'b')).toMatchObject({ x: 300, y: 100 })
    expect(undoDepth(store)).toBe(0)
  })

  it('群組拖出去再拖回原位：不新增 History', async () => {
    const store = await mountCanvas([rect('a'), rect('b', { x: 250 })])
    const groupId = store.group(['a', 'b'])
    await nextTick()
    const before = box(store, groupId)

    press(150, 150)
    move(260, 330)
    move(150, 150)
    releaseOnStage(150, 150)

    expect(box(store, groupId)).toEqual(before)
    // 只有建立群組那一筆。
    expect(undoDepth(store)).toBe(1)
  })

  it('沒有回到原位（差 1px）：仍建立一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(300, 260)
    move(151, 150)
    releaseOnStage(151, 150)

    expect(box(store, 'a')).toMatchObject({ x: 101, y: 100 })
    expect(undoDepth(store)).toBe(1)
  })
})

describe('CanvasArea：縮放回到原尺寸不產生 History（U3C）', () => {
  it('拉大再拉回原尺寸、在畫布上放開：尺寸不變、不新增 History', async () => {
    const store = await mountCanvas([rect('a')])
    await selectAndRender(store, 'a')

    press(200, 200) // 右下角把手
    move(280, 260)
    move(200, 200)
    releaseOnStage(200, 200)

    expect(box(store, 'a')).toEqual({ x: 100, y: 100, width: 100, height: 100 })
    expect(undoDepth(store)).toBe(0)
  })

  it('縮放回原尺寸不清掉 Redo', async () => {
    const store = await mountCanvas([rect('a')])
    await selectAndRender(store, 'a')

    press(200, 200)
    move(260, 250)
    releaseOnStage(260, 250)
    pressUndo()
    await selectAndRender(store, 'a')

    press(200, 200)
    move(300, 300)
    move(200, 200)
    releaseOnStage(200, 200)

    pressRedo()
    expect(box(store, 'a')).toEqual({ x: 100, y: 100, width: 160, height: 150 })
  })

  it('縮放回原尺寸後在畫布外放開：不新增 History', async () => {
    const store = await mountCanvas([rect('a')])
    await selectAndRender(store, 'a')

    press(200, 200)
    move(300, 590)
    move(200, 200)
    leave(200, 605)
    releaseOutside(200, 900)

    expect(box(store, 'a')).toEqual({ x: 100, y: 100, width: 100, height: 100 })
    expect(undoDepth(store)).toBe(0)
  })

  it('沒有回到原尺寸：仍建立一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])
    await selectAndRender(store, 'a')

    press(200, 200)
    move(300, 300)
    move(200, 201)
    releaseOnStage(200, 201)

    expect(box(store, 'a')).toEqual({ x: 100, y: 100, width: 100, height: 101 })
    expect(undoDepth(store)).toBe(1)
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

// ── mouseup 完全沒送到：回到畫布的 mousemove 從 buttons 收尾 ───────────────
//
//  例如拖曳中切換視窗、在別的視窗放開：window 與 Stage 都收不到 mouseup。
//  回到畫布後第一個 mousemove 的 buttons 已經沒有按下的那顆鍵。
//  注意 button 與 buttons 的編號不同：左鍵 button 0 / buttons 1，中鍵 button 1 / buttons 4，
//  右鍵 button 2 / buttons 2。

describe('CanvasArea：mouseup 沒送到，回到畫布的 mousemove 收尾', () => {
  it('拖曳：buttons 為 0 時停在最後的位置、只建立一筆 Undo、手勢回到 idle', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(170, 180)
    // 在別的視窗放開，mouseup 沒有送到任何地方，然後回到畫布移動。
    hover(400, 400)

    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
    expect(undoDepth(store)).toBe(1)

    hover(500, 500)
    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })

    // 手勢回到 idle，Undo 不再被「手勢進行中忽略 Undo」擋下。
    pressUndo()
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    pressRedo()
    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
  })

  it('縮放：buttons 為 0 時以最後的尺寸結束、只建立一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])
    await selectAndRender(store, 'a')

    press(200, 200) // 右下角把手
    move(260, 250)
    hover(400, 400)

    expect(box(store, 'a')).toEqual({ x: 100, y: 100, width: 160, height: 150 })
    expect(undoDepth(store)).toBe(1)
  })

  it('框選：buttons 為 0 時以最後的框完成選取，框不殘留、不產生 History', async () => {
    const store = await mountCanvas([rect('a'), rect('b', { x: 600, y: 100 })])

    press(50, 50)
    move(300, 300)
    hover(790, 590)

    expect([...store.selectedIds]).toEqual(['a'])
    const marquees = stage.find((n: Konva.Node) => n instanceof Konva.Rect && n.dash().length > 0)
    expect(marquees.filter((n) => !store.get(n.id()))).toHaveLength(0)
    expect(undoDepth(store)).toBe(0)
  })

  it('繪製：buttons 為 0 時以最後的預覽建立一個元素、一筆 Undo', async () => {
    const store = await mountCanvas()
    useToolStore().setTool(ToolType.Rect)
    await nextTick()

    press(600, 400)
    move(700, 500)
    hover(780, 590)

    const created = Object.values(store.byId)
    expect(created).toHaveLength(1)
    // 用預覽最後的點，不用這次 mousemove 的位置。
    expect(created[0]).toMatchObject({ x: 600, y: 400, width: 100, height: 100 })
    expect(useToolStore().activeTool).toBe(ToolType.Move)
    expect(undoDepth(store)).toBe(1)
  })

  it('Pencil：buttons 為 0 時以已取樣的點完成筆畫、一筆 Undo', async () => {
    const store = await mountCanvas()
    useToolStore().setTool(ToolType.Pencil)
    await nextTick()

    press(100, 100)
    move(200, 100)
    move(300, 150)
    hover(500, 500)

    expect(vectors(store)).toHaveLength(1)
    expect(vectors(store)[0]).toMatchObject({ x: 100, y: 100, width: 200, height: 50 })
    expect(undoDepth(store)).toBe(1)
  })

  it('Pencil：buttons 為 0 收尾後，下一次點擊空白處不會被吃掉', async () => {
    const store = await mountCanvas()
    useToolStore().setTool(ToolType.Pencil)
    await nextTick()

    press(100, 100)
    move(200, 100)
    hover(500, 500)
    expect(store.selectedIds.size).toBe(1)

    // 這次按壓不會有 stage click，按下時設的抑制要撤回。
    useToolStore().setTool(ToolType.Hand)
    await nextTick()
    press(700, 500)
    releaseOnStage(700, 500)
    expect([...store.selectedIds]).toEqual([])
  })

  it('Hand 平移：buttons 為 0 時停止平移、還原游標，不產生 History', async () => {
    const store = await mountCanvas([rect('a')])
    const viewport = useViewportStore()
    useToolStore().setTool(ToolType.Hand)
    await nextTick()

    press(400, 300)
    move(500, 350)
    hover(100, 100)

    expect(viewport.viewport).toMatchObject({ x: 100, y: 50 })
    expect(stage.container().style.cursor).toBe(useToolStore().cursor)
    expect(undoDepth(store)).toBe(0)
  })

  it('Pen：buttons 為 0 時只結束這次按壓，草稿保留、不再拉把手', async () => {
    const store = await mountCanvas()
    useToolStore().setTool(ToolType.Pen)
    await nextTick()

    press(100, 100)
    move(150, 100) // 拉出第一個錨點的出把手
    hover(400, 400)

    const preview = stage.findOne((n: Konva.Node) => Array.isArray(n.getAttr('vectorPoints')))!
    expect(preview.getAttr('vectorPoints')[0].handleOut).toEqual({ x: 150, y: 100 })

    press(300, 100)
    releaseOnStage(300, 100)
    key('Enter')

    expect(vectors(store)).toHaveLength(1)
    expect(undoDepth(store)).toBe(1)
  })
})

describe('CanvasArea：mousemove 的按鍵仍按著時不提前結束', () => {
  it.each([
    ['只有左鍵', 1],
    ['左鍵與右鍵', 1 | 2],
    ['左鍵與中鍵', 1 | 4],
  ])('左鍵拖曳，buttons 為%s：拖曳繼續、放開後一筆 Undo', async (_label, buttons) => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(200, 150, { buttons })
    move(250, 150, { buttons })
    expect(box(store, 'a')).toMatchObject({ x: 200, y: 100 })
    expect(undoDepth(store)).toBe(0)

    releaseOnStage(250, 150)
    await macrotask()
    expect(undoDepth(store)).toBe(1)
  })

  it.each([
    ['只有中鍵', 4],
    ['中鍵與左鍵', 4 | 1],
    ['中鍵與右鍵', 4 | 2],
  ])('中鍵平移，buttons 為%s：平移繼續', async (_label, buttons) => {
    const store = await mountCanvas([rect('a')])
    const viewport = useViewportStore()

    press(400, 300, { button: 1, buttons: 4 })
    move(450, 300, { buttons })
    move(500, 300, { buttons })
    expect(viewport.viewport).toMatchObject({ x: 100, y: 0 })

    releaseOnStage(500, 300, { button: 1, buttons: 0 })
    await macrotask()
    hover(100, 100)
    expect(viewport.viewport).toMatchObject({ x: 100, y: 0 })
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    expect(undoDepth(store)).toBe(0)
  })

  it('左鍵拖曳中在畫布上按住右鍵移動、放開右鍵後繼續：拖曳不中斷、一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(200, 150)
    press(200, 150, { button: 2, buttons: 1 | 2 })
    move(250, 150, { buttons: 1 | 2 })
    releaseOnStage(250, 150, { button: 2, buttons: 1 })
    move(300, 150, { buttons: 1 })
    expect(box(store, 'a')).toMatchObject({ x: 250, y: 100 })
    expect(undoDepth(store)).toBe(0)

    releaseOnStage(300, 150)
    await macrotask()
    expect(undoDepth(store)).toBe(1)
  })

  it('只按右鍵不建立按壓：右鍵按著移動不影響之後的左鍵拖曳', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150, { button: 2, buttons: 2 })
    move(200, 150, { buttons: 2 })
    releaseOnStage(200, 150, { button: 2, buttons: 0 })
    await macrotask()
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    expect(undoDepth(store)).toBe(0)

    press(150, 150)
    move(200, 150, { buttons: 1 })
    expect(box(store, 'a')).toMatchObject({ x: 150, y: 100 })
    releaseOnStage(200, 150)
    await macrotask()
    expect(undoDepth(store)).toBe(1)
  })
})

describe('CanvasArea：mousemove 的多按鍵交錯不誤判', () => {
  it.each([
    ['只剩右鍵', 2],
    ['只剩中鍵', 4],
  ])('左鍵拖曳，buttons %s（左鍵已放開）：結束拖曳、一筆 Undo', async (_label, buttons) => {
    const store = await mountCanvas([rect('a')])
    const viewport = useViewportStore()

    press(150, 150)
    move(170, 180)
    move(400, 400, { buttons })
    move(500, 500, { buttons })

    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
    expect(viewport.viewport).toMatchObject({ x: 0, y: 0 })
    expect(undoDepth(store)).toBe(1)
  })

  it.each([
    // buttons 1 是左鍵，不是 button 1（中鍵）：不能把兩者當成同一顆鍵。
    ['只剩左鍵', 1],
    ['只剩右鍵', 2],
  ])('中鍵平移，buttons %s（中鍵已放開）：停止平移，不開始拖曳', async (_label, buttons) => {
    const store = await mountCanvas([rect('a')])
    const viewport = useViewportStore()

    press(400, 300, { button: 1, buttons: 4 })
    move(450, 300, { buttons: 4 })
    // 平移 50 之後元素在螢幕上的 x 範圍是 150–250：移到元素上。
    move(200, 150, { buttons })
    move(250, 200, { buttons })

    expect(viewport.viewport).toMatchObject({ x: 50, y: 0 })
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    expect(undoDepth(store)).toBe(0)
  })
})

describe('CanvasArea：mousemove 收尾不重複結束、不重複寫入 History', () => {
  it('連續多個 buttons 為 0 的 mousemove：只收尾一次', async () => {
    const store = await mountCanvas([rect('a')])
    const push = vi.spyOn(store, 'pushSnapshot')

    press(150, 150)
    move(170, 180)
    hover(400, 400)
    hover(450, 450)
    hover(500, 500)

    expect(push).toHaveBeenCalledTimes(1)
    expect(undoDepth(store)).toBe(1)
  })

  it('收尾之後才送到的 mouseup（畫布上、畫布外）不再寫入 History', async () => {
    const store = await mountCanvas([rect('a')])
    const push = vi.spyOn(store, 'pushSnapshot')

    press(150, 150)
    move(170, 180)
    hover(400, 400)
    releaseOnStage(400, 400)
    releaseOutside(1000, 400)
    await macrotask()

    expect(push).toHaveBeenCalledTimes(1)
    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
    expect(undoDepth(store)).toBe(1)
  })

  it('被攔下的 mouseup 還沒補收尾就移動：只收尾一次', async () => {
    const store = await mountCanvas([rect('a')])
    const push = vi.spyOn(store, 'pushSnapshot')

    const unblock = blockMouseUpBeforeStage()
    press(150, 150)
    move(170, 180)
    releaseOnStage(170, 180)
    unblock()
    // 延後確認還沒跑：先來的 mousemove 收尾，之後的確認不能再收一次。
    hover(400, 400)
    await macrotask()

    expect(push).toHaveBeenCalledTimes(1)
    expect(box(store, 'a')).toMatchObject({ x: 120, y: 130 })
    expect(undoDepth(store)).toBe(1)
  })

  it('收尾之後再按下：新手勢正常開始，兩次操作各一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])

    press(150, 150)
    move(170, 180)
    hover(400, 400)

    press(200, 200)
    move(200, 300)
    releaseOnStage(200, 300)
    await macrotask()

    expect(box(store, 'a')).toMatchObject({ x: 120, y: 230 })
    expect(undoDepth(store)).toBe(2)
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

// ── 拖曳中按會改文件的快捷鍵 ─────────────────────────────────────────────────

describe('CanvasArea：拖曳中按會改文件的快捷鍵', () => {
  /** a 在 (100,100)、b 在 (300,100)，兩個都選取。 */
  async function mountTwoSelected(): Promise<Store> {
    const store = await mountCanvas([rect('a'), rect('b', { x: 300 })])
    store.select('a')
    store.select('b', true)
    await nextTick()
    return store
  }

  /** 拖曳 a：中途按下快捷鍵，繼續拖到總位移 (40, 50) 後在畫布上放開。 */
  async function dragWithShortcutInBetween(shortcut: () => void) {
    press(150, 150)
    move(170, 180)
    shortcut()
    await nextTick()
    move(190, 200)
    releaseOnStage(190, 200)
    await macrotask()
  }

  function groups(store: Store): CanvasElement[] {
    return Object.values(store.byId).filter((el) => el.kind === ElementKind.Group)
  }

  it('Ctrl+G：不建立群組，兩個元素停在正確位置，只有拖曳這一筆 Undo', async () => {
    // 修正前：群組把子元素改成相對座標，拖曳卻繼續寫入絕對座標，a 跑到 (260, 280)。
    const store = await mountTwoSelected()

    await dragWithShortcutInBetween(() => key('g', { ctrlKey: true }))

    expect(groups(store)).toHaveLength(0)
    expect(store.get('a')).toMatchObject({ x: 140, y: 150, parentId: undefined })
    expect(store.get('b')).toMatchObject({ x: 340, y: 150, parentId: undefined })
    expect(undoDepth(store)).toBe(1)

    pressUndo()
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    expect(box(store, 'b')).toMatchObject({ x: 300, y: 100 })
  })

  it('Ctrl+D：不建立複本，只有拖曳這一筆 Undo', async () => {
    // 修正前：複本以拖到一半的位置建立並推一筆快照，Undo 一次停在中間狀態。
    const store = await mountTwoSelected()

    await dragWithShortcutInBetween(() => key('d', { ctrlKey: true }))

    expect(Object.keys(store.byId).sort()).toEqual(['a', 'b'])
    expect(box(store, 'a')).toMatchObject({ x: 140, y: 150 })
    expect(undoDepth(store)).toBe(1)

    pressUndo()
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
  })

  it('Delete：不刪除元素，只有拖曳這一筆 Undo', async () => {
    const store = await mountTwoSelected()

    await dragWithShortcutInBetween(() => key('Delete'))

    expect(Object.keys(store.byId).sort()).toEqual(['a', 'b'])
    expect(box(store, 'b')).toMatchObject({ x: 340, y: 150 })
    expect(undoDepth(store)).toBe(1)
  })

  it('拖曳結束後 Ctrl+G 恢復作用：建立群組、是另一筆 Undo', async () => {
    const store = await mountTwoSelected()

    await dragWithShortcutInBetween(() => key('g', { ctrlKey: true }))
    // 既有行為：在畫布上放開後 Konva 合成的 click 會把選取縮成被按住的 a，所以重新選取。
    store.select('a')
    store.select('b', true)
    key('g', { ctrlKey: true })
    await nextTick()

    const [group] = groups(store)
    expect(group?.childIds).toEqual(['a', 'b'])
    expect(undoDepth(store)).toBe(2)

    pressUndo()
    expect(groups(store)).toHaveLength(0)
    expect(store.get('a')).toMatchObject({ x: 140, y: 150, parentId: undefined })
  })
})

describe('CanvasArea：Copy／Cut／Paste 整合（Batch 4）', () => {
  /** 畫布上有沒有畫出這個元素（用元素 id 找 Konva shape）。 */
  function drawn(id: string): boolean {
    return stage.findOne((n: Konva.Node) => n.id() === id) !== undefined
  }

  function names(store: Store): string[] {
    return store.rootElements.map((el) => el.name)
  }

  function selectedId(store: Store): string {
    expect(store.selectedIds.size).toBe(1)
    return [...store.selectedIds][0]
  }

  /** 拖曳 a：中途按下快捷鍵，繼續拖到總位移 (40, 50) 後在畫布上放開。 */
  async function dragWithShortcutInBetween(shortcut: () => void) {
    press(150, 150)
    move(170, 180)
    shortcut()
    await nextTick()
    move(190, 200)
    releaseOnStage(190, 200)
    await macrotask()
  }

  it('Ctrl+C → Ctrl+V：貼上的元素畫在畫布上並成為選取，一筆 Undo', async () => {
    const store = await mountCanvas([rect('a')])
    await selectAndRender(store, 'a')

    key('c', { ctrlKey: true })
    key('v', { ctrlKey: true })
    await nextTick()
    const pasted = selectedId(store)

    expect(store.get(pasted)).toMatchObject({ name: 'a copy', x: 110, y: 110 })
    expect(drawn(pasted)).toBe(true)
    expect(undoDepth(store)).toBe(1)

    pressUndo()
    await nextTick()
    expect(names(store)).toEqual(['a'])
    expect(drawn(pasted)).toBe(false)
  })

  it('Ctrl+X → Ctrl+V：剪下後畫布上不再有原件，貼回保留原名；兩次 Undo 回到原狀', async () => {
    const store = await mountCanvas([rect('a'), rect('b', { x: 300 })])
    await selectAndRender(store, 'a')

    key('x', { ctrlKey: true })
    await nextTick()
    expect(names(store)).toEqual(['b'])
    expect(drawn('a')).toBe(false)

    key('v', { ctrlKey: true })
    await nextTick()
    const pasted = selectedId(store)
    expect(store.get(pasted)).toMatchObject({ name: 'a', x: 110, y: 110 })
    expect(drawn(pasted)).toBe(true)
    expect(undoDepth(store)).toBe(2)

    pressUndo()
    pressUndo()
    await nextTick()
    expect(names(store)).toEqual(['a', 'b'])
    expect(box(store, 'a')).toMatchObject({ x: 100, y: 100 })
    expect(drawn('a')).toBe(true)
  })

  it('拖曳中按 Ctrl+V：不貼上，只有拖曳這一筆 Undo；放開後 Ctrl+V 恢復作用', async () => {
    const store = await mountCanvas([rect('a'), rect('b', { x: 300 })])
    await selectAndRender(store, 'b')
    key('c', { ctrlKey: true })
    await selectAndRender(store, 'a')

    await dragWithShortcutInBetween(() => key('v', { ctrlKey: true }))

    expect(names(store)).toEqual(['a', 'b'])
    expect(box(store, 'a')).toMatchObject({ x: 140, y: 150 })
    expect(undoDepth(store)).toBe(1)

    key('v', { ctrlKey: true })
    expect(names(store)).toEqual(['a', 'b', 'b copy'])
    expect(undoDepth(store)).toBe(2)
  })

  it('拖曳中按 Ctrl+X：不剪下、Clipboard 不變，只有拖曳這一筆 Undo', async () => {
    const store = await mountCanvas([rect('a'), rect('b', { x: 300 })])
    const clipboard = useClipboardStore()
    await selectAndRender(store, 'a')

    await dragWithShortcutInBetween(() => key('x', { ctrlKey: true }))

    expect(names(store)).toEqual(['a', 'b'])
    expect(box(store, 'a')).toMatchObject({ x: 140, y: 150 })
    expect(clipboard.read()).toBeNull()
    expect(undoDepth(store)).toBe(1)
  })

  it('拖曳中按 Ctrl+C：照常寫入 Clipboard（當下的位置），拖曳結果與 History 不受影響', async () => {
    const store = await mountCanvas([rect('a')])
    const clipboard = useClipboardStore()
    await selectAndRender(store, 'a')

    await dragWithShortcutInBetween(() => key('c', { ctrlKey: true }))

    expect(box(store, 'a')).toMatchObject({ x: 140, y: 150 })
    expect(undoDepth(store)).toBe(1)
    // 按下 Ctrl+C 時拖到一半：(100, 100) + (20, 30)
    expect(Object.values(clipboard.read()!.elements.byId)).toMatchObject([{ x: 120, y: 130 }])
  })

  it('Ctrl+D 不碰 Clipboard：之後 Ctrl+V 貼上的仍是先前複製的內容', async () => {
    const store = await mountCanvas([rect('a'), rect('b', { x: 300 })])
    await selectAndRender(store, 'b')
    key('c', { ctrlKey: true })
    await selectAndRender(store, 'a')

    key('d', { ctrlKey: true })
    key('v', { ctrlKey: true })

    expect(names(store)).toEqual(['a', 'b', 'a copy', 'b copy'])
    expect(undoDepth(store)).toBe(2)
  })

  it('複製之後載入另一份文件（切換專案）：貼上的元素畫在新文件上', async () => {
    const store = await mountCanvas([rect('a')])
    await selectAndRender(store, 'a')
    key('c', { ctrlKey: true })

    store.loadSnapshot({ byId: { x: rect('x', { x: 500 }) }, rootIds: ['x'] })
    await nextTick()
    key('v', { ctrlKey: true })
    await nextTick()
    const pasted = selectedId(store)

    expect(names(store)).toEqual(['x', 'a copy'])
    expect(drawn(pasted)).toBe(true)
    expect(drawn('a')).toBe(false)
    expect(undoDepth(store)).toBe(1)
  })

  it('剪下群組 → 貼上：整棵子樹畫回畫布，名稱不變', async () => {
    const store = await mountCanvas([rect('a'), rect('b', { x: 300 })])
    const groupId = store.group(['a', 'b'])
    await selectAndRender(store, groupId)

    key('x', { ctrlKey: true })
    await nextTick()
    expect(Object.keys(store.byId)).toEqual([])

    key('v', { ctrlKey: true })
    await nextTick()
    const pasted = store.get(selectedId(store))!

    expect(pasted.name).toBe('Group')
    expect(pasted.childIds.map((id) => store.get(id)!.name)).toEqual(['a', 'b'])
    for (const id of [pasted.id, ...pasted.childIds]) expect(drawn(id)).toBe(true)
  })
})

// ── 文字編輯的 History（#8）────────────────────────────────────────────────────

describe('CanvasArea：新建文字的 History（#8）', () => {
  const overlay = () => document.querySelector<HTMLTextAreaElement>('.text-edit-overlay')

  /** 用 Text 工具在空白處點一下，等延後的進入編輯與 textarea 掛載跑完。 */
  async function createTextAt(x: number, y: number) {
    useToolStore().setTool(ToolType.Text)
    await nextTick()
    press(x, y)
    releaseOnStage(x, y)
    await macrotask()
    await nextTick()
  }

  function typeText(value: string) {
    const ta = overlay()!
    ta.value = value
    ta.dispatchEvent(new Event('input'))
  }

  const blurText = () => overlay()!.dispatchEvent(new FocusEvent('blur'))
  const escapeText = () =>
    overlay()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )

  const texts = (store: Store) => Object.values(store.byId).map((el) => el.text)

  it('新增文字並輸入後離開：只有一筆 Undo，一次 Ctrl+Z 回到空畫布', async () => {
    const store = await mountCanvas()
    await createTextAt(300, 200)
    typeText('abc')
    blurText()
    await nextTick()

    expect(texts(store)).toEqual(['abc'])
    expect(undoDepth(store)).toBe(1)

    pressUndo()
    expect(Object.keys(store.byId)).toEqual([])
    pressRedo()
    expect(texts(store)).toEqual(['abc'])
  })

  it('新增文字留空離開：不留下元素也不產生 History，Undo 不會讓空 Text 復活', async () => {
    const store = await mountCanvas([rect('a')])
    await createTextAt(500, 400)
    blurText()
    await nextTick()

    expect(Object.keys(store.byId)).toEqual(['a'])
    expect(undoDepth(store)).toBe(0)

    pressUndo()
    expect(Object.keys(store.byId)).toEqual(['a'])
  })

  it('繪製路徑建立的文字（拖曳中切到 Text 工具）：同樣只有一筆 Undo', async () => {
    const store = await mountCanvas()
    useToolStore().setTool(ToolType.Rect)
    await nextTick()
    press(300, 200)
    move(400, 260)
    useToolStore().setTool(ToolType.Text)
    releaseOnStage(400, 260)
    await nextTick()
    await macrotask()
    await nextTick()

    expect(overlay()).not.toBeNull()
    typeText('abc')
    blurText()
    await nextTick()

    expect(texts(store)).toEqual(['abc'])
    expect(undoDepth(store)).toBe(1)
  })

  it('既有文字用 Text 工具點擊進入編輯：修改只記一筆，Escape 還原且零筆', async () => {
    const existing: CanvasElement = { ...rect('x'), kind: ElementKind.Text, text: 'hi', width: 200 }
    const store = await mountCanvas([existing])
    useToolStore().setTool(ToolType.Text)
    await nextTick()
    press(150, 105)
    releaseOnStage(150, 105)
    await macrotask()
    await nextTick()

    expect(overlay()!.value).toBe('hi')
    typeText('hey')
    blurText()
    await nextTick()
    expect(texts(store)).toEqual(['hey'])
    expect(undoDepth(store)).toBe(1)

    useToolStore().setTool(ToolType.Text)
    await nextTick()
    press(150, 105)
    releaseOnStage(150, 105)
    await macrotask()
    await nextTick()
    typeText('changed')
    escapeText()
    await nextTick()
    expect(texts(store)).toEqual(['hey'])
    expect(undoDepth(store)).toBe(1)
  })

  it('新增文字輸入後按 Escape：取消建立，不留下隱形的空 Text', async () => {
    const store = await mountCanvas()
    await createTextAt(300, 200)
    typeText('abc')
    escapeText()
    await nextTick()

    expect(overlay()).toBeNull()
    expect(Object.keys(store.byId)).toEqual([])
    expect(undoDepth(store)).toBe(0)
  })
})
