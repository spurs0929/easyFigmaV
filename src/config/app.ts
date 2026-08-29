/**
 * 應用程式層級的行為參數。
 *
 * 這些參數不隨部署環境改變，集中管理以避免 magic numbers
 * 散落於各模組。
 */

/**
 * 單一 API 請求的逾時。
 *
 * 原生 fetch 沒有預設逾時，因此設定上限以避免請求長時間 pending。
 * 目前保留較寬裕的時間以容納後端冷啟動。
 */
export const API_TIMEOUT_MS = 45_000

/**
 * refresh 收到 409 時的最大重試次數。
 *
 * 409 表示 refresh token 已被其他並行請求輪替。
 * 有限重試可處理正常競態，同時避免異常狀況下持續重試。
 */
export const REFRESH_MAX_RETRIES = 2

/**
 * refresh 409 重試的基礎延遲。
 *
 * 重試採遞增延遲，避免並行 refresh 發生衝突後立即再次競爭。
 */
export const REFRESH_RETRY_DELAY_MS = 150
