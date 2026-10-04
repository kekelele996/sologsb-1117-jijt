import type { BeeColony, ColonyChange, DropPoint, Placement } from '@/types'

/** 分并模拟结果：校验不通过时 ok=false 且不改动数据，变更留待重试 */
export interface ChangeApplyResult {
  ok: boolean
  reason: string
  colonies: BeeColony[]
  placements: Placement[]
  change: ColonyChange
}

export interface ColonyData {
  colonies: BeeColony[]
  placements: Placement[]
  drops: DropPoint[]
}

export function cloneData(data: ColonyData): ColonyData {
  return {
    colonies: data.colonies.map((item) => ({ ...item })),
    placements: data.placements.map((item) => ({ ...item })),
    drops: data.drops.map((item) => ({ ...item }))
  }
}

/** 某投放点已占用箱数 */
export function usedBoxes(dropId: string, placements: Placement[]): number {
  return placements.filter((item) => item.dropId === dropId).reduce((sum, item) => sum + item.boxes, 0)
}

/** 某群当前占用的箱位点（按点合并） */
export function placementsOfColony(colonyId: string, placements: Placement[]): Placement[] {
  const map = new Map<string, Placement>()
  placements
    .filter((item) => item.colonyId === colonyId)
    .forEach((item) => {
      const prev = map.get(item.dropId)
      if (prev) prev.boxes += item.boxes
      else map.set(item.dropId, { ...item })
    })
  return Array.from(map.values())
}

/**
 * 并群：源群（被并掉）的箱位全部转到留下的群；
 * 同一投放点已有该群箱位时合并计数；任一点合并后超出容量即失败。
 */
export function applyMerge(
  change: ColonyChange,
  data: ColonyData,
  opts: { now: string; idFactory: () => string }
): ChangeApplyResult {
  const work = cloneData(data)
  const survivor = work.colonies.find((item) => item.id === change.survivorId)
  const sources = work.colonies.filter((item) => change.sourceIds.includes(item.id))

  if (!survivor) {
    return { ok: false, reason: '留下的群已不存在', colonies: data.colonies, placements: data.placements, change }
  }
  if (sources.length !== change.sourceIds.length) {
    return { ok: false, reason: '被并掉的群中有已删除的群', colonies: data.colonies, placements: data.placements, change }
  }
  if (new Set(change.sourceIds).size !== change.sourceIds.length || change.sourceIds.includes(survivor.id)) {
    return { ok: false, reason: '并群群号选择无效', colonies: data.colonies, placements: data.placements, change }
  }

  // 容量复核：箱位只在群间转移、不增加投放点总占用；若现场已超容则失败，变更留着重试
  for (const drop of work.drops) {
    const total = usedBoxes(drop.id, work.placements)
    if (total > drop.capacityBoxes) {
      return {
        ok: false,
        reason: `投放点 ${drop.code} 当前占用 ${total} 箱已超容 ${drop.capacityBoxes} 箱，并群无法执行`,
        colonies: data.colonies,
        placements: data.placements,
        change
      }
    }
  }

  // 转移箱位：源群 → 留下群，同点合并计数
  for (const source of sources) {
    work.placements
      .filter((item) => item.colonyId === source.id)
      .forEach((slot) => {
        const target = work.placements.find((item) => item.colonyId === survivor.id && item.dropId === slot.dropId)
        if (target) {
          target.boxes += slot.boxes
          slot.boxes = 0
        } else {
          slot.colonyId = survivor.id
        }
      })
  }
  work.placements = work.placements.filter((item) => item.boxes > 0)

  if (!survivor.groupId) survivor.groupId = opts.idFactory()

  // 删除被并掉的群
  work.colonies = work.colonies.filter((item) => !change.sourceIds.includes(item.id))

  const done: ColonyChange = {
    ...change,
    status: '成功',
    reason: '',
    completedAt: opts.now,
    overflowSlots: []
  }
  return { ok: true, reason: '', colonies: work.colonies, placements: work.placements, change: done }
}

/**
 * 按权重把 total 个整数份分给两群（最大余数法，并列时群势强的群优先）。
 * 每个在该点有份的群至少 1 箱；total 不够均分时，弱群挂溢出槽、强群保底。
 */
export function splitBoxes(total: number, weights: { strong: number; weak: number }): { strong: number; weak: number } {
  if (total <= 0) return { strong: 0, weak: 0 }
  const sum = weights.strong + weights.weak
  if (sum <= 0) {
    return { strong: Math.ceil(total / 2), weak: Math.floor(total / 2) }
  }
  if (total === 1) return { strong: 1, weak: 0 }
  const strongRaw = (total * weights.strong) / sum
  const strongFloor = Math.floor(strongRaw)
  // 强群用最大余数：余数 ≥0.5 给强群，否则给弱群
  const strong = strongRaw - strongFloor >= 0.5 ? strongFloor + 1 : strongFloor
  return { strong, weak: total - strong }
}

/**
 * 拆群：按两组群势逐点分配原群箱位；某点一箱都分不到的组挂溢出槽、退回待投放。
 * 拆群不要求容量（箱子总数不变，不会撑爆投放点），因此不存在容量型失败。
 */
export function applySplit(
  change: ColonyChange,
  data: ColonyData,
  opts: { now: string }
): ChangeApplyResult {
  const work = cloneData(data)
  const parent = work.colonies.find((item) => item.id === change.parentId)
  if (!parent) {
    return { ok: false, reason: '原群已不存在', colonies: data.colonies, placements: data.placements, change }
  }
  if (change.children.length !== 2) {
    return { ok: false, reason: '拆群必须登记两组', colonies: data.colonies, placements: data.placements, change }
  }
  if (change.children.some((child) => !child.code.trim() || child.strengthFrames < 0)) {
    return { ok: false, reason: '两组的群号与群势必须填写完整', colonies: data.colonies, placements: data.placements, change }
  }

  // 强群排前（并列时按录入顺序，通常录入时强在前）；不改写变更单上的 children 顺序，重试时 id 才能对上
  const order = [...change.children]
    .map((child, index) => ({ child, index }))
    .sort((a, b) => b.child.strengthFrames - a.child.strengthFrames || a.index - b.index)
  const strongSpec = order[0].child
  const weakSpec = order[1].child
  const strongId = change.childColonyIds[order[0].index]
  const weakId = change.childColonyIds[order[1].index]

  const base: Omit<BeeColony, 'id' | 'code' | 'strengthFrames' | 'status'> = {
    species: parent.species,
    boxType: parent.boxType,
    groupId: parent.groupId,
    currentOrchardId: parent.currentOrchardId,
    lastCheckDate: parent.lastCheckDate,
    healthNote: parent.healthNote
  }
  const makeChild = (id: string, spec: { code: string; strengthFrames: number }, placed: boolean): BeeColony => ({
    ...base,
    id,
    code: spec.code.trim(),
    strengthFrames: spec.strengthFrames,
    status: placed ? parent.status : '待投放'
  })

  const newPlacements: Placement[] = []
  const overflowSlots: ColonyChange['overflowSlots'] = []
  let strongPlaced = false
  let weakPlaced = false

  const parentSlots = placementsOfColony(parent.id, work.placements)
  parentSlots.forEach((slot) => {
    const part = splitBoxes(slot.boxes, { strong: strongSpec.strengthFrames, weak: weakSpec.strengthFrames })
    if (part.strong > 0) {
      newPlacements.push({ id: `plc_${strongId}_${slot.dropId}`, colonyId: strongId, dropId: slot.dropId, boxes: part.strong })
      strongPlaced = true
    }
    if (part.weak > 0) {
      newPlacements.push({ id: `plc_${weakId}_${slot.dropId}`, colonyId: weakId, dropId: slot.dropId, boxes: part.weak })
      weakPlaced = true
    } else {
      // 该点一箱都没分到 → 退回待投放，记 1 箱溢出槽等容量放开回座
      overflowSlots.push({ colonyId: weakId, dropId: slot.dropId, boxes: 1 })
    }
  })

  // 完全没有箱位的组：原群本就待投放，两组都待投放，不记溢出
  const strongChild = makeChild(strongId, strongSpec, strongPlaced)
  const weakChild = makeChild(weakId, weakSpec, weakPlaced)

  work.colonies = work.colonies.filter((item) => item.id !== parent.id)
  work.colonies.push(strongChild, weakChild)
  work.placements = work.placements.filter((item) => item.colonyId !== parent.id)
  work.placements.push(...newPlacements)

  // 待投放子群的地块清空
  work.colonies.forEach((item) => {
    if (item.id === weakId && !weakPlaced) item.currentOrchardId = ''
    if (item.id === strongId && !strongPlaced) item.currentOrchardId = ''
  })

  const done: ColonyChange = {
    ...change,
    status: '成功',
    reason: '',
    completedAt: opts.now,
    overflowSlots
  }
  return { ok: true, reason: '', colonies: work.colonies, placements: work.placements, change: done }
}

/** 标记变更失败（数据保持原状） */
export function failChange(change: ColonyChange, reason: string): ColonyChange {
  return { ...change, status: '失败', reason }
}
