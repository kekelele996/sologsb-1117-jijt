import { create } from 'zustand'
import type { DropPoint } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { colonyStore } from '@/stores/colonyStore'
import { colonyChangeStore } from '@/stores/colonyChangeStore'
import { recomputeAll, type RecomputeSummary } from '@/services/colonyChangeEngine'

export interface DropPointState {
  rows: DropPoint[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 保存投放点；容量变化时重算分并安排，返回重算汇总（非容量变化返回 null） */
  save: (row: DropPoint) => Promise<RecomputeSummary | null>
  remove: (id: string) => Promise<void>
  removeByOrchard: (orchardId: string) => Promise<void>
}

/** 容量改动后联动刷新技术员侧的蜂群与分并变更 */
async function refreshAfterRecompute(): Promise<void> {
  await colonyStore.getState().hydrate()
  await colonyChangeStore.getState().hydrate()
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
    const previous = get().rows.find((item) => item.id === row.id)
    const capacityChanged = previous ? previous.capacityBoxes !== row.capacityBoxes : false
    await putRow<DropPoint>(db.dropPoints, row)
    await get().hydrate()
    // 投放点容量一改动，分并安排重算
    if (capacityChanged) {
      const summary = await recomputeAll()
      await get().hydrate()
      await refreshAfterRecompute()
      return summary
    }
    return null
  },
  remove: async (id) => {
    await deleteRow<DropPoint>(db.dropPoints, id)
    await get().hydrate()
  },
  removeByOrchard: async (orchardId) => {
    const targets = get().rows.filter((row) => row.orchardId === orchardId)
    await Promise.all(targets.map((row) => deleteRow<DropPoint>(db.dropPoints, row.id)))
    await get().hydrate()
  }
}))
