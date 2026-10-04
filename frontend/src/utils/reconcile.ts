import type { BeeColony, ColonyChange, DropPoint, Placement } from '@/types'
import { db } from '@/hooks/usePersistentStore'
import { applyMerge, applySplit, cloneData, failChange, usedBoxes, type ColonyData } from '@/utils/colonyOps'
import { uid } from '@/utils/id'

/**
 * 统一重算：投放点容量改动、分并变更登记/重试、箱位手工调整后都走这里。
 *
 * 顺序：
 * 1. 重放「待执行 / 失败」的分并变更（按登记先后）；引用失效的失败单保留并说明原因；
 * 2. 拆群溢出槽回座：容量放开时优先把退回待投放的箱子放回原投放点；
 * 3. 超容量裁剪：容量改小后把多余箱位退回待投放。
 *
 * 分并失败时只更新变更单状态与原因，蜂群与箱位数据不动。
 */
export interface ReconcileReport {
  completedChanges: ColonyChange[]
  failedChanges: ColonyChange[]
  reseated: { changeId: string; colonyId: string; dropId: string; boxes: number }[]
  trimmed: { dropId: string; colonyId: string; boxes: number }[]
}

interface Snapshot {
  colonies: BeeColony[]
  placements: Placement[]
  changes: ColonyChange[]
  drops: DropPoint[]
}

async function readSnapshot(): Promise<Snapshot> {
  const [colonies, placements, changes, drops] = await Promise.all([
    db.colonies.toArray(),
    db.placements.toArray(),
    db.colonyChanges.toArray(),
    db.dropPoints.toArray()
  ])
  return { colonies, placements, changes, drops }
}

/** 执行一张变更单（纯计算 → 返回新数据） */
function simulateChange(
  change: ColonyChange,
  data: ColonyData,
  now: string
): { ok: boolean; reason: string; colonies: BeeColony[]; placements: Placement[]; change: ColonyChange } {
  if (change.kind === '并群') {
    return applyMerge(change, data, { now, idFactory: () => uid('grp') })
  }
  return applySplit(change, data, { now })
}

/** 步骤 2：溢出槽回座（容量放开后把退回待投放的箱子放回原投放点） */
function reseatOverflow(data: ColonyData, changes: ColonyChange[], report: ReconcileReport['reseated']): void {
  const pending = changes
    .filter((change) => change.status === '成功' && change.overflowSlots.length > 0)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
  for (const change of pending) {
    const rest = change.overflowSlots
      .map((slot) => ({ ...slot }))
      .filter((slot) => {
        const colony = data.colonies.find((item) => item.id === slot.colonyId)
        const drop = data.drops.find((item) => item.id === slot.dropId)
        return Boolean(colony && drop)
      })
    if (rest.length === 0) continue

    const remain: ColonyChange['overflowSlots'] = []
    for (const slot of rest) {
      const free = (data.drops.find((item) => item.id === slot.dropId)?.capacityBoxes ?? 0) - usedBoxes(slot.dropId, data.placements)
      if (free <= 0) {
        remain.push(slot)
        continue
      }
      const boxes = Math.min(free, slot.boxes)
      const existing = data.placements.find((item) => item.colonyId === slot.colonyId && item.dropId === slot.dropId)
      if (existing) existing.boxes += boxes
      else data.placements.push({ id: uid('plc'), colonyId: slot.colonyId, dropId: slot.dropId, boxes })
      const colony = data.colonies.find((item) => item.id === slot.colonyId)
      if (colony && colony.status === '待投放') {
        const drop = data.drops.find((item) => item.id === slot.dropId)
        colony.status = '在园'
        colony.currentOrchardId = drop?.orchardId ?? colony.currentOrchardId
      }
      report.push({ changeId: change.id, colonyId: slot.colonyId, dropId: slot.dropId, boxes })
      if (boxes < slot.boxes) remain.push({ ...slot, boxes: slot.boxes - boxes })
    }
    change.overflowSlots = remain
  }
}

/** 步骤 3：超容量裁剪（按群号倒序逐群减，减空的群退回待投放） */
function trimOverCapacity(data: ColonyData, report: ReconcileReport['trimmed']): void {
  for (const drop of data.drops) {
    let over = usedBoxes(drop.id, data.placements) - drop.capacityBoxes
    if (over <= 0) continue
    const slots = data.placements
      .filter((item) => item.dropId === drop.id && item.boxes > 0)
      .map((slot) => ({ slot, code: data.colonies.find((item) => item.id === slot.colonyId)?.code ?? '' }))
      .sort((a, b) => b.code.localeCompare(a.code, 'zh-Hans-CN'))
    for (const entry of slots) {
      if (over <= 0) break
      const cut = Math.min(entry.slot.boxes, over)
      entry.slot.boxes -= cut
      over -= cut
      report.push({ dropId: drop.id, colonyId: entry.slot.colonyId, boxes: cut })
    }
  }
  // 清零的箱位删掉；一箱都不剩的群退回待投放
  const emptied = data.placements.filter((item) => item.boxes <= 0).map((item) => item.colonyId)
  data.placements = data.placements.filter((item) => item.boxes > 0)
  new Set(emptied).forEach((colonyId) => {
    if (data.placements.some((item) => item.colonyId === colonyId)) return
    const colony = data.colonies.find((item) => item.id === colonyId)
    if (colony && colony.status !== '回场') {
      colony.status = '待投放'
      colony.currentOrchardId = ''
    }
  })
}

/** 在一个 Dexie 事务内跑完全部重算，并把结果落库 */
export async function reconcile(): Promise<ReconcileReport> {
  const report: ReconcileReport = { completedChanges: [], failedChanges: [], reseated: [], trimmed: [] }
  const now = new Date().toISOString()

  await db.transaction('rw', db.colonies, db.placements, db.colonyChanges, db.dropPoints, async () => {
    const snap = await readSnapshot()
    const data: ColonyData = cloneData({
      colonies: snap.colonies,
      placements: snap.placements,
      drops: snap.drops
    })
    const changes = snap.changes.map((item) => ({ ...item, overflowSlots: item.overflowSlots.map((slot) => ({ ...slot })) }))
    const changeById = new Map(changes.map((item) => [item.id, item]))

    // 步骤 1：先裁剪超容量，把现场归一到「各点不超容」——容量改小后挂起的并群才可能解锁
    trimOverCapacity(data, report.trimmed)

    // 步骤 2：重放待执行 / 失败的变更单（按登记时间先后）
    const pending = changes
      .filter((item) => item.status === '待执行' || item.status === '失败')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const change of pending) {
      const result = simulateChange(change, data, now)
      if (result.ok) {
        data.colonies = result.colonies
        data.placements = result.placements
        const done = { ...result.change, status: '成功' as const, reason: '' }
        changeById.set(done.id, done)
        report.completedChanges.push(done)
      } else {
        const failed = failChange(change, result.reason)
        changeById.set(failed.id, failed)
        report.failedChanges.push(failed)
      }
    }

    // 步骤 3：成功拆群单上的溢出槽回座（容量放开后优先回原投放点）
    const allChanges = Array.from(changeById.values())
    reseatOverflow(data, allChanges, report.reseated)

    // 步骤 4：兜底再裁一次，保证任何路径下落库时都不超容
    trimOverCapacity(data, report.trimmed)

    await Promise.all([
      db.colonies.bulkPut(data.colonies),
      db.placements.bulkPut(data.placements),
      db.colonyChanges.bulkPut(allChanges)
    ])
    // 删除已不存在的箱位（裁剪清零等）与蜂群（并群被并掉、拆群原群）
    const alivePlacements = Array.from(new Set(data.placements.map((item) => item.id)))
    const beforePlacements = await db.placements.toCollection().primaryKeys()
    const stalePlacements = beforePlacements.filter((id) => !alivePlacements.includes(id))
    if (stalePlacements.length > 0) await db.placements.bulkDelete(stalePlacements)
    const aliveColonies = new Set(data.colonies.map((item) => item.id))
    const beforeColonies = await db.colonies.toCollection().primaryKeys()
    const staleColonies = beforeColonies.filter((id) => !aliveColonies.has(id))
    if (staleColonies.length > 0) await db.colonies.bulkDelete(staleColonies)
  })

  return report
}
