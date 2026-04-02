import { defineStore } from 'pinia'
import { ref, computed, readonly } from 'vue'
import { clampZoom } from '@/constants/canvas'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Viewport {
  x:     number  // stage offset X（screen coords）
  y:     number  // stage offset Y（screen coords）
  scale: number  // zoom factor，由 clampZoom 保證在 [ZOOM_MIN, ZOOM_MAX]
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useViewportStore = defineStore('viewport', () => {
  const _vp            = ref<Viewport>({ x: 0, y: 0, scale: 1 })
  const _containerSize = ref({ w: 0, h: 0 })

  // ── Computed ─────────────────────────────────────────────────────────────────

  /**
   * 以 readonly() 包裝，防止消費端直接對屬性賦值（store.viewport.x = 999）。
   * 注意：readonly() 開發模式發出 warning，production build 靜默失敗，
   * 不提供執行期強制保護。所有寫入請透過 action。
   */
  const viewport      = computed(() => readonly(_vp.value))
  const containerSize = computed(() => readonly(_containerSize.value))

  // ── Private helper ────────────────────────────────────────────────────────────

  /**
   * 縮放的核心邏輯，zoom / zoomTo 共用以消除重複。
   *
   * 完整輸入防禦（所有輸入在此統一處理，呼叫方不需重複防禦）：
   * - originX / originY 非有限值 → 提前 return
   * - oldScale === 0              → 提前 return，防止除以零
   * - rawScale 由 clampZoom 處理（NaN / Infinity / 負數 → ZOOM_MIN）
   */
  function _applyZoom(rawScale: number, originX: number, originY: number): void {
    if (!isFinite(originX) || !isFinite(originY)) return
    const oldScale = _vp.value.scale
    if (oldScale === 0) return
    const newScale = clampZoom(rawScale)
    const f        = newScale / oldScale
    _vp.value = {
      scale: newScale,
      x:     originX - (originX - _vp.value.x) * f,
      y:     originY - (originY - _vp.value.y) * f,
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  /**
   * 設定容器尺寸。負數、NaN、Infinity 靜默忽略，
   * 避免後續依賴 containerSize 的計算（如 fit-to-screen）產生無效結果。
   */
  function setContainerSize(w: number, h: number): void {
    if (w <= 0 || h <= 0 || !isFinite(w) || !isFinite(h)) return
    _containerSize.value = { w, h }
  }

  /**
   * 以 delta 平移畫布（screen coords）。
   * NaN / Infinity 靜默忽略，防止手勢計算異常污染座標。
   */
  function pan(dx: number, dy: number): void {
    if (!isFinite(dx) || !isFinite(dy)) return
    _vp.value = { ..._vp.value, x: _vp.value.x + dx, y: _vp.value.y + dy }
  }

  /**
   * 直接設定畫布偏移的絕對位置。不改變 scale，適用於平移手勢需要絕對定位的場景。
   * NaN / Infinity 靜默忽略。
   */
  function setPan(x: number, y: number): void {
    if (!isFinite(x) || !isFinite(y)) return
    _vp.value = { ..._vp.value, x, y }
  }

  /**
   * 以相對 factor 縮放，保持 (originX, originY) 螢幕座標在縮放後不移動。
   * factor ≤ 0、NaN、Infinity 靜默忽略（與 pan 的行為策略一致）。
   * originX / originY 的防禦由 _applyZoom 統一處理。
   */
  function zoom(factor: number, originX: number, originY: number): void {
    if (!isFinite(factor) || factor <= 0) return
    _applyZoom(_vp.value.scale * factor, originX, originY)
  }

  /**
   * 縮放至絕對 scale 值，直接設定以保證精確落地（如「100%」按鈕傳入 1）。
   * 不透過 factor 間接計算，避免浮點累積誤差。
   * originX / originY 的防禦由 _applyZoom 統一處理。
   */
  function zoomTo(targetScale: number, originX: number, originY: number): void {
    _applyZoom(targetScale, originX, originY)
  }

  /**
   * 螢幕座標 → 世界座標（canvas world space）。
   * sx / sy 為非有限值，或 scale 為 0 時，回傳 { x: 0, y: 0 }。
   */
  function toWorld(sx: number, sy: number): { x: number; y: number } {
    if (!isFinite(sx) || !isFinite(sy)) return { x: 0, y: 0 }
    const { x, y, scale } = _vp.value
    if (scale === 0) return { x: 0, y: 0 }
    return { x: (sx - x) / scale, y: (sy - y) / scale }
  }

  /**
   * 世界座標 → 螢幕座標（toWorld 的逆運算）。
   * wx / wy 為非有限值時回傳 { x: 0, y: 0 }，與 toWorld 防禦策略對稱。
   */
  function toScreen(wx: number, wy: number): { x: number; y: number } {
    if (!isFinite(wx) || !isFinite(wy)) return { x: 0, y: 0 }
    const { x, y, scale } = _vp.value
    return { x: wx * scale + x, y: wy * scale + y }
  }

  /** 重置畫布至原始位置與縮放比例。 */
  function reset(): void {
    _vp.value = { x: 0, y: 0, scale: 1 }
  }

  return {
    viewport,
    containerSize,
    setContainerSize,
    pan,
    setPan,
    zoom,
    zoomTo,
    toWorld,
    toScreen,
    reset,
  }
})
