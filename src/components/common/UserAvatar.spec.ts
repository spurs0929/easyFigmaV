import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import UserAvatar from './UserAvatar.vue'

function initialOf(name: string): string {
  return mount(UserAvatar, { props: { name } }).text()
}

describe('UserAvatar', () => {
  it('取名字的第一個字並轉大寫', () => {
    expect(initialOf('alice')).toBe('A')
  })

  it('忽略前後空白', () => {
    expect(initialOf('  bob ')).toBe('B')
  })

  it('中文名字取第一個字', () => {
    expect(initialOf('王小明')).toBe('王')
  })

  it('emoji 不會被切成半個字元', () => {
    expect(initialOf('🐱 cat')).toBe('🐱')
  })

  it('空名字顯示 ?', () => {
    expect(initialOf('')).toBe('?')
    expect(initialOf('   ')).toBe('?')
  })

  it('呼叫端的 class 與屬性落在 root 上', () => {
    const wrapper = mount(UserAvatar, {
      props: { name: 'Alice' },
      attrs: { class: 'account-avatar', 'aria-label': 'Alice' },
    })

    expect(wrapper.classes()).toEqual(expect.arrayContaining(['user-avatar', 'account-avatar']))
    expect(wrapper.attributes('aria-label')).toBe('Alice')
  })
})
