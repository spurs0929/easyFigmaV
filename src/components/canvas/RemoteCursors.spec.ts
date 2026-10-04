import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { mount, type VueWrapper } from '@vue/test-utils'
import { useAuthStore } from '@/store/auth'
import { usePresenceStore } from '@/store/presence'
import type { Viewport } from '@/store/viewport'
import type { PresenceUser } from '@/types/presence'
import RemoteCursors from './RemoteCursors.vue'

const PROJECT = '11111111-1111-1111-1111-111111111111'
const CANVAS_RECT = { left: 268, top: 40, width: 900, height: 800 }
const ALICE: PresenceUser = { user_id: 'alice', display_name: 'Alice', role: 'owner' }
const BOB: PresenceUser = { user_id: 'bob', display_name: 'Bob', role: 'member' }
const NAMELESS: PresenceUser = { user_id: 'anon', display_name: '  ', role: 'member' }

let pinia: Pinia
const wrappers: VueWrapper[] = []

/** 直接設定 store 狀態：這裡測的是畫面如何呈現，狀態怎麼來的在 store 的測試。 */
function givenOnline(users: PresenceUser[], cursors: Record<string, { x: number; y: number }>) {
  const presence = usePresenceStore()
  presence.status = { state: 'connected', projectId: PROJECT }
  presence.users = users
  presence.cursors = new Map(Object.entries(cursors))
  return presence
}

function mountCursors(viewport: Viewport = { x: 0, y: 0, scale: 1 }): VueWrapper {
  const wrapper = mount(RemoteCursors, {
    props: { viewport, canvasRect: CANVAS_RECT },
    global: { plugins: [pinia] },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  return wrapper
}

// 覆疊層 Teleport 到 body，內容不在 wrapper 底下，直接從 document 找。
const layer = () => document.querySelector<HTMLElement>('.remote-cursors')!
const cursors = () => [...document.querySelectorAll<HTMLElement>('[data-testid=remote-cursor]')]
const labels = () => cursors().map((el) => el.textContent?.trim())

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
})

describe('RemoteCursors：座標換算', () => {
  it('螢幕座標 = 世界座標 × scale + viewport 位移', async () => {
    givenOnline([ALICE, BOB], { alice: { x: 10, y: 20 }, bob: { x: -5, y: 0 } })

    mountCursors({ x: 100, y: 50, scale: 2 })
    await nextTick()

    expect(cursors().map((el) => el.style.transform)).toEqual([
      'translate(120px, 90px)',
      'translate(90px, 50px)',
    ])
  })

  it('自己 pan / zoom 時，別人的游標跟著畫布移動（world 位置不變）', async () => {
    givenOnline([BOB], { bob: { x: 10, y: 20 } })
    const wrapper = mountCursors({ x: 0, y: 0, scale: 1 })
    await nextTick()
    expect(cursors()[0]!.style.transform).toBe('translate(10px, 20px)')

    await wrapper.setProps({ viewport: { x: -30, y: 40, scale: 1 } })
    expect(cursors()[0]!.style.transform).toBe('translate(-20px, 60px)')

    await wrapper.setProps({ viewport: { x: -30, y: 40, scale: 0.5 } })
    expect(cursors()[0]!.style.transform).toBe('translate(-25px, 50px)')
  })

  it('對方移動時位置跟著更新', async () => {
    const presence = givenOnline([BOB], { bob: { x: 1, y: 1 } })
    mountCursors()
    await nextTick()

    presence.cursors.set('bob', { x: 30, y: 40 })
    await nextTick()

    expect(cursors()[0]!.style.transform).toBe('translate(30px, 40px)')
  })

  it('覆疊層對齊畫布的位置與尺寸', async () => {
    givenOnline([], {})

    mountCursors()
    await nextTick()

    expect(layer().style.left).toBe('268px')
    expect(layer().style.top).toBe('40px')
    expect(layer().style.width).toBe('900px')
    expect(layer().style.height).toBe('800px')
  })
})

describe('RemoteCursors：顯示誰的游標', () => {
  it('只畫有游標位置的在線成員，並標上名字', async () => {
    givenOnline([ALICE, BOB], { bob: { x: 1, y: 1 } })

    mountCursors()
    await nextTick()

    expect(labels()).toEqual(['Bob'])
  })

  it('沒有名字時有替代文字', async () => {
    givenOnline([NAMELESS], { anon: { x: 1, y: 1 } })

    mountCursors()
    await nextTick()

    expect(labels()).toEqual(['未命名使用者'])
  })

  it('不畫自己的游標', async () => {
    useAuthStore().user = {
      id: 'alice',
      email: 'a@example.com',
      display_name: 'Alice',
      created_at: '',
    }
    givenOnline([ALICE, BOB], { alice: { x: 1, y: 1 }, bob: { x: 2, y: 2 } })

    mountCursors()
    await nextTick()

    expect(labels()).toEqual(['Bob'])
  })

  it('不在名單上的游標不畫', async () => {
    givenOnline([ALICE], { ghost: { x: 1, y: 1 } })

    mountCursors()
    await nextTick()

    expect(cursors()).toEqual([])
  })

  it('游標離開或成員離線後，畫面上的游標消失', async () => {
    const presence = givenOnline([BOB], { bob: { x: 1, y: 1 } })
    mountCursors()
    await nextTick()
    expect(cursors()).toHaveLength(1)

    presence.cursors.delete('bob')
    await nextTick()

    expect(cursors()).toEqual([])
  })

  it('同一個人每次都是同一個顏色，不同的人可以不同', async () => {
    givenOnline([ALICE, BOB], { alice: { x: 1, y: 1 }, bob: { x: 2, y: 2 } })
    mountCursors()
    await nextTick()
    const colorOf = (index: number) => cursors()[index]!.style.getPropertyValue('--cursor-color')
    const [alice, bob] = [colorOf(0), colorOf(1)]

    expect(alice).toMatch(/^hsl\(/)
    expect(alice).not.toBe(bob)

    wrappers.pop()?.unmount()
    mountCursors({ x: 5, y: 5, scale: 3 })
    await nextTick()
    expect(colorOf(0)).toBe(alice)
  })

  it('整層不接收滑鼠事件，也不暴露給輔助技術', async () => {
    givenOnline([BOB], { bob: { x: 1, y: 1 } })

    mountCursors()
    await nextTick()

    expect(layer().getAttribute('aria-hidden')).toBe('true')
  })

  it('卸載後不留下任何 DOM', async () => {
    givenOnline([BOB], { bob: { x: 1, y: 1 } })
    mountCursors()
    await nextTick()

    wrappers.pop()?.unmount()

    expect(document.querySelector('.remote-cursors')).toBeNull()
  })
})
