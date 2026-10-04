import { create } from 'zustand'
import type { ColonyChange } from '@/types'
import { db, loadAll } from '@/hooks/usePersistentStore'
import { removeColonyChange } from '@/services/colonyChangeEngine'

export interface ColonyChangeState {
  rows: ColonyChange[]
  loaded: boolean
  hydrate: () => Promise<void>
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
  remove: async (id) => {
    await removeColonyChange(id)
    await get().hydrate()
  }
}))
