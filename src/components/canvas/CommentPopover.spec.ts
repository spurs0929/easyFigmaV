import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ApiError } from '@/services/api'
import type { CommentDto } from '@/services/comments'
import { ToolType } from '@/types/tool'

vi.mock('@/services/comments', () => ({
  listComments: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}))

const { listComments, createComment, updateComment, deleteComment } =
  await import('@/services/comments')
const { useCommentStore } = await import('@/store/comment')
const { useToolStore } = await import('@/store/tool')
const { default: CommentPopover } = await import('./CommentPopover.vue')
const mockList = vi.mocked(listComments)
const mockCreate = vi.mocked(createComment)
const mockUpdate = vi.mocked(updateComment)
const mockDelete = vi.mocked(deleteComment)

const PROJECT_ID = '11111111-1111-1111-1111-111111111111'
const ANCHOR = { x: 400, y: 300 }

function dto(id: string, overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id,
    world_x: 10,
    world_y: 20,
    content: '這裡的間距太擠了',
    resolved: false,
    created_at: '2026-10-02T03:00:00Z',
    updated_at: '2026-10-02T03:00:00Z',
    author: { user_id: 'u-alice', display_name: 'Alice', email: 'alice@example.com' },
    can_edit: true,
    can_delete: true,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

let pinia: Pinia
const wrappers: VueWrapper[] = []

async function enterCloud(rows: CommentDto[] = []) {
  const store = useCommentStore()
  mockList.mockResolvedValueOnce(rows)
  store.setSource('cloud')
  await store.load(PROJECT_ID)
  return store
}

/** 掛上留言框：有 activeComment 就顯示它，否則是新增。 */
function mountPopover(): VueWrapper {
  const store = useCommentStore()
  const wrapper = mount(CommentPopover, {
    props: { comment: store.activeComment, anchor: ANCHOR },
    global: { plugins: [pinia] },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  return wrapper
}

const input = (w: VueWrapper) => w.find<HTMLTextAreaElement>('[data-testid=comment-input]')
const submitBtn = (w: VueWrapper) => w.find<HTMLButtonElement>('[data-testid=comment-submit]')
const body = (w: VueWrapper) => w.find('[data-testid=comment-body]')
const closeBtn = (w: VueWrapper) => w.find<HTMLButtonElement>('[aria-label=關閉留言]')

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  vi.resetAllMocks()
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount()
})

describe('CommentPopover：新增', () => {
  it('一開啟就是輸入框，而且已經取得焦點', async () => {
    const store = await enterCloud()
    store.startDraft(10, 20)

    const wrapper = mountPopover()
    await nextTick()

    expect(input(wrapper).exists()).toBe(true)
    expect(document.activeElement).toBe(input(wrapper).element)
    // 新增時沒有作者列——這則留言還不存在
    expect(wrapper.find('[data-testid=comment-author]').exists()).toBe(false)
    expect(wrapper.attributes('aria-label')).toBe('新增留言')
  })

  it('沒有內容時不能送出；只有空白也不行', async () => {
    const store = await enterCloud()
    store.startDraft(10, 20)
    const wrapper = mountPopover()

    expect(submitBtn(wrapper).element.disabled).toBe(true)
    await input(wrapper).setValue('   \n ')
    expect(submitBtn(wrapper).element.disabled).toBe(true)
    await input(wrapper).setValue('標題太小')
    expect(submitBtn(wrapper).element.disabled).toBe(false)
  })

  it('按送出：建立留言，並把工具切回選取', async () => {
    const store = await enterCloud()
    const toolStore = useToolStore()
    toolStore.setTool(ToolType.Comment)
    mockCreate.mockResolvedValue(dto('new', { content: '標題太小' }))
    store.startDraft(10, 20)
    const wrapper = mountPopover()

    await input(wrapper).setValue('標題太小')
    await submitBtn(wrapper).trigger('click')
    await flushPromises()

    expect(mockCreate).toHaveBeenCalledWith(PROJECT_ID, {
      world_x: 10,
      world_y: 20,
      content: '標題太小',
    })
    expect(store.comments.map((c) => c.id)).toEqual(['new'])
    expect(store.draft).toBeNull()
    expect(toolStore.activeTool).toBe(ToolType.Move)
  })

  it.each([
    ['Ctrl+Enter', { ctrlKey: true }],
    ['Cmd+Enter', { metaKey: true }],
  ])('%s 也能送出', async (_label, modifier) => {
    const store = await enterCloud()
    mockCreate.mockResolvedValue(dto('new'))
    store.startDraft(10, 20)
    const wrapper = mountPopover()

    await input(wrapper).setValue('標題太小')
    await input(wrapper).trigger('keydown', { key: 'Enter', ...modifier })
    await flushPromises()

    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('單按 Enter 是換行，不送出', async () => {
    const store = await enterCloud()
    store.startDraft(10, 20)
    const wrapper = mountPopover()

    await input(wrapper).setValue('第一行')
    await input(wrapper).trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('送出失敗：留言框還在、文字還在、顯示錯誤，工具不切換', async () => {
    const store = await enterCloud()
    const toolStore = useToolStore()
    toolStore.setTool(ToolType.Comment)
    mockCreate.mockRejectedValue(new ApiError(503, '伺服器忙碌'))
    store.startDraft(10, 20)
    const wrapper = mountPopover()

    await input(wrapper).setValue('打了很久的一段話')
    await submitBtn(wrapper).trigger('click')
    await flushPromises()

    expect(store.draft).not.toBeNull()
    expect(input(wrapper).element.value).toBe('打了很久的一段話')
    expect(wrapper.find('[data-testid=comment-error]').text()).toBe(
      '伺服器暫時無法回應，請稍後再試',
    )
    expect(store.comments).toEqual([])
    expect(toolStore.activeTool).toBe(ToolType.Comment)
    // 可以直接再送一次
    expect(submitBtn(wrapper).element.disabled).toBe(false)
  })

  it('請求途中送出與取消都停用，避免重複送出', async () => {
    const store = await enterCloud()
    const slow = deferred<CommentDto>()
    mockCreate.mockReturnValue(slow.promise)
    store.startDraft(10, 20)
    const wrapper = mountPopover()

    await input(wrapper).setValue('標題太小')
    await submitBtn(wrapper).trigger('click')
    await nextTick()

    expect(submitBtn(wrapper).element.disabled).toBe(true)
    expect(wrapper.find<HTMLButtonElement>('[data-testid=comment-cancel]').element.disabled).toBe(
      true,
    )
    await input(wrapper).trigger('keydown', { key: 'Escape' })
    expect(store.draft).not.toBeNull()

    slow.resolve(dto('new'))
    await flushPromises()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('按取消：草稿消失，不送任何請求', async () => {
    const store = await enterCloud()
    store.startDraft(10, 20)
    const wrapper = mountPopover()

    await input(wrapper).setValue('不想留了')
    await wrapper.find('[data-testid=comment-cancel]').trigger('click')

    expect(store.draft).toBeNull()
    expect(store.comments).toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('Esc 等同取消，即使已經打了字', async () => {
    const store = await enterCloud()
    store.startDraft(10, 20)
    const wrapper = mountPopover()

    await input(wrapper).setValue('不想留了')
    await input(wrapper).trigger('keydown', { key: 'Escape' })

    expect(store.draft).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('打了字就告訴 store 有未送出的內容；清空後解除', async () => {
    const store = await enterCloud()
    store.startDraft(10, 20)
    const wrapper = mountPopover()
    expect(store.dirty).toBe(false)

    await input(wrapper).setValue('打到一半')
    expect(store.dirty).toBe(true)
    // 只有空白不算：點畫布可以直接關掉
    await input(wrapper).setValue('   ')
    expect(store.dirty).toBe(false)
  })

  it('被擋下關閉時顯示提醒，文字一變就收起來', async () => {
    const store = await enterCloud()
    store.startDraft(10, 20)
    const wrapper = mountPopover()
    await input(wrapper).setValue('打到一半')

    // 使用者點了畫布：store 擋下關閉並遞增 nudge
    expect(store.requestClose()).toBe(false)
    await nextTick()

    expect(wrapper.find('[role=status]').text()).toContain('內容還沒送出')
    expect(input(wrapper).element.value).toBe('打到一半')
    expect(document.activeElement).toBe(input(wrapper).element)

    await input(wrapper).setValue('打到一半，繼續打')
    expect(wrapper.find('[role=status]').exists()).toBe(false)
  })

  it('接近長度上限才顯示字數；超過時不能送出', async () => {
    const store = await enterCloud()
    store.startDraft(10, 20)
    const wrapper = mountPopover()

    await input(wrapper).setValue('字'.repeat(100))
    expect(wrapper.find('.comment-popover__counter').exists()).toBe(false)

    await input(wrapper).setValue('字'.repeat(1900))
    expect(wrapper.find('.comment-popover__counter').text()).toBe('1900 / 2000')
    expect(submitBtn(wrapper).element.disabled).toBe(false)

    await input(wrapper).setValue('字'.repeat(2001))
    expect(wrapper.find('.comment-popover__counter').text()).toBe('2001 / 2000')
    expect(submitBtn(wrapper).element.disabled).toBe(true)
    expect(input(wrapper).attributes('aria-invalid')).toBe('true')
  })

  it('留言框裡的按鍵不會傳到畫布的快捷鍵', async () => {
    // Delete 會刪掉選取的圖形、V / R / C 會切換工具——都掛在 document 上
    const store = await enterCloud()
    store.startDraft(10, 20)
    const wrapper = mountPopover()
    const onDocumentKeydown = vi.fn()
    document.addEventListener('keydown', onDocumentKeydown)

    await input(wrapper).trigger('keydown', { key: 'Delete' })
    await input(wrapper).trigger('keydown', { key: 'v' })

    document.removeEventListener('keydown', onDocumentKeydown)
    expect(onDocumentKeydown).not.toHaveBeenCalled()
  })
})

describe('CommentPopover：檢視既有留言', () => {
  it('預設是檢視狀態：作者、時間、內容，沒有輸入框', async () => {
    const store = await enterCloud([dto('c1', { content: '第一行\n第二行' })])
    store.open('c1')

    const wrapper = mountPopover()

    expect(input(wrapper).exists()).toBe(false)
    expect(wrapper.find('[data-testid=comment-author]').text()).toBe('Alice')
    expect(body(wrapper).text()).toBe('第一行\n第二行')
    expect(wrapper.find('time').attributes('datetime')).toBe('2026-10-02T03:00:00.000Z')
    expect(wrapper.find('time').text()).not.toBe('')
  })

  it('作者沒有顯示名稱時用 email', async () => {
    const store = await enterCloud([
      dto('c1', {
        author: { user_id: 'u-bob', display_name: null, email: 'bob@example.com' },
      }),
    ])
    store.open('c1')

    expect(mountPopover().find('[data-testid=comment-author]').text()).toBe('bob@example.com')
  })

  it('內容以純文字顯示，不會被當成 HTML', async () => {
    const store = await enterCloud([dto('c1', { content: '<img src=x onerror=alert(1)>' })])
    store.open('c1')

    const wrapper = mountPopover()

    expect(body(wrapper).text()).toBe('<img src=x onerror=alert(1)>')
    expect(body(wrapper).find('img').exists()).toBe(false)
  })

  it('自己的留言：有編輯與刪除', async () => {
    const store = await enterCloud([dto('c1', { can_edit: true, can_delete: true })])
    store.open('c1')

    const wrapper = mountPopover()

    expect(wrapper.find('[data-testid=comment-edit]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=comment-delete]').exists()).toBe(true)
  })

  it('別人的留言：沒有編輯與刪除，但仍然可以標記已解決', async () => {
    const store = await enterCloud([dto('c1', { can_edit: false, can_delete: false })])
    store.open('c1')

    const wrapper = mountPopover()

    expect(wrapper.find('[data-testid=comment-edit]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=comment-delete]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=comment-resolve]').exists()).toBe(true)
  })

  it('兩個權限旗標各自決定自己的按鈕', async () => {
    const store = await enterCloud([dto('c1', { can_edit: true, can_delete: false })])
    store.open('c1')

    const wrapper = mountPopover()

    expect(wrapper.find('[data-testid=comment-edit]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=comment-delete]').exists()).toBe(false)
  })

  it('標記已解決 / 重新開啟：送出 resolved，按鈕文字與標籤跟著變', async () => {
    const store = await enterCloud([dto('c1', { can_edit: false, can_delete: false })])
    store.open('c1')
    const wrapper = mountPopover()
    const resolve = () => wrapper.find('[data-testid=comment-resolve]')
    expect(resolve().text()).toBe('標記已解決')

    mockUpdate.mockResolvedValue(dto('c1', { resolved: true }))
    await resolve().trigger('click')
    await flushPromises()
    // 留言框的 comment 是 prop：由父層（覆疊層）把更新後的留言傳進來
    await wrapper.setProps({ comment: store.activeComment })

    expect(mockUpdate).toHaveBeenCalledWith(PROJECT_ID, 'c1', { resolved: true })
    expect(resolve().text()).toBe('重新開啟')
    expect(wrapper.find('.comment-popover__badge').text()).toBe('已解決')
  })

  it('檢視狀態沒有未送出的文字：Esc 與右上角的 X 都會關掉留言框', async () => {
    const store = await enterCloud([dto('c1')])
    store.open('c1')
    const wrapper = mountPopover()
    const nudgeBefore = store.nudge

    await wrapper.trigger('keydown', { key: 'Escape' })
    expect(store.activeId).toBeNull()

    store.open('c1')
    await closeBtn(wrapper).trigger('click')
    expect(store.activeId).toBeNull()
    expect(store.nudge).toBe(nudgeBefore)
  })

  it('檢視狀態把焦點放在留言框本身，Esc 才收得到', async () => {
    const store = await enterCloud([dto('c1')])
    store.open('c1')

    const wrapper = mountPopover()
    await nextTick()

    expect(document.activeElement).toBe(wrapper.element)
  })

  it('本機留言沒有作者：顯示「本機留言」，不顯示頭像', async () => {
    const store = useCommentStore()
    store.startDraft(1, 2)
    await store.submitDraft('本機的')
    store.open(store.comments[0]!.id)

    const wrapper = mountPopover()

    expect(wrapper.find('[data-testid=comment-author]').text()).toBe('本機留言')
    expect(wrapper.find('.comment-popover__avatar').exists()).toBe(false)
    expect(wrapper.find('[data-testid=comment-edit]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=comment-delete]').exists()).toBe(true)
  })
})

describe('CommentPopover：編輯', () => {
  async function openEditor(content = '原本的內容') {
    const store = await enterCloud([dto('c1', { content })])
    store.open('c1')
    const wrapper = mountPopover()
    await wrapper.find('[data-testid=comment-edit]').trigger('click')
    return { store, wrapper }
  }

  it('按編輯：輸入框帶入原本的內容並取得焦點', async () => {
    const { wrapper } = await openEditor()
    await nextTick()

    expect(input(wrapper).element.value).toBe('原本的內容')
    expect(document.activeElement).toBe(input(wrapper).element)
    expect(submitBtn(wrapper).text()).toBe('儲存')
  })

  it('內容沒變時不能儲存，也不算有未送出的內容', async () => {
    const { store, wrapper } = await openEditor()

    expect(submitBtn(wrapper).element.disabled).toBe(true)
    expect(store.dirty).toBe(false)

    await input(wrapper).setValue('原本的內容，補一句')
    expect(submitBtn(wrapper).element.disabled).toBe(false)
    expect(store.dirty).toBe(true)
  })

  it('儲存成功：送出 content，回到檢視狀態', async () => {
    const { store, wrapper } = await openEditor()
    mockUpdate.mockResolvedValue(dto('c1', { content: '改過的內容' }))

    await input(wrapper).setValue('改過的內容')
    await submitBtn(wrapper).trigger('click')
    await flushPromises()
    await wrapper.setProps({ comment: store.activeComment })

    expect(mockUpdate).toHaveBeenCalledWith(PROJECT_ID, 'c1', { content: '改過的內容' })
    expect(input(wrapper).exists()).toBe(false)
    expect(body(wrapper).text()).toBe('改過的內容')
    expect(store.dirty).toBe(false)
  })

  it('儲存失敗：留在編輯狀態，文字還在，顯示錯誤', async () => {
    const { store, wrapper } = await openEditor()
    mockUpdate.mockRejectedValue(new ApiError(403, '只有留言的作者能修改內容'))

    await input(wrapper).setValue('改過的內容')
    await submitBtn(wrapper).trigger('click')
    await flushPromises()

    expect(input(wrapper).element.value).toBe('改過的內容')
    expect(wrapper.find('[data-testid=comment-error]').text()).toBe('只有留言的作者能修改內容')
    expect(store.comments[0]?.text).toBe('原本的內容')
  })

  it('取消：丟掉修改，回到檢視狀態，留言框還開著', async () => {
    const { store, wrapper } = await openEditor()

    await input(wrapper).setValue('改到一半')
    await wrapper.find('[data-testid=comment-cancel]').trigger('click')

    expect(input(wrapper).exists()).toBe(false)
    expect(body(wrapper).text()).toBe('原本的內容')
    expect(store.activeId).toBe('c1')
    expect(store.dirty).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('編輯中按 Esc 是取消編輯，不是關掉留言框', async () => {
    const { store, wrapper } = await openEditor()

    await input(wrapper).trigger('keydown', { key: 'Escape' })

    expect(input(wrapper).exists()).toBe(false)
    expect(store.activeId).toBe('c1')
  })

  it('改過內容後按右上角的 X：不關閉、不丟掉文字，並提醒使用者', async () => {
    // X 是「關閉」，不是「取消」。放棄修改必須是使用者明確按下取消。
    const { store, wrapper } = await openEditor()
    await input(wrapper).setValue('改到一半的內容')
    const nudgeBefore = store.nudge

    await closeBtn(wrapper).trigger('click')

    expect(store.activeId).toBe('c1')
    expect(store.nudge).toBe(nudgeBefore + 1)
    expect(input(wrapper).element.value).toBe('改到一半的內容')
    expect(store.dirty).toBe(true)
    expect(wrapper.find('[role=status]').text()).toContain('內容還沒送出，請先儲存或取消')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('被 X 擋下之後按取消：這才真的放棄修改', async () => {
    const { store, wrapper } = await openEditor()
    await input(wrapper).setValue('改到一半的內容')
    await closeBtn(wrapper).trigger('click')

    await wrapper.find('[data-testid=comment-cancel]').trigger('click')

    expect(input(wrapper).exists()).toBe(false)
    expect(body(wrapper).text()).toBe('原本的內容')
    expect(store.dirty).toBe(false)
    // 回到檢視狀態之後，X 可以正常關閉
    await closeBtn(wrapper).trigger('click')
    expect(store.activeId).toBeNull()
  })

  it('進入編輯但沒有改內容時，X 直接關閉', async () => {
    const { store, wrapper } = await openEditor()
    const nudgeBefore = store.nudge

    await closeBtn(wrapper).trigger('click')

    expect(store.activeId).toBeNull()
    expect(store.nudge).toBe(nudgeBefore)
  })

  it('儲存還在途中時 X 不會關閉留言框', async () => {
    const { store, wrapper } = await openEditor()
    const slow = deferred<CommentDto>()
    mockUpdate.mockReturnValue(slow.promise)
    await input(wrapper).setValue('改過的內容')
    await submitBtn(wrapper).trigger('click')
    await nextTick()

    expect(closeBtn(wrapper).element.disabled).toBe(true)
    // 即使繞過 disabled 直接呼叫，store 也不會關
    expect(store.requestClose()).toBe(false)
    expect(store.activeId).toBe('c1')

    slow.resolve(dto('c1', { content: '改過的內容' }))
    await flushPromises()
  })
})

describe('CommentPopover：刪除', () => {
  async function openOwnComment() {
    const store = await enterCloud([dto('c1'), dto('c2')])
    store.open('c1')
    return { store, wrapper: mountPopover() }
  }
  const confirmBtn = (w: VueWrapper) => w.find('[data-testid=comment-delete-confirm]')

  it('按刪除只是進入確認，不會直接刪掉', async () => {
    const { store, wrapper } = await openOwnComment()

    await wrapper.find('[data-testid=comment-delete]').trigger('click')

    expect(mockDelete).not.toHaveBeenCalled()
    expect(store.comments).toHaveLength(2)
    expect(wrapper.text()).toContain('確定刪除這則留言？')
    // 確認時內容還看得到，才知道要刪的是哪一則
    expect(body(wrapper).exists()).toBe(true)
    expect(confirmBtn(wrapper).exists()).toBe(true)
  })

  it('確認之後才刪除；成功後留言框關閉', async () => {
    const { store, wrapper } = await openOwnComment()
    mockDelete.mockResolvedValue(undefined)

    await wrapper.find('[data-testid=comment-delete]').trigger('click')
    await confirmBtn(wrapper).trigger('click')
    await flushPromises()

    expect(mockDelete).toHaveBeenCalledWith(PROJECT_ID, 'c1')
    expect(store.comments.map((c) => c.id)).toEqual(['c2'])
    expect(store.activeId).toBeNull()
  })

  it('在確認畫面按取消或 Esc：回到檢視狀態，留言還在', async () => {
    const { store, wrapper } = await openOwnComment()

    await wrapper.find('[data-testid=comment-delete]').trigger('click')
    await wrapper.trigger('keydown', { key: 'Escape' })

    expect(confirmBtn(wrapper).exists()).toBe(false)
    expect(store.activeId).toBe('c1')
    expect(store.comments).toHaveLength(2)
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('在確認畫面按右上角的 X：關閉留言框，不會刪除', async () => {
    const { store, wrapper } = await openOwnComment()

    await wrapper.find('[data-testid=comment-delete]').trigger('click')
    await closeBtn(wrapper).trigger('click')

    expect(store.activeId).toBeNull()
    expect(store.comments).toHaveLength(2)
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('刪除失敗：回到檢視狀態並顯示錯誤，留言還在', async () => {
    const { store, wrapper } = await openOwnComment()
    mockDelete.mockRejectedValue(new ApiError(403, '只有留言的作者能刪除'))

    await wrapper.find('[data-testid=comment-delete]').trigger('click')
    await confirmBtn(wrapper).trigger('click')
    await flushPromises()

    expect(store.comments).toHaveLength(2)
    expect(confirmBtn(wrapper).exists()).toBe(false)
    expect(wrapper.find('[data-testid=comment-error]').text()).toBe('只有留言的作者能刪除')
  })
})
