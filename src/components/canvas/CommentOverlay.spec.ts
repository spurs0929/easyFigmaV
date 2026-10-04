import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ApiError } from '@/services/api'
import type { CommentDto } from '@/services/comments'

vi.mock('@/services/comments', () => ({
  listComments: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}))

const { listComments, updateComment } = await import('@/services/comments')
const { useCommentStore } = await import('@/store/comment')
const { default: CommentOverlay } = await import('./CommentOverlay.vue')
const mockList = vi.mocked(listComments)
const mockUpdate = vi.mocked(updateComment)

const PROJECT_ID = '11111111-1111-1111-1111-111111111111'
const CANVAS_RECT = { left: 268, top: 0, width: 900, height: 800 }
const VIEWPORT = { x: 100, y: 50, scale: 2 }

function dto(id: string, overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id,
    world_x: 10,
    world_y: 20,
    content: `留言 ${id}`,
    resolved: false,
    created_at: '2026-10-02T03:00:00Z',
    updated_at: '2026-10-02T03:00:00Z',
    author: { user_id: 'u-alice', display_name: 'Alice', email: 'alice@example.com' },
    can_edit: true,
    can_delete: true,
    ...overrides,
  }
}

let pinia: Pinia
const wrappers: VueWrapper[] = []
const strays: HTMLElement[] = []

async function enterCloud(rows: CommentDto[] = []) {
  const store = useCommentStore()
  mockList.mockResolvedValueOnce(rows)
  store.setSource('cloud')
  await store.load(PROJECT_ID)
  return store
}

function mountOverlay(): VueWrapper {
  const wrapper = mount(CommentOverlay, {
    props: { viewport: VIEWPORT, canvasRect: CANVAS_RECT },
    global: { plugins: [pinia] },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  return wrapper
}

// 覆疊層 Teleport 到 body，內容不在 wrapper 底下，直接從 document 找。
const pins = () => [...document.querySelectorAll<HTMLElement>('[data-testid=comment-pin]')]
const popovers = () => [...document.querySelectorAll<HTMLElement>('[data-testid=comment-popover]')]
const draftPin = () => document.querySelector<HTMLElement>('[data-testid=comment-draft-pin]')
const notice = () => document.querySelector<HTMLElement>('[data-testid=comment-notice]')

/** 在畫面上放一個不屬於留言 UI 的元素，模擬工具列、面板或畫布。 */
function addElement(className: string): HTMLElement {
  const el = document.createElement('div')
  el.className = className
  document.body.append(el)
  strays.push(el)
  return el
}

function mousedownOn(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
}

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  vi.resetAllMocks()
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
  while (strays.length) strays.pop()?.remove()
})

describe('CommentOverlay：圖釘', () => {
  it('每則留言一個圖釘，位置由世界座標與 viewport 換算', async () => {
    await enterCloud([
      dto('c1', { world_x: 10, world_y: 20 }),
      dto('c2', { world_x: -5, world_y: 0 }),
    ])

    mountOverlay()
    await nextTick()

    // 螢幕座標 = 世界座標 × scale + viewport 位移
    expect(pins().map((p) => [p.style.left, p.style.top])).toEqual([
      ['120px', '90px'],
      ['90px', '50px'],
    ])
  })

  it('viewport 改變時圖釘跟著移動', async () => {
    await enterCloud([dto('c1', { world_x: 10, world_y: 20 })])
    const wrapper = mountOverlay()

    await wrapper.setProps({ viewport: { x: 0, y: 0, scale: 1 } })

    expect([pins()[0]!.style.left, pins()[0]!.style.top]).toEqual(['10px', '20px'])
  })

  it('覆疊層對齊畫布在視窗中的位置', async () => {
    await enterCloud()
    mountOverlay()
    await nextTick()

    const overlay = document.querySelector<HTMLElement>('.comment-overlay')!
    expect([
      overlay.style.left,
      overlay.style.top,
      overlay.style.width,
      overlay.style.height,
    ]).toEqual(['268px', '0px', '900px', '800px'])
  })

  it('已解決的圖釘有自己的樣式，aria-label 帶作者與內容', async () => {
    await enterCloud([dto('c1', { resolved: true, content: '標題太小' })])
    mountOverlay()
    await nextTick()

    expect(pins()[0]!.classList.contains('comment-pin--resolved')).toBe(true)
    expect(pins()[0]!.getAttribute('aria-label')).toBe('Alice（已解決）：標題太小')
  })

  it('沒有留言時不顯示任何圖釘或留言框', async () => {
    await enterCloud()
    mountOverlay()
    await nextTick()

    expect(pins()).toEqual([])
    expect(popovers()).toEqual([])
    expect(draftPin()).toBeNull()
  })
})

describe('CommentOverlay：同時只有一個留言框', () => {
  it('點圖釘開啟那一則，圖釘標記為 active', async () => {
    const store = await enterCloud([dto('c1'), dto('c2')])
    mountOverlay()
    await nextTick()

    pins()[1]!.click()
    await nextTick()

    expect(store.activeId).toBe('c2')
    expect(popovers()).toHaveLength(1)
    expect(popovers()[0]!.textContent).toContain('留言 c2')
    expect(pins().map((p) => p.getAttribute('aria-expanded'))).toEqual(['false', 'true'])
  })

  it('點另一個圖釘：前一個留言框關閉，換成新的', async () => {
    await enterCloud([dto('c1'), dto('c2')])
    mountOverlay()
    await nextTick()

    pins()[0]!.click()
    await nextTick()
    pins()[1]!.click()
    await nextTick()

    expect(popovers()).toHaveLength(1)
    expect(popovers()[0]!.textContent).toContain('留言 c2')
    expect(popovers()[0]!.textContent).not.toContain('留言 c1')
  })

  it('換一則留言時不會把前一則的編輯狀態帶過去', async () => {
    const store = await enterCloud([dto('c1'), dto('c2')])
    mountOverlay()
    await nextTick()

    pins()[0]!.click()
    await nextTick()
    document.querySelector<HTMLElement>('[data-testid=comment-edit]')!.click()
    await nextTick()
    expect(document.querySelector('[data-testid=comment-input]')).not.toBeNull()

    // 內容沒改過，所以可以切換
    pins()[1]!.click()
    await nextTick()

    expect(store.activeId).toBe('c2')
    // 新的那一則從檢視狀態開始
    expect(document.querySelector('[data-testid=comment-input]')).toBeNull()
  })

  it('正在編輯而且改過內容時，點另一個圖釘不會切換', async () => {
    const store = await enterCloud([dto('c1'), dto('c2')])
    mountOverlay()
    await nextTick()
    pins()[0]!.click()
    await nextTick()
    document.querySelector<HTMLElement>('[data-testid=comment-edit]')!.click()
    await nextTick()
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid=comment-input]')!
    input.value = '改到一半'
    input.dispatchEvent(new Event('input'))
    await nextTick()

    pins()[1]!.click()
    await nextTick()

    expect(store.activeId).toBe('c1')
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid=comment-input]')!.value).toBe(
      '改到一半',
    )
    expect(document.querySelector('[role=status]')?.textContent).toContain('內容還沒送出')
  })

  it('有草稿時顯示草稿圖釘與新增用的留言框，而且不是正式的圖釘', async () => {
    const store = await enterCloud([dto('c1')])
    mountOverlay()

    store.startDraft(30, 40)
    await nextTick()

    expect(pins()).toHaveLength(1)
    expect([draftPin()!.style.left, draftPin()!.style.top]).toEqual(['160px', '130px'])
    expect(popovers()).toHaveLength(1)
    expect(popovers()[0]!.getAttribute('aria-label')).toBe('新增留言')
  })

  it('留言框的位置用的是視窗座標（加上畫布在視窗中的位移）', async () => {
    const store = await enterCloud()
    mountOverlay()

    store.startDraft(30, 40)
    await nextTick()

    // 圖釘尖端在視窗中的 x = 268 + 160 = 428，留言框在它右邊
    expect(parseFloat(popovers()[0]!.style.left)).toBeGreaterThan(428)
  })

  it('取消草稿後草稿圖釘與留言框一起消失', async () => {
    const store = await enterCloud()
    mountOverlay()
    store.startDraft(30, 40)
    await nextTick()

    document.querySelector<HTMLElement>('[data-testid=comment-cancel]')!.click()
    await nextTick()

    expect(draftPin()).toBeNull()
    expect(popovers()).toEqual([])
    expect(pins()).toEqual([])
  })
})

describe('CommentOverlay：點到留言框外面', () => {
  it('點工具列或面板：關閉留言框', async () => {
    const store = await enterCloud([dto('c1')])
    mountOverlay()
    store.open('c1')
    await nextTick()

    mousedownOn(addElement('toolbar'))
    await nextTick()

    expect(store.activeId).toBeNull()
    expect(popovers()).toEqual([])
  })

  it('點留言框裡面：不關閉', async () => {
    const store = await enterCloud([dto('c1')])
    mountOverlay()
    store.open('c1')
    await nextTick()

    mousedownOn(document.querySelector('[data-testid=comment-body]')!)

    expect(store.activeId).toBe('c1')
  })

  it('點畫布：這裡不處理，交給 CanvasArea 決定', async () => {
    // 畫布上的那一下要不要放新的留言，必須跟關閉一起判斷。這個 listener 若也處理，
    // 剛由畫布點擊建立的草稿會在同一次 mousedown 冒泡到 document 時被自己關掉。
    const store = await enterCloud()
    mountOverlay()
    const canvas = addElement('canvas-container')
    const stage = document.createElement('div')
    canvas.append(stage)

    store.startDraft(30, 40)
    await nextTick()
    mousedownOn(stage)

    expect(store.draft).toEqual({ worldX: 30, worldY: 40 })
  })

  it('有未送出的文字時，點外面不關閉也不丟掉文字', async () => {
    const store = await enterCloud()
    mountOverlay()
    store.startDraft(30, 40)
    await nextTick()
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid=comment-input]')!
    input.value = '打到一半'
    input.dispatchEvent(new Event('input'))
    await nextTick()

    mousedownOn(addElement('toolbar'))
    await nextTick()

    expect(store.draft).not.toBeNull()
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid=comment-input]')!.value).toBe(
      '打到一半',
    )
    expect(document.querySelector('[role=status]')?.textContent).toContain('內容還沒送出')
  })

  it('沒有留言框開著時，點任何地方都不做事', async () => {
    const store = await enterCloud([dto('c1')])
    mountOverlay()
    const nudgeBefore = store.nudge

    mousedownOn(addElement('toolbar'))

    expect(store.nudge).toBe(nudgeBefore)
    expect(store.activeId).toBeNull()
  })

  it('卸載後不再監聽 document', async () => {
    const store = await enterCloud([dto('c1')])
    const wrapper = mountOverlay()
    wrapper.unmount()
    wrappers.length = 0
    store.open('c1')

    mousedownOn(addElement('toolbar'))

    expect(store.activeId).toBe('c1')
  })
})

describe('CommentOverlay：錯誤提示', () => {
  it('留言載入失敗：顯示訊息與重試，重試成功後消失', async () => {
    const store = useCommentStore()
    store.setSource('cloud')
    mockList.mockRejectedValueOnce(new ApiError(503, '伺服器忙碌'))
    await store.load(PROJECT_ID)
    mountOverlay()
    await nextTick()

    expect(notice()!.textContent).toContain('伺服器暫時無法回應')

    mockList.mockResolvedValueOnce([dto('c1')])
    notice()!.querySelector('button')!.click()
    await flushPromises()

    expect(mockList).toHaveBeenLastCalledWith(PROJECT_ID)
    expect(notice()).toBeNull()
    expect(pins()).toHaveLength(1)
  })

  it('留言被別人刪掉：留言框關閉後，原因顯示在畫布上方，可以關掉', async () => {
    const store = await enterCloud([dto('c1')])
    mountOverlay()
    store.open('c1')
    await nextTick()
    mockUpdate.mockRejectedValue(new ApiError(404, '找不到留言'))
    mockList.mockResolvedValueOnce([])

    document.querySelector<HTMLElement>('[data-testid=comment-resolve]')!.click()
    await flushPromises()

    expect(popovers()).toEqual([])
    expect(pins()).toEqual([])
    expect(notice()!.textContent).toContain('這則留言已經被刪除')

    notice()!.querySelector('button')!.click()
    await nextTick()
    expect(notice()).toBeNull()
  })

  it('留言框開著時，錯誤顯示在留言框裡，不重複顯示在畫布上方', async () => {
    const store = await enterCloud([dto('c1')])
    mountOverlay()
    store.open('c1')
    await nextTick()
    mockUpdate.mockRejectedValue(new ApiError(403, '只有留言的作者能修改內容'))

    document.querySelector<HTMLElement>('[data-testid=comment-resolve]')!.click()
    await flushPromises()

    expect(document.querySelector('[data-testid=comment-error]')!.textContent).toContain(
      '只有留言的作者能修改內容',
    )
    expect(notice()).toBeNull()
  })
})
