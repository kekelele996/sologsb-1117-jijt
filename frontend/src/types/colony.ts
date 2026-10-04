/** 蜂种 */
export const BEE_SPECIES = ['意蜂', '中蜂'] as const
export type BeeSpecies = (typeof BEE_SPECIES)[number]

/** 蜂群状态 */
export const COLONY_STATUSES = ['待投放', '在园', '转场中', '回场'] as const
export type ColonyStatus = (typeof COLONY_STATUSES)[number]

/** 箱型 */
export const BOX_TYPES = ['标准继箱', '平箱', '交尾箱'] as const
export type BoxType = (typeof BOX_TYPES)[number]

/** 分并变更类型 */
export const CHANGE_KINDS = ['并群', '拆群'] as const
export type ColonyChangeKind = (typeof CHANGE_KINDS)[number]

/** 分并变更状态：待执行 → 成功 / 失败（失败留着重试） */
export const CHANGE_STATUSES = ['待执行', '成功', '失败'] as const
export type ColonyChangeStatus = (typeof CHANGE_STATUSES)[number]

/** BeeColony 蜂群 */
export interface BeeColony {
  id: string
  /** 群号 */
  code: string
  species: BeeSpecies
  /** 群势（足框数） */
  strengthFrames: number
  boxType: BoxType
  /** 群系 id：并群 / 拆群串起来的同一串群号共用；独立群各自一个 */
  groupId: string
  /** 当前所在地块 */
  currentOrchardId: string
  status: ColonyStatus
  /** 最近检查日期 */
  lastCheckDate: string
  /** 蜂群健康备注 */
  healthNote: string
}

/** 拆群登记的一组（群号 + 群势） */
export interface ColonyChangeChild {
  code: string
  strengthFrames: number
}

/** 拆群时装不下、退回待投放的箱位（容量放开后优先回座） */
export interface OverflowSlot {
  /** 该箱位所属的子群 */
  colonyId: string
  /** 原投放点 */
  dropId: string
  /** 待入座箱数 */
  boxes: number
}

/** ColonyChange 分并变更单（技术员侧） */
export interface ColonyChange {
  id: string
  kind: ColonyChangeKind
  status: ColonyChangeStatus
  /** 未执行 / 失败原因 */
  reason: string
  createdAt: string
  completedAt: string
  note: string
  /** 并群：被并掉的群 id 列表 */
  sourceIds: string[]
  /** 并群：留下的群 id */
  survivorId: string
  /** 拆群：原群 id */
  parentId: string
  /** 拆群：两组登记信息（群号 + 群势） */
  children: ColonyChangeChild[]
  /** 拆群成功后生成的两群 id（重试时沿用，避免重复造群） */
  childColonyIds: string[]
  /** 拆群时装不下、退回待投放的箱位 */
  overflowSlots: OverflowSlot[]
}
