import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return { ...actual, apiFetch: vi.fn() }
})

const { apiFetch } = await import('@/services/api')
const { createComment, deleteComment, listComments, updateComment } =
  await import('@/services/comments')
const mockApiFetch = vi.mocked(apiFetch)

const PROJECT_ID = '11111111-1111-1111-1111-111111111111'
const COMMENT_ID = '22222222-2222-2222-2222-222222222222'

describe('comments service', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
  })

  it('讀取留言走 GET，沒有 body', async () => {
    mockApiFetch.mockResolvedValue([])
    await listComments(PROJECT_ID)
    expect(mockApiFetch).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/comments`)
  })

  it('新增送出座標與內容，欄位名稱用後端的 snake_case', async () => {
    mockApiFetch.mockResolvedValue({ id: COMMENT_ID })

    await createComment(PROJECT_ID, { world_x: 12.5, world_y: -3, content: '標題太小' })

    expect(mockApiFetch).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/comments`, {
      method: 'POST',
      json: { world_x: 12.5, world_y: -3, content: '標題太小' },
    })
  })

  it('新增不送作者：作者由後端依登入者決定', async () => {
    mockApiFetch.mockResolvedValue({ id: COMMENT_ID })

    await createComment(PROJECT_ID, { world_x: 0, world_y: 0, content: 'a' })

    const [, options] = mockApiFetch.mock.calls[0]!
    expect(Object.keys((options as { json: object }).json).sort()).toEqual([
      'content',
      'world_x',
      'world_y',
    ])
  })

  it('修改內容走 PATCH，只帶 content', async () => {
    mockApiFetch.mockResolvedValue({ id: COMMENT_ID })

    await updateComment(PROJECT_ID, COMMENT_ID, { content: '改過' })

    expect(mockApiFetch).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      json: { content: '改過' },
    })
  })

  it('切換已解決走 PATCH，只帶 resolved', async () => {
    // 只帶一個欄位很重要：非作者同時送 content 與 resolved 會整個被 403 擋掉。
    mockApiFetch.mockResolvedValue({ id: COMMENT_ID })

    await updateComment(PROJECT_ID, COMMENT_ID, { resolved: true })

    expect(mockApiFetch).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      json: { resolved: true },
    })
  })

  it('刪除的路徑同時帶專案與留言的 id', async () => {
    mockApiFetch.mockResolvedValue(undefined)

    await deleteComment(PROJECT_ID, COMMENT_ID)

    expect(mockApiFetch).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/comments/${COMMENT_ID}`, {
      method: 'DELETE',
    })
  })

  it('後端的錯誤原封不動往上丟，由呼叫端決定怎麼呈現', async () => {
    mockApiFetch.mockRejectedValue(new ApiError(403, '只有留言的作者能修改內容'))
    await expect(updateComment(PROJECT_ID, COMMENT_ID, { content: 'x' })).rejects.toBeInstanceOf(
      ApiError,
    )
  })
})
