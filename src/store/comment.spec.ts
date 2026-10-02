import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiError } from '@/services/api'
import type { CommentDto } from '@/services/comments'

vi.mock('@/services/comments', () => ({
  listComments: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}))

const { listComments, createComment, updateComment, deleteComment } =
  await import('@/services/comments')
const { useCommentStore } = await import('@/store/comment')
const mockList = vi.mocked(listComments)
const mockCreate = vi.mocked(createComment)
const mockUpdate = vi.mocked(updateComment)
const mockDelete = vi.mocked(deleteComment)

const PROJECT_A = '11111111-1111-1111-1111-111111111111'
const PROJECT_B = '33333333-3333-3333-3333-333333333333'
const MIRROR_KEY = 'easyfigma_comments'

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

/** 手動控制 resolve / reject 時機，用來製造「請求還在途中」的狀態。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 進入一個雲端專案並載入留言——documentStore 與 EditorView 合起來做的事。 */
async function enterCloud(projectId: string, rows: CommentDto[] = []) {
  const store = useCommentStore()
  mockList.mockResolvedValueOnce(rows)
  store.setSource('cloud')
  await store.load(projectId)
  return store
}

beforeEach(() => {
  // store 建立時會從 localStorage 取初始值，jsdom 的 localStorage 在同一個檔案的
  // 測試之間是共用的。
  localStorage.clear()
  setActivePinia(createPinia())
  vi.resetAllMocks()
})

describe('雲端：載入', () => {
  it('切到雲端時列表是空的，載入後才有留言', async () => {
    localStorage.setItem(
      MIRROR_KEY,
      JSON.stringify([
        { id: 'local', worldX: 0, worldY: 0, text: '本機', resolved: false, createdAt: 1 },
      ]),
    )
    setActivePinia(createPinia())
    const store = useCommentStore()
    expect(store.comments.map((c) => c.id)).toEqual(['local'])

    store.setSource('cloud')
    // 本機留言不能在雲端專案的畫布上多停留任何一刻
    expect(store.comments).toEqual([])
    expect(store.loaded).toBe(false)

    mockList.mockResolvedValue([dto('c1'), dto('c2')])
    await expect(store.load(PROJECT_A)).resolves.toBe(true)

    expect(mockList).toHaveBeenCalledWith(PROJECT_A)
    expect(store.comments.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(store.loaded).toBe(true)
    expect(store.loadError).toBeNull()
  })

  it('把後端的欄位轉成畫面用的形狀，作者與權限照後端給的', async () => {
    const store = await enterCloud(PROJECT_A, [
      dto('c1', {
        world_x: 120.5,
        world_y: -48.25,
        content: '標題太小',
        resolved: true,
        created_at: '2026-10-02T03:04:05Z',
        author: { user_id: 'u-bob', display_name: null, email: 'bob@example.com' },
        can_edit: false,
        can_delete: false,
      }),
    ])

    expect(store.comments[0]).toEqual({
      id: 'c1',
      worldX: 120.5,
      worldY: -48.25,
      text: '標題太小',
      resolved: true,
      createdAt: Date.parse('2026-10-02T03:04:05Z'),
      author: { userId: 'u-bob', displayName: null, email: 'bob@example.com' },
      canEdit: false,
      canDelete: false,
    })
  })

  it('來源不是雲端時 load 不送請求', async () => {
    const store = useCommentStore()

    await expect(store.load(PROJECT_A)).resolves.toBe(false)

    expect(mockList).not.toHaveBeenCalled()
  })

  it('載入失敗：列表保持空的，錯誤在 loadError，而且算是載入過', async () => {
    const store = useCommentStore()
    store.setSource('cloud')
    mockList.mockRejectedValue(new ApiError(404, '找不到專案'))

    await expect(store.load(PROJECT_A)).resolves.toBe(false)

    expect(store.comments).toEqual([])
    expect(store.loadError).toBe('找不到專案')
    // 否則畫面會永遠停在「載入中」
    expect(store.loaded).toBe(true)
  })

  it('reload 重新載入同一個專案，成功後清掉 loadError', async () => {
    const store = useCommentStore()
    store.setSource('cloud')
    mockList.mockRejectedValueOnce(new ApiError(503, '伺服器忙碌'))
    await store.load(PROJECT_A)
    expect(store.loadError).not.toBeNull()

    mockList.mockResolvedValueOnce([dto('c1')])
    await expect(store.reload()).resolves.toBe(true)

    expect(mockList).toHaveBeenLastCalledWith(PROJECT_A)
    expect(store.comments.map((c) => c.id)).toEqual(['c1'])
    expect(store.loadError).toBeNull()
  })

  it('連按兩次重試，只有最後一次的結果算數', async () => {
    const store = useCommentStore()
    store.setSource('cloud')
    const first = deferred<CommentDto[]>()
    const second = deferred<CommentDto[]>()
    mockList.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const a = store.load(PROJECT_A)
    const b = store.load(PROJECT_A)
    second.resolve([dto('new')])
    await b
    first.resolve([dto('old')])
    await a

    expect(store.comments.map((c) => c.id)).toEqual(['new'])
  })
})

describe('雲端：過期的回應不得寫入 state', () => {
  it('A 的載入晚於 B：A 的留言不會出現在 B', async () => {
    const store = useCommentStore()
    const slowA = deferred<CommentDto[]>()
    mockList.mockReturnValueOnce(slowA.promise)

    store.setSource('cloud')
    const loadA = store.load(PROJECT_A)
    // 離開 A（documentStore.stopPersistence）再進 B
    store.setSource('local')
    await enterCloud(PROJECT_B, [dto('b1')])

    slowA.resolve([dto('a1'), dto('a2')])
    await expect(loadA).resolves.toBe(false)

    expect(store.comments.map((c) => c.id)).toEqual(['b1'])
  })

  it('A → B → A：第一次進 A 時送出的載入，不會寫進第二次進的 A', async () => {
    // 專案 id 相同，所以只比對 id 擋不住這個情況
    const store = useCommentStore()
    const firstVisit = deferred<CommentDto[]>()
    mockList.mockReturnValueOnce(firstVisit.promise)

    store.setSource('cloud')
    const stale = store.load(PROJECT_A)
    store.setSource('local')
    await enterCloud(PROJECT_B, [dto('b1')])
    store.setSource('local')
    await enterCloud(PROJECT_A, [dto('a-fresh')])

    firstVisit.resolve([dto('a-stale')])
    await expect(stale).resolves.toBe(false)

    expect(store.comments.map((c) => c.id)).toEqual(['a-fresh'])
  })

  it('過期的載入失敗不會把錯誤顯示在現在的專案', async () => {
    const store = useCommentStore()
    const slowA = deferred<CommentDto[]>()
    mockList.mockReturnValueOnce(slowA.promise)

    store.setSource('cloud')
    const loadA = store.load(PROJECT_A)
    store.setSource('local')
    await enterCloud(PROJECT_B, [dto('b1')])

    slowA.reject(new ApiError(404, '找不到專案'))
    await loadA

    expect(store.loadError).toBeNull()
    expect(store.comments.map((c) => c.id)).toEqual(['b1'])
  })

  it('離開專案後才回來的新增結果不會加進下一個專案', async () => {
    const store = await enterCloud(PROJECT_A)
    const slow = deferred<CommentDto>()
    mockCreate.mockReturnValueOnce(slow.promise)

    store.startDraft(1, 2)
    const submitted = store.submitDraft('送出後就離開')
    store.setSource('local')
    await enterCloud(PROJECT_B, [dto('b1')])

    slow.resolve(dto('a-new'))
    await expect(submitted).resolves.toBe(false)

    expect(store.comments.map((c) => c.id)).toEqual(['b1'])
    expect(store.pending).toBe(false)
  })

  it('離開專案後才回來的修改失敗，不會在下一個專案顯示錯誤或觸發重新載入', async () => {
    const store = await enterCloud(PROJECT_A, [dto('a1')])
    const slow = deferred<CommentDto>()
    mockUpdate.mockReturnValueOnce(slow.promise)

    const toggled = store.toggleResolved('a1')
    store.setSource('local')
    await enterCloud(PROJECT_B, [dto('b1')])
    mockList.mockClear()

    slow.reject(new ApiError(404, '找不到留言'))
    await expect(toggled).resolves.toBe(false)

    expect(store.error).toBeNull()
    expect(mockList).not.toHaveBeenCalled()
    expect(store.pending).toBe(false)
  })

  it('切換來源時 pending 歸零，過期的請求結束後不會把它扣成負的', async () => {
    const store = await enterCloud(PROJECT_A, [dto('a1')])
    const slow = deferred<CommentDto>()
    mockUpdate.mockReturnValueOnce(slow.promise)

    const toggled = store.toggleResolved('a1')
    expect(store.pending).toBe(true)
    store.setSource('local')
    expect(store.pending).toBe(false)

    slow.resolve(dto('a1', { resolved: true }))
    await toggled
    await enterCloud(PROJECT_B, [dto('b1')])
    mockUpdate.mockResolvedValueOnce(dto('b1', { resolved: true }))

    // pending 若變成負數，這裡的 pending 會在請求途中仍是 false，連按就擋不住
    const next = store.toggleResolved('b1')
    expect(store.pending).toBe(true)
    await next
    expect(store.pending).toBe(false)
  })
})

describe('雲端：留言不屬於 document', () => {
  it('新增、修改、切換、刪除都不遞增 documentRevision（不觸發 autosave）', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    const before = store.documentRevision

    mockCreate.mockResolvedValue(dto('c2'))
    store.startDraft(1, 2)
    await store.submitDraft('新留言')
    mockUpdate.mockResolvedValue(dto('c1', { content: '改過' }))
    await store.updateText('c1', '改過')
    mockUpdate.mockResolvedValue(dto('c1', { resolved: true }))
    await store.toggleResolved('c1')
    mockDelete.mockResolvedValue(undefined)
    await store.remove('c1')

    expect(store.documentRevision).toBe(before)
  })

  it('載入也不遞增 documentRevision', async () => {
    const store = useCommentStore()
    const before = store.documentRevision

    await enterCloud(PROJECT_A, [dto('c1')])

    expect(store.documentRevision).toBe(before)
  })

  it('snapshot 在雲端一律是空的', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1'), dto('c2')])

    expect(store.snapshot()).toEqual([])
  })

  it('replaceAll 在雲端被忽略：快照裡的 comments 不會變成畫面上的留言', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    const before = store.documentRevision

    store.replaceAll([
      { id: 'legacy', worldX: 0, worldY: 0, text: '舊版留下的', resolved: false, createdAt: 1 },
    ])

    expect(store.comments.map((c) => c.id)).toEqual(['c1'])
    expect(store.documentRevision).toBe(before)
  })

  it('雲端的任何操作都不寫 localStorage', async () => {
    const seeded = JSON.stringify([
      { id: 'local', worldX: 5, worldY: 5, text: '本機', resolved: false, createdAt: 100 },
    ])
    localStorage.setItem(MIRROR_KEY, seeded)
    setActivePinia(createPinia())
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)

    mockCreate.mockResolvedValue(dto('c2'))
    store.startDraft(1, 2)
    await store.submitDraft('新留言')
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
    mockUpdate.mockResolvedValue(dto('c1', { content: '改過', resolved: true }))
    await store.updateText('c1', '改過')
    await store.toggleResolved('c1')
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
    mockDelete.mockResolvedValue(undefined)
    await store.remove('c1')
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
    store.flush()
    expect(localStorage.getItem(MIRROR_KEY)).toBe(seeded)
  })

  it('離開雲端後，雲端留言從 store 消失，本機留言從 mirror 讀回來', async () => {
    localStorage.setItem(
      MIRROR_KEY,
      JSON.stringify([
        { id: 'local', worldX: 5, worldY: 5, text: '本機', resolved: false, createdAt: 100 },
      ]),
    )
    setActivePinia(createPinia())
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    const before = store.documentRevision

    store.setSource('local')

    expect(store.comments.map((c) => c.id)).toEqual(['local'])
    expect(store.comments[0]?.author).toBeNull()
    // 這是還原，不是一次編輯
    expect(store.documentRevision).toBe(before)
  })

  it('離開雲端時一併清掉草稿、開啟中的留言與錯誤', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    store.open('c1')
    store.setDirty(true)
    mockUpdate.mockRejectedValue(new ApiError(500, 'boom'))
    await store.toggleResolved('c1')
    expect(store.error).not.toBeNull()

    store.setSource('local')

    expect(store.activeId).toBeNull()
    expect(store.draft).toBeNull()
    expect(store.dirty).toBe(false)
    expect(store.error).toBeNull()
    expect(store.loadError).toBeNull()
  })
})

describe('雲端：新增（草稿 → POST）', () => {
  it('startDraft 只建立草稿：不送請求，列表裡沒有新的留言', async () => {
    const store = await enterCloud(PROJECT_A)

    expect(store.startDraft(30, 40)).toBe(true)

    expect(store.draft).toEqual({ worldX: 30, worldY: 40 })
    expect(store.comments).toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('送出成功：POST 帶草稿的座標與 trim 過的內容，留言進列表，草稿消失', async () => {
    const store = await enterCloud(PROJECT_A)
    mockCreate.mockResolvedValue(dto('new', { world_x: 30, world_y: 40, content: '標題太小' }))
    store.startDraft(30, 40)
    store.setDirty(true)

    await expect(store.submitDraft('  標題太小\n')).resolves.toBe(true)

    expect(mockCreate).toHaveBeenCalledWith(PROJECT_A, {
      world_x: 30,
      world_y: 40,
      content: '標題太小',
    })
    expect(store.comments.map((c) => c.id)).toEqual(['new'])
    expect(store.draft).toBeNull()
    expect(store.dirty).toBe(false)
    expect(store.hasOpenPopover).toBe(false)
  })

  it('送出失敗：草稿保留、列表不變、錯誤訊息在 error', async () => {
    const store = await enterCloud(PROJECT_A)
    mockCreate.mockRejectedValue(new ApiError(503, '伺服器忙碌'))
    store.startDraft(30, 40)
    store.setDirty(true)

    await expect(store.submitDraft('標題太小')).resolves.toBe(false)

    // 草稿還在，輸入框（元件自己的狀態）也就還在，使用者可以直接再送一次
    expect(store.draft).toEqual({ worldX: 30, worldY: 40 })
    expect(store.dirty).toBe(true)
    expect(store.comments).toEqual([])
    expect(store.error).toBe('伺服器暫時無法回應，請稍後再試')
    expect(store.pending).toBe(false)
  })

  it('取消草稿：什麼都不留下，也沒有送出任何請求', async () => {
    const store = await enterCloud(PROJECT_A)
    store.startDraft(30, 40)
    store.setDirty(true)

    store.close()

    expect(store.draft).toBeNull()
    expect(store.comments).toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it.each(['', '   ', '\n\t '])('空白內容 %j 不送請求', async (text) => {
    const store = await enterCloud(PROJECT_A)
    store.startDraft(1, 2)

    await expect(store.submitDraft(text)).resolves.toBe(false)

    expect(mockCreate).not.toHaveBeenCalled()
    expect(store.draft).not.toBeNull()
  })

  it('超過長度上限不送請求；剛好在上限則送出', async () => {
    const store = await enterCloud(PROJECT_A)
    store.startDraft(1, 2)

    await expect(store.submitDraft('字'.repeat(2001))).resolves.toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()

    mockCreate.mockResolvedValue(dto('new'))
    // 前後的空白不算長度
    await expect(store.submitDraft(`  ${'字'.repeat(2000)}\n`)).resolves.toBe(true)
  })

  it('沒有草稿時 submitDraft 不做任何事', async () => {
    const store = await enterCloud(PROJECT_A)

    await expect(store.submitDraft('沒有位置')).resolves.toBe(false)

    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('請求還在途中時再送一次會被擋下，不會建立兩則', async () => {
    const store = await enterCloud(PROJECT_A)
    const slow = deferred<CommentDto>()
    mockCreate.mockReturnValueOnce(slow.promise)
    store.startDraft(1, 2)

    const first = store.submitDraft('連按兩下')
    expect(store.pending).toBe(true)
    await expect(store.submitDraft('連按兩下')).resolves.toBe(false)
    slow.resolve(dto('new'))
    await first

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(store.comments).toHaveLength(1)
  })

  it('新增與重新載入並行：留言已經跟著列表回來時不會出現兩次', async () => {
    const store = await enterCloud(PROJECT_A)
    const slow = deferred<CommentDto>()
    mockCreate.mockReturnValueOnce(slow.promise)
    store.startDraft(1, 2)
    const submitted = store.submitDraft('新留言')

    mockList.mockResolvedValueOnce([dto('new')])
    await store.reload()
    slow.resolve(dto('new'))
    await submitted

    expect(store.comments.map((c) => c.id)).toEqual(['new'])
  })
})

describe('雲端：修改與刪除', () => {
  it('修改內容：PATCH 只帶 content，回應取代列表裡的那一則', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1'), dto('c2')])
    mockUpdate.mockResolvedValue(dto('c1', { content: '改過' }))
    store.open('c1')
    store.setDirty(true)

    await expect(store.updateText('c1', ' 改過 ')).resolves.toBe(true)

    expect(mockUpdate).toHaveBeenCalledWith(PROJECT_A, 'c1', { content: '改過' })
    expect(store.comments.map((c) => c.text)).toEqual(['改過', '留言 c2'])
    expect(store.dirty).toBe(false)
    // 留言框留著：回到檢視狀態由元件決定
    expect(store.activeId).toBe('c1')
  })

  it('修改失敗（403）：列表不變，錯誤訊息拿的是後端的說法', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    mockUpdate.mockRejectedValue(new ApiError(403, '只有留言的作者能修改內容'))
    store.open('c1')
    store.setDirty(true)

    await expect(store.updateText('c1', '改過')).resolves.toBe(false)

    expect(store.comments[0]?.text).toBe('留言 c1')
    expect(store.error).toBe('只有留言的作者能修改內容')
    // 文字還在輸入框裡，不能因為失敗就當成沒有未送出的內容
    expect(store.dirty).toBe(true)
  })

  it('切換已解決：PATCH 只帶 resolved，值是目前狀態的相反', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    mockUpdate.mockResolvedValueOnce(dto('c1', { resolved: true }))

    await store.toggleResolved('c1')
    expect(mockUpdate).toHaveBeenLastCalledWith(PROJECT_A, 'c1', { resolved: true })
    expect(store.comments[0]?.resolved).toBe(true)

    mockUpdate.mockResolvedValueOnce(dto('c1', { resolved: false }))
    await store.toggleResolved('c1')
    expect(mockUpdate).toHaveBeenLastCalledWith(PROJECT_A, 'c1', { resolved: false })
    expect(store.comments[0]?.resolved).toBe(false)
  })

  it('不做樂觀更新：請求途中列表仍是舊的', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    const slow = deferred<CommentDto>()
    mockUpdate.mockReturnValueOnce(slow.promise)

    const toggled = store.toggleResolved('c1')
    expect(store.comments[0]?.resolved).toBe(false)

    slow.resolve(dto('c1', { resolved: true }))
    await toggled
    expect(store.comments[0]?.resolved).toBe(true)
  })

  it('刪除成功：從列表移除，開著的留言框一起關掉', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1'), dto('c2')])
    mockDelete.mockResolvedValue(undefined)
    store.open('c1')

    await expect(store.remove('c1')).resolves.toBe(true)

    expect(mockDelete).toHaveBeenCalledWith(PROJECT_A, 'c1')
    expect(store.comments.map((c) => c.id)).toEqual(['c2'])
    expect(store.activeId).toBeNull()
  })

  it('刪除失敗（403）：留言還在，留言框也還開著', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    mockDelete.mockRejectedValue(new ApiError(403, '只有留言的作者能刪除'))
    store.open('c1')

    await expect(store.remove('c1')).resolves.toBe(false)

    expect(store.comments.map((c) => c.id)).toEqual(['c1'])
    expect(store.activeId).toBe('c1')
    expect(store.error).toBe('只有留言的作者能刪除')
  })

  it('留言已被別人刪掉（404）：說明原因，並重新載入讓列表與後端一致', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1'), dto('c2')])
    mockUpdate.mockRejectedValue(new ApiError(404, '找不到留言'))
    mockList.mockResolvedValueOnce([dto('c2')])
    store.open('c1')

    await expect(store.toggleResolved('c1')).resolves.toBe(false)
    await flush()

    expect(store.error).toBe('這則留言已經被刪除')
    expect(store.comments.map((c) => c.id)).toEqual(['c2'])
    // 開著的那一則不在了，留言框跟著關掉
    expect(store.activeId).toBeNull()
  })

  it('404 而且整個專案都進不去了：重新載入失敗，loadError 說明原因', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    mockDelete.mockRejectedValue(new ApiError(404, '找不到專案'))
    mockList.mockRejectedValueOnce(new ApiError(404, '找不到專案'))

    await store.remove('c1')
    await flush()

    expect(store.loadError).toBe('找不到專案')
  })

  it('對不存在的留言操作不送請求', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])

    await expect(store.updateText('nope', 'x')).resolves.toBe(false)
    await expect(store.toggleResolved('nope')).resolves.toBe(false)
    await expect(store.remove('nope')).resolves.toBe(false)

    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockDelete).not.toHaveBeenCalled()
  })
})

describe('留言框的開關（同時只有一個）', () => {
  it('open 設定 activeId；開另一則會取代前一則', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1'), dto('c2')])

    expect(store.open('c1')).toBe(true)
    expect(store.activeComment?.id).toBe('c1')
    expect(store.open('c2')).toBe(true)

    expect(store.activeId).toBe('c2')
    expect(store.hasOpenPopover).toBe(true)
  })

  it('open 不存在的留言不做任何事', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])

    expect(store.open('nope')).toBe(false)

    expect(store.activeId).toBeNull()
  })

  it('已經有留言框開著時 startDraft 不建立草稿', async () => {
    // 那一次點擊的意思是「關掉它」，不是「再放一個」
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    store.open('c1')

    expect(store.startDraft(1, 2)).toBe(false)
    expect(store.draft).toBeNull()

    store.close()
    store.startDraft(1, 2)
    expect(store.startDraft(9, 9)).toBe(false)
    expect(store.draft).toEqual({ worldX: 1, worldY: 2 })
  })

  it('草稿與開啟中的留言互斥', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    store.startDraft(1, 2)

    expect(store.open('c1')).toBe(true)

    expect(store.draft).toBeNull()
    expect(store.activeId).toBe('c1')
  })

  it('requestClose：沒有未送出的文字就關閉', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    store.startDraft(1, 2)

    expect(store.requestClose()).toBe(true)

    expect(store.hasOpenPopover).toBe(false)
  })

  it('requestClose：有未送出的文字時不關，並提醒使用者', async () => {
    const store = await enterCloud(PROJECT_A)
    store.startDraft(1, 2)
    store.setDirty(true)
    const nudgeBefore = store.nudge

    expect(store.requestClose()).toBe(false)

    expect(store.draft).toEqual({ worldX: 1, worldY: 2 })
    expect(store.nudge).toBe(nudgeBefore + 1)
  })

  it('有未送出的文字時，開另一則留言也會被擋下', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1'), dto('c2')])
    store.open('c1')
    store.setDirty(true)

    expect(store.open('c2')).toBe(false)

    expect(store.activeId).toBe('c1')
  })

  it('請求還在途中時 requestClose 不關，也不提醒', async () => {
    const store = await enterCloud(PROJECT_A, [dto('c1')])
    const slow = deferred<CommentDto>()
    mockUpdate.mockReturnValueOnce(slow.promise)
    store.open('c1')
    const toggled = store.toggleResolved('c1')
    const nudgeBefore = store.nudge

    expect(store.requestClose()).toBe(false)
    expect(store.activeId).toBe('c1')
    expect(store.nudge).toBe(nudgeBefore)

    slow.resolve(dto('c1', { resolved: true }))
    await toggled
  })

  it('close 是明確取消：有未送出的文字也照關', async () => {
    const store = await enterCloud(PROJECT_A)
    store.startDraft(1, 2)
    store.setDirty(true)

    store.close()

    expect(store.hasOpenPopover).toBe(false)
    expect(store.dirty).toBe(false)
  })

  it('沒有留言框時 requestClose 回傳 true', () => {
    expect(useCommentStore().requestClose()).toBe(true)
  })
})

describe('本機：行為與雲端相同，但留在這台電腦上', () => {
  function mirror(): { id: string; text: string }[] {
    const raw = localStorage.getItem(MIRROR_KEY)
    return raw ? (JSON.parse(raw) as { id: string; text: string }[]) : []
  }

  it('送出草稿：不送任何請求，留言沒有作者、可以編輯與刪除', async () => {
    const store = useCommentStore()
    store.startDraft(30, 40)

    await expect(store.submitDraft('  本機留言 ')).resolves.toBe(true)

    expect(mockCreate).not.toHaveBeenCalled()
    expect(store.comments).toHaveLength(1)
    expect(store.comments[0]).toMatchObject({
      worldX: 30,
      worldY: 40,
      text: '本機留言',
      resolved: false,
      author: null,
      canEdit: true,
      canDelete: true,
    })
    expect(store.draft).toBeNull()
  })

  it('每一種修改都遞增 documentRevision（觸發本機 autosave）並寫入 mirror', async () => {
    const store = useCommentStore()
    let revision = store.documentRevision

    store.startDraft(1, 2)
    await store.submitDraft('第一則')
    const id = store.comments[0]!.id
    expect(store.documentRevision).toBeGreaterThan(revision)
    expect(mirror().map((c) => c.text)).toEqual(['第一則'])
    revision = store.documentRevision

    await store.updateText(id, '改過')
    expect(store.documentRevision).toBeGreaterThan(revision)
    expect(mirror().map((c) => c.text)).toEqual(['改過'])
    revision = store.documentRevision

    await store.toggleResolved(id)
    expect(store.documentRevision).toBeGreaterThan(revision)
    expect(store.comments[0]?.resolved).toBe(true)
    revision = store.documentRevision

    await store.remove(id)
    expect(store.documentRevision).toBeGreaterThan(revision)
    expect(mirror()).toEqual([])
  })

  it('取消草稿不留下留言、不寫 mirror、不遞增 documentRevision', () => {
    const store = useCommentStore()
    const before = store.documentRevision
    store.startDraft(1, 2)

    store.close()

    expect(store.comments).toEqual([])
    expect(localStorage.getItem(MIRROR_KEY)).toBeNull()
    expect(store.documentRevision).toBe(before)
  })

  it('snapshot 只含持久化欄位，不帶作者與權限旗標', async () => {
    const store = useCommentStore()
    store.startDraft(1, 2)
    await store.submitDraft('要存檔的')

    const [saved] = store.snapshot()

    expect(Object.keys(saved!).sort()).toEqual([
      'createdAt',
      'id',
      'resolved',
      'text',
      'worldX',
      'worldY',
    ])
  })

  it('mirror 裡也只寫持久化欄位', async () => {
    const store = useCommentStore()
    store.startDraft(1, 2)
    await store.submitDraft('要存檔的')

    const [saved] = JSON.parse(localStorage.getItem(MIRROR_KEY)!) as object[]

    expect(Object.keys(saved!)).not.toContain('author')
    expect(Object.keys(saved!)).not.toContain('canEdit')
  })

  it('replaceAll 取代整個列表，並關掉開著的留言框', async () => {
    const store = useCommentStore()
    store.startDraft(1, 2)
    await store.submitDraft('舊的')
    store.open(store.comments[0]!.id)

    store.replaceAll([
      { id: 'imported', worldX: 0, worldY: 0, text: '匯入的', resolved: true, createdAt: 5 },
    ])

    expect(store.comments.map((c) => c.id)).toEqual(['imported'])
    expect(store.comments[0]?.author).toBeNull()
    expect(store.activeId).toBeNull()
  })

  it('local → local 不重新讀 mirror（store 的內容可能來自 IndexedDB）', () => {
    const store = useCommentStore()
    store.replaceAll([
      { id: 'from-idb', worldX: 0, worldY: 0, text: 'IndexedDB', resolved: false, createdAt: 5 },
    ])
    localStorage.setItem(MIRROR_KEY, '[]')

    store.setSource('local')

    expect(store.comments.map((c) => c.id)).toEqual(['from-idb'])
  })
})
