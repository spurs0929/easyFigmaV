// ── Delay ─────────────────────────────────────────────────────────────────────
/**
 * Tooltip 顯示延遲（ms）。
 * - action：可點擊按鈕的說明，延遲較長，避免滑鼠掃過工具列時一直跳出。
 * - status：只供查看的狀態資訊（存檔狀態、在線成員），hover 就是為了看它，延遲較短。
 */
export const TOOLTIP_DELAY = {
  action: 400,
  status: 300,
} as const

// ── Pass Through ──────────────────────────────────────────────────────────────
export const TOOLBAR_TOOLTIP_PT = { root: 'toolbar-tooltip' } as const
