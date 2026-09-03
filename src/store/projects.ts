import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { describeError } from '@/services/errorMessage'
import {
  createProject as apiCreate,
  deleteProject as apiDelete,
  listProjects as apiList,
  renameProject as apiRename,
  type ProjectDocument,
  type ProjectSummary,
} from '@/services/projects'

export const useProjectsStore = defineStore('projects', () => {
  const items = ref<ProjectSummary[]>([])
  const error = ref<string | null>(null)
  const pendingCount = ref(0)
  const pending = computed(() => pendingCount.value > 0)
  /** 是否已至少載入過一次。用來區分「還沒載入」與「真的沒有專案」。 */
  const loaded = ref(false)

  const isEmpty = computed(() => loaded.value && items.value.length === 0)

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

  async function fetchAll(): Promise<void> {
    const list = await run(apiList)
    if (list) items.value = list
    loaded.value = true
  }

  async function create(document: ProjectDocument, name?: string): Promise<string | null> {
    const created = await run(() => apiCreate({ name, document }))
    if (!created) return null
    // 後端依 updated_at 由新到舊排序，新建的一定在最前面
    const { document: _document, ...summary } = created
    items.value.unshift(summary)
    return created.id
  }

  async function rename(id: string, name: string): Promise<boolean> {
    const updated = await run(() => apiRename(id, name))
    if (!updated) return false
    const index = items.value.findIndex((p) => p.id === id)
    if (index !== -1) items.value[index] = updated
    return true
  }

  async function remove(id: string): Promise<boolean> {
    // 先送請求再更新列表：樂觀更新在刪除失敗時要把項目放回原位，
    // 而列表是有排序的，放回去不一定是原本的位置。
    const ok = await run(() => apiDelete(id))
    if (ok === null) return false
    items.value = items.value.filter((p) => p.id !== id)
    return true
  }

  function clearError(): void {
    error.value = null
  }

  return {
    items,
    error,
    pending,
    loaded,
    isEmpty,
    fetchAll,
    create,
    rename,
    remove,
    clearError,
  }
})
