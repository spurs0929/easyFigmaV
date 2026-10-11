import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useElementStore } from '@/store/element'
import { ELEMENT_HISTORY_MAX, ElementKind, type CanvasElement } from '@/types/element'

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

/** store 內容的可比較形式。history 不對外公開，測試一律透過「內容有沒有變」觀察它。 */
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
 * 一直 undo 到內容不再改變為止，回傳「內容真的有變」的次數與「按了卻沒變」的次數。
 *
 * 只數到最後一次有變化為止：history 走到底之後 undo 本來就不會動，那不算空的 undo。
 * 空的 undo 指的是夾在中間、使用者按了卻什麼都沒發生的那幾筆。
 */
function drainUndo(store: Store): { effective: number; empty: number } {
  const results: boolean[] = []
  // 上限取 history 容量的兩倍，足以走完任何合法的 history。
  for (let i = 0; i < ELEMENT_HISTORY_MAX * 2; i++) {
    const before = content(store)
    store.undo()
    results.push(content(store) !== before)
  }
  const last = results.lastIndexOf(true)
  const used = results.slice(0, last + 1)
  return {
    effective: used.filter(Boolean).length,
    empty: used.filter((changed) => !changed).length,
  }
}

/** a、b、c、d 四個根元素，依序建立三層巢狀群組：outer > middle > inner > (a, b)。 */
function buildNestedGroups(store: Store): { inner: string; middle: string; outer: string } {
  store.addAll([rect('a'), rect('b'), rect('c'), rect('d'), rect('e')])
  const inner = store.group(['a', 'b'])
  const middle = store.group([inner, 'c'])
  const outer = store.group([middle, 'd'])
  return { inner, middle, outer }
}

describe('elementStore history', () => {
  let store: Store

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useElementStore()
    // assertStoreIntegrity 發現不一致時只會 console.error，不會丟例外。
    // 這裡讓它直接丟出來：任何一個操作破壞了 byId / rootIds / parentId / childIds
    // 的一致性，當下的測試就會失敗，等於每個測試都順帶驗證了結構不變條件。
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      throw new Error(`unexpected console.error: ${args.join(' ')}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('pushSnapshot 參考去重', () => {
    it('沒有任何變更時重複 pushSnapshot，不增加 undo 步數', () => {
      store.add(rect('a'))
      store.pushSnapshot()
      store.pushSnapshot()
      store.pushSnapshot()

      store.undo()
      expect(allIds(store)).toEqual([])
    })

    it('Undo 之後的 no-op pushSnapshot 不清除 Redo', () => {
      store.add(rect('a'))
      store.commitUpdate('a', { x: 50 })
      store.undo()
      expect(store.get('a')?.x).toBe(0)

      store.pushSnapshot()

      store.redo()
      expect(store.get('a')?.x).toBe(50)
    })

    it('全新的空 store 上 pushSnapshot 不產生多餘的一筆', () => {
      store.pushSnapshot()
      store.add(rect('a'))

      // 多出來的那一筆會夾在最底下：第二次 undo 會「成功」退到它，redo 一次就只回到
      // 內容相同的空狀態。沒有多餘的一筆時，第二次 undo 不動，redo 直接回到有元素。
      store.undo()
      store.undo()
      store.redo()
      expect(allIds(store)).toEqual(['a'])
    })

    it('loadSnapshot 之後的 no-op pushSnapshot 不產生多餘的一筆', () => {
      store.loadSnapshot({ byId: { a: rect('a') }, rootIds: ['a'] })
      store.pushSnapshot()
      store.commitUpdate('a', { x: 50 })

      // 判斷方式同上一個測試：多餘的一筆會讓 undo、undo、redo 停在 x = 0。
      store.undo()
      expect(store.get('a')?.x).toBe(0)
      store.undo()
      store.redo()
      expect(store.get('a')?.x).toBe(50)
    })

    it('update 之後的 pushSnapshot 仍然推入一筆（拖曳結束的既有路徑）', () => {
      store.add(rect('a'))
      store.update('a', { x: 30 })
      store.pushSnapshot()

      store.undo()
      expect(store.get('a')?.x).toBe(0)
      store.redo()
      expect(store.get('a')?.x).toBe(30)
    })

    it('Undo 之後執行實際變更，Redo 會被清除', () => {
      store.add(rect('a'))
      store.commitUpdate('a', { x: 50 })
      store.undo()

      store.commitUpdate('a', { y: 70 })
      store.redo()

      expect(store.get('a')).toMatchObject({ x: 0, y: 70 })
    })

    it('單純改變選取不影響 history 與 documentRevision', () => {
      store.addAll([rect('a'), rect('b')])
      const revision = store.documentRevision

      store.select('a')
      store.select('b', true)
      store.selectAll()
      store.clearSelection()
      store.pushSnapshot()

      expect(store.documentRevision).toBe(revision)
      expect(drainUndo(store)).toEqual({ effective: 1, empty: 0 })
    })
  })

  describe('z-order 無變更時提前返回', () => {
    it.each([
      ['bringToFront 最上層元素', (s: Store) => s.bringToFront('c')],
      ['moveUp 最上層元素', (s: Store) => s.moveUp('c')],
      ['sendToBack 最下層元素', (s: Store) => s.sendToBack('a')],
      ['moveDown 最下層元素', (s: Store) => s.moveDown('a')],
      ['不存在的 id', (s: Store) => s.bringToFront('missing')],
    ])('%s：不改順序、不增加 documentRevision、不增加 history', (_label, reorder) => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const revision = store.documentRevision
      const byIdBefore = store.byId

      reorder(store)
      store.pushSnapshot()

      expect(rootOrder(store)).toEqual(['a', 'b', 'c'])
      expect(store.documentRevision).toBe(revision)
      expect(store.byId).toBe(byIdBefore)
      expect(drainUndo(store)).toEqual({ effective: 1, empty: 0 })
    })

    it('只有一個元素時四種方向都是 no-op', () => {
      store.add(rect('a'))
      const revision = store.documentRevision

      store.bringToFront('a')
      store.sendToBack('a')
      store.moveUp('a')
      store.moveDown('a')
      store.pushSnapshot()

      expect(store.documentRevision).toBe(revision)
      expect(drainUndo(store)).toEqual({ effective: 1, empty: 0 })
    })

    it('群組內子元素的 no-op reorder 同樣不動 store', () => {
      store.addAll([rect('a'), rect('b')])
      const groupId = store.group(['a', 'b'])
      const revision = store.documentRevision

      store.bringToFront('b')
      store.sendToBack('a')
      store.pushSnapshot()

      expect(store.get(groupId)?.childIds).toEqual(['a', 'b'])
      expect(store.documentRevision).toBe(revision)
    })

    it('Undo 之後的 no-op reorder 不清除 Redo', () => {
      store.addAll([rect('a'), rect('b')])
      store.commitUpdate('a', { x: 50 })
      store.undo()

      store.bringToFront('b')
      store.pushSnapshot()

      store.redo()
      expect(store.get('a')?.x).toBe(50)
    })

    it('實際改變順序時仍然更新 store，搭配 pushSnapshot 是一筆 undo', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const revision = store.documentRevision

      store.bringToFront('a')
      store.pushSnapshot()

      expect(rootOrder(store)).toEqual(['b', 'c', 'a'])
      expect(store.documentRevision).toBe(revision + 1)

      store.undo()
      expect(rootOrder(store)).toEqual(['a', 'b', 'c'])
      store.redo()
      expect(rootOrder(store)).toEqual(['b', 'c', 'a'])
    })

    it('多個元素依序 reorder 後推一次快照，其中 no-op 的那幾個不影響結果', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])

      // 與 `]` 快捷鍵相同的呼叫方式：逐一 bringToFront，最後推一次。
      for (const id of ['c', 'a']) store.bringToFront(id)
      store.pushSnapshot()

      expect(rootOrder(store)).toEqual(['b', 'c', 'a'])
      store.undo()
      expect(rootOrder(store)).toEqual(['a', 'b', 'c'])
    })

    it.each([
      ['moveUp', (s: Store) => s.moveUp('a'), ['b', 'a', 'c']],
      ['moveDown', (s: Store) => s.moveDown('c'), ['a', 'c', 'b']],
      ['sendToBack', (s: Store) => s.sendToBack('c'), ['c', 'a', 'b']],
    ])('%s 的實際移動結果不變', (_label, reorder, expected) => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      reorder(store)
      expect(rootOrder(store)).toEqual(expected)
    })
  })

  describe('removeMany', () => {
    it('刪除多個根元素只產生一筆 Undo，一次 Undo 完整恢復（含順序）', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d')])
      const before = content(store)
      const revision = store.documentRevision

      store.removeMany(['c', 'a', 'd'])

      expect(rootOrder(store)).toEqual(['b'])
      expect(allIds(store)).toEqual(['b'])
      expect(store.documentRevision).toBe(revision + 1)

      store.undo()
      expect(content(store)).toBe(before)
      expect(rootOrder(store)).toEqual(['a', 'b', 'c', 'd'])
    })

    it('Redo 重新刪除相同的結構', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      store.removeMany(['a', 'c'])
      const afterRemove = content(store)

      store.undo()
      store.redo()

      expect(content(store)).toBe(afterRemove)
      expect(allIds(store)).toEqual(['b'])
    })

    it('刪除群組時連同所有子元素一起刪除，Undo 後群組結構完整', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const groupId = store.group(['a', 'b'])
      const before = content(store)

      store.removeMany([groupId])
      expect(allIds(store)).toEqual(['c'])
      expect(rootOrder(store)).toEqual(['c'])

      store.undo()
      expect(content(store)).toBe(before)
      expect(store.get(groupId)?.childIds).toEqual(['a', 'b'])
      expect(store.get('a')?.parentId).toBe(groupId)
    })

    it('同時刪除根元素與群組', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d')])
      const groupId = store.group(['a', 'b'])
      const before = content(store)

      store.removeMany(['d', groupId])
      expect(allIds(store)).toEqual(['c'])

      store.undo()
      expect(content(store)).toBe(before)
    })

    it('父群組與子元素同時出現在 ids：只處理一次，順序不影響結果', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const groupId = store.group(['a', 'b'])
      const before = content(store)

      store.removeMany(['a', groupId, 'b'])
      expect(allIds(store)).toEqual(['c'])
      const afterRemove = content(store)

      store.undo()
      expect(content(store)).toBe(before)
      store.redo()
      expect(content(store)).toBe(afterRemove)
      // 再往回走一步就是「建立群組之前」，表示整批刪除確實只佔一筆。
      store.undo()
      store.undo()
      expect(store.get(groupId)).toBeUndefined()
      expect(rootOrder(store)).toEqual(['a', 'b', 'c'])
    })

    it('三層巢狀群組：刪除最外層，所有子孫一併刪除並可還原', () => {
      const { inner, middle, outer } = buildNestedGroups(store)
      const before = content(store)

      store.removeMany([outer])
      expect(allIds(store)).toEqual(['e'])
      expect(rootOrder(store)).toEqual(['e'])
      const afterRemove = content(store)

      store.undo()
      expect(content(store)).toBe(before)
      expect(store.get(outer)?.childIds).toEqual([middle, 'd'])
      expect(store.get(middle)?.childIds).toEqual([inner, 'c'])
      expect(store.get(inner)?.childIds).toEqual(['a', 'b'])
      expect(store.get('a')?.parentId).toBe(inner)

      store.redo()
      expect(content(store)).toBe(afterRemove)
    })

    it('三層巢狀群組：刪除中間層，外層的 childIds 同步更新並可還原', () => {
      const { inner, middle, outer } = buildNestedGroups(store)
      const before = content(store)

      store.removeMany([middle])

      expect(allIds(store)).toEqual(['d', 'e', outer].sort())
      expect(store.get(outer)?.childIds).toEqual(['d'])
      expect(store.get(inner)).toBeUndefined()
      expect(rootOrder(store)).toEqual([outer, 'e'])

      store.undo()
      expect(content(store)).toBe(before)
    })

    it('三層巢狀群組：祖先、中間層、葉節點同時在 ids 內，只以最上層為準', () => {
      const { inner, middle, outer } = buildNestedGroups(store)
      const before = content(store)

      store.removeMany(['a', inner, middle, outer, 'e'])
      expect(allIds(store)).toEqual([])

      store.undo()
      expect(content(store)).toBe(before)
    })

    it('同一個群組內刪除多個子元素：父元素的 childIds 一次更新', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const groupId = store.group(['a', 'b', 'c'])
      const before = content(store)

      store.removeMany(['a', 'c'])

      expect(store.get(groupId)?.childIds).toEqual(['b'])
      expect(allIds(store)).toEqual(['b', groupId].sort())

      store.undo()
      expect(content(store)).toBe(before)
      expect(store.get(groupId)?.childIds).toEqual(['a', 'b', 'c'])
    })

    it.each([
      ['空陣列', []],
      ['全部都是不存在的 id', ['missing', 'also-missing']],
    ])('%s：不動 store、不增加 history、不增加 documentRevision', (_label, ids) => {
      store.addAll([rect('a'), rect('b')])
      store.select('a')
      const revision = store.documentRevision
      const byIdBefore = store.byId

      store.removeMany(ids)

      expect(store.byId).toBe(byIdBefore)
      expect(store.documentRevision).toBe(revision)
      expect([...store.selectedIds]).toEqual(['a'])
      expect(drainUndo(store)).toEqual({ effective: 1, empty: 0 })
    })

    it('Undo 之後以無效 id 呼叫 removeMany，不清除 Redo', () => {
      store.add(rect('a'))
      store.commitUpdate('a', { x: 50 })
      store.undo()

      store.removeMany(['missing'])

      store.redo()
      expect(store.get('a')?.x).toBe(50)
    })

    it('有效、無效、重複的 id 混在一起：仍然只有一筆 Undo', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const before = content(store)
      const revision = store.documentRevision

      store.removeMany(['a', 'missing', 'a', 'b', 'b'])

      expect(allIds(store)).toEqual(['c'])
      expect(store.documentRevision).toBe(revision + 1)
      store.undo()
      expect(content(store)).toBe(before)
    })

    it('被刪除的 id（含子孫）從選取中移除，其餘選取保留', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      const groupId = store.group(['a', 'b'])
      store.select(groupId)
      store.select('a', true)
      store.select('c', true)

      store.removeMany([groupId])

      expect([...store.selectedIds]).toEqual(['c'])
    })

    it('不修改刪除前的 store 物件（history 裡的快照）', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d')])
      const groupId = store.group(['a', 'b', 'c'])

      const byIdBefore = store.byId
      const groupBefore = store.get(groupId)!
      const childIdsBefore = groupBefore.childIds
      const rootElementsBefore = rootOrder(store)
      const serialized = JSON.stringify(byIdBefore)

      store.removeMany(['a', 'd'])

      expect(JSON.stringify(byIdBefore)).toBe(serialized)
      expect(groupBefore.childIds).toBe(childIdsBefore)
      expect(childIdsBefore).toEqual(['a', 'b', 'c'])
      expect(rootElementsBefore).toEqual([groupId, 'd'])
      // 父元素是新物件，不是在舊物件上改 childIds。
      expect(store.get(groupId)).not.toBe(groupBefore)
      expect(store.get(groupId)?.childIds).toEqual(['b', 'c'])
    })

    it('連續兩次 removeMany 是兩筆獨立的 Undo', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d')])

      store.removeMany(['a', 'b'])
      store.removeMany(['c'])

      store.undo()
      expect(allIds(store)).toEqual(['c', 'd'])
      store.undo()
      expect(allIds(store)).toEqual(['a', 'b', 'c', 'd'])
    })

    it('單一元素的 remove 行為不變', () => {
      store.addAll([rect('a'), rect('b')])
      store.select('a')

      store.remove('a')

      expect(allIds(store)).toEqual(['b'])
      expect(store.selectedIds.size).toBe(0)
      store.undo()
      expect(allIds(store)).toEqual(['a', 'b'])
    })
  })

  describe('history 上限', () => {
    it(`最多保留 ${ELEMENT_HISTORY_MAX} 筆快照，可 Undo ${ELEMENT_HISTORY_MAX - 1} 步`, () => {
      const total = ELEMENT_HISTORY_MAX + 30
      for (let i = 0; i < total; i++) store.add(rect(`r${i}`))

      expect(drainUndo(store)).toEqual({ effective: ELEMENT_HISTORY_MAX - 1, empty: 0 })
      // 最舊的快照已被捨棄，退到底時留下的是第 (total - 上限 + 1) 個狀態。
      expect(allIds(store)).toHaveLength(total - ELEMENT_HISTORY_MAX + 1)
    })

    it('達到上限後 no-op 不會擠掉既有的快照', () => {
      for (let i = 0; i < ELEMENT_HISTORY_MAX + 5; i++) store.add(rect(`r${i}`))

      for (let i = 0; i < 20; i++) {
        store.pushSnapshot()
        store.bringToFront(`r${ELEMENT_HISTORY_MAX + 4}`)
        store.removeMany(['missing'])
      }

      expect(drainUndo(store)).toEqual({ effective: ELEMENT_HISTORY_MAX - 1, empty: 0 })
    })

    it('退到底之後 Redo 可以完整走回最新狀態', () => {
      for (let i = 0; i < ELEMENT_HISTORY_MAX + 5; i++) store.add(rect(`r${i}`))
      const latest = content(store)

      drainUndo(store)
      for (let i = 0; i < ELEMENT_HISTORY_MAX * 2; i++) store.redo()

      expect(content(store)).toBe(latest)
    })
  })
})
