import { describe, expect, it } from 'vitest'
import { duplicateElements, type DuplicateOptions } from '@/types/duplicate'
import { ElementKind, type CanvasElement, type ElementStore } from '@/types/element'

function el(id: string, patch: Partial<CanvasElement> = {}): CanvasElement {
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

function group(id: string, childIds: string[], patch: Partial<CanvasElement> = {}): CanvasElement {
  return el(id, { kind: ElementKind.Group, childIds, ...patch })
}

function storeOf(elements: CanvasElement[], rootIds?: string[]): ElementStore {
  return {
    byId: Object.fromEntries(elements.map((e) => [e.id, e])),
    rootIds: rootIds ?? elements.filter((e) => e.parentId === undefined).map((e) => e.id),
  }
}

/** 遞迴凍結，確認 duplicateElements 不會修改傳進來的文件。 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** 固定的 id 序列：n1、n2、n3……，讓斷言可以寫死新 id。 */
function sequentialIds(): () => string {
  let n = 0
  return () => `n${++n}`
}

function options(patch: Partial<DuplicateOptions> = {}): DuplicateOptions {
  return {
    offset: { x: 10, y: 10 },
    rename: (name) => `${name} copy`,
    newId: sequentialIds(),
    ...patch,
  }
}

function byId(elements: CanvasElement[]): Record<string, CanvasElement> {
  return Object.fromEntries(elements.map((e) => [e.id, e]))
}

/** 結果裡出現過的所有 id（自身、parentId、childIds）。 */
function referencedIds(elements: CanvasElement[]): Set<string> {
  const ids = new Set<string>()
  for (const e of elements) {
    ids.add(e.id)
    if (e.parentId !== undefined) ids.add(e.parentId)
    for (const childId of e.childIds) ids.add(childId)
  }
  return ids
}

/**
 * 三層巢狀的文件，座標都不是 0，絕對座標換算錯了才看得出來：
 *
 * rootIds = [m, outer, z]
 * - outer (400, 300) > inner (20, 10) > p (1, 2)、q (30, 40)；outer > r (80, 0)
 * - m (5, 5)、z (600, 600)：根層級的一般元素
 */
function nestedStore(): ElementStore {
  return storeOf(
    [
      el('m', { x: 5, y: 5 }),
      group('outer', ['inner', 'r'], { x: 400, y: 300, width: 200, height: 100 }),
      group('inner', ['p', 'q'], { x: 20, y: 10, parentId: 'outer', width: 50, height: 50 }),
      el('p', { x: 1, y: 2, parentId: 'inner' }),
      el('q', { x: 30, y: 40, parentId: 'inner' }),
      el('r', { x: 80, y: 0, parentId: 'outer' }),
      el('z', { x: 600, y: 600 }),
    ],
    ['m', 'outer', 'z'],
  )
}

describe('duplicateElements', () => {
  describe('單一元素', () => {
    it('換新 id、放在根層級、位移並重新命名，其餘欄位與原件相同', () => {
      const source = el('a', {
        x: 3,
        y: 4,
        rotation: 30,
        opacity: 0.5,
        cornerRadius: 6,
        fill: { type: 'solid', color: '#ff0000', opacity: 0.4 },
      })

      const result = duplicateElements(storeOf([source]), ['a'], options())

      expect(result.rootIds).toEqual(['n1'])
      expect(result.elements).toEqual([
        { ...source, id: 'n1', name: 'a copy', x: 13, y: 14, parentId: undefined },
      ])
    })

    it('深拷貝：複本不與原件共用任何物件或陣列', () => {
      const source = el('v', {
        kind: ElementKind.Vector,
        points: [0, 0, 10, 10],
        vectorPoints: [{ x: 0, y: 0, handleIn: { x: -1, y: 0 }, handleOut: { x: 1, y: 0 } }],
        closed: true,
      })

      const [copy] = duplicateElements(storeOf([source]), ['v'], options()).elements

      expect(copy.fill).toEqual(source.fill)
      expect(copy.fill).not.toBe(source.fill)
      expect(copy.stroke).not.toBe(source.stroke)
      expect(copy.childIds).not.toBe(source.childIds)
      expect(copy.points).toEqual(source.points)
      expect(copy.points).not.toBe(source.points)
      expect(copy.vectorPoints).toEqual(source.vectorPoints)
      expect(copy.vectorPoints).not.toBe(source.vectorPoints)
      expect(copy.vectorPoints![0]).not.toBe(source.vectorPoints![0])
      expect(copy.vectorPoints![0].handleIn).not.toBe(source.vectorPoints![0].handleIn)
      expect(copy.vectorPoints![0].handleOut).not.toBe(source.vectorPoints![0].handleOut)
    })

    it('Text 的文字欄位一併複製', () => {
      const source = el('t', {
        kind: ElementKind.Text,
        text: 'Hello',
        fontSize: 20,
        fontFamily: 'Inter',
        fontWeight: 700,
        lineHeight: 1.2,
        letterSpacing: 1,
        textAlign: 'center',
      })

      const [copy] = duplicateElements(storeOf([source]), ['t'], options()).elements

      expect(copy).toEqual({ ...source, id: 'n1', name: 't copy', x: 10, y: 10 })
    })

    it('沒有指定 newId 時用 UUID，與原件的 id 不同', () => {
      const result = duplicateElements(storeOf([el('a')]), ['a'], {
        offset: { x: 0, y: 0 },
        rename: (name) => name,
      })

      expect(result.elements).toHaveLength(1)
      expect(result.elements[0].id).toMatch(/^[0-9a-f-]{36}$/)
      expect(result.rootIds).toEqual([result.elements[0].id])
    })

    it('不修改傳進來的文件', () => {
      const store = deepFreeze(nestedStore())
      const before = JSON.stringify(store)

      duplicateElements(store, ['outer', 'm', 'q'], options())

      expect(JSON.stringify(store)).toBe(before)
    })
  })

  describe('群組：遞迴複製整棵子樹', () => {
    it('三層巢狀：全部換新 id，重建 parentId / childIds，結構與原件相同', () => {
      const result = duplicateElements(nestedStore(), ['outer'], options())
      const copies = byId(result.elements)

      // 前序：outer → inner → p → q → r
      expect(result.elements.map((e) => e.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
      expect(result.rootIds).toEqual(['n1'])
      expect(copies.n1).toMatchObject({ parentId: undefined, childIds: ['n2', 'n5'] })
      expect(copies.n2).toMatchObject({ parentId: 'n1', childIds: ['n3', 'n4'] })
      expect(copies.n3).toMatchObject({ parentId: 'n2', childIds: [] })
      expect(copies.n4).toMatchObject({ parentId: 'n2', childIds: [] })
      expect(copies.n5).toMatchObject({ parentId: 'n1', childIds: [] })
    })

    it('複本完全不參照任何原件的 id（孫元素也不共用）', () => {
      const original = nestedStore()
      const result = duplicateElements(original, ['outer'], options())

      const shared = [...referencedIds(result.elements)].filter((id) => id in original.byId)
      expect(shared).toEqual([])
    })

    it('只有頂層位移與改名；子孫的座標維持相對父元素，名稱不變', () => {
      const copies = byId(duplicateElements(nestedStore(), ['outer'], options()).elements)

      expect(copies.n1).toMatchObject({ name: 'outer copy', x: 410, y: 310 })
      expect(copies.n2).toMatchObject({ name: 'inner', x: 20, y: 10 })
      expect(copies.n3).toMatchObject({ name: 'p', x: 1, y: 2 })
      expect(copies.n4).toMatchObject({ name: 'q', x: 30, y: 40 })
      expect(copies.n5).toMatchObject({ name: 'r', x: 80, y: 0 })
    })

    it('子孫的其他欄位與原件相同', () => {
      const original = nestedStore()
      const copies = byId(duplicateElements(original, ['outer'], options()).elements)

      expect(copies.n2).toEqual({
        ...original.byId.inner,
        id: 'n2',
        parentId: 'n1',
        childIds: ['n3', 'n4'],
      })
      expect(copies.n4).toEqual({ ...original.byId.q, id: 'n4', parentId: 'n2' })
    })

    it('空群組：只複製群組本身', () => {
      const result = duplicateElements(storeOf([group('g', [])]), ['g'], options())

      expect(result.elements).toEqual([
        { ...group('g', []), id: 'n1', name: 'g copy', x: 10, y: 10 },
      ])
    })
  })

  describe('群組內的子元素被單獨選取', () => {
    it('複本放到根層級，座標換成絕對座標再位移', () => {
      const result = duplicateElements(nestedStore(), ['r'], options())

      expect(result.rootIds).toEqual(['n1'])
      expect(result.elements).toEqual([
        { ...nestedStore().byId.r, id: 'n1', name: 'r copy', parentId: undefined, x: 490, y: 310 },
      ])
    })

    it('孫元素：累加每一層祖先的座標', () => {
      const [copy] = duplicateElements(nestedStore(), ['q'], options()).elements

      // q (30, 40) + inner (20, 10) + outer (400, 300) + offset (10, 10)
      expect(copy).toMatchObject({ parentId: undefined, x: 460, y: 360, name: 'q copy' })
    })

    it('內層群組：複本與它的子樹一起到根層級，子樹座標仍相對於新的群組', () => {
      const copies = byId(duplicateElements(nestedStore(), ['inner'], options()).elements)

      expect(copies.n1).toMatchObject({
        parentId: undefined,
        x: 430,
        y: 320,
        childIds: ['n2', 'n3'],
      })
      expect(copies.n2).toMatchObject({ parentId: 'n1', x: 1, y: 2 })
      expect(copies.n3).toMatchObject({ parentId: 'n1', x: 30, y: 40 })
    })

    it('群組有旋轉時也只累加位置（畫布不把群組的 rotation 套用到子元素）', () => {
      const store = storeOf([
        group('g', ['a'], { x: 100, y: 200, rotation: 45 }),
        el('a', { x: 5, y: 6, rotation: 10, parentId: 'g' }),
      ])

      const [copy] = duplicateElements(store, ['a'], options()).elements

      expect(copy).toMatchObject({ x: 115, y: 216, rotation: 10 })
    })
  })

  describe('選取正規化', () => {
    it.each([
      ['祖先在前', ['outer', 'inner', 'q']],
      ['子孫在前', ['q', 'inner', 'outer']],
      ['只有祖先與孫元素', ['p', 'outer']],
    ])('祖先與子孫同時選取（%s）：只複製祖先一次', (_label, ids) => {
      const result = duplicateElements(nestedStore(), ids, options())

      expect(result.rootIds).toEqual(['n1'])
      expect(result.elements).toHaveLength(5)
      expect(result.elements[0]).toMatchObject({ name: 'outer copy', x: 410, y: 310 })
    })

    it('重複的 id 只處理一次', () => {
      const result = duplicateElements(nestedStore(), ['m', 'm', 'm'], options())

      expect(result.rootIds).toEqual(['n1'])
      expect(result.elements).toHaveLength(1)
    })

    it('不存在的 id 略過，其餘照常複製', () => {
      const result = duplicateElements(nestedStore(), ['ghost', 'z'], options())

      expect(result.elements.map((e) => e.name)).toEqual(['z copy'])
    })

    it('不在文件樹上的孤兒略過', () => {
      const store = storeOf([el('a'), el('orphan', { parentId: 'gone' })], ['a'])

      expect(duplicateElements(store, ['orphan'], options())).toEqual({ elements: [], rootIds: [] })
    })

    it('沒有任何可複製的元素：回傳空結果，也不消耗 id', () => {
      const newId = sequentialIds()

      const result = duplicateElements(nestedStore(), [], options({ newId }))

      expect(result).toEqual({ elements: [], rootIds: [] })
      expect(newId()).toBe('n1')
    })
  })

  describe('圖層順序', () => {
    it('頂層複本依原件的圖層順序（由下到上），與選取的先後無關', () => {
      const result = duplicateElements(nestedStore(), ['z', 'outer', 'm'], options())

      expect(result.rootIds.map((id) => byId(result.elements)[id].name)).toEqual([
        'm copy',
        'outer copy',
        'z copy',
      ])
      // elements 裡頂層複本的先後與 rootIds 相同，addAll 才會照這個順序放進 rootIds。
      expect(result.elements.filter((e) => e.parentId === undefined).map((e) => e.id)).toEqual(
        result.rootIds,
      )
    })

    it('不同層級混合：依繪製順序（父元素先於子元素，同層由下到上）', () => {
      const result = duplicateElements(nestedStore(), ['z', 'r', 'p', 'm'], options())

      expect(result.rootIds.map((id) => byId(result.elements)[id].name)).toEqual([
        'm copy',
        'p copy',
        'r copy',
        'z copy',
      ])
    })

    it('子樹內的 childIds 保留原本的順序', () => {
      const store = storeOf([
        group('g', ['c', 'a', 'b']),
        el('a', { parentId: 'g' }),
        el('b', { parentId: 'g' }),
        el('c', { parentId: 'g' }),
      ])

      const result = duplicateElements(store, ['g'], options())
      const copies = byId(result.elements)

      expect(copies.n1.childIds.map((id) => copies[id].name)).toEqual(['c', 'a', 'b'])
    })
  })

  describe('不一致的文件（防禦）', () => {
    it('childIds 指到不存在的元素：丟掉，不帶進複本', () => {
      const store = storeOf([group('g', ['a', 'missing']), el('a', { parentId: 'g' })])

      const result = duplicateElements(store, ['g'], options())

      expect(result.elements).toHaveLength(2)
      expect(result.elements[0].childIds).toEqual(['n2'])
    })

    it('同一個子元素掛在兩個群組底下：只複製一次，複本裡不會有兩個父元素', () => {
      const store = storeOf([
        group('g1', ['shared']),
        group('g2', ['shared']),
        el('shared', { parentId: 'g1' }),
      ])

      const result = duplicateElements(store, ['g1', 'g2'], options())
      const copies = byId(result.elements)

      expect(result.elements).toHaveLength(3)
      expect(copies.n1.childIds).toEqual(['n2'])
      expect(copies.n3.childIds).toEqual([])
    })

    it('元素同時在 rootIds 與某個群組的 childIds 裡：兩者都被選取時只複製一次', () => {
      const store = storeOf([group('g', ['a']), el('a')], ['g', 'a'])

      const result = duplicateElements(store, ['g', 'a'], options())

      expect(result.elements).toHaveLength(2)
      expect(result.rootIds).toEqual(['n1'])
    })

    it('同一個 childIds 裡重複的 id 只複製一次', () => {
      const store = storeOf([group('g', ['a', 'a']), el('a', { parentId: 'g' })])

      const result = duplicateElements(store, ['g'], options())

      expect(result.elements).toHaveLength(2)
      expect(result.elements[0].childIds).toEqual(['n2'])
    })

    it('childIds 形成循環：不會無限遞迴', () => {
      const store = storeOf([group('g', ['h']), group('h', ['g'], { parentId: 'g' })])

      const result = duplicateElements(store, ['g'], options())

      expect(result.elements.map((e) => e.id)).toEqual(['n1', 'n2'])
      expect(result.elements[1].childIds).toEqual([])
    })

    it('parentId 形成循環：計算祖先時不會無限迴圈', () => {
      const store = storeOf(
        [
          group('g', ['h']),
          group('h', ['a'], { parentId: 'k' }),
          group('k', ['h'], { parentId: 'h' }),
          el('a', { x: 1, y: 1, parentId: 'h' }),
        ],
        ['g'],
      )

      const result = duplicateElements(store, ['a'], options())

      expect(result.rootIds).toEqual(['n1'])
      expect(result.elements).toHaveLength(1)
    })
  })
})
