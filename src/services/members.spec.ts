import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/services/api'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return { ...actual, apiFetch: vi.fn() }
})

const { apiFetch } = await import('@/services/api')
const { addMember, listMembers, removeMember } = await import('@/services/members')
const mockApiFetch = vi.mocked(apiFetch)

const PROJECT_ID = '11111111-1111-1111-1111-111111111111'
const USER_ID = '22222222-2222-2222-2222-222222222222'

describe('members service', () => {
  beforeEach(() => {
    mockApiFetch.mockReset()
  })

  it('讀取名單走 GET，沒有 body', async () => {
    mockApiFetch.mockResolvedValue([])
    await listMembers(PROJECT_ID)
    expect(mockApiFetch).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/members`)
  })

  it('邀請送出 email，回傳新增的那一列', async () => {
    const added = { user_id: USER_ID, email: 'b@example.com', display_name: null, role: 'member' }
    mockApiFetch.mockResolvedValue(added)

    await expect(addMember(PROJECT_ID, 'b@example.com')).resolves.toEqual(added)
    expect(mockApiFetch).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/members`, {
      method: 'POST',
      json: { email: 'b@example.com' },
    })
  })

  it('移除成員的路徑帶的是 user_id，不是 email', async () => {
    mockApiFetch.mockResolvedValue(undefined)
    await removeMember(PROJECT_ID, USER_ID)
    expect(mockApiFetch).toHaveBeenCalledWith(`/projects/${PROJECT_ID}/members/${USER_ID}`, {
      method: 'DELETE',
    })
  })

  it('後端的錯誤原封不動往上丟，由呼叫端決定怎麼呈現', async () => {
    mockApiFetch.mockRejectedValue(new ApiError(409, '這個使用者已經是專案成員'))
    await expect(addMember(PROJECT_ID, 'b@example.com')).rejects.toBeInstanceOf(ApiError)
  })
})
