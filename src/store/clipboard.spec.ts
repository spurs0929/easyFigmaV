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

  it.each(['copy', 'cut'] as const)(
    'write（%s）之後可以讀到帶版本號與來源的內容，內容原封不動',
    (origin) => {
      const elements = tree('a', 'b')

      clipboard.write(elements, origin)

      expect(clipboard.read()).toEqual({ version: CLIPBOARD_FORMAT_VERSION, origin, elements })
      expect(clipboard.read()!.elements).toBe(elements)
    },
  )

  it('內容不會被包成 reactive proxy', () => {
    clipboard.write(tree('a'), 'copy')

    expect(isReactive(clipboard.read())).toBe(false)
    expect(isReactive(clipboard.read()!.elements)).toBe(false)
  })

  it('新的 write 取代舊內容與來源', () => {
    clipboard.write(tree('a'), 'cut')
    const second = tree('b')

    clipboard.write(second, 'copy')

    expect(clipboard.read()).toMatchObject({ origin: 'copy', elements: second })
  })

  it('nextPasteNumber 只讀取、不改變計數；recordPaste 之後才前進', () => {
    clipboard.write(tree('a'), 'copy')

    expect([clipboard.nextPasteNumber(), clipboard.nextPasteNumber()]).toEqual([1, 1])
    clipboard.recordPaste()
    expect(clipboard.nextPasteNumber()).toBe(2)
    clipboard.recordPaste()
    clipboard.recordPaste()
    expect(clipboard.nextPasteNumber()).toBe(4)
  })

  it('新的 write 讓貼上次數歸零', () => {
    clipboard.write(tree('a'), 'copy')
    clipboard.recordPaste()
    clipboard.recordPaste()

    clipboard.write(tree('b'), 'cut')

    expect(clipboard.nextPasteNumber()).toBe(1)
  })

  it('clear 清空內容；之後再 write，貼上次數從 1 開始', () => {
    clipboard.write(tree('a'), 'copy')
    clipboard.recordPaste()
    clipboard.recordPaste()

    clipboard.clear()

    expect(clipboard.read()).toBeNull()
    clipboard.write(tree('a'), 'copy')
    expect(clipboard.nextPasteNumber()).toBe(1)
  })
})
