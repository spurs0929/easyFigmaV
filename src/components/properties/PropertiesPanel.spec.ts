import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useElementStore } from '@/store/element'
import { ELEMENT_HISTORY_MAX, ElementKind, type CanvasElement } from '@/types/element'
import PropertiesPanel from './PropertiesPanel.vue'

type Store = ReturnType<typeof useElementStore>

const GROUP_TRANSFORM_HINT = '群組目前不支援旋轉與縮放'

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

let pinia: Pinia
let wrapper: VueWrapper | null = null

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

/** 載入 a、b 兩個矩形與獨立的矩形 c，把 a、b 組成群組；c 帶 rotation 30。 */
async function mountPanel() {
  const store = useElementStore()
  store.loadSnapshot({
    byId: {
      a: rect('a'),
      b: rect('b', { x: 250, y: 250, width: 50, height: 50 }),
      c: rect('c', { x: 500, rotation: 30 }),
    },
    rootIds: ['a', 'b', 'c'],
  })
  const groupId = store.group(['a', 'b'])
  wrapper = mount(PropertiesPanel, { global: { plugins: [pinia] } })
  await nextTick()
  return { store, groupId }
}

async function selectOnly(store: Store, id: string) {
  store.select(id)
  await nextTick()
}

/** 依欄位標籤找到外層 label 與裡面的 input。 */
function field(label: string) {
  const found = wrapper!
    .findAll('.props-field')
    .find(
      (candidate) =>
        candidate.find('.props-label').exists() && candidate.find('.props-label').text() === label,
    )
  if (!found) throw new Error(`field not found: ${label}`)
  return { label: found, input: found.find('input') }
}

function fieldState(label: string) {
  const { label: wrapperLabel, input } = field(label)
  return {
    disabled: (input.element as HTMLInputElement).disabled,
    title: wrapperLabel.attributes('title') ?? null,
  }
}

async function changeField(label: string, value: string) {
  await nextTick()
  const { input } = field(label)
  ;(input.element as HTMLInputElement).value = value
  await input.trigger('change')
}

/**
 * 目前 history 位置往回能 undo 幾步（量完會 redo 回原位）。
 * Undo 會清除選取，量完後恢復原本的選取，面板才會繼續顯示同一個元素。
 */
function undoDepth(store: Store): number {
  const selected = [...store.selectedIds]
  let steps = 0
  for (let i = 0; i < ELEMENT_HISTORY_MAX; i++) {
    const revision = store.documentRevision
    store.undo()
    if (store.documentRevision === revision) break
    steps++
  }
  for (let i = 0; i < steps; i++) store.redo()
  for (const id of selected) store.select(id, true)
  return steps
}

const DISABLED = { disabled: true, title: GROUP_TRANSFORM_HINT }
const ENABLED = { disabled: false, title: null }

describe('PropertiesPanel：群組變形限制（Batch G）', () => {
  it('選取群組：Rotation / W / H 停用並顯示說明，X / Y 可編輯', async () => {
    const { store, groupId } = await mountPanel()
    await selectOnly(store, groupId)

    expect(['X', 'Y', 'Rotation', 'W', 'H'].map(fieldState)).toEqual([
      ENABLED,
      ENABLED,
      DISABLED,
      DISABLED,
      DISABLED,
    ])
  })

  it('選取一般矩形：五個欄位都可編輯，Rotation 顯示儲存的值', async () => {
    const { store } = await mountPanel()
    await selectOnly(store, 'c')

    expect(['X', 'Y', 'Rotation', 'W', 'H'].map(fieldState)).toEqual([
      ENABLED,
      ENABLED,
      ENABLED,
      ENABLED,
      ENABLED,
    ])
    expect((field('Rotation').input.element as HTMLInputElement).value).toBe('30')
  })

  it('群組與一般元素來回切換：欄位的停用狀態跟著改變', async () => {
    const { store, groupId } = await mountPanel()

    await selectOnly(store, groupId)
    expect(fieldState('Rotation')).toEqual(DISABLED)
    await selectOnly(store, 'c')
    expect(fieldState('Rotation')).toEqual(ENABLED)
    await selectOnly(store, groupId)
    expect(['Rotation', 'W', 'H'].map(fieldState)).toEqual([DISABLED, DISABLED, DISABLED])
  })

  it('已旋轉的群組：Rotation 顯示生效值 0，儲存的 rotation 與 documentRevision 不變', async () => {
    const { store, groupId } = await mountPanel()
    store.loadSnapshot({
      byId: { ...store.byId, [groupId]: { ...store.byId[groupId], rotation: 45 } },
      rootIds: store.rootElements.map((el) => el.id),
    })
    const revision = store.documentRevision
    await selectOnly(store, groupId)

    expect((field('Rotation').input.element as HTMLInputElement).value).toBe('0')
    expect(store.get(groupId)!.rotation).toBe(45)
    expect(store.documentRevision).toBe(revision)
  })

  it('對群組停用的欄位送出 change：資料與 History 都不變', async () => {
    const { store, groupId } = await mountPanel()
    await selectOnly(store, groupId)
    const before = JSON.stringify(store.snapshot())
    const depth = undoDepth(store)

    await changeField('Rotation', '30')
    await changeField('W', '20')
    await changeField('H', '20')

    expect(JSON.stringify(store.snapshot())).toBe(before)
    expect(undoDepth(store)).toBe(depth)
  })

  it('群組的 X 仍可編輯：整個群組移動，只記一筆 History', async () => {
    const { store, groupId } = await mountPanel()
    await selectOnly(store, groupId)
    const depth = undoDepth(store)

    await changeField('X', '40')

    expect(store.get(groupId)).toMatchObject({ x: 40, y: 100, width: 200, height: 200 })
    expect(undoDepth(store)).toBe(depth + 1)
  })

  it('一般矩形的 Rotation 仍可編輯，只記一筆 History', async () => {
    const { store } = await mountPanel()
    await selectOnly(store, 'c')
    const depth = undoDepth(store)

    await changeField('Rotation', '15')

    expect(store.get('c')!.rotation).toBe(15)
    expect(undoDepth(store)).toBe(depth + 1)
  })
})
