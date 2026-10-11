import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { useElementStore } from '@/store/element'
import { useCanvasActions } from '@/composables/useCanvasActions'
import { useCanvasKeyboard } from '@/composables/useCanvasKeyboard'
import SelectionContextMenu from '@/components/context-menu/SelectionContextMenu.vue'
import { ELEMENT_HISTORY_MAX, ElementKind, type CanvasElement } from '@/types/element'
import type { ContextMenuState, GestureState } from '@/types/canvas'

type Store = ReturnType<typeof useElementStore>

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

function content(store: Store): string {
  return JSON.stringify(store.snapshot())
}

function rootOrder(store: Store): string[] {
  return store.rootElements.map((el) => el.id)
}

function allIds(store: Store): string[] {
  return Object.keys(store.byId).sort()
}

/**
 * 一直 undo（或 redo）到 history 走到底，回傳實際走了幾步。
 *
 * 「有沒有走一步」看的是 documentRevision：undo / redo 只有在 history 位置真的移動時
 * 才遞增它。只比較內容的話，數不到內容與相鄰那一筆相同的空快照。
 */
function drain(store: Store, step: () => void): { effective: number; empty: number } {
  let effective = 0
  let empty = 0
  for (let i = 0; i < ELEMENT_HISTORY_MAX * 2; i++) {
    const revision = store.documentRevision
    const before = content(store)
    step()
    if (store.documentRevision === revision) return { effective, empty }
    if (content(store) === before) empty++
    else effective++
  }
  throw new Error('history 沒有在預期的步數內走到底')
}

function drainUndo(store: Store): { effective: number; empty: number } {
  return drain(store, () => store.undo())
}

function drainRedo(store: Store): { effective: number; empty: number } {
  return drain(store, () => store.redo())
}

function select(store: Store, ids: string[]): void {
  store.clearSelection()
  for (const id of ids) store.select(id, true)
}

describe('useCanvasActions.deleteSelected', () => {
  let pinia: Pinia
  let store: Store
  let deleteSelected: () => void

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    store = useElementStore()
    deleteSelected = useCanvasActions().deleteSelected
    // assertStoreIntegrity 發現不一致時只會 console.error。讓它直接丟出來，
    // 每個測試都順帶驗證 byId / rootIds / parentId / childIds 的一致性。
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      throw new Error(`unexpected console.error: ${args.join(' ')}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  describe('一次多選刪除只產生一筆 Undo', () => {
    it('多個根元素：一次 Undo 完整恢復（含順序），Redo 重新刪除', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d')])
      const before = content(store)
      const revision = store.documentRevision
      select(store, ['c', 'a', 'd'])

      deleteSelected()

      expect(allIds(store)).toEqual(['b'])
      expect(rootOrder(store)).toEqual(['b'])
      // 整批只遞增一次：自動存檔只會被觸發一次。
      expect(store.documentRevision).toBe(revision + 1)
      const after = content(store)

      store.undo()
      expect(content(store)).toBe(before)
      expect(rootOrder(store)).toEqual(['a', 'b', 'c', 'd'])

      store.redo()
      expect(content(store)).toBe(after)

      // addAll 一筆、刪除一筆。
      expect(drainUndo(store)).toEqual({ effective: 2, empty: 0 })
    })

    it('全選後刪除（Ctrl+A → Delete）：一次 Undo 全部回來', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const before = content(store)
      store.selectAll()

      deleteSelected()
      expect(allIds(store)).toEqual([])

      store.undo()
      expect(content(store)).toBe(before)
    })

    it('改用 removeMany，不再逐一呼叫 remove', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const remove = vi.spyOn(store, 'remove')
      const removeMany = vi.spyOn(store, 'removeMany')
      select(store, ['a', 'b', 'c'])

      deleteSelected()

      expect(remove).not.toHaveBeenCalled()
      expect(removeMany).toHaveBeenCalledTimes(1)
      expect([...removeMany.mock.calls[0][0]].sort()).toEqual(['a', 'b', 'c'])
    })

    it('單選刪除仍然是一筆 Undo', () => {
      store.addAll([rect('a'), rect('b')])
      select(store, ['a'])

      deleteSelected()
      expect(allIds(store)).toEqual(['b'])

      store.undo()
      expect(allIds(store)).toEqual(['a', 'b'])
    })

    it('連續兩次多選刪除是兩筆獨立的 Undo', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d')])

      select(store, ['a', 'b'])
      deleteSelected()
      select(store, ['c', 'd'])
      deleteSelected()
      expect(allIds(store)).toEqual([])

      store.undo()
      expect(allIds(store)).toEqual(['c', 'd'])
      store.undo()
      expect(allIds(store)).toEqual(['a', 'b', 'c', 'd'])
    })

    it('刪除後選取被清空', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      select(store, ['a', 'c'])

      deleteSelected()

      expect(store.selectedIds.size).toBe(0)
    })
  })

  describe('群組', () => {
    it('群組與根元素一起刪除：子元素一併刪除，一次 Undo 恢復群組結構', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d')])
      const groupId = store.group(['a', 'b'])
      const before = content(store)
      select(store, [groupId, 'd'])

      deleteSelected()
      expect(allIds(store)).toEqual(['c'])

      store.undo()
      expect(content(store)).toBe(before)
      expect(store.get(groupId)?.childIds).toEqual(['a', 'b'])
      expect(store.get('a')?.parentId).toBe(groupId)
    })

    it('群組內的多個子元素：父群組的 childIds 同步更新，一次 Undo 恢復順序', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d'), rect('e')])
      const groupId = store.group(['a', 'b', 'c', 'd'])
      const before = content(store)
      select(store, ['d', 'b'])

      deleteSelected()

      expect(store.get(groupId)?.childIds).toEqual(['a', 'c'])
      expect(rootOrder(store)).toEqual([groupId, 'e'])
      expect(allIds(store)).toEqual(['a', 'c', 'e', groupId].sort())
      const after = content(store)

      store.undo()
      expect(content(store)).toBe(before)
      expect(store.get(groupId)?.childIds).toEqual(['a', 'b', 'c', 'd'])

      store.redo()
      expect(content(store)).toBe(after)
    })

    it('不同群組的子元素與根元素混合選取：仍然只有一筆', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d'), rect('e')])
      const first = store.group(['a', 'b'])
      const second = store.group(['c', 'd'])
      const before = content(store)
      select(store, ['a', 'd', 'e'])

      deleteSelected()

      expect(store.get(first)?.childIds).toEqual(['b'])
      expect(store.get(second)?.childIds).toEqual(['c'])
      expect(rootOrder(store)).toEqual([first, second])

      store.undo()
      expect(content(store)).toBe(before)
    })

    it('祖先與子孫同時選取：子樹只刪一次，一次 Undo 完整恢復', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d'), rect('e')])
      const inner = store.group(['a', 'b'])
      const outer = store.group([inner, 'c'])
      const before = content(store)
      // 葉節點、中間層、最外層同時在選取裡，順序刻意打亂。
      select(store, ['a', outer, inner, 'c', 'e'])

      deleteSelected()
      expect(allIds(store)).toEqual(['d'])
      expect(rootOrder(store)).toEqual(['d'])
      const after = content(store)

      store.undo()
      expect(content(store)).toBe(before)
      expect(store.get(outer)?.childIds).toEqual([inner, 'c'])
      expect(store.get(inner)?.childIds).toEqual(['a', 'b'])

      store.redo()
      expect(content(store)).toBe(after)

      // addAll、兩次 group、一次刪除。
      expect(drainUndo(store)).toEqual({ effective: 4, empty: 0 })
    })
  })

  describe('無效的選取', () => {
    it('沒有選取：不動 store、不增加 history、不增加 documentRevision', () => {
      store.addAll([rect('a'), rect('b')])
      const revision = store.documentRevision
      const byIdBefore = store.byId
      const removeMany = vi.spyOn(store, 'removeMany')

      deleteSelected()

      expect(removeMany).not.toHaveBeenCalled()
      expect(store.byId).toBe(byIdBefore)
      expect(store.documentRevision).toBe(revision)
      expect(drainUndo(store)).toEqual({ effective: 1, empty: 0 })
    })

    it('選取裡只有已不存在的 id：不動 store、不增加 history', () => {
      store.addAll([rect('a'), rect('b')])
      const revision = store.documentRevision
      const byIdBefore = store.byId
      select(store, ['missing', 'also-missing'])

      deleteSelected()

      expect(store.byId).toBe(byIdBefore)
      expect(store.documentRevision).toBe(revision)
      expect(drainUndo(store)).toEqual({ effective: 1, empty: 0 })
    })

    it('Undo 之後以無效的選取按刪除：Redo 不被截斷', () => {
      store.add(rect('a'))
      store.commitUpdate('a', { x: 50 })
      store.undo()

      deleteSelected()
      select(store, ['missing'])
      deleteSelected()

      expect(drainRedo(store)).toEqual({ effective: 1, empty: 0 })
      expect(store.get('a')?.x).toBe(50)
    })

    it('有效與無效的 id 混在選取裡：有效的照常刪除，仍然只有一筆', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const before = content(store)
      const revision = store.documentRevision
      select(store, ['missing', 'a', 'c', 'also-missing'])

      deleteSelected()

      expect(allIds(store)).toEqual(['b'])
      expect(store.documentRevision).toBe(revision + 1)
      store.undo()
      expect(content(store)).toBe(before)
    })

    it('重複加入同一個 id 不會讓它被處理兩次', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const before = content(store)
      const removeMany = vi.spyOn(store, 'removeMany')
      // selectedIds 是 Set：重複選取同一個元素，交給 removeMany 的清單裡只會有一個。
      store.select('a')
      store.select('b', true)
      store.select('a', true)
      store.select('a', true)

      deleteSelected()

      expect(removeMany.mock.calls[0][0]).toHaveLength(2)
      expect(allIds(store)).toEqual(['c'])
      store.undo()
      expect(content(store)).toBe(before)
    })
  })

  describe('Undo / Redo 序列', () => {
    it('多選刪除後連續 Undo / Redo 多次，結構與順序保持一致', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d'), rect('e')])
      const groupId = store.group(['b', 'c', 'd'])
      const before = content(store)
      select(store, ['a', 'c'])

      deleteSelected()
      const after = content(store)

      for (let round = 0; round < 5; round++) {
        store.undo()
        expect(content(store)).toBe(before)
        expect(rootOrder(store)).toEqual(['a', groupId, 'e'])
        expect(store.get(groupId)?.childIds).toEqual(['b', 'c', 'd'])

        store.redo()
        expect(content(store)).toBe(after)
        expect(rootOrder(store)).toEqual([groupId, 'e'])
        expect(store.get(groupId)?.childIds).toEqual(['b', 'd'])
      }

      // addAll、group、刪除：來回之後沒有多出任何一筆。
      expect(drainUndo(store)).toEqual({ effective: 3, empty: 0 })
    })

    it('Undo 後執行多選刪除：原本的 Redo 失效，新的一筆可以正常 Undo / Redo', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      store.commitUpdate('a', { x: 50 })
      store.commitUpdate('a', { x: 80 })
      store.undo()
      store.undo()
      select(store, ['b', 'c'])

      deleteSelected()
      const after = content(store)

      expect(drainRedo(store)).toEqual({ effective: 0, empty: 0 })
      expect(content(store)).toBe(after)
      expect(store.get('a')?.x).toBe(0)

      store.undo()
      expect(allIds(store)).toEqual(['a', 'b', 'c'])
      store.redo()
      expect(content(store)).toBe(after)
    })
  })

  describe('刪除的入口都只產生一筆 Undo', () => {
    function keydown(key: string): KeyboardEvent {
      return new KeyboardEvent('keydown', { key, cancelable: true })
    }

    function createKeyboard(gesture: GestureState = { kind: 'idle' }) {
      const cancelPenGesture = vi.fn()
      const refreshPenGesture = vi.fn()
      const keyboard = useCanvasKeyboard({
        getGesture: () => gesture,
        cancelPenGesture,
        cancelPencilGesture: vi.fn(),
        finishPenGesture: vi.fn(),
        refreshPenGesture,
        pointerWorld: () => ({ x: 0, y: 0 }),
        deleteSelected,
        duplicateSelected: vi.fn(),
        groupSelected: vi.fn(),
        ungroupSelected: vi.fn(),
        onAltRelease: vi.fn(),
      })
      return { keyboard, cancelPenGesture, refreshPenGesture }
    }

    it.each(['Delete', 'Backspace'])('鍵盤 %s：多選刪除是一筆 Undo', (key) => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const before = content(store)
      select(store, ['a', 'b', 'c'])
      const event = keydown(key)

      createKeyboard().keyboard.onKeydown(event)

      expect(event.defaultPrevented).toBe(true)
      expect(allIds(store)).toEqual([])
      store.undo()
      expect(content(store)).toBe(before)
    })

    it('正在輸入文字時按 Delete 不會刪除選取的元素', () => {
      store.addAll([rect('a'), rect('b')])
      select(store, ['a', 'b'])
      const input = document.createElement('input')
      document.body.append(input)
      input.focus()

      createKeyboard().keyboard.onKeydown(keydown('Delete'))

      expect(allIds(store)).toEqual(['a', 'b'])
    })

    it('Pen 繪製中的 Backspace 只退回錨點，不刪除選取的元素', () => {
      store.addAll([rect('a'), rect('b')])
      select(store, ['a', 'b'])
      const revision = store.documentRevision
      const gesture = {
        kind: 'pen',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        pointerDown: false,
        activeIndex: 1,
        dragOrigin: { x: 0, y: 0 },
        hoverPoint: null,
        closing: false,
      } as unknown as GestureState
      const { keyboard, refreshPenGesture } = createKeyboard(gesture)

      keyboard.onKeydown(keydown('Backspace'))

      expect(refreshPenGesture).toHaveBeenCalledTimes(1)
      expect(allIds(store)).toEqual(['a', 'b'])
      expect(store.documentRevision).toBe(revision)
    })

    it('右鍵選單的 Delete（畫布與圖層面板共用）：多選刪除是一筆 Undo', async () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const before = content(store)
      select(store, ['a', 'c'])
      const contextMenu: ContextMenuState = {
        x: 0,
        y: 0,
        hasSelection: true,
        canGroup: true,
        canUngroup: false,
      }
      const wrapper = mount(SelectionContextMenu, {
        props: { contextMenu },
        global: { plugins: [pinia] },
        attachTo: document.body,
      })

      // 選單 Teleport 到 body，不在 wrapper 的 DOM 樹裡。
      const item = document.body.querySelector<HTMLElement>('.ctx-item--danger')
      expect(item).not.toBeNull()
      item!.click()

      expect(allIds(store)).toEqual(['b'])
      expect(wrapper.emitted('close')).toHaveLength(1)
      store.undo()
      expect(content(store)).toBe(before)
      // addAll 一筆、刪除一筆；undo 過一次，剩 addAll 那一筆。
      expect(drainUndo(store)).toEqual({ effective: 1, empty: 0 })

      wrapper.unmount()
    })
  })
})
