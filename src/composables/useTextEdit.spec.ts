import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useElementStore } from '@/store/element'
import { useTextEdit } from '@/composables/useTextEdit'
import { ELEMENT_HISTORY_MAX, ElementKind, type CanvasElement } from '@/types/element'

type Store = ReturnType<typeof useElementStore>
type TextEdit = ReturnType<typeof useTextEdit>

// ─────────────────────────────────────────────────────────────────────────────
//  文字編輯的 History（#8）。
//  直接呼叫 composable，不經過 DOM textarea：textareaRef 為 null，focus / resize 會略過；
//  blur、輸入、Escape 都改成呼叫對應的 handler。進入編輯的 setTimeout 用 fake timer 推進。
// ─────────────────────────────────────────────────────────────────────────────

let store: Store
let te: TextEdit

beforeEach(() => {
  setActivePinia(createPinia())
  store = useElementStore()
  te = useTextEdit(
    ref({ left: 0, top: 0, width: 0, height: 0 }),
    () => {},
    () => {},
    () => 'Text',
  )
  vi.useFakeTimers()
  // 樹結構不一致時 assertStoreIntegrity 會呼叫 console.error；這裡改成丟例外，每一步順帶驗證
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    throw new Error(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function rect(id: string): CanvasElement {
  return { ...te.createTextElementAt({ x: 0, y: 0 }), id, name: id, kind: ElementKind.Rect }
}

function textEl(id: string, text: string): CanvasElement {
  return { ...te.createTextElementAt({ x: 0, y: 0 }), id, name: id, text }
}

function load(...elements: CanvasElement[]) {
  store.loadSnapshot({
    byId: Object.fromEntries(elements.map((el) => [el.id, el])),
    rootIds: elements.map((el) => el.id),
  })
}

/** 目前位置往回能 undo 幾步（量完 redo 回原位）。 */
function undoDepth(): number {
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

/** 目前位置往前能 redo 幾步（量完 undo 回原位）。 */
function redoDepth(): number {
  let steps = 0
  for (let i = 0; i < ELEMENT_HISTORY_MAX; i++) {
    const revision = store.documentRevision
    store.redo()
    if (store.documentRevision === revision) break
    steps++
  }
  for (let i = 0; i < steps; i++) store.undo()
  return steps
}

const ids = () => Object.keys(store.byId)
const textOf = (id: string) => store.get(id)?.text

/** 走 CanvasArea 的新建路徑：放入新文字、選取並排程進入編輯，等編輯真的開始。 */
function createText(id = 't'): string {
  te.insertNewText(textEl(id, ''))
  te.beginTextEdit(id)
  vi.runAllTimers()
  return id
}

/** 以 Text 工具點既有文字（或雙擊）進入編輯。 */
function editExisting(id: string) {
  te.beginTextEdit(id)
  vi.runAllTimers()
}

function type(value: string) {
  te.onTextareaInput({ target: { value, style: {}, scrollHeight: 0 } } as unknown as Event)
}

const blur = () => te.onTextareaBlur()
const escape = () => te.onTextareaKeydown(new KeyboardEvent('keydown', { key: 'Escape' }))

describe('useTextEdit：新建文字是一次操作', () => {
  it('輸入內容後離開：一筆 History，一次 Undo 回到建立前', () => {
    load(rect('r'))
    createText()
    type('abc')
    blur()

    expect(textOf('t')).toBe('abc')
    expect(undoDepth()).toBe(1)
    store.undo()
    expect(ids()).toEqual(['r'])
    store.redo()
    expect(textOf('t')).toBe('abc')
  })

  it('留空離開：元素拿掉、零筆 History', () => {
    load(rect('r'))
    createText()
    blur()

    expect(ids()).toEqual(['r'])
    expect(undoDepth()).toBe(0)
    expect(te.editingTextId.value).toBeNull()
  })

  it('只輸入空白後離開：視同留空', () => {
    load(rect('r'))
    createText()
    type('  \n ')
    blur()

    expect(ids()).toEqual(['r'])
    expect(undoDepth()).toBe(0)
  })

  it('輸入後按 Escape：取消整個建立，不留下空 Text、零筆 History', () => {
    load(rect('r'))
    createText()
    type('abc')
    escape()

    expect(ids()).toEqual(['r'])
    expect(undoDepth()).toBe(0)
    expect(te.editingTextId.value).toBeNull()
  })

  it('Escape 之後 textarea 移除觸發的 blur 不再提交', () => {
    load()
    createText()
    type('abc')
    escape()
    blur()

    expect(ids()).toEqual([])
    expect(undoDepth()).toBe(0)
  })

  it('取消建立後換回建立前的 store 物件：之後的 pushSnapshot 不會多推空白 History', () => {
    load(rect('r'))
    createText()
    blur()
    store.pushSnapshot()

    expect(undoDepth()).toBe(0)
  })

  it('取消建立不清掉 Redo', () => {
    load()
    store.add(rect('r'))
    store.undo()
    expect(redoDepth()).toBe(1)

    createText()
    escape()
    expect(redoDepth()).toBe(1)

    createText()
    blur()
    expect(redoDepth()).toBe(1)

    store.redo()
    expect(ids()).toEqual(['r'])
  })

  it('提交新文字會清掉 Redo 分支', () => {
    load()
    store.add(rect('r'))
    store.undo()

    createText()
    type('abc')
    blur()

    expect(redoDepth()).toBe(0)
    expect(undoDepth()).toBe(1)
  })

  it('取消時只拿掉新文字，期間其他還沒記錄的修改保留', () => {
    load(rect('r'))
    createText()
    store.update('r', { x: 42 })
    escape()

    expect(ids()).toEqual(['r'])
    expect(store.get('r')!.x).toBe(42)
  })

  it('建立期間有其他 History 寫入：取消時把刪除記成一筆，不留下無法撤銷的元素', () => {
    load()
    createText()
    store.add(rect('r'))
    blur()

    expect(ids()).toEqual(['r'])
    expect(undoDepth()).toBe(2)
    store.undo()
    expect(ids().sort()).toEqual(['r', 't'])
    store.undo()
    expect(ids()).toEqual([])
  })

  it('編輯新文字時切換到另一個文字：先提交新文字，只記一筆', () => {
    load(textEl('b', 'bee'))
    createText('a')
    type('abc')
    editExisting('b')

    expect(te.editingTextId.value).toBe('b')
    expect(textOf('a')).toBe('abc')
    expect(undoDepth()).toBe(1)
  })

  it('還沒開始編輯就被另一個新文字取代：前一個取消，不留在文件裡', () => {
    load()
    te.insertNewText(textEl('a', ''))
    te.beginTextEdit('a')
    te.insertNewText(textEl('b', ''))
    te.beginTextEdit('b')
    vi.runAllTimers()

    expect(te.editingTextId.value).toBe('b')
    expect(ids()).toEqual(['b'])
    type('bee')
    blur()
    expect(ids()).toEqual(['b'])
    expect(undoDepth()).toBe(1)
  })
})

describe('useTextEdit：非同步進入編輯與文件重新載入', () => {
  it('排程進入編輯前元素被 Undo 換掉：不開始編輯，之後新建照常只記一筆', () => {
    load()
    store.add(rect('r'))
    te.insertNewText(textEl('a', ''))
    te.beginTextEdit('a')
    store.undo()
    vi.runAllTimers()

    expect(te.editingTextId.value).toBeNull()
    expect(ids()).toEqual([])

    store.redo()
    createText('b')
    type('bee')
    blur()
    expect(ids().sort()).toEqual(['b', 'r'])
    expect(undoDepth()).toBe(2)
  })

  it('排程之後文件被重新載入：即使新文件有同一個 id 也不開始編輯', () => {
    load(textEl('x', 'old'))
    te.beginTextEdit('x')
    load(textEl('x', 'reloaded'))
    vi.runAllTimers()

    expect(te.editingTextId.value).toBeNull()
    expect(textOf('x')).toBe('reloaded')
  })

  it('新建文字編輯中文件被重新載入：提交不把草稿寫進新文件', () => {
    load()
    createText('t')
    type('abc')
    load(textEl('t', ''))
    blur()

    expect(ids()).toEqual(['t'])
    expect(textOf('t')).toBe('')
    expect(undoDepth()).toBe(0)
  })

  it('新建文字編輯中文件被重新載入：Escape 不刪新文件裡同 id 的元素', () => {
    load()
    createText('t')
    load(textEl('t', ''))
    escape()

    expect(ids()).toEqual(['t'])
    expect(undoDepth()).toBe(0)
  })

  it('新建文字編輯中文件被重新載入：留空離開不刪新文件裡同 id 的元素', () => {
    load()
    createText('t')
    load(textEl('t', ''))
    blur()

    expect(ids()).toEqual(['t'])
    expect(undoDepth()).toBe(0)
  })

  it('既有文字編輯中文件被重新載入：提交不把草稿寫進新文件', () => {
    load(textEl('x', 'old'))
    editExisting('x')
    type('draft')
    load(textEl('x', 'reloaded'))
    blur()

    expect(textOf('x')).toBe('reloaded')
    expect(undoDepth()).toBe(0)
  })

  /**
   * 新建 t、進入編輯前文件被重新載入，而新文件裡也有 t（例如 autosave 已經把空的 t 存上去）。
   * 這時的 t 是新文件裡的既有文字，不能沿用舊文件的新建登記。
   */
  function createThenReloadBeforeEditing(reloaded: string) {
    load()
    te.insertNewText(textEl('t', ''))
    te.beginTextEdit('t')
    load(textEl('t', reloaded))
    vi.runAllTimers()
    expect(te.editingTextId.value).toBeNull()
  }

  it('進入編輯前重新載入（情境 A）：同 id 的既有文字清空後照常刪除並記一筆', () => {
    createThenReloadBeforeEditing('')
    editExisting('t')
    blur()

    expect(ids()).toEqual([])
    expect(undoDepth()).toBe(1)
    store.undo()
    expect(ids()).toEqual(['t'])
  })

  it('進入編輯前重新載入：之後同 id 的既有文字修改、再清空，都照既有文字記錄', () => {
    createThenReloadBeforeEditing('old')
    editExisting('t')
    type('abc')
    blur()
    expect(textOf('t')).toBe('abc')
    expect(undoDepth()).toBe(1)

    editExisting('t')
    type('')
    blur()
    expect(ids()).toEqual([])
    expect(undoDepth()).toBe(2)
  })

  it('進入編輯前元素暫時不存在（情境 B）：Redo 回來後以既有文字按 Escape，保留元素、不新增 History', () => {
    load()
    te.insertNewText(textEl('t', ''))
    te.beginTextEdit('t')
    // 另一個操作推了 History，把還沒提交的 t 一起記進去；Undo 讓 t 暫時消失
    store.add(rect('r'))
    store.undo()
    vi.runAllTimers()
    expect(te.editingTextId.value).toBeNull()

    store.redo()
    expect(ids().sort()).toEqual(['r', 't'])
    editExisting('t')
    type('abc')
    escape()

    expect(ids().sort()).toEqual(['r', 't'])
    expect(textOf('t')).toBe('')
    expect(undoDepth()).toBe(1)
  })
})

describe('useTextEdit：既有文字的行為不變', () => {
  it('修改內容：一筆 History，Undo 還原原文字', () => {
    load(textEl('x', 'hi'))
    editExisting('x')
    type('hey')
    blur()

    expect(textOf('x')).toBe('hey')
    expect(undoDepth()).toBe(1)
    store.undo()
    expect(textOf('x')).toBe('hi')
  })

  it('內容沒變：零筆', () => {
    load(textEl('x', 'hi'))
    editExisting('x')
    type('hi')
    blur()

    expect(undoDepth()).toBe(0)
  })

  it('清空：刪除並記一筆，Undo 還原原文字', () => {
    load(textEl('x', 'hi'))
    editExisting('x')
    type('')
    blur()

    expect(ids()).toEqual([])
    expect(undoDepth()).toBe(1)
    store.undo()
    expect(textOf('x')).toBe('hi')
  })

  it('Escape：還原原文字，零筆，元素保留', () => {
    load(textEl('x', 'hi'))
    editExisting('x')
    type('changed')
    escape()

    expect(textOf('x')).toBe('hi')
    expect(undoDepth()).toBe(0)
  })

  it('Enter 不結束編輯，換行跟著內容一起提交成一筆', () => {
    load(textEl('x', 'a'))
    editExisting('x')
    te.onTextareaKeydown(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(te.editingTextId.value).toBe('x')

    type('a\nb')
    blur()
    expect(textOf('x')).toBe('a\nb')
    expect(undoDepth()).toBe(1)
  })
})
