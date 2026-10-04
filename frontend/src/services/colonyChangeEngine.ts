import type { BeeColony, ColonyChange, DropPoint } from '@/types'
import { db } from '@/hooks/usePersistentStore'
import { uid } from '@/utils/id'

/** 分并变更执行结果（创建单据时立即尝试一次） */
export interface ChangeResult {
  ok: boolean
  /** 是否需要后续重试（单据留为待重试） */
  pending: boolean
  message: string
  changeId: string
  /** 本次装不下、退回待投放的子群群号 */
  overflowCodes: string[]
}

/** 投放点容量 / 重试引发的重算汇总 */
export interface RecomputeSummary {
  /** 本次重试成功的变更 id */
  appliedChangeIds: string[]
  /** 仍待重试的变更及原因 */
  pendingChanges: { id: string; message: string }[]
  /** 因容量收缩被退回待投放的群号（群号 → 投放点编号） */
  evicted: { code: string; pointCode: string }[]
  /** 容量恢复后补回投放点的群号（群号 → 投放点编号） */
  refilled: { code: string; pointCode: string }[]
}

interface WorkSet {
  colonies: BeeColony[]
  points: DropPoint[]
  changes: ColonyChange[]
}

async function loadWorkSet(): Promise<WorkSet> {
  const [colonies, points, changes] = await Promise.all([
    db.colonies.toArray(),
    db.dropPoints.toArray(),
    db.colonyChanges.toArray()
  ])
  points.sort((a, b) => a.dropWindow.localeCompare(b.dropWindow) || a.code.localeCompare(b.code))
  changes.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { colonies, points, changes }
}

async function persistWorkSet(ws: WorkSet, before: WorkSet): Promise<void> {
  const beforeColonyIds = new Set(before.colonies.map((item) => item.id))
  const afterColonyIds = new Set(ws.colonies.map((item) => item.id))
  const addedColonies = ws.colonies.filter((item) => !beforeColonyIds.has(item.id))
  const keptColonies = ws.colonies.filter((item) => beforeColonyIds.has(item.id))
  const removedColonyIds = [...beforeColonyIds].filter((id) => !afterColonyIds.has(id))

  await db.colonies.bulkPut(keptColonies)
  if (addedColonies.length > 0) await db.colonies.bulkAdd(addedColonies)
  if (removedColonyIds.length > 0) await db.colonies.bulkDelete(removedColonyIds)
  await db.dropPoints.bulkPut(ws.points)
  await db.colonyChanges.bulkPut(ws.changes)
}

/** 投放点排序键：投放时间窗优先，其次编号（箱位按此先后分配） */
function pointRank(point: DropPoint): string {
  return `${point.dropWindow}|${point.code}`
}

/**
 * 按群势（权重）把箱位分给各组：最大余数法；
 * 余数并列时群势强的组先得，保证强群优先。
 * 这是「应分箱位」计划，与投放点当下容量无关（容量不够时放置阶段再退回待投放）。
 */
export function apportionSlots(totalSlots: number, frames: number[]): number[] {
  const n = frames.length
  const counts = new Array<number>(n).fill(0)
  if (totalSlots <= 0) return counts
  const totalFrames = frames.reduce((sum, value) => sum + value, 0)
  if (totalFrames <= 0) return counts
  const exact = frames.map((value) => (totalSlots * value) / totalFrames)
  exact.forEach((value, index) => {
    counts[index] = Math.floor(value)
  })
  let remaining = totalSlots - counts.reduce((sum, value) => sum + value, 0)
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value), frame: frames[index] }))
    .sort((a, b) => b.fraction - a.fraction || b.frame - a.frame || a.index - b.index)
  for (const item of order) {
    if (remaining <= 0) break
    counts[item.index] += 1
    remaining -= 1
  }
  return counts
}

/**
 * 按群势把源群的一批箱位切成计划：强群先拿靠前（投放窗早）的箱位。
 * 箱位数少于拆出组数时，没分到箱位的组仍指向最早的源投放点——
 * 它的蜂箱本就来自该点，只是装不下退回待投放，容量恢复后据此补回。
 * 返回 plan 与 strengthRank（分箱时的群势次序，0 为最强；并列时群号在前更强）。
 */
function buildSlotPlan(
  occupiedPointIds: string[],
  frames: number[],
  childCodes: string[]
): { plan: Record<string, string[]>; strengthRank: Record<string, number> } {
  const counts = apportionSlots(occupiedPointIds.length, frames)
  const strengthOrder = frames.map((frame, index) => ({ frame, index })).sort((a, b) => b.frame - a.frame || a.index - b.index)
  const plan: Record<string, string[]> = {}
  const strengthRank: Record<string, number> = {}
  strengthOrder.forEach(({ index }, rank) => {
    strengthRank[childCodes[index]] = rank
  })
  let cursor = 0
  strengthOrder.forEach(({ index }) => {
    plan[childCodes[index]] = occupiedPointIds.slice(cursor, cursor + counts[index])
    cursor += counts[index]
  })
  if (occupiedPointIds.length > 0) {
    childCodes.forEach((code) => {
      if (plan[code].length === 0) plan[code] = [occupiedPointIds[0]]
    })
  }
  return { plan, strengthRank }
}

/** 构造并群变更（先落单再立即执行；失败保留为待重试，投放点安排照旧） */
export async function createMerge(survivorCode: string, absorbedCodesInput: string[]): Promise<ChangeResult> {
  const survivor = survivorCode.trim()
  const absorbed = Array.from(new Set(absorbedCodesInput.map((item) => item.trim()).filter(Boolean))).filter(
    (item) => item !== survivor
  )
  const change: ColonyChange = {
    id: uid('chg'),
    type: '并群',
    status: '待重试',
    createdAt: new Date().toISOString(),
    note: '',
    survivorCode: survivor,
    absorbedCodes: absorbed
  }
  if (!survivor) {
    change.note = '未指定留下群号'
    return finishCreate(change)
  }
  if (absorbed.length === 0) {
    change.note = '未选择被并群号'
    return finishCreate(change)
  }

  return db.transaction('rw', db.colonies, db.dropPoints, db.colonyChanges, async () => {
    const before = await loadWorkSet()
    const ws: WorkSet = structuredClone(before)
    ws.changes.push(change)
    const error = applyMerge(ws, change)
    if (error) {
      // 校验失败：只落单据，投放点安排不动
      change.status = '待重试'
      change.note = error
      await db.colonyChanges.put(change)
      return {
        ok: false,
        pending: true,
        message: `并群失败：${error}。变更已保留，可在重试后继续`,
        changeId: change.id,
        overflowCodes: []
      }
    }
    await persistWorkSet(ws, before)
    return {
      ok: true,
      pending: false,
      message: change.note,
      changeId: change.id,
      overflowCodes: []
    }
  })
}

async function finishCreate(change: ColonyChange): Promise<ChangeResult> {
  await db.colonyChanges.put(change)
  return {
    ok: false,
    pending: true,
    message: `分并失败：${change.note}。变更已保留，可在重试后继续`,
    changeId: change.id,
    overflowCodes: []
  }
}

/** 执行并群：原群号串转到留下群号；返回错误串表示失败（调用方保证不改动安排） */
function applyMerge(ws: WorkSet, change: ColonyChange): string | null {
  const survivorCode = (change.survivorCode ?? '').trim()
  const absorbed = change.absorbedCodes ?? []
  const byCode = new Map(ws.colonies.map((item) => [item.code, item]))
  const survivor = byCode.get(survivorCode)
  if (!survivor) return `留下群号 ${survivorCode} 不存在`
  const missing = absorbed.filter((code) => !byCode.has(code))
  if (missing.length > 0) return `被并群号 ${missing.join('、')} 不存在`

  // 群势并入留下群
  survivor.strengthFrames += absorbed.reduce((sum, code) => sum + (byCode.get(code)?.strengthFrames ?? 0), 0)
  if (survivor.currentOrchardId === '' || survivor.status === '待投放') {
    const firstPlaced = absorbed
      .map((code) => byCode.get(code))
      .find((item): item is BeeColony => item !== undefined && Boolean(item.currentOrchardId))
    if (firstPlaced) {
      survivor.currentOrchardId = firstPlaced.currentOrchardId
      if (survivor.status === '待投放') survivor.status = '在园'
    }
  }

  // 原群号串在所有投放点转到留下群号（同一点重复只占一箱）
  const absorbedSet = new Set(absorbed)
  ws.points.forEach((point) => {
    if (!point.colonyCodes.some((code) => absorbedSet.has(code))) return
    point.colonyCodes = Array.from(new Set(point.colonyCodes.map((code) => (absorbedSet.has(code) ? survivorCode : code))))
  })

  ws.colonies = ws.colonies.filter((item) => !absorbedSet.has(item.code))
  change.status = '已完成'
  change.note = `${absorbed.join('、')} 已并入 ${survivorCode}，原投放点安排全部转到 ${survivorCode}`
  return null
}

/** 构造拆群变更（按群势把箱位分给两组，装不下的退回待投放） */
export async function createSplit(
  sourceCodeInput: string,
  childCodesInput: string[],
  childFramesInput: number[]
): Promise<ChangeResult> {
  const sourceCode = sourceCodeInput.trim()
  const childCodes = childCodesInput.map((item) => item.trim())
  const childFrames = childFramesInput.map((item) => Number(item) || 0)
  const change: ColonyChange = {
    id: uid('chg'),
    type: '拆群',
    status: '待重试',
    createdAt: new Date().toISOString(),
    note: '',
    sourceCode,
    childCodes,
    childFrames
  }
  if (!sourceCode) return finishCreate(Object.assign(change, { note: '未选择被拆群号' }))
  if (childCodes.length < 2) return finishCreate(Object.assign(change, { note: '拆群至少需要两组新群号' }))
  if (childCodes.some((item) => !item)) return finishCreate(Object.assign(change, { note: '新群号不能为空' }))
  if (new Set(childCodes).size !== childCodes.length) return finishCreate(Object.assign(change, { note: '两组新群号不能重复' }))
  if (childFrames.some((item) => item <= 0)) return finishCreate(Object.assign(change, { note: '各组群势须大于 0 足框' }))

  return db.transaction('rw', db.colonies, db.dropPoints, db.colonyChanges, async () => {
    const before = await loadWorkSet()
    const ws: WorkSet = structuredClone(before)
    ws.changes.push(change)
    const error = applySplit(ws, change)
    if (error) {
      change.status = '待重试'
      change.note = error
      await db.colonyChanges.put(change)
      return {
        ok: false,
        pending: true,
        message: `拆群失败：${error}。变更已保留，可在重试后继续`,
        changeId: change.id,
        overflowCodes: []
      }
    }
    await persistWorkSet(ws, before)
    const realized = realizedSplitCodes(ws.points, change)
    const overflowCodes = childCodes.filter((code) => !realized.has(code))
    return {
      ok: true,
      pending: false,
      message: change.note,
      changeId: change.id,
      overflowCodes
    }
  })
}

function realizedSplitCodes(points: DropPoint[], change: ColonyChange): Set<string> {
  const realized = new Set<string>()
  points.forEach((point) => {
    point.colonyCodes.forEach((code) => {
      if (change.childCodes?.includes(code)) realized.add(code)
    })
  })
  return realized
}

/** 执行拆群；返回错误串表示失败 */
function applySplit(ws: WorkSet, change: ColonyChange): string | null {
  const sourceCode = change.sourceCode ?? ''
  const childCodes = change.childCodes ?? []
  const childFrames = change.childFrames ?? []
  const source = ws.colonies.find((item) => item.code === sourceCode)
  if (!source) return `被拆群号 ${sourceCode} 不存在`
  const duplicated = childCodes.filter((code) => ws.colonies.some((item) => item.code === code))
  if (duplicated.length > 0) return `新群号 ${duplicated.join('、')} 已存在`

  // 源群现占箱位（按投放时间窗、编号排序，强群先拿靠前箱位）
  const occupied = ws.points
    .filter((point) => point.colonyCodes.includes(sourceCode))
    .sort((a, b) => pointRank(a).localeCompare(pointRank(b)))
  // 应分计划：只按群势切，不看当下容量；容量不够时放置阶段退回，恢复后据此补回
  const built = buildSlotPlan(
    occupied.map((point) => point.id),
    childFrames,
    childCodes
  )
  change.plan = built.plan
  change.strengthRank = built.strengthRank

  // 先释放源群箱位
  ws.points.forEach((point) => {
    point.colonyCodes = point.colonyCodes.filter((code) => code !== sourceCode)
  })

  // 逐组按计划放入；该点容量不够则这一箱退回待投放
  const overflow: string[] = []
  const placedPointIds = new Map<string, string[]>()
  childFrames
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => b.frame - a.frame || a.index - b.index)
    .forEach(({ index }) => {
      const code = childCodes[index]
      const placed: string[] = []
      change.plan?.[code]?.forEach((pointId) => {
        const point = ws.points.find((item) => item.id === pointId)
        if (!point) return
        if (point.colonyCodes.length < point.capacityBoxes && !point.colonyCodes.includes(code)) {
          point.colonyCodes.push(code)
          placed.push(pointId)
        } else {
          overflow.push(code)
        }
      })
      placedPointIds.set(code, placed)
    })

  // 生成两组新蜂群（沿用谱系），装不下的组退回待投放
  const children: BeeColony[] = childCodes.map((code, index) => {
    const firstPointId = (placedPointIds.get(code) ?? [])[0]
    const firstPoint = firstPointId ? ws.points.find((item) => item.id === firstPointId) : undefined
    return {
      id: uid('col'),
      code,
      species: source.species,
      strengthFrames: childFrames[index],
      boxType: source.boxType,
      currentOrchardId: firstPoint?.orchardId ?? '',
      status: firstPoint ? '在园' : '待投放',
      lastCheckDate: source.lastCheckDate,
      healthNote: source.healthNote,
      groupId: source.groupId
    }
  })
  ws.colonies = ws.colonies.filter((item) => item.id !== source.id)
  ws.colonies.push(...children)

  change.status = '已完成'
  const groupText = childCodes.map((code, index) => `${code}（${childFrames[index]} 足框）`).join('、')
  const overflowText = overflow.length > 0 ? `；${Array.from(new Set(overflow)).join('、')} 箱位不足已退回待投放` : ''
  change.note = `${sourceCode} 已拆为 ${groupText}，箱位按群势分配${overflowText}`
  return null
}

/**
 * 重算全部投放安排：
 * 1. 清掉投放点上蜂群已不存在的悬挂群号；
 * 2. 按创建顺序重试待重试的分并变更；
 * 3. 容量收缩导致超容的点，优先退回最近拆群的弱组，全部退净的群回到待投放；
 * 4. 容量恢复时把拆群退回待投放的组按原计划补回。
 */
export async function recomputeAll(): Promise<RecomputeSummary> {
  return db.transaction('rw', db.colonies, db.dropPoints, db.colonyChanges, async () => {
    const before = await loadWorkSet()
    const ws: WorkSet = structuredClone(before)
    const summary: RecomputeSummary = {
      appliedChangeIds: [],
      pendingChanges: [],
      evicted: [],
      refilled: []
    }

    pruneLingeringCodes(ws)
    retryPendingChanges(ws, summary)
    evictOverflow(ws, summary)
    refillSplitChildren(ws, summary)

    await persistWorkSet(ws, before)
    return summary
  })
}

/** 删除投放点上已无对应蜂群的群号（被并掉/删除后的悬挂安排） */
function pruneLingeringCodes(ws: WorkSet): void {
  const liveCodes = new Set(ws.colonies.map((item) => item.code))
  ws.points.forEach((point) => {
    point.colonyCodes = point.colonyCodes.filter((code) => liveCodes.has(code))
  })
}

/** 按创建顺序重试待重试变更；成功的标记并执行，仍失败的保留原因 */
function retryPendingChanges(ws: WorkSet, summary: RecomputeSummary): void {
  ws.changes
    .filter((item) => item.status === '待重试')
    .forEach((change) => {
      const error = change.type === '并群' ? applyMerge(ws, change) : applySplit(ws, change)
      if (error) {
        change.note = error
        summary.pendingChanges.push({ id: change.id, message: error })
      } else {
        summary.appliedChangeIds.push(change.id)
      }
    })
}

/** 容量收缩：超容投放点退回多余群号，拆出的弱组优先退；退净的群回待投放 */
function evictOverflow(ws: WorkSet, summary: RecomputeSummary): void {
  const successfulSplits = ws.changes
    .filter((item) => item.status === '已完成' && item.type === '拆群')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const splitMeta = new Map<string, { createdAt: string; frame: number; rank: number }>()
  successfulSplits.forEach((change) => {
    change.childCodes?.forEach((code, index) => {
      splitMeta.set(code, {
        createdAt: change.createdAt,
        frame: change.childFrames?.[index] ?? 0,
        rank: change.strengthRank?.[code] ?? 0
      })
    })
  })

  const markColony = (code: string): void => {
    const stillPlaced = ws.points.some((point) => point.colonyCodes.includes(code))
    if (stillPlaced) return
    const colony = ws.colonies.find((item) => item.code === code)
    if (colony && colony.status !== '回场') {
      colony.status = '待投放'
      colony.currentOrchardId = ''
    }
  }

  ws.points.forEach((point) => {
    while (point.colonyCodes.length > point.capacityBoxes) {
      const ranked = point.colonyCodes
        .map((code, index) => {
          const meta = splitMeta.get(code)
          return {
            code,
            index,
            isSplit: Boolean(meta),
            createdAt: meta?.createdAt ?? '',
            frame: meta?.frame ?? Number.POSITIVE_INFINITY,
            rank: meta?.rank ?? 0
          }
        })
        .sort((a, b) => {
          // 拆出的组优先于原群；同一次拆群里弱组（群势次序靠后）先退；并列时按当前顺序
          if (a.isSplit !== b.isSplit) return a.isSplit ? -1 : 1
          if (a.isSplit && b.isSplit) {
            if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt)
            if (a.rank !== b.rank) return b.rank - a.rank
            if (a.frame !== b.frame) return a.frame - b.frame
          }
          return a.index - b.index
        })
      const victim = ranked[0]
      point.colonyCodes.splice(victim.index, 1)
      summary.evicted.push({ code: victim.code, pointCode: point.code })
      markColony(victim.code)
    }
  })
}

/** 容量恢复：拆群时退回待投放的子群，按原计划箱位补回 */
function refillSplitChildren(ws: WorkSet, summary: RecomputeSummary): void {
  const successfulSplits = ws.changes
    .filter((item) => item.status === '已完成' && item.type === '拆群')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  // 还有待重试的拆群可能重建/占用同群号，补回让给重试阶段处理，避免互相覆盖
  const pendingSplitCodes = new Set(
    ws.changes
      .filter((item) => item.status === '待重试' && item.type === '拆群')
      .flatMap((item) => item.childCodes ?? [])
  )

  successfulSplits.forEach((change) => {
    change.childCodes?.forEach((code) => {
      if (pendingSplitCodes.has(code)) return
      const colony = ws.colonies.find((item) => item.code === code)
      if (!colony) return
      const already = ws.points.some((point) => point.colonyCodes.includes(code))
      // 只补「拆群时按计划该放、但装不下退回待投放」且当前完全没有箱位的子群
      if (already || colony.status !== '待投放') return
      const planned = change.plan?.[code] ?? []
      if (planned.length === 0) return
      const isOverflowChild = !planned.every((pointId) => {
        const point = ws.points.find((item) => item.id === pointId)
        // 计划点已不存在视为已失效；存在且仍含该群才算当时放下了
        return !point || point.colonyCodes.includes(code)
      })
      if (!isOverflowChild) return
      const gained: string[] = []
      planned.forEach((pointId) => {
        const point = ws.points.find((item) => item.id === pointId)
        if (!point || point.colonyCodes.includes(code)) return
        if (point.colonyCodes.length < point.capacityBoxes) {
          point.colonyCodes.push(code)
          gained.push(pointId)
          summary.refilled.push({ code, pointCode: point.code })
        }
      })
      if (gained.length > 0) {
        const first = ws.points.find((item) => item.id === gained[0])
        colony.currentOrchardId = first?.orchardId ?? ''
        colony.status = '在园'
      }
    })
  })
}

/** 技术员手工安排待投放蜂群到投放点（仅在容量内放入/移出） */
export async function setColonyAssignments(colonyId: string, pointIds: string[]): Promise<void> {
  await db.transaction('rw', db.colonies, db.dropPoints, async () => {
    const colony = await db.colonies.get(colonyId)
    if (!colony) throw new Error('蜂群不存在')
    const points = await db.dropPoints.toArray()
    const wanted = new Set(pointIds)

    points.forEach((point) => {
      const has = point.colonyCodes.includes(colony.code)
      const should = wanted.has(point.id)
      if (should && !has) {
        if (point.colonyCodes.length >= point.capacityBoxes) {
          throw new Error(`投放点 ${point.code} 容量已满（${point.capacityBoxes} 箱）`)
        }
        point.colonyCodes.push(colony.code)
      } else if (!should && has) {
        point.colonyCodes = point.colonyCodes.filter((code) => code !== colony.code)
      }
    })

    const placed = points
      .filter((point) => point.colonyCodes.includes(colony.code))
      .sort((a, b) => pointRank(a).localeCompare(pointRank(b)))
    colony.currentOrchardId = placed[0]?.orchardId ?? ''
    if (colony.status === '待投放' && placed.length > 0) colony.status = '在园'
    if (placed.length === 0 && colony.status !== '回场') colony.status = '待投放'

    await db.dropPoints.bulkPut(points)
    await db.colonies.put(colony)
  })
}

/** 删除分并变更单据（仅清理记录，不影响投放点安排） */
export async function removeColonyChange(changeId: string): Promise<void> {
  await db.colonyChanges.delete(changeId)
}
