import { create } from 'zustand'
import type { Placement } from '@/types'
import { db, loadAll, putRow } from '@/hooks/usePersistentStore'
import { reconcile } from '@/utils/reconcile'
import { hydrateAll } from '@/stores/hydrate'

export interface PlacementDraft {
  colonyId: string
  boxes: number
}

export interface PlacementState {
  rows: Placement[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 整单保存某投放点的箱位安排（技术员侧），随后统一重算 */
  saveDropAssignments: (dropId: string, drafts: PlacementDraft[]) => Promise<void>
}

/** 同群同点的箱位记录 id 保持稳定，便于覆盖写 */
export function placementId(colonyId: string, dropId: string): string {
  return `plc_${colonyId}_${dropId}`
}

export const placementStore = create<PlacementState>((set) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<Placement>(db.placements)
    set({ rows, loaded: true })
  },
  saveDropAssignments: async (dropId, drafts) => {
    const valid = drafts
      .map((item) => ({ colonyId: item.colonyId, boxes: Math.max(0, Math.floor(item.boxes)) }))
      .filter((item) => item.colonyId && item.boxes > 0)
    const keep = new Set(valid.map((item) => item.colonyId))
    const existing = await db.placements.where('dropId').equals(dropId).toArray()
    const removed = existing.filter((item) => !keep.has(item.colonyId)).map((item) => item.id)
    if (removed.length > 0) await db.placements.bulkDelete(removed)
    await Promise.all(
      valid.map((item) =>
        putRow<Placement>(db.placements, { id: placementId(item.colonyId, dropId), colonyId: item.colonyId, dropId, boxes: item.boxes })
      )
    )
    // 箱位调整后统一重算：失败变更可能因此解锁，裁剪保证不超容
    await reconcile()
    await hydrateAll()
  }
}))
