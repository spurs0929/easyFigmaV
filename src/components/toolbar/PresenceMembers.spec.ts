import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { useAuthStore } from '@/store/auth'
import { usePresenceStore } from '@/store/presence'
import type { PresenceStatus, PresenceUser } from '@/types/presence'
import PresenceMembers from './PresenceMembers.vue'

const PROJECT = '11111111-1111-1111-1111-111111111111'
const ALICE: PresenceUser = { user_id: 'alice', display_name: 'Alice', role: 'owner' }
const BOB: PresenceUser = { user_id: 'bob', display_name: 'bob', role: 'member' }
const NAMELESS: PresenceUser = { user_id: 'anon', display_name: null, role: 'member' }

let pinia: Pinia

/** 直接設定 store 狀態：這裡測的是畫面如何呈現，不是狀態怎麼來的。 */
async function mountWith(status: PresenceStatus, users: PresenceUser[] = []) {
  const presence = usePresenceStore()
  presence.status = status
  presence.users = users
  const wrapper = mount(PresenceMembers, {
    // tooltip 內容不在 DOM 裡，改用 aria-label 驗證同一份文字。
    global: { plugins: [pinia], directives: { tooltip: {} } },
  })
  await nextTick()
  return wrapper
}

function avatarLabels(wrapper: Awaited<ReturnType<typeof mountWith>>): string[] {
  return wrapper
    .findAll('[data-testid="presence-avatar"]')
    .map((node) => node.attributes('aria-label') ?? '')
}

describe('PresenceMembers', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it('顯示 snapshot 裡的使用者與在線人數', async () => {
    const wrapper = await mountWith({ state: 'connected', projectId: PROJECT }, [ALICE, BOB])

    const avatars = wrapper.findAll('[data-testid="presence-avatar"]')
    expect(avatars.map((a) => a.text())).toEqual(['A', 'B'])
    expect(wrapper.get('[data-testid="presence-status"]').text()).toBe('2')
    expect(wrapper.get('[data-testid="presence-members"]').attributes('aria-label')).toBe(
      '在線 2 人',
    )
  })

  it('display_name 與角色正確呈現，沒有名字時有替代文字', async () => {
    const wrapper = await mountWith({ state: 'connected', projectId: PROJECT }, [
      ALICE,
      BOB,
      NAMELESS,
    ])

    expect(avatarLabels(wrapper)).toEqual(['Alice · 擁有者', 'bob · 成員', '未命名使用者 · 成員'])
  })

  it('標示目前登入的使用者', async () => {
    useAuthStore().user = {
      id: 'bob',
      email: 'bob@example.com',
      display_name: 'bob',
      created_at: '2026-01-01T00:00:00Z',
    }

    const wrapper = await mountWith({ state: 'connected', projectId: PROJECT }, [ALICE, BOB])

    expect(avatarLabels(wrapper)).toEqual(['Alice · 擁有者', 'bob（你） · 成員'])
  })

  it('超過三人時其餘收成 +N', async () => {
    const extra: PresenceUser[] = ['c', 'd'].map((id) => ({
      user_id: id,
      display_name: id.toUpperCase(),
      role: 'member',
    }))
    const wrapper = await mountWith({ state: 'connected', projectId: PROJECT }, [
      ALICE,
      BOB,
      NAMELESS,
      ...extra,
    ])

    expect(wrapper.findAll('[data-testid="presence-avatar"]')).toHaveLength(3)
    expect(wrapper.text()).toContain('+2')
    expect(wrapper.get('[data-testid="presence-status"]').text()).toBe('5')
  })

  it('重連中保留名單並標示狀態', async () => {
    const wrapper = await mountWith(
      { state: 'reconnecting', projectId: PROJECT, attempt: 1, delayMs: 1000 },
      [ALICE],
    )

    const root = wrapper.get('[data-testid="presence-members"]')
    expect(root.classes()).toContain('is-reconnecting')
    expect(root.attributes('aria-label')).toBe('在線成員：重新連線中…')
    expect(avatarLabels(wrapper)).toEqual(['Alice · 擁有者'])
  })

  it('idle（本機草稿或未連線）時完全不渲染', async () => {
    const wrapper = await mountWith({ state: 'idle' })

    expect(wrapper.find('[data-testid="presence-members"]').exists()).toBe(false)
  })

  it('終止狀態只留下一個小標示，不顯示名單也不蓋住其他內容', async () => {
    const wrapper = await mountWith({
      state: 'stopped',
      projectId: PROJECT,
      reason: 'project_unavailable',
    })

    const root = wrapper.get('[data-testid="presence-members"]')
    expect(root.classes()).toContain('is-stopped')
    expect(root.attributes('aria-label')).toBe('在線成員目前無法取得')
    expect(wrapper.findAll('[data-testid="presence-avatar"]')).toHaveLength(0)
    // 不用對話框或遮罩呈現錯誤。
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('.p-dialog-mask').exists()).toBe(false)
  })
})
