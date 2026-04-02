// ── Zoom ──────────────────────────────────────────────────────────────────────
export const ZOOM_STEP = 1.1
export const ZOOM_MIN  = 0.05
export const ZOOM_MAX  = 100

/**
 * 將 scale 夾至合法縮放範圍。
 * 對 NaN / Infinity 等非有限值一律回傳 ZOOM_MIN，避免靜默傳播。
 */
export function clampZoom(scale: number): number {
  if (!isFinite(scale)) return ZOOM_MIN
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

// ── Stroke ────────────────────────────────────────────────────────────────────
export const MIN_STROKE_SCREEN_PX       = 0.5
export const SELECTION_STROKE_SCREEN_PX = 1.5

// ── Grid ──────────────────────────────────────────────────────────────────────
export const GRID_SCREEN_STEP = 80

/**
 * 每隔幾條小線畫一條主線。
 *
 * ⚠️ 耦合提醒：此值與 niceStep() 內建的 1 / 2 / 5 倍數系列隱性耦合。
 * 若 niceStep 日後改為支援其他倍數（如 4、8），此常數也需同步評估調整。
 */
export const GRID_MAJOR_EVERY = 5

/**
 * Grid 可見性的雙閾值（hysteresis），避免 scale 在邊界值時閃爍。
 * - scale < GRID_HIDE_BELOW → 隱藏
 * - scale > GRID_SHOW_ABOVE → 顯示
 * - 中間帶 → 維持前一狀態（由 resolveGridVisible 管理）
 */
export const GRID_HIDE_BELOW = 0.14
export const GRID_SHOW_ABOVE = 0.16

/**
 * 根據初始 scale 計算 grid 的初始可見性。
 * 中間帶（GRID_HIDE_BELOW ≤ scale ≤ GRID_SHOW_ABOVE）預設顯示，
 * 因此以 scale >= GRID_HIDE_BELOW 作為初始判斷。
 *
 * @example
 * const gridVisible = ref(initGridVisible(viewport.scale))
 */
export function initGridVisible(scale: number): boolean {
  return scale >= GRID_HIDE_BELOW
}

/**
 * Grid 可見性狀態機（hysteresis reference implementation）。
 * 呼叫端持有 `gridVisible` ref，每次 scale 改變時呼叫此函式更新。
 * 初始值請用 initGridVisible() 取得。
 *
 * @example
 * const gridVisible = ref(initGridVisible(viewport.scale))
 * watch(() => vp.scale, s => { gridVisible.value = resolveGridVisible(s, gridVisible.value) })
 */
export function resolveGridVisible(scale: number, current: boolean): boolean {
  if (scale < GRID_HIDE_BELOW) return false
  if (scale > GRID_SHOW_ABOVE) return true
  return current
}

// ── Colours ───────────────────────────────────────────────────────────────────
export const COLOR_SELECTION    = '#6366f1'
export const COLOR_LOCKED       = '#f59e0b'
export const COLOR_MARQUEE_FILL = 'rgba(99,102,241,0.06)'
export const COLOR_GRID_MAJOR   = 'rgba(148,163,184,0.25)'
export const COLOR_GRID_MINOR   = 'rgba(148,163,184,0.1)'
export const COLOR_GHOST_FILL   = 'rgba(99,102,241,0.08)'

// ── Keyboard ──────────────────────────────────────────────────────────────────
/** 輸入元素 tagName 集合，快捷鍵攔截前先排除。 */
export const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * 遞迴穿透 Shadow DOM，取得真正 focused 的元素。
 * document.activeElement 在 Shadow DOM 內只回傳 shadow host，
 * 不穿透則可能誤攔截在 shadow 內部輸入框時的快捷鍵。
 */
export function getDeepActiveElement(): Element | null {
  let el: Element | null = document.activeElement
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement
  }
  return el
}

/**
 * 回傳 true 表示使用者正在輸入，快捷鍵應讓行。
 *
 * - 涵蓋標準 INPUT / TEXTAREA / SELECT
 * - 以 closest() 向上查找 contenteditable 祖先，
 *   正確處理 `<span>` 在 `<div contenteditable>` 內被 focus 的情境
 * - 建議搭配 getDeepActiveElement() 以正確處理 Shadow DOM
 */
export function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (TYPING_TAGS.has(el.tagName)) return true
  return el.closest('[contenteditable="true"], [contenteditable=""]') !== null
}

// ── Grid step helper ──────────────────────────────────────────────────────────

/**
 * 將 approx 取整為「人類友善」的步距（1、2、5 的冪次倍數）。
 *
 * 合法輸入：有限正數。
 *
 * @throws {RangeError} approx ≤ 0、NaN、Infinity 時拋出，避免靜默 NaN 傳播。
 * @throws {RangeError} approx 極小導致 pow 下溢為 0 時拋出（如 Number.MIN_VALUE）。
 *
 * @example
 * niceStep(60)    // → 50  (r = 60/10 = 6.0，6 < 7.5 → nice=5，5×10=50)
 * niceStep(0.03)  // → 0.02 (r = 0.03/0.01 = 3.0，3 < 3.5 → nice=2，2×0.01=0.02)
 */
export function niceStep(approx: number): number {
  if (!isFinite(approx) || approx <= 0) {
    throw new RangeError(`niceStep requires a finite positive number, got ${approx}`)
  }
  const pow = Math.pow(10, Math.floor(Math.log10(approx)))
  if (pow === 0) {
    throw new RangeError(`approx too small to compute a grid step: ${approx}`)
  }
  const r    = approx / pow
  const nice = r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10
  return nice * pow
}
