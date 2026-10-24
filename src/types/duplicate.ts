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
 * 依文件樹的繪製順序替每個「從 rootIds 走得到」的元素編號（前序：父元素先於子元素，
 * 同一層依 childIds / rootIds 由下到上）。走不到的元素（不在樹上的孤兒）不會出現在結果裡。
 * 以 visited 擋住循環參照與同一個子元素掛在多個父元素底下的情況。
 */
function layerOrder(store: ElementStore): Map<string, number> {
  const order = new Map<string, number>()
  const visit = (id: string): void => {
    const el = store.byId[id]
    if (!el || order.has(id)) return
    order.set(id, order.size)
    for (const childId of el.childIds) visit(childId)
  }
  for (const id of store.rootIds) visit(id)
  return order
}

/** 沿 parentId 往上走過的所有祖先 id（不含自己）；遇到循環或斷掉的鏈就停。 */
function ancestorIds(store: ElementStore, el: CanvasElement): string[] {
  const result: string[] = []
  const seen = new Set<string>([el.id])
  let parentId = el.parentId
  while (parentId !== undefined && !seen.has(parentId)) {
    const parent = store.byId[parentId]
    if (!parent) break
    result.push(parentId)
    seen.add(parentId)
    parentId = parent.parentId
  }
  return result
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
 *   childIds 裡指到不存在元素的 id 直接丟掉，不會帶進複本。
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
  // 已經複製過的原件。除了上面的祖先 / 子孫，也擋住不一致的樹裡同一個元素被複製兩次。
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
      if (!child || copied.has(childId)) continue
      copy.childIds.push(copySubtree(child, copy.id).id)
    }
    return copy
  }

  for (const id of requested) {
    if (copied.has(id)) continue
    const source = store.byId[id]
    let x = source.x
    let y = source.y
    for (const ancestorId of ancestorIds(store, source)) {
      x += store.byId[ancestorId].x
      y += store.byId[ancestorId].y
    }

    const copy = copySubtree(source, undefined)
    copy.name = options.rename(source.name)
    copy.x = x + options.offset.x
    copy.y = y + options.offset.y
    rootIds.push(copy.id)
  }

  return { elements, rootIds }
}
