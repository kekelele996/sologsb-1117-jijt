import { create } from 'zustand'
import type { BeeColony, ColonyStatus } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { reconcile } from '@/utils/reconcile'
import { hydrateAll } from '@/stores/hydrate'
import { uid } from '@/utils/id'

export interface ColonyState {
  rows: BeeColony[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: BeeColony) => Promise<void>
  remove: (id: string) => Promise<void>
  bulkSetStatus: (ids: string[], status: ColonyStatus) => Promise<void>
  bulkSetHealthNote: (ids: string[], note: string, checkDate: string) => Promise<void>
}

export const colonyStore = create<ColonyState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<BeeColony>(db.colonies)
    rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    // 新建的独立群各自一个群系
    const withGroup: BeeColony = row.groupId ? row : { ...row, groupId: uid('grp') }
    await putRow<BeeColony>(db.colonies, withGroup)
    await get().hydrate()
  },
  remove: async (id) => {
    await deleteRow<BeeColony>(db.colonies, id)
    // 删群连带清掉该群的箱位，再统一重算（退回待投放 / 失败变更重试）
    const own = await db.placements.where('colonyId').equals(id).toArray()
    if (own.length > 0) await db.placements.bulkDelete(own.map((item) => item.id))
    await reconcile()
    await hydrateAll()
  },
  bulkSetStatus: async (ids, status) => {
    const targets = get().rows.filter((row) => ids.includes(row.id))
    await Promise.all(targets.map((row) => putRow<BeeColony>(db.colonies, { ...row, status })))
    await get().hydrate()
  },
  bulkSetHealthNote: async (ids, note, checkDate) => {
    const targets = get().rows.filter((row) => ids.includes(row.id))
    await Promise.all(targets.map((row) => putRow<BeeColony>(db.colonies, { ...row, healthNote: note, lastCheckDate: checkDate })))
    await get().hydrate()
  }
}))
