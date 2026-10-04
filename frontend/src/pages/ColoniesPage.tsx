import { useMemo, useState } from 'react'
import {
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Slider,
  Space,
  Table,
  Tag,
  Typography,
  message
} from 'antd'
import dayjs from 'dayjs'
import type { BeeColony, ColonyChange, ColonyStatus, DropPoint, Placement } from '@/types'
import { BEE_SPECIES, BOX_TYPES, COLONY_STATUSES } from '@/types'
import StatusTag from '@/components/common/StatusTag'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { colonyStore } from '@/stores/colonyStore'
import { colonyChangeStore } from '@/stores/colonyChangeStore'
import { orchardStore } from '@/stores/orchardStore'
import { droppointStore } from '@/stores/droppointStore'
import { placementStore } from '@/stores/placementStore'
import { uid } from '@/utils/id'

/** 蜂群台账：技术员管蜂群、箱位安排与分并变更；托管队的投放点容量只读引用 */
export default function ColoniesPage(): JSX.Element {
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const changes = usePersistentStore(colonyChangeStore, (state) => state.rows)
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const placements = usePersistentStore(placementStore, (state) => state.rows)

  const [statusFilter, setStatusFilter] = useState<ColonyStatus | ''>('')
  const [minFrames, setMinFrames] = useState(0)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [batchStatus, setBatchStatus] = useState<ColonyStatus>('在园')
  const [checkNote, setCheckNote] = useState('')
  const [checkDate, setCheckDate] = useState(dayjs())
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<BeeColony | null>(null)

  const [mergeOpen, setMergeOpen] = useState(false)
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitTarget, setSplitTarget] = useState<BeeColony | null>(null)

  const [assignDrop, setAssignDrop] = useState<DropPoint | null>(null)

  const [form] = Form.useForm<{
    code: string
    species: BeeColony['species']
    strengthFrames: number
    boxType: BeeColony['boxType']
    currentOrchardId: string
    status: ColonyStatus
    lastCheckDate: dayjs.Dayjs
    healthNote: string
  }>()
  const [mergeForm] = Form.useForm<{ sourceIds: string[]; survivorId: string; note: string }>()
  const [splitForm] = Form.useForm<{
    codeA: string
    framesA: number
    codeB: string
    framesB: number
    note: string
  }>()

  const filtered = useMemo(
    () =>
      colonies.filter((item) => {
        if (statusFilter && item.status !== statusFilter) return false
        if (item.strengthFrames < minFrames) return false
        return true
      }),
    [colonies, statusFilter, minFrames]
  )

  /** 群系 → 该系现存群号串（并群 / 拆群串起来的同一串群号） */
  const groupCodes = useMemo(() => {
    const map = new Map<string, string[]>()
    colonies.forEach((item) => {
      const list = map.get(item.groupId) ?? []
      list.push(item.code)
      map.set(item.groupId, list)
    })
    map.forEach((list) => list.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
    return map
  }, [colonies])

  const colonyById = useMemo(() => new Map(colonies.map((item) => [item.id, item])), [colonies])
  const usedByDrop = useMemo(() => {
    const map = new Map<string, number>()
    placements.forEach((item) => map.set(item.dropId, (map.get(item.dropId) ?? 0) + item.boxes))
    return map
  }, [placements])
  const usedByColony = useMemo(() => {
    const map = new Map<string, number>()
    placements.forEach((item) => map.set(item.colonyId, (map.get(item.colonyId) ?? 0) + item.boxes))
    return map
  }, [placements])

  function orchardName(id: string): string {
    return orchards.find((item) => item.id === id)?.name ?? '未分配地块'
  }

  function openCreate(): void {
    setEditing(null)
    form.setFieldsValue({
      code: `Q-${String(colonies.length + 1).padStart(2, '0')}`,
      species: '意蜂',
      strengthFrames: 6,
      boxType: '标准继箱',
      currentOrchardId: orchards[0]?.id ?? '',
      status: '待投放',
      lastCheckDate: dayjs(),
      healthNote: ''
    })
    setModalOpen(true)
  }

  function openEdit(colony: BeeColony): void {
    setEditing(colony)
    form.setFieldsValue({
      code: colony.code,
      species: colony.species,
      strengthFrames: colony.strengthFrames,
      boxType: colony.boxType,
      currentOrchardId: colony.currentOrchardId,
      status: colony.status,
      lastCheckDate: dayjs(colony.lastCheckDate),
      healthNote: colony.healthNote
    })
    setModalOpen(true)
  }

  async function submit(): Promise<void> {
    const values = await form.validateFields()
    if (colonies.some((item) => item.code === values.code.trim() && item.id !== editing?.id)) {
      message.error(`群号 ${values.code} 已存在`)
      return
    }
    const row: BeeColony = {
      id: editing?.id ?? uid('col'),
      code: values.code.trim(),
      species: values.species,
      strengthFrames: Number(values.strengthFrames) || 0,
      boxType: values.boxType,
      groupId: editing?.groupId ?? uid('grp'),
      currentOrchardId: values.currentOrchardId ?? '',
      status: values.status,
      lastCheckDate: values.lastCheckDate.format('YYYY-MM-DD'),
      healthNote: values.healthNote?.trim() ?? ''
    }
    await colonyStore.getState().save(row)
    message.success(`蜂群 ${row.code} 已保存`)
    setModalOpen(false)
  }

  async function applyBatchStatus(): Promise<void> {
    if (selectedKeys.length === 0) {
      message.warning('请先勾选蜂群')
      return
    }
    await colonyStore.getState().bulkSetStatus(selectedKeys, batchStatus)
    message.success(`已把 ${selectedKeys.length} 群状态改为「${batchStatus}」`)
    setSelectedKeys([])
  }

  async function applyCheckNote(): Promise<void> {
    if (selectedKeys.length === 0) {
      message.warning('请先勾选蜂群')
      return
    }
    if (!checkNote.trim()) {
      message.warning('请填写检查备注')
      return
    }
    await colonyStore.getState().bulkSetHealthNote(selectedKeys, checkNote.trim(), checkDate.format('YYYY-MM-DD'))
    message.success(`已为 ${selectedKeys.length} 群记录检查备注`)
    setCheckNote('')
  }

  // ============ 并群 ============
  function openMerge(colony?: BeeColony): void {
    const preselect = colony ? [colony.id] : selectedKeys.slice(0, 2)
    mergeForm.setFieldsValue({
      sourceIds: preselect,
      survivorId: preselect[0] ?? colony?.id,
      note: ''
    })
    setMergeOpen(true)
  }

  async function submitMerge(): Promise<void> {
    const values = await mergeForm.validateFields()
    if (!values.survivorId) {
      message.error('请指定留下的群')
      return
    }
    const sources = values.sourceIds.filter((id) => id !== values.survivorId)
    if (sources.length === 0) {
      message.error('至少要并掉一群（被并群不能包含留下的群）')
      return
    }
    const change: ColonyChange = {
      id: uid('chg'),
      kind: '并群',
      status: '待执行',
      reason: '',
      createdAt: new Date().toISOString(),
      completedAt: '',
      note: values.note?.trim() ?? '',
      sourceIds: sources,
      survivorId: values.survivorId,
      parentId: '',
      children: [],
      childColonyIds: [],
      overflowSlots: []
    }
    await colonyChangeStore.getState().register(change)
    const done = colonyChangeStore.getState().rows.find((item) => item.id === change.id)
    const survivorCode = colonyStore.getState().rows.find((item) => item.id === values.survivorId)?.code
    if (done?.status === '成功') {
      message.success(`并群完成：被并群箱位已转入 ${survivorCode ?? ''}（页面已刷新）`)
    } else {
      message.warning(`并群未能执行，变更单已保留：${done?.reason ?? '可在下方变更记录重试'}`)
    }
    setMergeOpen(false)
    setSelectedKeys([])
  }

  // ============ 拆群 ============
  function openSplit(colony: BeeColony): void {
    setSplitTarget(colony)
    splitForm.setFieldsValue({
      codeA: `${colony.code}-1`,
      framesA: Math.ceil(colony.strengthFrames / 2),
      codeB: `${colony.code}-2`,
      framesB: Math.floor(colony.strengthFrames / 2),
      note: ''
    })
    setSplitOpen(true)
  }

  async function submitSplit(): Promise<void> {
    if (!splitTarget) return
    const values = await splitForm.validateFields()
    if (colonies.some((item) => [values.codeA.trim(), values.codeB.trim()].includes(item.code))) {
      message.error('拆出的新群号与现有群号重复')
      return
    }
    const idA = uid('col')
    const idB = uid('col')
    const change: ColonyChange = {
      id: uid('chg'),
      kind: '拆群',
      status: '待执行',
      reason: '',
      createdAt: new Date().toISOString(),
      completedAt: '',
      note: values.note?.trim() ?? '',
      sourceIds: [],
      survivorId: '',
      parentId: splitTarget.id,
      children: [
        { code: values.codeA.trim(), strengthFrames: Number(values.framesA) || 0 },
        { code: values.codeB.trim(), strengthFrames: Number(values.framesB) || 0 }
      ],
      childColonyIds: [idA, idB],
      overflowSlots: []
    }
    await colonyChangeStore.getState().register(change)
    const done = colonyChangeStore.getState().rows.find((item) => item.id === change.id)
    if (done?.status === '成功') {
      const overflow = done.overflowSlots.reduce((sum, slot) => sum + slot.boxes, 0)
      message.success(
        overflow > 0
          ? `拆群完成：${overflow} 箱装不下，弱组已退回待投放，容量放开后自动回座`
          : '拆群完成，箱位已按两群群势分好'
      )
    } else {
      message.error(`拆群未执行：${done?.reason ?? '见变更记录'}`)
    }
    setSplitOpen(false)
    setSelectedKeys([])
  }

  const pendingChanges = changes.filter((item) => item.status !== '成功')
  const successChanges = changes.filter((item) => item.status === '成功')

  function describeChange(change: ColonyChange): string {
    const codeOf = (id: string): string => colonyById.get(id)?.code ?? '（已不在册）'
    if (change.kind === '并群') {
      return `${change.sourceIds.map(codeOf).join('、')} 并入 ${codeOf(change.survivorId)}`
    }
    return `${codeOf(change.parentId)} 拆为 ${change.children.map((child) => child.code).join('、')}（按群势 ${change.children
      .map((child) => `${child.strengthFrames} 框`)
      .join(' : ')} 分箱）`
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">蜂群台账</h2>
          <p className="page-sub">
            技术员管蜂群与分并变更：并群把被并群的箱位整串转到留下的群；拆群按两组群势分配箱位，装不下的退回待投放。投放点容量改动后，下方分并安排会自动重算。
          </p>
        </div>
        <Space>
          <Button onClick={() => openMerge()} disabled={selectedKeys.length < 1}>
            并群
          </Button>
          <Button type="primary" onClick={openCreate}>
            新增蜂群
          </Button>
        </Space>
      </div>

      <Card size="small">
        <Row gutter={[16, 12]} align="bottom">
          <Col xs={24} md={6}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              状态筛选
            </Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={statusFilter}
              onChange={(value) => setStatusFilter(value)}
              options={[{ value: '', label: '全部状态' }, ...COLONY_STATUSES.map((item) => ({ value: item, label: item }))]}
            />
          </Col>
          <Col xs={24} md={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              最小群势：{minFrames} 足框
            </Typography.Text>
            <Slider min={0} max={12} value={minFrames} onChange={setMinFrames} />
          </Col>
          <Col xs={24} md={10}>
            <Space wrap>
              <Select
                style={{ width: 140 }}
                value={batchStatus}
                onChange={(value) => setBatchStatus(value)}
                options={COLONY_STATUSES.map((item) => ({ value: item, label: `改为 ${item}` }))}
              />
              <Button onClick={() => void applyBatchStatus()}>批量改状态</Button>
              <Input
                style={{ width: 200 }}
                placeholder="检查备注"
                value={checkNote}
                onChange={(event) => setCheckNote(event.target.value)}
              />
              <DatePicker value={checkDate} onChange={(value) => setCheckDate(value ?? dayjs())} />
              <Button onClick={() => void applyCheckNote()}>批量记录检查</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      <Card size="small" title={`蜂群清单（命中 ${filtered.length} / ${colonies.length}）`}>
        <Table<BeeColony>
          dataSource={filtered}
          rowKey="id"
          pagination={false}
          rowSelection={{ selectedRowKeys: selectedKeys, onChange: (keys) => setSelectedKeys(keys as string[]) }}
          columns={[
            { title: '群号', dataIndex: 'code', key: 'code', width: 90 },
            {
              title: '群系（同串群号）',
              key: 'group',
              render: (_, record) => {
                const codes = groupCodes.get(record.groupId) ?? [record.code]
                return codes.length > 1 ? (
                  <Space size={4} wrap>
                    {codes.map((code) => (
                      <Tag key={code} color={code === record.code ? 'geekblue' : 'default'}>
                        {code}
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">独立一群</Typography.Text>
                )
              }
            },
            { title: '蜂种', dataIndex: 'species', key: 'species', width: 70 },
            {
              title: '群势',
              dataIndex: 'strengthFrames',
              key: 'frames',
              width: 90,
              sorter: (a: BeeColony, b: BeeColony) => a.strengthFrames - b.strengthFrames,
              render: (value: number) => `${value} 足框`
            },
            { title: '箱型', dataIndex: 'boxType', key: 'box', width: 96 },
            {
              title: '已排箱位',
              key: 'placed',
              width: 150,
              render: (_, record) => {
                const slots = placements.filter((item) => item.colonyId === record.id)
                if (slots.length === 0) return <Tag>待投放（0 箱）</Tag>
                return (
                  <Space size={4} wrap>
                    {slots.map((slot) => {
                      const drop = dropPoints.find((item) => item.id === slot.dropId)
                      return (
                        <Tag key={slot.id} color="cyan">
                          {drop?.code ?? '未知点'}×{slot.boxes}
                        </Tag>
                      )
                    })}
                  </Space>
                )
              }
            },
            {
              title: '当前所在地块',
              key: 'orchard',
              width: 130,
              render: (_, record: BeeColony) => (record.currentOrchardId ? orchardName(record.currentOrchardId) : '—')
            },
            {
              title: '状态',
              key: 'status',
              width: 130,
              render: (_, record: BeeColony) => (
                <StatusTag status={record.status} hint={record.currentOrchardId ? orchardName(record.currentOrchardId) : undefined} />
              )
            },
            { title: '最近检查', dataIndex: 'lastCheckDate', key: 'check', width: 104 },
            {
              title: '操作',
              key: 'action',
              width: 190,
              render: (_, record) => (
                <Space size={0}>
                  <Button size="small" type="link" onClick={() => openEdit(record)}>
                    编辑
                  </Button>
                  <Button size="small" type="link" onClick={() => openSplit(record)}>
                    拆群
                  </Button>
                  <Button size="small" type="link" onClick={() => openMerge(record)}>
                    并群
                  </Button>
                  <Popconfirm title="删群会连带删除其箱位安排，确定？" onConfirm={() => void colonyStore.getState().remove(record.id)}>
                    <Button size="small" type="link" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              )
            }
          ]}
        />
      </Card>

      <Card size="small" title="投放点箱位安排（技术员按容量排群）" style={{ marginTop: 12 }}>
        <Table<DropPoint>
          size="small"
          pagination={false}
          dataSource={dropPoints}
          rowKey="id"
          locale={{ emptyText: '暂无投放点，请先在「果园地块管理」里由托管队建档' }}
          columns={[
            { title: '投放点', dataIndex: 'code', key: 'code', width: 90 },
            {
              title: '所属地块',
              key: 'orchard',
              render: (_, record) => orchardName(record.orchardId)
            },
            {
              title: '容量占用',
              key: 'usage',
              width: 140,
              render: (_, record) => {
                const used = usedByDrop.get(record.id) ?? 0
                return (
                  <Tag color={used > record.capacityBoxes ? 'red' : used === record.capacityBoxes ? 'gold' : 'green'}>
                    {used} / {record.capacityBoxes} 箱
                  </Tag>
                )
              }
            },
            {
              title: '已安排',
              key: 'assign',
              render: (_, record) => {
                const slots = placements.filter((item) => item.dropId === record.id)
                if (slots.length === 0) return <Typography.Text type="secondary">空点</Typography.Text>
                return (
                  <Space size={4} wrap>
                    {slots.map((slot: Placement) => (
                      <Tag key={slot.id}>{colonyById.get(slot.colonyId)?.code ?? '未知群'}×{slot.boxes}</Tag>
                    ))}
                  </Space>
                )
              }
            },
            {
              title: '操作',
              key: 'action',
              width: 120,
              render: (_, record) => (
                <Button size="small" type="link" onClick={() => setAssignDrop(record)}>
                  安排箱位
                </Button>
              )
            }
          ]}
        />
      </Card>

      {pendingChanges.length > 0 ? (
        <Card
          size="small"
          style={{ marginTop: 12 }}
          title={
            <Space>
              <Tag color="red">待重试 {pendingChanges.length}</Tag>
              <span>分并不成的变更留着重试；期间投放点安排照旧不动</span>
            </Space>
          }
          extra={
            <Button
              size="small"
              type="primary"
              onClick={async () => {
                await colonyChangeStore.getState().retryAll()
                message.success('已按当前投放点容量重新计算分并安排')
              }}
            >
              全部重试
            </Button>
          }
        >
          <ChangeTable
            changes={pendingChanges}
            describeChange={describeChange}
            onRetry={() => {
              void colonyChangeStore.getState().retryAll().then(() => message.success('已重新计算'))
            }}
            allowDelete={false}
          />
        </Card>
      ) : null}

      {successChanges.length > 0 ? (
        <Card size="small" style={{ marginTop: 12 }} title={`分并记录（成功 ${successChanges.length} 单）`}>
          <ChangeTable
            changes={successChanges}
            describeChange={describeChange}
            onRetry={() => undefined}
            allowDelete
            onDelete={(id) => void colonyChangeStore.getState().remove(id)}
          />
        </Card>
      ) : null}

      <Card size="small" title="状态分布" style={{ marginTop: 12 }}>
        <Space wrap>
          {COLONY_STATUSES.map((status) => (
            <Tag key={status} color="default">
              {status}：{colonies.filter((item) => item.status === status).length} 群
            </Tag>
          ))}
          <Tag color="blue">
            平均群势：
            {(colonies.reduce((sum, item) => sum + item.strengthFrames, 0) / Math.max(1, colonies.length)).toFixed(1)} 足框
          </Tag>
          <Tag color="cyan">
            已排箱位：
            {placements.reduce((sum, item) => sum + item.boxes, 0)} 箱 / {usedByColony.size} 群
          </Tag>
        </Space>
      </Card>

      <Modal title={editing ? '编辑蜂群' : '新增蜂群'} open={modalOpen} onCancel={() => setModalOpen(false)} onOk={() => void submit()} okText="保存" width={680}>
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="code" label="群号" rules={[{ required: true, message: '请填写群号' }]}>
                <Input placeholder="如 Q-04" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="species" label="蜂种" rules={[{ required: true }]}>
                <Select options={BEE_SPECIES.map((item) => ({ value: item, label: item }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="strengthFrames" label="群势（足框）" rules={[{ required: true }]}>
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="boxType" label="箱型" rules={[{ required: true }]}>
                <Select options={BOX_TYPES.map((item) => ({ value: item, label: item }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="status" label="状态" rules={[{ required: true }]}>
                <Select options={COLONY_STATUSES.map((item) => ({ value: item, label: item }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="lastCheckDate" label="最近检查日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="currentOrchardId" label="当前所在地块">
                <Select
                  allowClear
                  options={orchards.map((item) => ({ value: item.id, label: `${item.name}（${item.crop}）` }))}
                />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="healthNote" label="蜂群健康备注">
                <Input.TextArea rows={2} placeholder="如 轻微螨害，转场后需治螨" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title="并群：把弱群并进强群"
        open={mergeOpen}
        onCancel={() => setMergeOpen(false)}
        onOk={() => void submitMerge()}
        okText="执行并群"
        width={620}
      >
        <Form form={mergeForm} layout="vertical">
          <Form.Item
            name="sourceIds"
            label="被并掉的群（可多选；箱位整串转给留下的群）"
            rules={[{ required: true, message: '请至少选择一群' }]}
          >
            <Select
              mode="multiple"
              optionFilterProp="label"
              options={colonies.map((item) => ({
                value: item.id,
                label: `${item.code}（${item.species} ${item.strengthFrames} 足框 · ${item.status}）`
              }))}
              onChange={(ids: string[]) => {
                const survivor = mergeForm.getFieldValue('survivorId')
                if (!survivor || !ids.includes(survivor)) mergeForm.setFieldValue('survivorId', ids[0])
              }}
            />
          </Form.Item>
          <Form.Item name="survivorId" label="留下的群（群号与群系保留）" rules={[{ required: true, message: '请指定留下的群' }]}>
            <Select
              optionFilterProp="label"
              options={colonies.map((item) => ({
                value: item.id,
                label: `${item.code}（${item.species} ${item.strengthFrames} 足框）`
              }))}
            />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input placeholder="如 授粉季弱群补强" />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            并群只转箱位、不增加投放点总箱数；若现场有投放点超容导致执行失败，本单保留为「失败」，可在容量调整后重试，期间投放点安排不变。
          </Typography.Paragraph>
        </Form>
      </Modal>

      <Modal
        title={splitTarget ? `拆群：${splitTarget.code}（${splitTarget.strengthFrames} 足框）拆为两组` : '拆群'}
        open={splitOpen}
        onCancel={() => setSplitOpen(false)}
        onOk={() => void submitSplit()}
        okText="执行拆群"
        width={620}
      >
        <Form form={splitForm} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="codeA" label="一组群号" rules={[{ required: true, message: '请填写群号' }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="framesA" label="一组群势（足框）" rules={[{ required: true }]}>
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="codeB" label="二组群号" rules={[{ required: true, message: '请填写群号' }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="framesB" label="二组群势（足框）" rules={[{ required: true }]}>
                <InputNumber min={0} max={20} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="note" label="备注">
            <Input placeholder="如 强群补位西沟，弱组留待投放" />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            每个投放点的箱位按两组群势之比拆分（最大余数法，强组优先保底）；某点一箱都分不到的组退回「待投放」，等该点容量放开后自动回座。
          </Typography.Paragraph>
        </Form>
      </Modal>

      {assignDrop ? (
        <AssignDropModal
          drop={assignDrop}
          orchards={orchards}
          colonies={colonies}
          placements={placements}
          onClose={() => setAssignDrop(null)}
        />
      ) : null}
    </div>
  )
}

/** 变更记录表 */
function ChangeTable({
  changes,
  describeChange,
  onRetry,
  onDelete,
  allowDelete
}: {
  changes: ColonyChange[]
  describeChange: (change: ColonyChange) => string
  onRetry: (id: string) => void
  onDelete?: (id: string) => void
  allowDelete: boolean
}): JSX.Element {
  return (
    <Table<ColonyChange>
      size="small"
      pagination={false}
      dataSource={changes}
      rowKey="id"
      columns={[
        { title: '类型', dataIndex: 'kind', key: 'kind', width: 70, render: (value: ColonyChange['kind']) => <Tag color="blue">{value}</Tag> },
        { title: '内容', key: 'desc', render: (_, record) => describeChange(record) },
        {
          title: '状态 / 原因',
          key: 'status',
          width: 260,
          render: (_, record) =>
            record.status === '失败' || record.status === '待执行' ? (
              <Space direction="vertical" size={0}>
                <Tag color={record.status === '失败' ? 'red' : 'orange'}>{record.status}</Tag>
                {record.reason ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{record.reason}</Typography.Text> : null}
              </Space>
            ) : (
              <Tag color="green">成功</Tag>
            )
        },
        { title: '登记时间', dataIndex: 'createdAt', key: 'time', width: 170, render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm') },
        {
          title: '操作',
          key: 'action',
          width: 120,
          render: (_, record) => (
            <Space size={0}>
              {record.status !== '成功' ? (
                <Button size="small" type="link" onClick={() => onRetry(record.id)}>
                  重试
                </Button>
              ) : null}
              {allowDelete && onDelete ? (
                <Popconfirm title="删除这条分并记录？蜂群与箱位不受影响" onConfirm={() => onDelete(record.id)}>
                  <Button size="small" type="link" danger>
                    删除
                  </Button>
                </Popconfirm>
              ) : null}
            </Space>
          )
        }
      ]}
    />
  )
}

/** 投放点箱位安排弹窗：按群设置箱数，总量不得超过该点容量 */
function AssignDropModal({
  drop,
  orchards,
  colonies,
  placements,
  onClose
}: {
  drop: DropPoint
  orchards: { id: string; name: string }[]
  colonies: BeeColony[]
  placements: Placement[]
  onClose: () => void
}): JSX.Element {
  const orchard = orchards.find((item) => item.id === drop.orchardId)
  const existing = placements.filter((item) => item.dropId === drop.id)
  const [drafts, setDrafts] = useState<{ colonyId: string; boxes: number }[]>(
    existing.length > 0
      ? existing.map((item) => ({ colonyId: item.colonyId, boxes: item.boxes }))
      : [{ colonyId: colonies[0]?.id ?? '', boxes: Math.min(2, drop.capacityBoxes) }]
  )

  const total = drafts.reduce((sum, item) => sum + (Number(item.boxes) || 0), 0)
  const over = total > drop.capacityBoxes
  const usedColonyIds = new Set(drafts.map((item) => item.colonyId))

  function update(index: number, patch: Partial<{ colonyId: string; boxes: number }>): void {
    setDrafts((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  async function save(): Promise<void> {
    if (over) {
      message.error(`合计 ${total} 箱超过投放点容量 ${drop.capacityBoxes} 箱`)
      return
    }
    if (drafts.some((item) => !item.colonyId)) {
      message.error('每行都要选择蜂群')
      return
    }
    await placementStore.getState().saveDropAssignments(drop.id, drafts)
    message.success(`投放点 ${drop.code} 的箱位安排已保存，分并安排已重算`)
    onClose()
  }

  return (
    <Modal title={`安排箱位 · ${drop.code}（${orchard?.name ?? ''}）`} open onCancel={onClose} onOk={() => void save()} width={640} okText="保存安排">
      <Space style={{ marginBottom: 12 }}>
        <Tag color={over ? 'red' : total === drop.capacityBoxes ? 'gold' : 'green'}>
          合计 {total} / {drop.capacityBoxes} 箱
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          一行一群，箱数为 0 的行会清空；容量由托管队维护，改容量后回蜂群台账会自动重算分并。
        </Typography.Text>
      </Space>
      <Table
        size="small"
        pagination={false}
        dataSource={drafts.map((item, index) => ({ ...item, key: index }))}
        columns={[
          {
            title: '蜂群',
            key: 'colony',
            render: (_, record) => (
              <Select
                style={{ width: '100%' }}
                value={record.colonyId || undefined}
                optionFilterProp="label"
                placeholder="选择蜂群"
                onChange={(value) => update(record.key, { colonyId: value })}
                options={colonies.map((item) => ({
                  value: item.id,
                  label: `${item.code}（${item.species} ${item.strengthFrames} 足框 · ${item.status}）`,
                  disabled: item.id !== record.colonyId && usedColonyIds.has(item.id)
                }))}
              />
            )
          },
          {
            title: '箱数',
            key: 'boxes',
            width: 130,
            render: (_, record) => (
              <InputNumber min={0} max={drop.capacityBoxes} value={record.boxes} onChange={(value) => update(record.key, { boxes: Number(value) || 0 })} />
            )
          },
          {
            title: '',
            key: 'remove',
            width: 60,
            render: (_, record) => (
              <Button
                size="small"
                type="link"
                danger
                onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== record.key))}
              >
                移除
              </Button>
            )
          }
        ]}
      />
      <Button
        style={{ marginTop: 10 }}
        disabled={drafts.length >= colonies.length}
        onClick={() => setDrafts((prev) => [...prev, { colonyId: colonies.find((item) => !usedColonyIds.has(item.id))?.id ?? '', boxes: 1 }])}
      >
        + 加一群
      </Button>
    </Modal>
  )
}
