/* eslint-disable no-console */
import 'fake-indexeddb/auto'
import { db } from '@/hooks/usePersistentStore'
import {
  apportionSlots,
  createMerge,
  createSplit,
  recomputeAll,
  setColonyAssignments
} from '@/services/colonyChangeEngine'
import type { BeeColony, DropPoint } from '@/types'

let passed = 0
let failed = 0

function assert(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`, detail ?? '')
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function colony(id: string, code: string, frames: number, groupId = id): BeeColony {
  return {
    id,
    code,
    species: '意蜂',
    strengthFrames: frames,
    boxType: '平箱',
    currentOrchardId: '',
    status: '待投放',
    lastCheckDate: '2026-04-01',
    healthNote: '',
    groupId
  }
}

function point(id: string, orchardId: string, cap: number, codes: string[], window = '2026-04-08'): DropPoint {
  return {
    id,
    orchardId,
    longitude: 107,
    latitude: 34,
    code: id.toUpperCase(),
    capacityBoxes: cap,
    shade: '',
    waterDistance: 100,
    dropWindow: window,
    withdrawTime: '2026-04-18',
    owner: '',
    colonyCodes: codes
  }
}

async function reset(): Promise<void> {
  await db.delete()
  await db.open()
}

async function seed(coloniesIn: BeeColony[], pointsIn: DropPoint[]): Promise<void> {
  await reset()
  await db.colonies.bulkAdd(coloniesIn)
  await db.dropPoints.bulkAdd(pointsIn)
}

async function getCodes(pointId: string): Promise<string[]> {
  const p = await db.dropPoints.get(pointId)
  return p ? p.colonyCodes : []
}

// ---------- 纯函数：按群势分箱位 ----------
console.log('apportionSlots（最大余数，强群优先）')
assert('10 框 6:4 分 3 箱 → [2,1]', deepEqual(apportionSlots(3, [6, 4]), [2, 1]))
assert('10 框 5:5 分 3 箱 → [2,1]', deepEqual(apportionSlots(3, [5, 5]), [2, 1]))
assert('7 框 2:2:3 分 5 箱 → 余数并列按序 → [2,1,2]', deepEqual(apportionSlots(5, [2, 2, 3]), [2, 1, 2]))
assert('0 箱 → 全 0', deepEqual(apportionSlots(0, [6, 4]), [0, 0]))
assert('10 框 6:4 分 10 箱 → [6,4]', deepEqual(apportionSlots(10, [6, 4]), [6, 4]))
assert('余数并列弱群不抢强群：10 框 6:4 分 1 箱 → [1,0]', deepEqual(apportionSlots(1, [6, 4]), [1, 0]))

// ---------- 并群：旧群号串转到留下群号 ----------
console.log('\n并群')
{
  await seed(
    [colony('c1', 'Q-01', 3, 'g1'), colony('c2', 'Q-02', 5, 'g2'), colony('c3', 'Q-03', 4, 'g3')],
    [
      point('p1', 'o1', 6, ['Q-02']),
      point('p2', 'o2', 6, ['Q-02', 'Q-03'], '2026-04-12'),
      point('p3', 'o3', 6, ['Q-03'], '2026-04-15')
    ]
  )
  const r = await createMerge('Q-01', ['Q-02', 'Q-03'])
  assert('并群成功', r.ok && !r.pending, r)
  const codes1 = await getCodes('p1')
  const codes2 = await getCodes('p2')
  const codes3 = await getCodes('p3')
  assert('p1 群号转到 Q-01', deepEqual(codes1, ['Q-01']), codes1)
  assert('p2 两群并到同点去重只占一箱', deepEqual(codes2, ['Q-01']), codes2)
  assert('p3 群号转到 Q-01', deepEqual(codes3, ['Q-01']), codes3)
  const remaining = await db.colonies.toArray()
  assert('被并两群已删除，只留 Q-01', remaining.length === 1 && remaining[0].code === 'Q-01', remaining.map((i) => i.code))
  assert('群势累加 3+5+4=12', remaining[0].strengthFrames === 12, remaining[0].strengthFrames)
  const change = await db.colonyChanges.toArray()
  assert('变更单已完成', change.length === 1 && change[0].status === '已完成', change)
}

// ---------- 并群失败：留下群号不存在，安排照旧 ----------
console.log('\n并群失败保留待重试')
{
  await seed(
    [colony('c1', 'Q-01', 3), colony('c2', 'Q-02', 5)],
    [point('p1', 'o1', 6, ['Q-02'])]
  )
  const r = await createMerge('Q-99', ['Q-02'])
  assert('并群失败', !r.ok && r.pending, r)
  assert('投放点安排照旧', deepEqual(await getCodes('p1'), ['Q-02']))
  const cols = await db.colonies.toArray()
  assert('蜂群未被删除', cols.length === 2, cols.map((i) => i.code))
  const chg = await db.colonyChanges.toArray()
  assert('变更单保留为待重试', chg.length === 1 && chg[0].status === '待重试' && chg[0].note.includes('不存在'))

  // 让留下群号出现后重试
  await db.colonies.add(colony('c99', 'Q-99', 2))
  await recomputeAll()
  assert('重试后安排转到 Q-99', deepEqual(await getCodes('p1'), ['Q-99']))
  const chg2 = await db.colonyChanges.toArray()
  assert('重试后变更已完成', chg2[0].status === '已完成')
}

// ---------- 拆群：按群势分箱位 ----------
console.log('\n拆群')
{
  await seed(
    [colony('c1', 'Q-10', 10, 'g10')],
    [
      point('p1', 'o1', 6, ['Q-10'], '2026-04-08'),
      point('p2', 'o1', 6, ['Q-10'], '2026-04-12'),
      point('p3', 'o2', 6, ['Q-10'], '2026-04-15')
    ]
  )
  const r = await createSplit('Q-10', ['Q-10A', 'Q-10B'], [6, 4])
  assert('拆群成功', r.ok && r.overflowCodes.length === 0, r)
  assert('早窗 p1 给强群 Q-10A', deepEqual(await getCodes('p1'), ['Q-10A']))
  assert('中窗 p2 给强群 Q-10A（6 框占 2 箱）', deepEqual(await getCodes('p2'), ['Q-10A']))
  assert('晚窗 p3 给弱群 Q-10B', deepEqual(await getCodes('p3'), ['Q-10B']))
  const cols = await db.colonies.toArray()
  const a = cols.find((i) => i.code === 'Q-10A')
  const b = cols.find((i) => i.code === 'Q-10B')
  assert('源群删除，生成两组', cols.length === 2 && a && b)
  assert('两组沿用同一谱系', a?.groupId === 'g10' && b?.groupId === 'g10')
  assert('放入箱位的新群置为在园', a && a.status === '在园', a)
  const chg = await db.colonyChanges.toArray()
  assert('拆群单已完成并记录 plan', chg[0].status === '已完成' && Object.keys(chg[0].plan ?? {}).length === 2)
}

// ---------- 拆群装不下退回待投放，容量恢复后补回 ----------
console.log('\n拆群溢出 → 容量恢复补回')
{
  await seed(
    [colony('c1', 'Q-20', 4, 'g20')],
    [point('p1', 'o1', 1, ['Q-20'])]
  )
  const r = await createSplit('Q-20', ['Q-20A', 'Q-20B'], [2, 2])
  assert('拆群成功（溢出不算失败）', r.ok, r)
  assert('强群拿到唯一箱位', deepEqual(await getCodes('p1'), ['Q-20A']))
  const cols = await db.colonies.toArray()
  const weak = cols.find((i) => i.code === 'Q-20B')
  assert('弱群退回待投放', weak?.status === '待投放' && weak.currentOrchardId === '', weak)

  // 容量扩容 → 重算补回
  const p = (await db.dropPoints.get('p1')) as DropPoint
  p.capacityBoxes = 2
  await db.dropPoints.put(p)
  const s = await recomputeAll()
  assert('补回 1 个箱位', s.refilled.length === 1 && s.refilled[0].code === 'Q-20B', s)
  assert('p1 现含两组', deepEqual(await getCodes('p1'), ['Q-20A', 'Q-20B']))
  const weak2 = await db.colonies.toArray().then((list) => list.find((i) => i.code === 'Q-20B'))
  assert('弱群补回后恢复在园', weak2?.status === '在园' && weak2.currentOrchardId === 'o1', weak2)

  // 容量收回 → 弱组优先退回
  const p2 = (await db.dropPoints.get('p1')) as DropPoint
  p2.capacityBoxes = 1
  await db.dropPoints.put(p2)
  const s2 = await recomputeAll()
  assert('收缩时退回 1 箱', s2.evicted.length === 1 && s2.evicted[0].code === 'Q-20B', s2)
  assert('p1 只留强群', deepEqual(await getCodes('p1'), ['Q-20A']))
}

// ---------- 拆群失败：源群不存在 ----------
console.log('\n拆群失败保留待重试')
{
  await seed([colony('c1', 'Q-30', 4)], [point('p1', 'o1', 6, ['Q-30'])])
  const r = await createSplit('Q-404', ['A1', 'A2'], [2, 2])
  assert('拆群失败', !r.ok && r.pending, r)
  assert('安排照旧', deepEqual(await getCodes('p1'), ['Q-30']))
  assert('蜂群不增不减', (await db.colonies.toArray()).length === 1)
}

// ---------- 技术员手工投放受容量约束 ----------
console.log('\n手工投放')
{
  await seed(
    [colony('c1', 'Q-50', 4), colony('c2', 'Q-51', 4)],
    [point('p1', 'o1', 1, [])]
  )
  await setColonyAssignments('c1', ['p1'])
  assert('容量内可放入', deepEqual(await getCodes('p1'), ['Q-50']))
  let threw = false
  try {
    await setColonyAssignments('c2', ['p1'])
  } catch {
    threw = true
  }
  assert('超容量拒绝', threw)
  await setColonyAssignments('c1', [])
  assert('移出后清空', deepEqual(await getCodes('p1'), []))
}

// ---------- 悬挂群号清理 ----------
console.log('\n悬挂群号清理')
{
  await seed(
    [colony('c1', 'Q-60', 4)],
    [point('p1', 'o1', 4, ['Q-60', 'GONE-1', 'GONE-2'])]
  )
  const s = await recomputeAll()
  assert('无补算无补退', s.appliedChangeIds.length === 0 && s.evicted.length === 0 && s.refilled.length === 0, s)
  assert('悬挂群号被清掉', deepEqual(await getCodes('p1'), ['Q-60']))
}

// ---------- 拆群待重试：源群后补出现，重试成功 ----------
console.log('\n拆群待重试后补成功')
{
  await seed([colony('c1', 'Q-70', 6)], [point('p1', 'o1', 4, ['Q-70'])])
  const r = await createSplit('Q-71', ['Q-71A', 'Q-71B'], [3, 3])
  assert('源群不存在，拆群待重试', !r.ok && r.pending, r)
  assert('待重试期间安排照旧', deepEqual(await getCodes('p1'), ['Q-70']))
  // 与待重试单据同名的蜂群补录进来（含其投放点安排）
  await db.colonies.add(colony('c71', 'Q-71', 6))
  const p = (await db.dropPoints.get('p1')) as DropPoint
  p.colonyCodes = ['Q-70', 'Q-71']
  await db.dropPoints.put(p)
  const s = await recomputeAll()
  assert('重试补算 1 笔', s.appliedChangeIds.length === 1, s)
  const codes = await getCodes('p1')
  assert('源群 Q-71 被两组替代', codes.includes('Q-71A') && !codes.includes('Q-71') && codes.includes('Q-70'), codes)
  const now = await db.colonies.toArray()
  assert('台账为 Q-70 + 两个子群', now.length === 3 && now.every((i) => i.code !== 'Q-71'), now.map((i) => i.code))
}

// ---------- 容量收缩只影响超容点，不动其他点 ----------
console.log('\n收缩隔离')
{
  await seed(
    [colony('a', 'A', 2, 'g'), colony('b', 'B', 2, 'g'), colony('c', 'C', 2)],
    [point('p1', 'o1', 2, ['A', 'B']), point('p2', 'o2', 2, ['C'], '2026-04-20')]
  )
  const p1 = (await db.dropPoints.get('p1')) as DropPoint
  p1.capacityBoxes = 1
  await db.dropPoints.put(p1)
  const s = await recomputeAll()
  assert('仅 p1 退回 1 箱', s.evicted.length === 1 && s.evicted[0].pointCode === 'P1', s)
  assert('p2 不受影响', deepEqual(await getCodes('p2'), ['C']))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
