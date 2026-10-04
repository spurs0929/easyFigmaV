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

/**
 * Presence 斷線重連的第一次延遲。之後每次加倍（1s → 2s → 4s …）。
 *
 * 不是固定間隔：server 重啟或 Render 冷啟動時，所有 client 會同時斷線，
 * 固定且很短的間隔等於一起打一個還沒起來的服務。
 */
export const PRESENCE_RECONNECT_BASE_DELAY_MS = 1_000

/**
 * Presence 重連延遲的上限。
 *
 * 不設次數上限：presence 只是輔助資訊，斷線時持續低頻重試即可，
 * 放棄重連反而需要另一套 UI 讓使用者手動恢復。
 */
export const PRESENCE_RECONNECT_MAX_DELAY_MS = 30_000

/**
 * 送出自己游標位置的最小間隔（約 20 則 / 秒）。
 *
 * mousemove 每秒可以觸發上百次，全部送出只是讓對方重畫他來不及看的位置。
 * 節流只保留最新的一點：間隔內的移動不會排隊，停下來之後一定會補送最後的位置。
 * server 沒有頻率限制，這裡是唯一的節流。
 */
export const PRESENCE_CURSOR_THROTTLE_MS = 50
