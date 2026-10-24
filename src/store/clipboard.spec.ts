import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { isReactive } from 'vue'
import { CLIPBOARD_FORMAT_VERSION, useClipboardStore } from '@/store/clipboard'
import { ElementKind, type CanvasElement, type ElementStore } from '@/types/element'

function rect(id: string): CanvasElement {
  return {
    id,
    kind: ElementKind.Rect,
    name: id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    fill: { type: 'solid', color: '#ffffff' },
    stroke: { type: 'solid', color: '#000000' },
    strokeWidth: 1,
    opacity: 1,
    visible: true,
    locked: false,
    parentId: undefined,
    childIds: [],
  }
}

function tree(...ids: string[]): ElementStore {
  return { byId: Object.fromEntries(ids.map((id) => [id, rect(id)])), rootIds: ids }
}

describe('useClipboardStore', () => {
  let clipboard: ReturnType<typeof useClipboardStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    clipboard = useClipboardStore()
  })

  it('一開始是空的', () => {
    expect(clipboard.read()).toBeNull()
  })

  it('write 之後可以讀到帶版本號的內容，內容原封不動', () => {
    const elements = tree('a', 'b')

    clipboard.write(elements)

    expect(clipboard.read()).toEqual({ version: CLIPBOARD_FORMAT_VERSION, elements })
    expect(clipboard.read()!.elements).toBe(elements)
  })

  it('內容不會被包成 reactive proxy', () => {
    clipboard.write(tree('a'))

    expect(isReactive(clipboard.read())).toBe(false)
    expect(isReactive(clipboard.read()!.elements)).toBe(false)
  })

  it('新的 write 取代舊內容', () => {
    clipboard.write(tree('a'))
    const second = tree('b')

    clipboard.write(second)

    expect(clipboard.read()!.elements).toBe(second)
  })

  it('recordPaste 從 1 開始逐次遞增；新的 write 歸零', () => {
    clipboard.write(tree('a'))
    expect([clipboard.recordPaste(), clipboard.recordPaste(), clipboard.recordPaste()]).toEqual([
      1, 2, 3,
    ])

    clipboard.write(tree('b'))
    expect(clipboard.recordPaste()).toBe(1)
  })

  it('clear 清空內容；之後再 write，貼上次數從 1 開始', () => {
    clipboard.write(tree('a'))
    clipboard.recordPaste()
    clipboard.recordPaste()

    clipboard.clear()

    expect(clipboard.read()).toBeNull()
    clipboard.write(tree('a'))
    expect(clipboard.recordPaste()).toBe(1)
  })
})
