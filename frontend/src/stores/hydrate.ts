import { colonyStore } from '@/stores/colonyStore'
import { colonyChangeStore } from '@/stores/colonyChangeStore'
import { droppointStore } from '@/stores/droppointStore'
import { placementStore } from '@/stores/placementStore'
import { orchardStore } from '@/stores/orchardStore'
import { routeStore } from '@/stores/routeStore'

/**
 * 重算后统一水合：分并变更会改蜂群与箱位，容量改动会改箱位，
 * 页面任意一侧的写操作都可能影响另一侧，因此整组刷新。
 */
export async function hydrateAll(): Promise<void> {
  await Promise.all([
    orchardStore.getState().hydrate(),
    colonyStore.getState().hydrate(),
    droppointStore.getState().hydrate(),
    placementStore.getState().hydrate(),
    colonyChangeStore.getState().hydrate(),
    routeStore.getState().hydrate()
  ])
}
