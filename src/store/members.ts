import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { describeError } from '@/services/errorMessage'
import {
  addMember as apiAdd,
  listMembers as apiList,
  removeMember as apiRemove,
  type ProjectMember,
} from '@/services/members'

/**
 * 一次只持有一個專案的成員名單——成員管理是開在單一專案上的面板，
 * 沒有同時顯示多個專案名單的畫面。
 */
export const useMembersStore = defineStore('members', () => {
  const projectId = ref<string | null>(null)
  const items = ref<ProjectMember[]>([])
  const error = ref<string | null>(null)
  const pendingCount = ref(0)
  const pending = computed(() => pendingCount.value > 0)
  /** 是否已至少載入過一次。用來區分「還在載入」與「真的只有 owner 一個人」。 */
  const loaded = ref(false)

  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    pendingCount.value += 1
    error.value = null
    try {
      return await action()
    } catch (caught) {
      error.value = describeError(caught)
      return null
    } finally {
      pendingCount.value -= 1
    }
  }

  /** 開啟某個專案的成員名單。先清空再載入，不讓上一個專案的名單短暫留在畫面上。 */
  async function open(id: string): Promise<void> {
    projectId.value = id
    items.value = []
    loaded.value = false
    error.value = null

    const list = await run(() => apiList(id))
    // 等待期間可能已經關掉面板或切到別的專案，晚回來的結果不能蓋上去。
    if (projectId.value !== id) return
    if (list) items.value = list
    loaded.value = true
  }

  async function invite(email: string): Promise<boolean> {
    const id = projectId.value
    if (!id) return false

    const added = await run(() => apiAdd(id, email.trim()))
    if (!added) return false
    if (projectId.value === id) items.value.push(added)
    return true
  }

  async function remove(userId: string): Promise<boolean> {
    // 先送請求再更新名單。樂觀移除在失敗時要放回原位，而名單是有順序的
    // （owner 第一、其餘照加入時間），放回去不一定是原本的位置。
    const id = projectId.value
    if (!id) return false

    const ok = await run(() => apiRemove(id, userId))
    if (ok === null) return false
    if (projectId.value === id) items.value = items.value.filter((m) => m.user_id !== userId)
    return true
  }

  function close(): void {
    projectId.value = null
    items.value = []
    loaded.value = false
    error.value = null
  }

  function clearError(): void {
    error.value = null
  }

  return { projectId, items, error, pending, loaded, open, invite, remove, close, clearError }
})
