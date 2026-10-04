import { useStore } from 'zustand'
import type { StoreApi, UseBoundStore } from 'zustand'
import Dexie, { type Table } from 'dexie'
import type { BeeColony, ColonyChange, DropPoint, Orchard, Placement, TransitRoute } from '@/types'

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/**
 * Dexie 封装：
 * 托管队侧 —— 果园 orchards / 投放点 dropPoints（只存地块与容量）；
 * 技术员侧 —— 蜂群 colonies / 箱位安排 placements / 分并变更 colonyChanges；
 * 另含转场路线 routes 与元数据 meta。
 */
class BeeRouteDb extends Dexie {
  orchards!: Table<Orchard, string>
  colonies!: Table<BeeColony, string>
  dropPoints!: Table<DropPoint, string>
  placements!: Table<Placement, string>
  colonyChanges!: Table<ColonyChange, string>
  routes!: Table<TransitRoute, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbbeeroute')
    this.version(1).stores({
      orchards: 'id, name, crop',
      colonies: 'id, code, status',
      dropPoints: 'id, orchardId, code',
      routes: 'id, fromDropId, toDropId',
      meta: 'key'
    })
    // v2：投放点新增「可容纳箱数」字段，迁移时为历史投放点补齐（按 8 箱兜底）
    this.version(2).stores({
      orchards: 'id, name, crop, bloomStart',
      colonies: 'id, code, status, currentOrchardId',
      dropPoints: 'id, orchardId, code, dropWindow',
      routes: 'id, fromDropId, toDropId, departAt',
      meta: 'key'
    })
    // v3：职责拆分——投放点不再挂群号；箱位安排独立成 placements（按群 id 引用），
    // 新增 colonyChanges 分并变更单，蜂群新增 groupId 群系字段
    this.version(SCHEMA_VERSION)
      .stores({
        orchards: 'id, name, crop, bloomStart',
        colonies: 'id, code, status, currentOrchardId, groupId',
        dropPoints: 'id, orchardId, code, dropWindow',
        placements: 'id, colonyId, dropId',
        colonyChanges: 'id, kind, status, createdAt',
        routes: 'id, fromDropId, toDropId, departAt',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        // v2 迁移在旧库上会先跑，capacityBoxes 已补齐；这里把历史投放点上的群号
        // 转成独立的箱位安排，每个群号按 1 箱记（旧数据没有箱数粒度）
        const dropTable = tx.table<DropPoint & { colonyCodes?: string[] }, string>('dropPoints')
        const colonyTable = tx.table<BeeColony, string>('colonies')
        const placementTable = tx.table<Placement, string>('placements')

        const oldDrops = await dropTable.toCollection().toArray()
        const oldColonies = await colonyTable.toCollection().toArray()
        const codeToColony = new Map(oldColonies.map((item) => [item.code, item]))

        // 旧数据没有群势关系：每群各自独立一群，groupId 用自身 id 补上
        oldColonies.forEach((colony) => {
          if (!colony.groupId) {
            colony.groupId = colony.id
          }
        })

        const placements: Placement[] = []
        oldDrops.forEach((point, pointIndex) => {
          // 兜底再补一次容量：链式升级时 v2 的 modify 结果不保证先于本事务落盘
          if (!point.capacityBoxes) {
            point.capacityBoxes = 8
          }
          const codes = Array.from(new Set(point.colonyCodes ?? []))
          codes.forEach((code, codeIndex) => {
            const colony = codeToColony.get(code)
            if (!colony) return
            placements.push({
              id: `plc_mig_${pointIndex}_${codeIndex}`,
              colonyId: colony.id,
              dropId: point.id,
              boxes: 1
            })
          })
          // 投放点不再保留群号串
          delete point.colonyCodes
        })
        await colonyTable.bulkPut(oldColonies)
        await dropTable.bulkPut(oldDrops)
        if (placements.length > 0) {
          await placementTable.bulkPut(placements)
        }
      })
  }
}

export const db = new BeeRouteDb()

/** 写入当前数据结构版本号 */
export async function stampDbVersion(): Promise<void> {
  await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
}

/** 读取整表 */
export async function loadAll<T extends object>(table: Table<T, string>): Promise<T[]> {
  return table.toArray()
}

/** 写入一条记录 */
export async function putRow<T extends object>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(row)
}

/** 删除一条记录 */
export async function deleteRow<T extends object>(table: Table<T, string>, id: string): Promise<void> {
  await table.delete(id)
}

/** Zustand store ↔ Dexie 表 的读写桥接（页面统一通过它读取 store） */
export function usePersistentStore<T extends object>(store: UseBoundStore<StoreApi<T>>): T
export function usePersistentStore<T extends object, S>(
  store: UseBoundStore<StoreApi<T>>,
  selector: (state: T) => S
): S
export function usePersistentStore<T extends object, S>(
  store: UseBoundStore<StoreApi<T>>,
  selector?: (state: T) => S
): T | S {
  return useStore(store, selector ?? ((state: T) => state as unknown as S))
}

/** 首次打开写入示例数据 */
export async function seedDemoData(): Promise<void> {
  const count = await db.orchards.count()
  if (count > 0) return

  const year = new Date().getFullYear()

  await db.orchards.bulkPut([
    {
      id: 'orc_ap',
      name: '北岭苹果园',
      crop: '苹果',
      areaMu: 120,
      longitude: 107.4132,
      latitude: 34.6128,
      bloomStart: `${year}-04-08`,
      bloomEnd: `${year}-04-18`,
      colonyIntensity: 0.1,
      ownerContact: '135****2043（周园主）',
      accessibility: '大车可达',
      historyYears: [year - 2, year - 1],
      note: '主栽富士，行距 4 m，南坡'
    },
    {
      id: 'orc_cherry',
      name: '西沟樱桃坡',
      crop: '樱桃',
      areaMu: 46,
      longitude: 107.3755,
      latitude: 34.5891,
      bloomStart: `${year}-04-12`,
      bloomEnd: `${year}-04-21`,
      colonyIntensity: 0.2,
      ownerContact: '138****7712（李园主）',
      accessibility: '仅小车',
      historyYears: [year - 1],
      note: '坡地梯田，需小车倒运蜂箱'
    },
    {
      id: 'orc_rape',
      name: '东滩油菜田',
      crop: '油菜',
      areaMu: 220,
      longitude: 107.4621,
      latitude: 34.6435,
      bloomStart: `${year}-03-28`,
      bloomEnd: `${year}-04-12`,
      colonyIntensity: 0.05,
      ownerContact: '137****9981（合作社）',
      accessibility: '大车可达',
      historyYears: [year - 1],
      note: '连片油菜，与苹果花期部分重叠'
    }
  ])

  await db.colonies.bulkPut([
    {
      id: 'col_001',
      code: 'Q-01',
      species: '意蜂',
      strengthFrames: 8,
      boxType: '标准继箱',
      groupId: 'grp_001',
      currentOrchardId: 'orc_ap',
      status: '在园',
      lastCheckDate: `${year}-04-09`,
      healthNote: '群势稳定，子脾整齐'
    },
    {
      id: 'col_002',
      code: 'Q-02',
      species: '意蜂',
      strengthFrames: 6,
      boxType: '标准继箱',
      groupId: 'grp_002',
      currentOrchardId: 'orc_rape',
      status: '转场中',
      lastCheckDate: `${year}-04-05`,
      healthNote: '轻微螨害，转场后需治螨'
    },
    {
      id: 'col_003',
      code: 'Q-03',
      species: '中蜂',
      strengthFrames: 4,
      boxType: '平箱',
      groupId: 'grp_003',
      currentOrchardId: '',
      status: '待投放',
      lastCheckDate: `${year}-04-02`,
      healthNote: '新分群，群势偏弱'
    }
  ])

  await db.dropPoints.bulkPut([
    {
      id: 'dp_a01',
      orchardId: 'orc_ap',
      longitude: 107.4108,
      latitude: 34.6142,
      code: 'A-01',
      capacityBoxes: 8,
      shade: '北侧有防风林，午后半阴',
      waterDistance: 220,
      dropWindow: `${year}-04-07`,
      withdrawTime: `${year}-04-19`,
      owner: '周园主'
    },
    {
      id: 'dp_b01',
      orchardId: 'orc_rape',
      longitude: 107.4598,
      latitude: 34.6411,
      code: 'B-01',
      capacityBoxes: 12,
      shade: '无遮阴，需临时搭棚',
      waterDistance: 480,
      dropWindow: `${year}-03-27`,
      withdrawTime: `${year}-04-13`,
      owner: '合作社'
    },
    {
      id: 'dp_c01',
      orchardId: 'orc_cherry',
      longitude: 107.3741,
      latitude: 34.5902,
      code: 'C-01',
      capacityBoxes: 6,
      shade: '坡顶两株核桃树遮阴',
      waterDistance: 350,
      dropWindow: `${year}-04-11`,
      withdrawTime: `${year}-04-22`,
      owner: '李园主'
    }
  ])

  await db.placements.bulkPut([
    { id: 'plc_001_a01', colonyId: 'col_001', dropId: 'dp_a01', boxes: 6 },
    { id: 'plc_002_b01', colonyId: 'col_002', dropId: 'dp_b01', boxes: 4 },
    { id: 'plc_002_c01', colonyId: 'col_002', dropId: 'dp_c01', boxes: 2 }
  ])

  await db.routes.bulkPut([
    {
      id: 'rt_001',
      fromDropId: 'dp_b01',
      toDropId: 'dp_c01',
      distanceKm: 9.4,
      durationH: 0.54,
      vehicleType: '农用三轮',
      departAt: `${year}-04-13T06:30`,
      riskNote: '西沟坡道窄，雨天泥泞，需小车倒运',
      actualNote: '待执行'
    }
  ])
}
