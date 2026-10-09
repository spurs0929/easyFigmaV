import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useToolStore } from '@/store/tool'
import { TOOL_GROUPS, ToolGroup, ToolType, matchShortcut, type ToolDef } from '@/types/tool'

type KeyInit = {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  repeat?: boolean
}

/**
 * 建立一個從指定元素發出的 keydown / keyup。
 * 事件要真的 dispatch 過，event.target 才會有值——matchShortcut 靠它判斷是不是輸入框。
 */
function keyEvent(
  type: 'keydown' | 'keyup',
  init: KeyInit,
  target: HTMLElement = document.body,
): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

function keydown(init: KeyInit, target?: HTMLElement): KeyboardEvent {
  return keyEvent('keydown', init, target)
}

const SPACE: KeyInit = { key: ' ', code: 'Space' }

describe('tool store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('單鍵快捷鍵', () => {
    it.each([
      ['v', ToolType.Move],
      ['r', ToolType.Rect],
      ['o', ToolType.Ellipse],
      ['l', ToolType.Line],
      ['f', ToolType.Frame],
      ['p', ToolType.Pen],
      ['t', ToolType.Text],
      ['c', ToolType.Comment],
      ['h', ToolType.Hand],
    ])('%s 切換到 %s', (key, expected) => {
      const store = useToolStore()
      // 先離開預設的 Move，V 那一列才驗得到東西。
      store.setTool(ToolType.Polygon)

      const event = keydown({ key })
      store.handleKeydown(event)

      expect(store.activeTool).toBe(expected)
      expect(event.defaultPrevented).toBe(true)
    })

    it('大寫字母（Caps Lock）一樣會匹配', () => {
      const store = useToolStore()

      store.handleKeydown(keydown({ key: 'R' }))

      expect(store.activeTool).toBe(ToolType.Rect)
    })

    it('沒有對應工具的按鍵不切換，也不擋預設行為', () => {
      const store = useToolStore()

      const event = keydown({ key: 'z' })
      store.handleKeydown(event)

      expect(store.activeTool).toBe(ToolType.Move)
      expect(event.defaultPrevented).toBe(false)
    })
  })

  describe('Ctrl / Cmd 組合', () => {
    // 這些組合都撞到某個工具的單鍵快捷鍵。它們屬於瀏覽器或編輯指令，工具列不該搶。
    const COLLIDING_KEYS = ['c', 'v', 'r', 'p', 's', 'f', 'l', 't', 'o', 'h', 'k']

    it.each(COLLIDING_KEYS)('Ctrl+%s 不切換工具，也不擋預設行為', (key) => {
      const store = useToolStore()
      store.setTool(ToolType.Polygon)

      const event = keydown({ key, ctrlKey: true })
      store.handleKeydown(event)

      expect(store.activeTool).toBe(ToolType.Polygon)
      expect(event.defaultPrevented).toBe(false)
    })

    it.each(COLLIDING_KEYS)('Cmd+%s 不切換工具，也不擋預設行為', (key) => {
      const store = useToolStore()
      store.setTool(ToolType.Polygon)

      const event = keydown({ key, metaKey: true })
      store.handleKeydown(event)

      expect(store.activeTool).toBe(ToolType.Polygon)
      expect(event.defaultPrevented).toBe(false)
    })

    it('Ctrl+Shift+P 不切換到 Pencil', () => {
      const store = useToolStore()

      const event = keydown({ key: 'P', ctrlKey: true, shiftKey: true })
      store.handleKeydown(event)

      expect(store.activeTool).toBe(ToolType.Move)
      expect(event.defaultPrevented).toBe(false)
    })

    it('明確宣告 ctrl: true 的快捷鍵只在 Ctrl/Cmd 按下時匹配', () => {
      const withCtrl: ToolDef = {
        ...TOOL_GROUPS[ToolGroup.Hand][0],
        shortcuts: [{ key: 'j', ctrl: true }],
      }
      const groups = { ...TOOL_GROUPS, [ToolGroup.Hand]: [withCtrl] }

      expect(matchShortcut(keydown({ key: 'j', ctrlKey: true }), groups)).toEqual([withCtrl])
      expect(matchShortcut(keydown({ key: 'j', metaKey: true }), groups)).toEqual([withCtrl])
      expect(matchShortcut(keydown({ key: 'j' }), groups)).toEqual([])
    })
  })

  describe('Shift', () => {
    it('Shift+P 切換到 Pencil', () => {
      const store = useToolStore()

      store.handleKeydown(keydown({ key: 'P', shiftKey: true }))

      expect(store.activeTool).toBe(ToolType.Pencil)
    })

    it('已經是 Pencil 時再按 Shift+P 循環到 Pen，再按一次回到 Pencil', () => {
      const store = useToolStore()
      store.setTool(ToolType.Pencil)

      store.handleKeydown(keydown({ key: 'P', shiftKey: true }))
      expect(store.activeTool).toBe(ToolType.Pen)

      store.handleKeydown(keydown({ key: 'P', shiftKey: true }))
      expect(store.activeTool).toBe(ToolType.Pencil)
    })

    it('沒有宣告 shift 的快捷鍵不在意 Shift：Shift+R 仍切換到 Rectangle', () => {
      const store = useToolStore()

      store.handleKeydown(keydown({ key: 'R', shiftKey: true }))

      expect(store.activeTool).toBe(ToolType.Rect)
    })
  })

  describe('Alt', () => {
    // Alt 的語意這次刻意不動：量距只聽 Alt 鍵本身，不走工具快捷鍵比對。
    it('按住 Alt 時單鍵快捷鍵維持原本行為', () => {
      const store = useToolStore()

      store.handleKeydown(keydown({ key: 'r', altKey: true }))

      expect(store.activeTool).toBe(ToolType.Rect)
    })
  })

  describe('Space 暫時 Hand', () => {
    it('按下切到 Hand，放開回到原本的工具', () => {
      const store = useToolStore()
      store.setTool(ToolType.Rect)

      const down = keydown(SPACE)
      store.handleKeydown(down)
      expect(store.activeTool).toBe(ToolType.Hand)
      expect(down.defaultPrevented).toBe(true)

      store.handleKeyup(keyEvent('keyup', SPACE))
      expect(store.activeTool).toBe(ToolType.Rect)
    })

    it('連按兩次 Space 不會疊兩層 Hand', () => {
      const store = useToolStore()
      store.setTool(ToolType.Rect)

      store.handleKeydown(keydown(SPACE))
      store.handleKeydown(keydown(SPACE))
      store.handleKeyup(keyEvent('keyup', SPACE))

      expect(store.activeTool).toBe(ToolType.Rect)
    })

    it('按住不放的重複 keydown 不會再疊一層', () => {
      const store = useToolStore()
      store.setTool(ToolType.Rect)

      store.handleKeydown(keydown(SPACE))
      store.handleKeydown(keydown({ ...SPACE, repeat: true }))
      store.handleKeyup(keyEvent('keyup', SPACE))

      expect(store.activeTool).toBe(ToolType.Rect)
    })

    it('按住 Space 時切換工具只換底層：仍是 Hand，放開後才是新工具', () => {
      const store = useToolStore()
      store.setTool(ToolType.Rect)
      store.handleKeydown(keydown(SPACE))

      store.setTool(ToolType.Ellipse)
      expect(store.activeTool).toBe(ToolType.Hand)

      store.handleKeyup(keyEvent('keyup', SPACE))
      expect(store.activeTool).toBe(ToolType.Ellipse)
    })

    it('基礎工具本來就是 Hand 時，放開 Space 仍停在 Hand', () => {
      const store = useToolStore()
      store.setTool(ToolType.Hand)

      store.handleKeydown(keydown(SPACE))
      store.handleKeyup(keyEvent('keyup', SPACE))

      expect(store.activeTool).toBe(ToolType.Hand)
    })
  })

  describe('輸入框', () => {
    it.each(['input', 'textarea'])('焦點在 %s 時單鍵不切換工具', (tag) => {
      const store = useToolStore()
      const field = document.createElement(tag)
      document.body.appendChild(field)

      const event = keydown({ key: 'r' }, field)
      store.handleKeydown(event)

      expect(store.activeTool).toBe(ToolType.Move)
      expect(event.defaultPrevented).toBe(false)

      field.remove()
    })
  })

  describe('setTool', () => {
    it('忽略未知的工具類型', () => {
      const store = useToolStore()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      store.setTool('not-a-tool' as ToolType)

      expect(store.activeTool).toBe(ToolType.Move)
      expect(warn).toHaveBeenCalledOnce()
      warn.mockRestore()
    })

    it('記住每個群組最後使用的子工具', () => {
      const store = useToolStore()

      store.setTool(ToolType.Ellipse)
      store.setTool(ToolType.Move)
      store.activateGroup(ToolGroup.Shape)

      expect(store.activeTool).toBe(ToolType.Ellipse)
    })
  })
})
