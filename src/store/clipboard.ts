import { markRaw, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { useAuthStore } from '@/store/auth'
import type { ElementStore } from '@/types/element'

/** Clipboard 資料格式的版本。格式改變時遞增；之後接上系統剪貼簿時，用來辨識讀進來的內容。 */
export const CLIPBOARD_FORMAT_VERSION = 2 as const

/**
 * Clipboard 裡的一份內容：被複製的元素整理成一棵自成一體的樹。
 *
 * - elements 由複製核心（duplicateElements）產生：id 只在 Clipboard 內有效，不是來源文件的 id；
 *   頂層元素是根層級、座標是絕對座標。不參照來源文件的任何元素、專案或權限，來源被刪除、
 *   換了專案都不影響貼上。
 * - 每次貼上都會再交給複製核心產生全新的 id，Clipboard 本身不會被修改，也不會進入文件。
 */
export interface ClipboardPayload {
  readonly version: typeof CLIPBOARD_FORMAT_VERSION
  /**
   * 內容從哪裡來：copy 表示建立複本，貼上時名稱加「 copy」；cut 表示移動內容，
   * 貼上時保留原名（重複貼上也一樣）。
   */
  readonly origin: ClipboardOrigin
  readonly elements: ElementStore
}

export type ClipboardOrigin = 'copy' | 'cut'

/**
 * 編輯器的記憶體 Clipboard（Ctrl/Cmd+C、Ctrl/Cmd+X、Ctrl/Cmd+V）。
 *
 * 刻意與文件狀態分開：不進 document snapshot、Undo history、IndexedDB、localStorage、
 * 雲端文件。Copy 不產生 history；Undo / Redo 貼上或剪下都不會清空或改變 Clipboard。
 * 重新整理頁面就會消失。
 *
 * 與瀏覽器的系統剪貼簿是分開的兩份：反白文字後按 Ctrl+C 寫入的是系統剪貼簿，
 * 畫布上的 Ctrl+V 只讀這裡，貼上的仍是最後一次在畫布上複製或剪下的元素。
 *
 * 登入身分改變時清空（見下方的 watch）：已登入的使用者登出、或換成另一位使用者，
 * 前一位使用者複製的內容不能留給下一個坐在電腦前的人。同一位使用者切換專案、
 * refresh token 輪替、以及未登入時複製之後才登入，都保留。
 */
export const useClipboardStore = defineStore('clipboard', () => {
  // shallowRef + markRaw：payload 寫入後就不再改動，不需要也不應該被包成 reactive proxy。
  const _payload = shallowRef<ClipboardPayload | null>(null)
  // 目前這份內容已經貼上過幾次；換新內容或清空時歸零。
  let _pasteCount = 0

  /** 以新內容取代 Clipboard，貼上次數歸零。 */
  function write(elements: ElementStore, origin: ClipboardOrigin): void {
    _payload.value = markRaw({ version: CLIPBOARD_FORMAT_VERSION, origin, elements })
    _pasteCount = 0
  }

  /**
   * 目前的內容；空的時候回傳 null。
   *
   * 內容只會由 write 寫入、只存在記憶體，所以版本一定是目前的版本。之後若接上瀏覽器的
   * 系統剪貼簿，從外部讀進來的內容要在那裡先檢查 version，不符就當成空的。
   */
  function read(): ClipboardPayload | null {
    return _payload.value
  }

  /**
   * 下一次貼上是目前這份內容的第幾次（從 1 開始），只讀取、不改變計數。
   * 用來讓連續貼上逐次往右下錯開，不會疊在同一個位置。
   */
  function nextPasteNumber(): number {
    return _pasteCount + 1
  }

  /** 貼上真的加進文件之後才呼叫，記下又貼上了一次。 */
  function recordPaste(): void {
    _pasteCount++
  }

  /** 清空 Clipboard。貼上次數在下一次 write 時歸零。 */
  function clear(): void {
    _payload.value = null
  }

  // 判斷的是「使用者 id」，不是 session 物件：refresh token 輪替時 api 層會以同一位使用者
  // 重新通知、換一個新的 user 物件，id 不變就不算身分改變。
  // 只在「原本有登入的使用者」不見了（登出、session 失效、silent refresh 失敗）或換人時清空；
  // 原本未登入（null）→ 登入，保留未登入時複製的內容。
  // flush: 'sync'：身分一改變就清空，不等到下一個 tick，中間不會有機會貼上前一位的內容。
  const authStore = useAuthStore()
  watch(
    () => authStore.user?.id ?? null,
    (userId, previousUserId) => {
      if (previousUserId !== null && userId !== previousUserId) clear()
    },
    { flush: 'sync' },
  )

  return { write, read, nextPasteNumber, recordPaste, clear }
})
