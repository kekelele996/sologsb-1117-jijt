import { create } from 'zustand'
import type { ColonyChange } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { reconcile } from '@/utils/reconcile'
import { hydrateAll } from '@/stores/hydrate'

export interface ColonyChangeState {
  rows: ColonyChange[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 登记一张分并变更单并立刻重算（成功 / 失败都落单，失败留着重试） */
  register: (change: ColonyChange) => Promise<void>
  /** 重试全部待执行 / 失败的变更单（重算按登记先后重放） */
  retryAll: () => Promise<void>
  /** 删除变更单（仅成功单允许删除；失败单必须保留等重试） */
  remove: (id: string) => Promise<void>
}

export const colonyChangeStore = create<ColonyChangeState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<ColonyChange>(db.colonyChanges)
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    set({ rows, loaded: true })
  },
  register: async (change) => {
    await putRow<ColonyChange>(db.colonyChanges, change)
    await reconcile()
    await hydrateAll()
  },
  retryAll: async () => {
    await reconcile()
    await hydrateAll()
  },
  remove: async (id) => {
    const target = get().rows.find((item) => item.id === id)
    if (target && target.status !== '成功') return
    await deleteRow<ColonyChange>(db.colonyChanges, id)
    await get().hydrate()
  }
}))
