import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import PrimeVue from 'primevue/config'
import Dialog from 'primevue/dialog'
import DocumentImportDialog from './DocumentImportDialog.vue'

type Props = { visible?: boolean; loading?: boolean; errorMessage?: string; cloud?: boolean }

let wrapper: VueWrapper | null = null

/** Dialog 會 teleport 到 body；Portal 在 mounted 之後才掛上內容，要多等一個 tick。 */
async function mountDialog(props: Props = {}): Promise<VueWrapper> {
  wrapper = mount(DocumentImportDialog, {
    props: { visible: true, ...props },
    attachTo: document.body,
    global: { plugins: [PrimeVue], stubs: { transition: false } },
  })
  await nextTick()
  return wrapper
}

function footerButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (el) => el.textContent?.trim() === label,
  )
  if (!button) throw new Error(`找不到按鈕：${label}`)
  return button
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

describe('DocumentImportDialog', () => {
  describe('閒置時', () => {
    it('按取消會關閉', async () => {
      const w = await mountDialog()
      footerButton('取消').click()
      expect(closeRequests(w)).toEqual([[false]])
    })

    it('點遮罩會關閉（沿用遷移前的行為）', async () => {
      const w = await mountDialog()
      clickMask()
      expect(closeRequests(w)).toEqual([[false]])
    })

    it('按選擇檔案會通知 caller 開啟檔案選擇器', async () => {
      const w = await mountDialog()
      footerButton('選擇 JSON 檔案').click()
      expect(w.emitted('choose-file')).toHaveLength(1)
    })
  })

  describe('匯入中', () => {
    it('X、Esc、遮罩、取消都無法關閉', async () => {
      const w = await mountDialog({ loading: true })

      expect(document.body.querySelector('[data-pc-name="pcclosebutton"]')).toBeNull()
      pressEscape()
      clickMask()
      const cancel = footerButton('取消')
      expect(cancel.disabled).toBe(true)
      cancel.click()

      expect(closeRequests(w)).toEqual([])
    })

    it('無法重複送出', async () => {
      const w = await mountDialog({ loading: true })
      const choose = footerButton('選擇 JSON 檔案')
      expect(choose.disabled).toBe(true)
      choose.click()
      expect(w.emitted('choose-file')).toBeUndefined()
    })

    it('caller 在匯入成功時仍可以直接關閉', async () => {
      // DocumentActions 在 importFile 成功後、finally 把 loading 設回 false 之前就關閉對話框。
      const w = await mountDialog({ loading: true })
      await w.setProps({ visible: false })
      expect(w.findComponent(Dialog).props('visible')).toBe(false)
    })
  })

  describe('匯入範圍的說明', () => {
    const LOCAL_TEXT = '匯入 JSON 快照後，會直接取代目前的畫布與留言內容。'
    const CLOUD_TEXT =
      '匯入 JSON 快照後，會直接取代目前的畫布內容。雲端專案的留言不受影響，檔案裡的留言也不會被匯入。'

    function bodyText(): string {
      return document.body.querySelector('.document-import-dialog__text')?.textContent?.trim() ?? ''
    }

    it('沒有傳 cloud 時是本機草稿的說明：畫布與留言都會被取代', async () => {
      await mountDialog()
      expect(bodyText()).toBe(LOCAL_TEXT)
    })

    it('cloud=false 與沒有傳相同', async () => {
      await mountDialog({ cloud: false })
      expect(bodyText()).toBe(LOCAL_TEXT)
    })

    it('cloud=true 時說明只取代畫布，雲端留言不受影響、檔案裡的留言不會被匯入', async () => {
      await mountDialog({ cloud: true })
      expect(bodyText()).toBe(CLOUD_TEXT)
    })
  })

  it('匯入失敗時顯示錯誤訊息', async () => {
    await mountDialog({ errorMessage: '檔案格式不正確。' })
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent?.trim()).toBe('檔案格式不正確。')
  })

  it('沒有錯誤時不顯示錯誤區塊', async () => {
    await mountDialog()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })
})
