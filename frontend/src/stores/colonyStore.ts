import { create } from 'zustand'
import type { BeeColony, ColonyStatus } from '@/types'
import { db, loadAll, putRow } from '@/hooks/usePersistentStore'
import { droppointStore } from '@/stores/droppointStore'
import { setColonyAssignments } from '@/services/colonyChangeEngine'

export interface ColonyState {
  rows: BeeColony[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: BeeColony) => Promise<void>
  remove: (id: string) => Promise<void>
  bulkSetStatus: (ids: string[], status: ColonyStatus) => Promise<void>
  bulkSetHealthNote: (ids: string[], note: string, checkDate: string) => Promise<void>
  assignPoints: (colonyId: string, pointIds: string[]) => Promise<void>
}

/** 技术员直接安排某群到投放点后，联动刷新蜂群与投放点两侧 */
async function refreshAfterArrangement(): Promise<void> {
  await droppointStore.getState().hydrate()
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
    await db.transaction('rw', db.colonies, db.dropPoints, db.colonyChanges, async () => {
      const existing = await db.colonies.get(row.id)
      const saved: BeeColony = { ...row, groupId: row.groupId || existing?.groupId || row.id }
      // 群号一换，投放点安排与待重试单据里的旧群号跟着换
      if (existing && existing.code !== saved.code) {
        const points = await db.dropPoints.toArray()
        points.forEach((point) => {
          if (point.colonyCodes.includes(existing.code)) {
            point.colonyCodes = Array.from(new Set(point.colonyCodes.map((code) => (code === existing.code ? saved.code : code))))
          }
        })
        await db.dropPoints.bulkPut(points)
        const changes = await db.colonyChanges.toArray()
        changes.forEach((change) => {
          if (change.status !== '待重试') return
          if (change.survivorCode === existing.code) change.survivorCode = saved.code
          if (change.sourceCode === existing.code) change.sourceCode = saved.code
          if (change.absorbedCodes) change.absorbedCodes = change.absorbedCodes.map((code) => (code === existing.code ? saved.code : code))
          if (change.childCodes) change.childCodes = change.childCodes.map((code) => (code === existing.code ? saved.code : code))
        })
        await db.colonyChanges.bulkPut(changes)
      }
      await putRow<BeeColony>(db.colonies, saved)
    })
    await get().hydrate()
    await refreshAfterArrangement()
  },
  remove: async (id) => {
    await db.transaction('rw', db.colonies, db.dropPoints, db.colonyChanges, async () => {
      const existing = await db.colonies.get(id)
      if (existing) {
        const points = await db.dropPoints.toArray()
        points.forEach((point) => {
          point.colonyCodes = point.colonyCodes.filter((code) => code !== existing.code)
        })
        await db.dropPoints.bulkPut(points)
        // 引用该群的待重试单据已不可能成功，一并清掉
        const changes = await db.colonyChanges.toArray()
        const doomed = changes.filter(
          (change) =>
            change.status === '待重试' &&
            (change.survivorCode === existing.code ||
              change.sourceCode === existing.code ||
              change.absorbedCodes?.includes(existing.code) ||
              change.childCodes?.includes(existing.code))
        )
        if (doomed.length > 0) await db.colonyChanges.bulkDelete(doomed.map((item) => item.id))
      }
      await db.colonies.delete(id)
    })
    await get().hydrate()
    await refreshAfterArrangement()
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
  },
  assignPoints: async (colonyId, pointIds) => {
    await setColonyAssignments(colonyId, pointIds)
    await get().hydrate()
    await refreshAfterArrangement()
  }
}))
