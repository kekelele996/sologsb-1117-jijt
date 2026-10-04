import { create } from 'zustand'
import type { DropPoint } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { reconcile } from '@/utils/reconcile'
import { hydrateAll } from '@/stores/hydrate'

export interface DropPointState {
  rows: DropPoint[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 保存投放点（新增 / 改容量都算容量变化），随后重算分并安排 */
  save: (row: DropPoint) => Promise<void>
  remove: (id: string) => Promise<void>
  removeByOrchard: (orchardId: string) => Promise<void>
}

export const droppointStore = create<DropPointState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<DropPoint>(db.dropPoints)
    rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    await putRow<DropPoint>(db.dropPoints, row)
    // 投放点容量一改动，分并安排就要重算
    await reconcile()
    await hydrateAll()
  },
  remove: async (id) => {
    await deleteRow<DropPoint>(db.dropPoints, id)
    await db.placements.where('dropId').equals(id).delete()
    await reconcile()
    await hydrateAll()
  },
  removeByOrchard: async (orchardId) => {
    const targets = get().rows.filter((row) => row.orchardId === orchardId)
    await Promise.all(
      targets.map(async (row) => {
        await deleteRow<DropPoint>(db.dropPoints, row.id)
        await db.placements.where('dropId').equals(row.id).delete()
      })
    )
    await reconcile()
    await hydrateAll()
  }
}))
