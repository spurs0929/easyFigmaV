import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiError } from '@/services/api'
import type { ProjectMember } from '@/services/members'

vi.mock('@/services/members', () => ({
  listMembers: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
}))

const { listMembers, addMember, removeMember } = await import('@/services/members')
const { useMembersStore } = await import('@/store/members')
const mockList = vi.mocked(listMembers)
const mockAdd = vi.mocked(addMember)
const mockRemove = vi.mocked(removeMember)

const PROJECT_A = '11111111-1111-1111-1111-111111111111'
const PROJECT_B = '33333333-3333-3333-3333-333333333333'

function member(id: string, email: string, role: ProjectMember['role'] = 'member'): ProjectMember {
  return { user_id: id, email, display_name: null, role }
}

const OWNER = member('owner-id', 'a@example.com', 'owner')
const MEMBER = member('member-id', 'b@example.com')

/** 手動控制 resolve 時機，用來製造「請求還在途中」的狀態。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('members store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('open 載入名單並標記 loaded', async () => {
    mockList.mockResolvedValue([OWNER, MEMBER])
    const store = useMembersStore()

    await store.open(PROJECT_A)

    expect(store.items).toEqual([OWNER, MEMBER])
    expect(store.loaded).toBe(true)
    expect(store.error).toBeNull()
    expect(store.pending).toBe(false)
  })

  it('載入失敗時名單保持空的，錯誤訊息拿的是後端的說法', async () => {
    mockList.mockRejectedValue(new ApiError(404, '找不到專案'))
    const store = useMembersStore()

    await store.open(PROJECT_A)

    expect(store.items).toEqual([])
    expect(store.error).toBe('找不到專案')
    // 載入失敗也算載入過：否則畫面會永遠停在「載入中」。
    expect(store.loaded).toBe(true)
  })

  it('晚回來的載入結果不會蓋掉已經切換過去的專案', async () => {
    const slow = deferred<ProjectMember[]>()
    mockList.mockReturnValueOnce(slow.promise)
    mockList.mockResolvedValueOnce([OWNER])
    const store = useMembersStore()

    const first = store.open(PROJECT_A)
    await store.open(PROJECT_B)
    slow.resolve([OWNER, MEMBER])
    await first

    expect(store.projectId).toBe(PROJECT_B)
    expect(store.items).toEqual([OWNER])
  })

  it('邀請成功後把新成員接在名單後面', async () => {
    mockList.mockResolvedValue([OWNER])
    mockAdd.mockResolvedValue(MEMBER)
    const store = useMembersStore()
    await store.open(PROJECT_A)

    await expect(store.invite(' b@example.com ')).resolves.toBe(true)

    // 前後空白要在送出前去掉，否則後端的 EmailStr 會直接回 422。
    expect(mockAdd).toHaveBeenCalledWith(PROJECT_A, 'b@example.com')
    expect(store.items).toEqual([OWNER, MEMBER])
  })

  it.each([
    [404, '找不到這個 email 對應的使用者'],
    [409, '這個使用者已經是專案成員'],
    [403, '只有專案擁有者能執行這個操作'],
  ])('邀請失敗（%i）時名單不變，訊息可以直接顯示', async (status, detail) => {
    mockList.mockResolvedValue([OWNER])
    mockAdd.mockRejectedValue(new ApiError(status, detail))
    const store = useMembersStore()
    await store.open(PROJECT_A)

    await expect(store.invite('b@example.com')).resolves.toBe(false)

    expect(store.items).toEqual([OWNER])
    expect(store.error).toBe(detail)
  })

  it('429 換成使用者看得懂的說法，不直接顯示後端字串', async () => {
    mockList.mockResolvedValue([OWNER])
    mockAdd.mockRejectedValue(new ApiError(429, 'Too Many Requests'))
    const store = useMembersStore()
    await store.open(PROJECT_A)

    await store.invite('b@example.com')

    expect(store.error).toBe('嘗試次數過多，請稍後再試')
  })

  it('移除成功後才把那一列拿掉', async () => {
    mockList.mockResolvedValue([OWNER, MEMBER])
    mockRemove.mockResolvedValue(undefined)
    const store = useMembersStore()
    await store.open(PROJECT_A)

    await expect(store.remove(MEMBER.user_id)).resolves.toBe(true)

    expect(mockRemove).toHaveBeenCalledWith(PROJECT_A, MEMBER.user_id)
    expect(store.items).toEqual([OWNER])
  })

  it('移除失敗時名單原封不動', async () => {
    mockList.mockResolvedValue([OWNER, MEMBER])
    mockRemove.mockRejectedValue(new ApiError(403, '不能移除專案擁有者'))
    const store = useMembersStore()
    await store.open(PROJECT_A)

    await expect(store.remove(OWNER.user_id)).resolves.toBe(false)

    expect(store.items).toEqual([OWNER, MEMBER])
    expect(store.error).toBe('不能移除專案擁有者')
  })

  it('沒有開啟任何專案時，邀請與移除都不會送出請求', async () => {
    const store = useMembersStore()

    await expect(store.invite('b@example.com')).resolves.toBe(false)
    await expect(store.remove(MEMBER.user_id)).resolves.toBe(false)

    expect(mockAdd).not.toHaveBeenCalled()
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('close 清掉狀態，下次開啟不會看到上一個專案的殘影', async () => {
    mockList.mockResolvedValue([OWNER, MEMBER])
    const store = useMembersStore()
    await store.open(PROJECT_A)

    store.close()

    expect(store.projectId).toBeNull()
    expect(store.items).toEqual([])
    expect(store.loaded).toBe(false)
  })
})
