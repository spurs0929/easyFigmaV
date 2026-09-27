import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import PrimeVue from 'primevue/config'
import Dialog from 'primevue/dialog'
import AppDialog from './AppDialog.vue'

type AppDialogProps = {
  busy?: boolean
  dismissible?: boolean
  dismissableMask?: boolean
  width?: string
}

let wrapper: VueWrapper | null = null

/**
 * PrimeVue Dialog 會 teleport 到 body，所以查詢都走 document；
 * Portal 在 mounted 之後才掛上內容，要多等一個 tick。
 * transition 不 stub：Esc listener 是在 transition 的 onEnter 才綁上去的。
 */
async function mountDialog(
  props: AppDialogProps = {},
  slots: Record<string, string> = { default: '<p>內容</p>' },
): Promise<VueWrapper> {
  wrapper = mount(AppDialog, {
    props: { visible: true, header: '標題', ...props },
    slots,
    attachTo: document.body,
    global: { plugins: [PrimeVue], stubs: { transition: false } },
  })
  await nextTick()
  return wrapper
}

function closeButton(): HTMLElement | null {
  return document.body.querySelector('[data-pc-name="pcclosebutton"]')
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }))
}

function clickMask(): void {
  const mask = document.body.querySelector('[data-pc-section="mask"]')
  if (!mask) throw new Error('找不到 Dialog 遮罩')
  mask.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  mask.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

function closeRequests(w: VueWrapper): unknown[][] {
  return w.emitted('update:visible') ?? []
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('AppDialog', () => {
  it('固定為 modal 且不可拖曳', async () => {
    const w = await mountDialog()
    const dialog = w.findComponent(Dialog)
    expect(dialog.props('modal')).toBe(true)
    expect(dialog.props('draggable')).toBe(false)
  })

  describe('一般狀態', () => {
    it('按 X 會送出關閉', async () => {
      const w = await mountDialog()
      const button = closeButton()
      expect(button).not.toBeNull()
      button?.click()
      expect(closeRequests(w)).toEqual([[false]])
    })

    it('按 Esc 會送出關閉', async () => {
      const w = await mountDialog()
      pressEscape()
      expect(closeRequests(w)).toEqual([[false]])
    })
  })

  it('沒指定 width 時使用預設寬度，指定時套用 caller 的值', async () => {
    const w = await mountDialog()
    const dialogStyle = () => w.findComponent(Dialog).vm.$attrs.style
    expect(dialogStyle()).toEqual({ width: 'min(420px, 92vw)' })

    await w.setProps({ width: 'min(30rem, calc(100vw - 2rem))' })
    expect(dialogStyle()).toEqual({ width: 'min(30rem, calc(100vw - 2rem))' })
  })

  describe('遮罩關閉由 caller 決定', () => {
    it('預設點遮罩不會關閉', async () => {
      const w = await mountDialog()
      clickMask()
      expect(closeRequests(w)).toEqual([])
    })

    it('dismissableMask=true 時點遮罩會送出關閉', async () => {
      const w = await mountDialog({ dismissableMask: true })
      clickMask()
      expect(closeRequests(w)).toEqual([[false]])
    })
  })

  describe.each<[string, AppDialogProps]>([
    ['busy=true', { busy: true }],
    ['dismissible=false', { dismissible: false }],
  ])('%s', (_label, props) => {
    it('不顯示 X', async () => {
      await mountDialog(props)
      expect(closeButton()).toBeNull()
    })

    it('按 Esc 不會關閉', async () => {
      const w = await mountDialog(props)
      pressEscape()
      expect(closeRequests(w)).toEqual([])
    })

    it('即使 dismissableMask=true，點遮罩也不會關閉', async () => {
      const w = await mountDialog({ ...props, dismissableMask: true })
      clickMask()
      expect(closeRequests(w)).toEqual([])
    })

    it('攔截內層 Dialog 的 update:visible(false)', async () => {
      const w = await mountDialog(props)
      w.findComponent(Dialog).vm.$emit('update:visible', false)
      expect(closeRequests(w)).toEqual([])
    })
  })

  describe('update:visible 攔截', () => {
    it('一般狀態下把內層 Dialog 的關閉轉發出去', async () => {
      const w = await mountDialog()
      w.findComponent(Dialog).vm.$emit('update:visible', false)
      expect(closeRequests(w)).toEqual([[false]])
    })

    it('開啟途中才變成 busy 時，Esc 也會被擋下', async () => {
      const w = await mountDialog()
      await w.setProps({ busy: true })
      pressEscape()
      expect(closeRequests(w)).toEqual([])
    })

    it('busy 結束後恢復可關閉', async () => {
      const w = await mountDialog({ busy: true })
      await w.setProps({ busy: false })
      w.findComponent(Dialog).vm.$emit('update:visible', false)
      expect(closeRequests(w)).toEqual([[false]])
    })
  })

  it('沒有 #footer 時不渲染 footer 區塊', async () => {
    await mountDialog()
    expect(document.body.querySelector('[data-pc-section="footer"]')).toBeNull()
  })

  it('#footer 內容會渲染進 Dialog footer', async () => {
    await mountDialog({}, { footer: '<button class="custom-action">動作</button>' })
    expect(document.body.querySelector('[data-pc-section="footer"] .custom-action')).not.toBeNull()
  })
})
