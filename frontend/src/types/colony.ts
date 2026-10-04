/** 蜂种 */
export const BEE_SPECIES = ['意蜂', '中蜂'] as const
export type BeeSpecies = (typeof BEE_SPECIES)[number]

/** 蜂群状态 */
export const COLONY_STATUSES = ['待投放', '在园', '转场中', '回场'] as const
export type ColonyStatus = (typeof COLONY_STATUSES)[number]

/** 箱型 */
export const BOX_TYPES = ['标准继箱', '平箱', '交尾箱'] as const
export type BoxType = (typeof BOX_TYPES)[number]

/** BeeColony 蜂群 */
export interface BeeColony {
  id: string
  /** 群号 */
  code: string
  species: BeeSpecies
  /** 群势（足框数） */
  strengthFrames: number
  boxType: BoxType
  /** 当前所在地块 */
  currentOrchardId: string
  status: ColonyStatus
  /** 最近检查日期 */
  lastCheckDate: string
  /** 蜂群健康备注 */
  healthNote: string
  /** 分并谱系号：同一来源的拆分子群共用，独立群等于自身 id */
  groupId: string
}

/** 分并变更类型 */
export const COLONY_CHANGE_TYPES = ['并群', '拆群'] as const
export type ColonyChangeType = (typeof COLONY_CHANGE_TYPES)[number]

/** 分并变更状态：失败的变更保留为「待重试」 */
export const COLONY_CHANGE_STATUSES = ['待重试', '已完成'] as const
export type ColonyChangeStatus = (typeof COLONY_CHANGE_STATUSES)[number]

/**
 * ColonyChange 分并变更
 * 技术员侧单据：并群把一串旧群号转到留下群号；拆群按群势把箱位分给两组。
 * 执行失败（如被并群号已不存在）不改动投放点安排，单据留为待重试。
 */
export interface ColonyChange {
  id: string
  type: ColonyChangeType
  status: ColonyChangeStatus
  /** 创建时间（ISO） */
  createdAt: string
  /** 结果或失败原因 */
  note: string
  /** 并群：留下的群号 */
  survivorCode?: string
  /** 并群：被并掉的群号串 */
  absorbedCodes?: string[]
  /** 拆群：被拆的源群号 */
  sourceCode?: string
  /** 拆群：两组（或多组）新群号，与 childFrames 对齐 */
  childCodes?: string[]
  /** 拆群：各组群势（足框） */
  childFrames?: number[]
  /** 拆群：各组按群势应分到的投放点 id（容量不够时未实际放入，容量恢复后据此补位） */
  plan?: Record<string, string[]>
  /** 拆群：分箱时各组的群势次序（0 为最强），容量收缩时弱组先退回 */
  strengthRank?: Record<string, number>
}
