import { cloneCanvasElementSnapshot } from '@/types/document'
import { newElementId, type CanvasElement, type ElementStore } from '@/types/element'

/**
 * 複製元素的共用核心（純函式）：Ctrl+D 目前使用，之後的 Copy / Paste 沿用同一份實作。
 *
 * 不讀寫任何 store、不產生 history；呼叫端拿回結果後自己決定怎麼寫入文件
 * （例如 elementStore.addAll，整批一筆 undo）。
 */

export interface DuplicateOptions {
  /** 加在每個頂層複本絕對座標上的位移；子孫的座標相對於父元素，不受影響。 */
  offset: { x: number; y: number }
  /** 頂層複本的名稱；子孫保留原名。 */
  rename: (name: string) => string
  /** 產生新 id；預設 newElementId（crypto.randomUUID），測試可注入固定序列。 */
  newId?: () => string
}

export interface DuplicateResult {
  /**
   * 所有新元素：每個頂層複本後面緊接著它的完整子樹（前序）。
   * 頂層複本的 parentId 是 undefined，依原本的圖層順序（由下到上）排列，
   * 所以直接交給 elementStore.addAll，複本在 rootIds 裡的相對順序與原件相同。
   */
  elements: CanvasElement[]
  /** 頂層複本的 id，順序同 elements（由下到上）。 */
  rootIds: string[]
}

/**
 * el 是否真的是 parentId 的子元素（parentId 為 undefined 表示根層級）。
 *
 * 只有 childIds（或 rootIds）列了它、而且它自己的 parentId 也指回來，才算數。
 * 雙向不一致的關聯一律略過、不修復：畫布的 absoluteCoords 沿 parentId 計算位置，
 * 只看 childIds 會把元素複製到畫面上不屬於它的父元素底下。
 */
function isChildOf(
  el: CanvasElement | undefined,
  parentId: string | undefined,
): el is CanvasElement {
  return el !== undefined && el.parentId === parentId
}

/**
 * 依文件樹的繪製順序替每個「從 rootIds 走得到」的元素編號（前序：父元素先於子元素，
 * 同一層依 childIds / rootIds 由下到上）。只沿雙向一致的關聯往下走（見 isChildOf），
 * 走不到的元素（不在樹上的孤兒、只被不一致的關聯指到的元素）不會出現在結果裡。
 * 以 visited 擋住同一個 id 在 childIds / rootIds 裡重複出現的情況。
 */
function layerOrder(store: ElementStore): Map<string, number> {
  const order = new Map<string, number>()
  const visit = (id: string, parentId: string | undefined): void => {
    const el = store.byId[id]
    if (!isChildOf(el, parentId) || order.has(id)) return
    order.set(id, order.size)
    for (const childId of el.childIds) visit(childId, id)
  }
  for (const id of store.rootIds) visit(id, undefined)
  return order
}

/**
 * 元素在畫布上的絕對位置：沿 parentId 累加每一層祖先的 x / y（與畫布的 absoluteCoords 一致）。
 *
 * 只用在 layerOrder 走得到的元素上。這些元素是沿雙向一致的關聯從根層級走下來的，
 * parentId 鏈一定一路接回根層級，所以不需要循環或斷鏈的保護。
 */
function absolutePosition(store: ElementStore, el: CanvasElement): { x: number; y: number } {
  let x = el.x
  let y = el.y
  let parentId = el.parentId
  while (parentId !== undefined) {
    const parent = store.byId[parentId]
    x += parent.x
    y += parent.y
    parentId = parent.parentId
  }
  return { x, y }
}

/**
 * 複製 ids 指到的元素（含各自的完整子樹），回傳一批可以直接加入文件的新元素。
 *
 * - 選取正規化：不存在、重複、或不在文件樹上的 id 略過；祖先與子孫同時被選取時只複製祖先
 *   （子孫已經在祖先的子樹裡，不會被複製兩次）。
 * - 頂層複本一律放在根層級：群組內的子元素被單獨複製時，座標轉成絕對座標
 *   （沿 parentId 累加各層祖先的 x / y，與畫布的 absoluteCoords 一致；群組的 rotation
 *   不套用到子元素，畫布也不套用），再加上 offset，並重新命名。
 * - 子孫遞迴複製任意深度：全部換新 id、重建 parentId / childIds，座標維持相對父元素。
 *   只複製雙向一致的子元素（childIds 列了它、它的 parentId 也指回來，見 isChildOf）；
 *   指到不存在的元素、或 parentId 指向別處的 id 直接略過。不會修改原始文件，
 *   也不會反過來搜尋 parentId 指向自己、卻沒列在 childIds 裡的元素來補上。
 * - 深拷貝：用 cloneCanvasElementSnapshot（與存檔相同的欄位），複本與原件不共用
 *   fill、stroke、points、vectorPoints、childIds 等任何物件或陣列。
 * - 頂層複本依原件的圖層順序排列（與選取的先後無關）。
 *
 * 沒有任何可複製的元素時回傳空結果。
 */
export function duplicateElements(
  store: ElementStore,
  ids: readonly string[],
  options: DuplicateOptions,
): DuplicateResult {
  const newId = options.newId ?? newElementId
  const order = layerOrder(store)

  // 依前序排序：祖先一定排在子孫前面。祖先先被處理時整棵子樹都會記進 copied，
  // 輪到同時被選取的子孫時直接略過，所以祖先與子孫同時選取只會複製祖先一次。
  const requested = ids.filter((id) => order.has(id)).sort((a, b) => order.get(a)! - order.get(b)!)

  const elements: CanvasElement[] = []
  const rootIds: string[] = []
  // 已經複製過的原件。除了上面的祖先 / 子孫，也擋住同一個 childIds 裡重複列出的 id。
  const copied = new Set<string>()

  /** 複製 source 與它的整棵子樹（前序推入 elements），回傳 source 的複本。 */
  const copySubtree = (source: CanvasElement, parentId: string | undefined): CanvasElement => {
    copied.add(source.id)
    const copy = cloneCanvasElementSnapshot(source)
    copy.id = newId()
    copy.parentId = parentId
    copy.childIds = []
    elements.push(copy)
    for (const childId of source.childIds) {
      const child = store.byId[childId]
      if (!isChildOf(child, source.id) || copied.has(childId)) continue
      copy.childIds.push(copySubtree(child, copy.id).id)
    }
    return copy
  }

  for (const id of requested) {
    if (copied.has(id)) continue
    const source = store.byId[id]
    const { x, y } = absolutePosition(store, source)

    const copy = copySubtree(source, undefined)
    copy.name = options.rename(source.name)
    copy.x = x + options.offset.x
    copy.y = y + options.offset.y
    rootIds.push(copy.id)
  }

  return { elements, rootIds }
}
