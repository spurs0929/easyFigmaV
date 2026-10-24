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
 * 一直 undo（或 redo）到 history 走到底，回傳實際走了幾步，以及其中內容有沒有變。
 *
 * 「有沒有走一步」看的是 documentRevision，不是內容：undo / redo 只有在 history
 * 位置真的移動時才遞增它，走到底之後就不再動。這樣每一筆 history 都數得到，
 * 包含內容與相鄰那一筆完全相同的空快照——不論它夾在中間，還是壓在最舊的那一端。
 *
 * 只比較內容是數不到最舊端的：退到一筆空快照與「已經到底、按了沒反應」，
 * 兩者的內容都沒有變，無從分辨。
 *
 * - effective：走了一步，內容也變了。
 * - empty：走了一步，內容卻沒變——使用者按了卻什麼都沒發生的那幾筆。
 */
function drain(store: Store, step: () => void): { effective: number; empty: number } {
  let effective = 0
  let empty = 0
  // 上限取 history 容量的兩倍：足以走完任何合法的 history，也避免壞掉時變成無窮迴圈。
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

/** 目前位置之前還有幾筆可以 undo。走完會停在最舊的那一筆，只用在測試的最後一步。 */
function undoDepth(store: Store): number {
  const { effective, empty } = drainUndo(store)
  return effective + empty
}

/** a、b、c、d 四個根元素，依序建立三層巢狀群組：outer > middle > inner > (a, b)。 */
function buildNestedGroups(store: Store): { inner: string; middle: string; outer: string } {
  store.addAll([rect('a'), rect('b'), rect('c'), rect('d'), rect('e')])
  const inner = store.group(['a', 'b'])
  const middle = store.group([inner, 'c'])
  const outer = store.group([middle, 'd'])
  return { inner, middle, outer }
}

interface FixtureIds {
  g1: string
  g2: string
  inner: string
  outer: string
}

/**
 * Ungroup 用的文件，座標都不是 0，解散時座標換算錯了才看得出來：
 *
 * rootIds = [g1, m, g2, outer, z]
 * - g1 (10, 20)  > a (0, 0)、b (30, 0)
 * - g2 (100, 150) > c (0, 0)、d (30, 20)
 * - outer (400, 400) > inner (0, 10) > p (0, 0)、q (30, 30)；outer > r (80, 0)
 * - m、z：不在群組裡的一般元素
 */
function buildUngroupFixture(store: Store): FixtureIds {
  store.addAll([
    rect('a', { x: 10, y: 20 }),
    rect('b', { x: 40, y: 20 }),
    rect('m', { x: 300, y: 300 }),
    rect('c', { x: 100, y: 150 }),
    rect('d', { x: 130, y: 170 }),
    rect('p', { x: 400, y: 410 }),
    rect('q', { x: 430, y: 440 }),
    rect('r', { x: 480, y: 400 }),
    rect('z', { x: 600, y: 600 }),
  ])
  const g1 = store.group(['a', 'b'])
  const g2 = store.group(['c', 'd'])
  const inner = store.group(['p', 'q'])
  const outer = store.group([inner, 'r'])
  return { g1, g2, inner, outer }
}

/** 非群組元素在畫布上的絕對位置（沿 parent 鏈累加；fixture 的群組都沒有旋轉）。 */
function leafWorldPositions(store: Store): Record<string, { x: number; y: number }> {
  const result: Record<string, { x: number; y: number }> = {}
  for (const el of Object.values(store.byId)) {
    if (el.kind === ElementKind.Group) continue
    let x = el.x
    let y = el.y
    let parentId = el.parentId
    while (parentId) {
      const parent = store.get(parentId)!
      x += parent.x
      y += parent.y
      parentId = parent.parentId
    }
    result[el.id] = { x, y }
  }
  return result
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

  describe('ungroupMany', () => {
    it('多個群組一次解散只產生一筆 Undo；Undo 一次完整恢復，Redo 一次再次解散', () => {
      const { g1, g2, outer } = buildUngroupFixture(store)
      const before = content(store)
      const worldBefore = leafWorldPositions(store)
      const revision = store.documentRevision

      store.ungroupMany([g1, g2])

      expect(rootOrder(store)).toEqual(['a', 'b', 'm', 'c', 'd', outer, 'z'])
      expect(store.get(g1)).toBeUndefined()
      expect(store.get(g2)).toBeUndefined()
      expect(['a', 'b', 'c', 'd'].map((id) => store.get(id)?.parentId)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ])
      // 子元素在畫布上的絕對位置不變。
      expect(leafWorldPositions(store)).toEqual(worldBefore)
      // 整批只遞增一次：自動存檔只會被觸發一次。
      expect(store.documentRevision).toBe(revision + 1)
      const after = content(store)

      store.undo()
      expect(content(store)).toBe(before)
      expect(rootOrder(store)).toEqual([g1, 'm', g2, outer, 'z'])
      expect(store.get(g1)?.childIds).toEqual(['a', 'b'])
      expect(store.get(g2)?.childIds).toEqual(['c', 'd'])
      expect(store.get('a')?.parentId).toBe(g1)
      expect(store.get('d')?.parentId).toBe(g2)

      store.redo()
      expect(content(store)).toBe(after)

      // addAll 一筆、group 四筆、ungroupMany 一筆。逐一解散的話會是 7。
      expect(undoDepth(store)).toBe(6)
    })

    it('回傳被還原的子元素 id（依處理順序）；被解散的群組移出選取，其他選取保留', () => {
      const { g1, g2 } = buildUngroupFixture(store)
      store.select(g2, true)
      store.select('m', true)
      store.select(g1, true)

      const restored = store.ungroupMany([g2, g1])

      expect(restored).toEqual(['c', 'd', 'a', 'b'])
      expect([...store.selectedIds]).toEqual(['m'])
    })

    it('巢狀群組：只解散傳入的外層，內層群組保留並轉為絕對座標，Undo 完整恢復', () => {
      const { inner, outer } = buildUngroupFixture(store)
      const before = content(store)
      const worldBefore = leafWorldPositions(store)

      const restored = store.ungroupMany([outer])

      expect(restored).toEqual([inner, 'r'])
      expect(store.get(outer)).toBeUndefined()
      expect(store.get(inner)?.parentId).toBeUndefined()
      expect(store.get(inner)?.kind).toBe(ElementKind.Group)
      expect({ x: store.get(inner)?.x, y: store.get(inner)?.y }).toEqual({ x: 400, y: 410 })
      // 內層群組的子元素不動：仍掛在內層群組下，座標仍相對於內層群組。
      expect(store.get(inner)?.childIds).toEqual(['p', 'q'])
      expect(store.get('p')?.parentId).toBe(inner)
      expect({ x: store.get('q')?.x, y: store.get('q')?.y }).toEqual({ x: 30, y: 30 })
      expect(leafWorldPositions(store)).toEqual(worldBefore)

      store.undo()
      expect(content(store)).toBe(before)
      expect(store.get(inner)?.parentId).toBe(outer)
      expect(store.get(outer)?.childIds).toEqual([inner, 'r'])
    })

    it.each<[string, (ids: FixtureIds) => string[]]>([
      ['空清單', () => []],
      ['只有一般元素', () => ['m', 'z']],
      ['不存在的 id', () => ['missing']],
      ['不在 root 的群組（內層）', ({ inner }) => [inner]],
    ])(
      '沒有可解散的群組（%s）：不動 store、不遞增 documentRevision、不截斷 Redo',
      (_label, pick) => {
        const ids = buildUngroupFixture(store)
        store.commitUpdate('m', { x: 999 })
        store.undo()
        const before = content(store)
        const revision = store.documentRevision

        expect(store.ungroupMany(pick(ids))).toEqual([])

        expect(content(store)).toBe(before)
        expect(store.documentRevision).toBe(revision)
        // 原本可以 Redo 的那一步還在。
        store.redo()
        expect(store.get('m')?.x).toBe(999)
      },
    )

    it.each<[string, (ids: FixtureIds) => string[]]>([
      ['兩個獨立群組', ({ g1, g2 }) => [g1, g2]],
      ['兩個獨立群組（相反順序）', ({ g1, g2 }) => [g2, g1]],
      ['群組與一般元素混合', ({ g1, g2 }) => [g1, 'm', g2, 'z']],
      ['重複與不存在的 id', ({ g1 }) => [g1, 'missing', g1]],
      ['外層群組', ({ outer }) => [outer]],
      ['外層與其他群組', ({ g1, outer }) => [outer, g1]],
      ['祖先先於子孫', ({ inner, outer }) => [outer, inner]],
      ['子孫先於祖先', ({ inner, outer }) => [inner, outer]],
    ])('結果與逐一呼叫 ungroup 相同，只是整批一筆（%s）', (_label, pick) => {
      const ids = buildUngroupFixture(store)
      const selection = [ids.g1, 'm', ids.g2, ids.outer]
      for (const id of selection) store.select(id, true)
      const before = content(store)

      // 另一個 store 載入相同的內容，逐一呼叫 ungroup 作為對照。
      const reference = useElementStore(createPinia())
      reference.loadSnapshot(store.snapshot())
      for (const id of selection) reference.select(id, true)
      const sequential = pick(ids).flatMap((id) => reference.ungroup(id))

      const restored = store.ungroupMany(pick(ids))

      expect(content(store)).toBe(content(reference))
      expect([...store.selectedIds]).toEqual([...reference.selectedIds])
      // 同一批裡也被解散的群組（祖先先於子孫時的子孫）不會出現在回傳值。
      expect(restored).toEqual(sequential.filter((id) => reference.get(id) !== undefined))
      // 不論傳入幾個群組，解散都只佔一筆：退一步就回到解散前。
      store.undo()
      expect(content(store)).toBe(before)
    })

    it('不修改解散前的 store 物件（history 裡的快照）', () => {
      const { g1, g2, outer } = buildUngroupFixture(store)
      const byIdBefore = store.byId
      const childBefore = store.get('a')!
      const rootElementsBefore = rootOrder(store)
      const serialized = JSON.stringify(byIdBefore)

      store.ungroupMany([g1, g2])

      expect(JSON.stringify(byIdBefore)).toBe(serialized)
      expect(childBefore.parentId).toBe(g1)
      expect({ x: childBefore.x, y: childBefore.y }).toEqual({ x: 0, y: 0 })
      expect(rootElementsBefore).toEqual([g1, 'm', g2, outer, 'z'])
      // 子元素是新物件，不是在舊物件上改座標。
      expect(store.get('a')).not.toBe(childBefore)
    })

    it('連續兩次 ungroupMany 是兩筆獨立的 Undo', () => {
      const { g1, g2, outer } = buildUngroupFixture(store)

      store.ungroupMany([g1, g2])
      const afterFirst = content(store)
      store.ungroupMany([outer])

      store.undo()
      expect(content(store)).toBe(afterFirst)
      store.undo()
      expect(store.get(g1)?.childIds).toEqual(['a', 'b'])
      expect(store.get(g2)?.childIds).toEqual(['c', 'd'])
    })

    it('Undo 後執行 ungroupMany：原本的 Redo 被截斷，新的一筆可以正常 Undo / Redo', () => {
      const { g1, g2 } = buildUngroupFixture(store)
      store.commitUpdate('m', { x: 999 })
      store.undo()
      const before = content(store)

      store.ungroupMany([g1, g2])
      const after = content(store)

      // 原本 Redo 回 x = 999 的那一筆已經不存在。
      store.redo()
      expect(content(store)).toBe(after)
      store.undo()
      expect(content(store)).toBe(before)
      store.redo()
      expect(content(store)).toBe(after)
      expect(store.get('m')?.x).toBe(300)
    })

    it('單一群組的 ungroup 行為不變：回傳子元素、絕對座標、圖層位置、選取與一筆 Undo', () => {
      const { g1, g2, outer } = buildUngroupFixture(store)
      store.select(g1, true)
      store.select('m', true)
      const before = content(store)
      const worldBefore = leafWorldPositions(store)

      const restored = store.ungroup(g1)

      expect(restored).toEqual(['a', 'b'])
      expect(rootOrder(store)).toEqual(['a', 'b', 'm', g2, outer, 'z'])
      expect(store.get('a')?.parentId).toBeUndefined()
      expect({ x: store.get('b')?.x, y: store.get('b')?.y }).toEqual({ x: 40, y: 20 })
      expect(leafWorldPositions(store)).toEqual(worldBefore)
      expect([...store.selectedIds]).toEqual(['m'])

      store.undo()
      expect(content(store)).toBe(before)
      // addAll 一筆、group 四筆。
      expect(undoDepth(store)).toBe(5)
    })
  })

  describe('Undo / Redo 序列', () => {
    it('初始空文件重複 pushSnapshot：沒有任何可 Undo 的步驟', () => {
      const revision = store.documentRevision

      store.pushSnapshot()
      store.pushSnapshot()
      store.pushSnapshot()

      expect(undoDepth(store)).toBe(0)
      expect(drainRedo(store)).toEqual({ effective: 0, empty: 0 })
      expect(store.documentRevision).toBe(revision)
    })

    it('初始空文件重複 pushSnapshot 之後新增元素：剛好一筆，Undo / Redo 各一步', () => {
      store.pushSnapshot()
      store.pushSnapshot()
      store.add(rect('a'))
      store.pushSnapshot()

      expect(drainUndo(store)).toEqual({ effective: 1, empty: 0 })
      expect(allIds(store)).toEqual([])
      expect(drainRedo(store)).toEqual({ effective: 1, empty: 0 })
      expect(allIds(store)).toEqual(['a'])
    })

    it('loadSnapshot 後重複 pushSnapshot：沒有任何可 Undo 的步驟', () => {
      store.add(rect('old'))
      store.loadSnapshot({ byId: { a: rect('a') }, rootIds: ['a'] })
      const revision = store.documentRevision

      store.pushSnapshot()
      store.pushSnapshot()

      expect(undoDepth(store)).toBe(0)
      expect(drainRedo(store)).toEqual({ effective: 0, empty: 0 })
      expect(store.documentRevision).toBe(revision)
      // loadSnapshot 會重設 history：載入前的內容不可能被 undo 回來。
      expect(allIds(store)).toEqual(['a'])
    })

    it('loadSnapshot 後重複 pushSnapshot 再變更：剛好一筆，退回載入時的內容', () => {
      store.loadSnapshot({ byId: { a: rect('a') }, rootIds: ['a'] })
      const loaded = content(store)

      store.pushSnapshot()
      store.commitUpdate('a', { x: 50 })
      store.pushSnapshot()

      expect(drainUndo(store)).toEqual({ effective: 1, empty: 0 })
      expect(content(store)).toBe(loaded)
      expect(drainRedo(store)).toEqual({ effective: 1, empty: 0 })
      expect(store.get('a')?.x).toBe(50)
    })

    it('Undo 多步之後連續執行各種 no-op，Redo 仍可完整走回最新狀態', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      store.commitUpdate('a', { x: 10 })
      store.commitUpdate('a', { x: 20 })
      store.commitUpdate('a', { x: 30 })
      const latest = content(store)

      store.undo()
      store.undo()
      expect(store.get('a')?.x).toBe(10)
      const revision = store.documentRevision

      store.pushSnapshot()
      store.bringToFront('c')
      store.sendToBack('a')
      store.moveUp('c')
      store.moveDown('a')
      store.bringToFront('missing')
      store.pushSnapshot()
      store.removeMany([])
      store.removeMany(['missing', 'missing'])
      store.pushSnapshot()

      expect(store.documentRevision).toBe(revision)
      expect(drainRedo(store)).toEqual({ effective: 2, empty: 0 })
      expect(content(store)).toBe(latest)
    })

    it('刪除群組內部分子元素後連續 Undo / Redo 多次，結構與順序保持一致', () => {
      store.addAll([rect('a'), rect('b'), rect('c'), rect('d'), rect('e'), rect('f')])
      const groupId = store.group(['b', 'c', 'd', 'e'])
      const before = content(store)

      store.removeMany(['e', 'c'])
      const after = content(store)

      expect(store.get(groupId)?.childIds).toEqual(['b', 'd'])
      expect(rootOrder(store)).toEqual(['a', groupId, 'f'])

      for (let round = 0; round < 5; round++) {
        store.undo()
        expect(content(store)).toBe(before)
        expect(store.get(groupId)?.childIds).toEqual(['b', 'c', 'd', 'e'])
        expect(store.get('c')?.parentId).toBe(groupId)
        expect(store.get('e')?.parentId).toBe(groupId)
        expect(rootOrder(store)).toEqual(['a', groupId, 'f'])

        store.redo()
        expect(content(store)).toBe(after)
        expect(store.get(groupId)?.childIds).toEqual(['b', 'd'])
        expect(store.get('c')).toBeUndefined()
        expect(store.get('e')).toBeUndefined()
        expect(rootOrder(store)).toEqual(['a', groupId, 'f'])
      }

      // 來回五次之後 history 沒有多出任何一筆：addAll、group、removeMany 共三步。
      expect(drainUndo(store)).toEqual({ effective: 3, empty: 0 })
      expect(allIds(store)).toEqual([])
    })

    it('Undo 後執行混合有效與無效 id 的 removeMany：Redo 正確失效', () => {
      store.addAll([rect('a'), rect('b'), rect('c')])
      store.commitUpdate('a', { x: 50 })
      store.commitUpdate('a', { x: 80 })
      store.undo()
      store.undo()
      expect(store.get('a')?.x).toBe(0)

      store.removeMany(['missing', 'b', 'b', 'also-missing'])
      const afterRemove = content(store)
      const revision = store.documentRevision

      // 原本可以 redo 回 x = 50、x = 80 的兩筆已經被新的操作截斷。
      store.redo()
      store.redo()
      expect(store.documentRevision).toBe(revision)
      expect(content(store)).toBe(afterRemove)
      expect(store.get('a')?.x).toBe(0)
      expect(allIds(store)).toEqual(['a', 'c'])

      // 新的那一筆本身可以正常 Undo / Redo。
      store.undo()
      expect(allIds(store)).toEqual(['a', 'b', 'c'])
      expect(rootOrder(store)).toEqual(['a', 'b', 'c'])
      expect(store.get('a')?.x).toBe(0)
      store.redo()
      expect(content(store)).toBe(afterRemove)

      // history 現在是：空 → addAll → removeMany，不多不少。
      expect(drainUndo(store)).toEqual({ effective: 2, empty: 0 })
    })
  })

  describe('history 上限', () => {
    /** 連續新增 n 個元素；每個 add 各佔一筆 history。 */
    function addMany(n: number): void {
      for (let i = 0; i < n; i++) store.add(rect(`r${i}`))
    }

    it(`少於上限一筆（${ELEMENT_HISTORY_MAX - 1} 筆）：全部可以 Undo`, () => {
      addMany(ELEMENT_HISTORY_MAX - 2)

      expect(drainUndo(store)).toEqual({ effective: ELEMENT_HISTORY_MAX - 2, empty: 0 })
      expect(allIds(store)).toEqual([])
    })

    it(`剛好 ${ELEMENT_HISTORY_MAX} 筆：不捨棄任何快照，可以一路退回空文件`, () => {
      // 初始的空狀態佔一筆，所以 (上限 - 1) 次新增剛好填滿。
      addMany(ELEMENT_HISTORY_MAX - 1)

      expect(drainUndo(store)).toEqual({ effective: ELEMENT_HISTORY_MAX - 1, empty: 0 })
      expect(allIds(store)).toEqual([])
    })

    it('超過上限一筆：只捨棄最舊的空狀態，退到底時剩下第一個元素', () => {
      addMany(ELEMENT_HISTORY_MAX)

      expect(drainUndo(store)).toEqual({ effective: ELEMENT_HISTORY_MAX - 1, empty: 0 })
      expect(allIds(store)).toEqual(['r0'])
    })

    it(`遠超過上限：最多保留 ${ELEMENT_HISTORY_MAX} 筆，可 Undo ${ELEMENT_HISTORY_MAX - 1} 步`, () => {
      const total = ELEMENT_HISTORY_MAX + 30
      addMany(total)

      expect(drainUndo(store)).toEqual({ effective: ELEMENT_HISTORY_MAX - 1, empty: 0 })
      // 最舊的快照已被捨棄，退到底時留下的是第 (total - 上限 + 1) 個狀態。
      expect(allIds(store)).toHaveLength(total - ELEMENT_HISTORY_MAX + 1)
    })

    it('達到上限後 no-op 不會擠掉既有的快照', () => {
      addMany(ELEMENT_HISTORY_MAX + 5)
      const top = `r${ELEMENT_HISTORY_MAX + 4}`

      for (let i = 0; i < 20; i++) {
        store.pushSnapshot()
        store.bringToFront(top)
        store.removeMany(['missing'])
      }

      expect(drainUndo(store)).toEqual({ effective: ELEMENT_HISTORY_MAX - 1, empty: 0 })
      // 最舊的那一筆還在：沒有被 no-op 擠掉。
      expect(allIds(store)).toHaveLength(6)
    })

    it('達到上限後 Undo 再執行 no-op：Redo 不被截斷', () => {
      addMany(ELEMENT_HISTORY_MAX + 5)
      const latest = content(store)

      store.undo()
      store.undo()
      store.undo()
      store.pushSnapshot()
      store.removeMany(['missing'])

      expect(drainRedo(store)).toEqual({ effective: 3, empty: 0 })
      expect(content(store)).toBe(latest)
    })

    it('達到上限後 Undo 再執行實際變更：Redo 失效，總筆數仍不超過上限', () => {
      addMany(ELEMENT_HISTORY_MAX + 5)

      store.undo()
      store.undo()
      store.undo()
      store.removeMany(['r10', 'r11'])
      const afterRemove = content(store)

      expect(drainRedo(store)).toEqual({ effective: 0, empty: 0 })
      expect(content(store)).toBe(afterRemove)
      // 上限 50 筆，退了 3 筆又推 1 筆：48 筆，可 Undo 47 步。
      expect(drainUndo(store)).toEqual({ effective: ELEMENT_HISTORY_MAX - 3, empty: 0 })
    })

    it('退到底之後 Redo 可以完整走回最新狀態', () => {
      addMany(ELEMENT_HISTORY_MAX + 5)
      const latest = content(store)

      expect(drainUndo(store)).toEqual({ effective: ELEMENT_HISTORY_MAX - 1, empty: 0 })
      expect(drainRedo(store)).toEqual({ effective: ELEMENT_HISTORY_MAX - 1, empty: 0 })
      expect(content(store)).toBe(latest)
    })
  })
  describe('checkpoint / restoreIfUnchanged（拖曳、縮放回到原狀，U3C）', () => {
    /** 模擬一次手勢：記下 checkpoint，做一連串 update，結束時照 CanvasArea 的順序收尾。 */
    function gesture(steps: () => void): boolean {
      const cp = store.checkpoint()
      steps()
      const restored = store.restoreIfUnchanged(cp)
      store.pushSnapshot()
      return restored
    }

    it('拖出去再拖回原位：不新增 History', () => {
      store.add(rect('a', { x: 10, y: 20 }))

      const restored = gesture(() => {
        store.update('a', { x: 60, y: 90 })
        store.update('a', { x: 10, y: 20 })
      })

      expect(restored).toBe(true)
      expect(undoDepth(store)).toBe(1)
    })

    it('拖回原位不清掉 Redo', () => {
      store.add(rect('a'))
      store.add(rect('b'))
      store.undo()

      gesture(() => {
        store.update('a', { x: 50 })
        store.update('a', { x: 0 })
      })

      expect(drainRedo(store)).toEqual({ effective: 1, empty: 0 })
      expect(allIds(store)).toEqual(['a', 'b'])
    })

    it('縮放回原尺寸：不新增 History', () => {
      store.add(rect('a', { x: 5, y: 5, width: 40, height: 30 }))

      const restored = gesture(() => {
        store.update('a', { x: 5, y: 5, width: 80, height: 70 })
        store.update('a', { x: 5, y: 5, width: 40, height: 30 })
      })

      expect(restored).toBe(true)
      expect(undoDepth(store)).toBe(1)
    })

    it('多個元素都拖回原位：不新增 History', () => {
      store.addAll([rect('a', { x: 0 }), rect('b', { x: 100 })])

      const restored = gesture(() => {
        store.update('a', { x: 30 })
        store.update('b', { x: 130 })
        store.update('a', { x: 0 })
        store.update('b', { x: 100 })
      })

      expect(restored).toBe(true)
      expect(undoDepth(store)).toBe(1)
    })

    it('換回後 store 就是記下的那個物件：之後重複 pushSnapshot 也不會多出空白 History', () => {
      store.add(rect('a'))

      gesture(() => {
        store.update('a', { x: 50 })
        store.update('a', { x: 0 })
      })
      // 像是之後的純點擊：按下、沒移動就放開，只會 pushSnapshot。
      store.pushSnapshot()
      store.pushSnapshot()

      expect(drainUndo(store)).toEqual({ effective: 1, empty: 0 })
    })

    it('換回不遞增 documentRevision，內容與 checkpoint 相同', () => {
      store.add(rect('a', { x: 7 }))
      const before = content(store)
      const cp = store.checkpoint()
      store.update('a', { x: 70 })
      store.update('a', { x: 7 })
      const revision = store.documentRevision

      expect(store.restoreIfUnchanged(cp)).toBe(true)
      expect(store.documentRevision).toBe(revision)
      expect(content(store)).toBe(before)
    })

    it('完全沒有 update：回傳 true，store 不變、不新增 History', () => {
      store.add(rect('a'))
      const revision = store.documentRevision

      expect(gesture(() => {})).toBe(true)
      expect(store.documentRevision).toBe(revision)
      expect(undoDepth(store)).toBe(1)
    })

    it('真的移動了：回傳 false，保留移動後的內容並新增一筆 History', () => {
      store.add(rect('a'))

      const restored = gesture(() => {
        store.update('a', { x: 50 })
        store.update('a', { x: 40 })
      })

      expect(restored).toBe(false)
      expect(store.get('a')!.x).toBe(40)
      expect(drainUndo(store)).toEqual({ effective: 2, empty: 0 })
    })

    it('只差 1 個單位也算變更', () => {
      store.add(rect('a', { y: 10 }))

      const restored = gesture(() => {
        store.update('a', { y: 11 })
      })

      expect(restored).toBe(false)
      expect(undoDepth(store)).toBe(2)
    })

    it('多個元素只有一個回到原位：回傳 false，新增一筆 History', () => {
      store.addAll([rect('a', { x: 0 }), rect('b', { x: 100 })])

      const restored = gesture(() => {
        store.update('a', { x: 30 })
        store.update('b', { x: 130 })
        store.update('a', { x: 0 })
      })

      expect(restored).toBe(false)
      expect(store.get('b')!.x).toBe(130)
      expect(undoDepth(store)).toBe(2)
    })

    it('位置回到原位但尺寸改了：回傳 false', () => {
      store.add(rect('a', { width: 10 }))

      const restored = gesture(() => {
        store.update('a', { x: 50, width: 20 })
        store.update('a', { x: 0 })
      })

      expect(restored).toBe(false)
      expect(store.get('a')!.width).toBe(20)
      expect(undoDepth(store)).toBe(2)
    })

    it('判定為已變更時不動 store：內容與 documentRevision 都維持', () => {
      store.add(rect('a'))
      const cp = store.checkpoint()
      store.update('a', { x: 50 })
      const after = content(store)
      const revision = store.documentRevision

      expect(store.restoreIfUnchanged(cp)).toBe(false)
      expect(content(store)).toBe(after)
      expect(store.documentRevision).toBe(revision)
    })

    it('記下後新增了元素：回傳 false', () => {
      store.add(rect('a'))
      const cp = store.checkpoint()
      store.add(rect('b'))

      expect(store.restoreIfUnchanged(cp)).toBe(false)
      expect(allIds(store)).toEqual(['a', 'b'])
    })

    it('記下後刪除了元素：回傳 false', () => {
      store.addAll([rect('a'), rect('b')])
      const cp = store.checkpoint()
      store.remove('b')

      expect(store.restoreIfUnchanged(cp)).toBe(false)
      expect(allIds(store)).toEqual(['a'])
    })

    it('記下後刪一個、加一個（元素數量相同、id 不同）：回傳 false', () => {
      store.addAll([rect('a'), rect('b')])
      const cp = store.checkpoint()
      store.remove('b')
      store.add(rect('c'))

      expect(store.restoreIfUnchanged(cp)).toBe(false)
      expect(allIds(store)).toEqual(['a', 'c'])
    })

    it('記下後改了圖層順序：回傳 false', () => {
      store.addAll([rect('a'), rect('b')])
      const cp = store.checkpoint()
      store.bringToFront('a')

      expect(store.restoreIfUnchanged(cp)).toBe(false)
      expect(rootOrder(store)).toEqual(['b', 'a'])
    })

    it('圖層順序改了又改回：rootIds 是新陣列但順序相同，回傳 true', () => {
      store.addAll([rect('a'), rect('b')])
      const cp = store.checkpoint()
      store.bringToFront('a')
      store.sendToBack('a')

      expect(store.restoreIfUnchanged(cp)).toBe(true)
      expect(rootOrder(store)).toEqual(['a', 'b'])
    })

    it('群組內子元素回到原位：回傳 true', () => {
      store.addAll([rect('a', { x: 0 }), rect('b', { x: 50 })])
      const groupId = store.group(['a', 'b'])
      const [childId] = store.get(groupId)!.childIds
      const original = store.get(childId)!.x

      const restored = gesture(() => {
        store.update(childId, { x: original + 25 })
        store.update(childId, { x: original })
      })

      expect(restored).toBe(true)
      expect(undoDepth(store)).toBe(2)
    })

    it('物件屬性換成內容相同的新物件：只比一層，保守地判定為已變更', () => {
      store.add(rect('a'))
      const cp = store.checkpoint()
      store.update('a', { fill: { type: 'solid', color: '#ffffff' } })

      expect(store.restoreIfUnchanged(cp)).toBe(false)
    })

    it('新增了原本沒有的屬性（即使值是 undefined）：保守地判定為已變更', () => {
      store.add(rect('a'))
      const cp = store.checkpoint()
      store.update('a', { componentId: undefined })

      expect(store.restoreIfUnchanged(cp)).toBe(false)
    })

    it('記下時已有未推入 History 的變更：拖回原位後仍只推一筆（那筆既有變更）', () => {
      store.add(rect('a'))
      store.update('a', { x: 5 }) // 沒有 pushSnapshot 的變更

      const restored = gesture(() => {
        store.update('a', { x: 50 })
        store.update('a', { x: 5 })
      })

      expect(restored).toBe(true)
      expect(store.get('a')!.x).toBe(5)
      expect(drainUndo(store)).toEqual({ effective: 2, empty: 0 })
    })

    it('記下後經過 loadSnapshot（內容相同的空文件）：checkpoint 失效，不換回、不新增空白 History', () => {
      const cp = store.checkpoint()
      store.loadSnapshot({ byId: {}, rootIds: [] })

      expect(store.restoreIfUnchanged(cp)).toBe(false)
      store.pushSnapshot()
      expect(undoDepth(store)).toBe(0)
    })

    it('記下後經過 loadSnapshot（內容相同、有元素）：回傳 false，載入的文件保持原樣', () => {
      store.loadSnapshot({ byId: { a: rect('a') }, rootIds: ['a'] })
      const cp = store.checkpoint()
      store.loadSnapshot({ byId: { a: rect('a') }, rootIds: ['a'] })
      store.update('a', { x: 40 })
      store.update('a', { x: 0 })

      expect(store.restoreIfUnchanged(cp)).toBe(false)
      expect(allIds(store)).toEqual(['a'])
    })

    it('loadSnapshot 之後才記下：checkpoint 照常有效，拖回原位不新增 History', () => {
      store.loadSnapshot({ byId: { a: rect('a') }, rootIds: ['a'] })
      store.loadSnapshot({ byId: { a: rect('a', { x: 5 }) }, rootIds: ['a'] })

      const restored = gesture(() => {
        store.update('a', { x: 60 })
        store.update('a', { x: 5 })
      })

      expect(restored).toBe(true)
      expect(undoDepth(store)).toBe(0)
    })

    it('記下後經過 Undo / Redo：checkpoint 仍有效（只有 loadSnapshot 會讓它失效）', () => {
      store.add(rect('a'))
      store.commitUpdate('a', { x: 30 })
      const cp = store.checkpoint()
      store.undo()
      store.redo()

      expect(store.restoreIfUnchanged(cp)).toBe(true)
      store.pushSnapshot()
      expect(undoDepth(store)).toBe(2)
    })

    it('記下後推過一筆 History 又改回：checkpoint 仍有效（只有 loadSnapshot 會讓它失效）', () => {
      store.add(rect('a'))
      const cp = store.checkpoint()
      store.commitUpdate('a', { x: 50 })
      store.update('a', { x: 0 })

      expect(store.restoreIfUnchanged(cp)).toBe(true)
      expect(store.get('a')!.x).toBe(0)
    })

    it('Undo 之後記下、拖回原位：Undo 後的位置不變、Redo 保留', () => {
      store.add(rect('a'))
      store.commitUpdate('a', { x: 30 })
      store.undo()

      gesture(() => {
        store.update('a', { x: 80 })
        store.update('a', { x: 0 })
      })

      expect(store.get('a')!.x).toBe(0)
      expect(drainRedo(store)).toEqual({ effective: 1, empty: 0 })
      expect(store.get('a')!.x).toBe(30)
    })
  })
})
