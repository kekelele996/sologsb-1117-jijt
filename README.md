# 蜜蜂授粉路线规划器（gbbeeroute）

面向果园托管服务队与蜂场技术员，把「果园地块 → 花期 → 蜂群投放点 → 转场路线」排成季内可执行的授粉安排，解决花期重叠时蜂群撞车、转场距离过远、投放点与地块不匹配的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21817>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbbeeroute
FRONTEND_PORT=21817
VITE_AMAP_KEY=            # 可选，留空即自动降级为本地 SVG 网格视图
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 |
| 语言 | TypeScript（`tsc --noEmit` 类型检查零错误） |
| UI 组件库 | Ant Design 5 |
| 地图 | 高德地图 JS API 2.0（可选，key 走 `VITE_AMAP_KEY`） |
| 状态管理 | Zustand |
| 路由 | React Router 6（nginx `try_files` 回落） |
| 构建 | Vite 5 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、高德地图 Key 与降级策略

- 在 `.env` 里填写 `VITE_AMAP_KEY=<你的 key>` 后**重新构建**（`docker compose up -d --build`），地图将使用高德 JS API 渲染地块、投放点与转场折线；
- **未配置 key 或脚本加载失败时，`RouteMap` 自动降级为本地 SVG 网格视图**：按经纬度线性映射渲染地块、投放点与转场折线，支持点选拾取坐标；
- **构建与运行都不依赖该 key**：未配置 key 时不会注入任何外部脚本（避免无谓请求与报错），Docker 构建零网络依赖即可通过；
- 页面右上角始终显示当前数据源（高德地图 JS API / 本地 SVG 网格视图）。

## 四、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21817
npm run build      # 类型检查 + 生产构建
```

## 五、目录结构

```
sologsb-1117/
├── docker-compose.yml          # 顶层 name: gbbeeroute，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # orchard.ts / colony.ts / droppoint.ts / placement.ts / route.ts / index.ts
│       ├── stores/             # orchardStore / colonyStore / droppointStore / placementStore / colonyChangeStore / routeStore（Zustand）
│       ├── components/common/  # RouteMap / FlowerWindowBar / StatusTag / CoordPicker
│       ├── hooks/              # useAmap / usePersistentStore
│       ├── pages/              # SchedulePage / OrchardsPage / ColoniesPage / RoutesPage / ExportPage
│       ├── router/index.tsx
│       └── utils/              # geo.ts / colonyOps.ts（分并纯计算）/ reconcile.ts（容量重算）/ export.ts / id.ts
```

## 六、数据模型与存储

| 模型 | 说明 | 归属 | Dexie 表 |
| --- | --- | --- | --- |
| Orchard 果园地块 | 地块名、作物、面积、经纬度、盛花期起止、需蜂强度（箱/亩）、园主联系方式、可达性、历史授粉年份 | 托管队 | `orchards` |
| DropPoint 投放点 | 所属地块、坐标、编号、**可容纳箱数**、遮阴条件、水源距离、投放时间窗、撤场时间、责任人（不挂群号） | 托管队 | `dropPoints` |
| BeeColony 蜂群 | 群号、群系 `groupId`、蜂种、群势（足框）、箱型、当前所在地块、状态、最近检查日期、健康备注 | 技术员 | `colonies` |
| Placement 箱位安排 | 某群（按**群 id** 引用）在某投放点占多少箱；并群 / 拆群只转 id，不随群号失效 | 技术员 | `placements` |
| ColonyChange 分并变更单 | 并群 / 拆群登记（待执行 / 成功 / 失败）、失败原因、拆群两组群号群势、退回待投放的溢出箱位 | 技术员 | `colonyChanges` |
| TransitRoute 转场路线 | 出发/到达投放点、预计里程与耗时、车辆类型、出发时刻、风险备注、实际记录 | 共用 | `routes` |

### 两边各管各的

- **托管队**在「果园地块管理」里只维护地块与投放点（容量、时间窗、责任人），页面上的已排群号为只读汇总；
- **技术员**在「蜂群台账」里维护蜂群、投放点箱位安排与分并变更，群号怎么换都不影响投放点。

- 数据库名 `gbbeeroute`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史投放点补齐「可容纳箱数」（默认 8 箱）；
- `version(3)` 职责拆分：
  - 投放点上的 `colonyCodes` 群号串迁移为独立 `placements`（每群号按 1 箱记，按群 id 引用），投放点不再保留群号；
  - 历史蜂群没有群势关系，按**各自独立一群**补 `groupId`（取自身 id）；
  - 新增 `colonyChanges` 表；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 七、主要页面

| 路由 | 功能 |
| --- | --- |
| `/` | 季内授粉安排总表：花期条带 + 已投放群体，冲突（同一蜂群被排入花期重叠的不同地块）标红并汇总 |
| `/orchards` | 果园地块管理（托管队）：面积与需蜂强度自动算建议箱数、可达性标记、花期重叠提示、投放点维护（含坐标拾取与容量编辑）；不排群号 |
| `/colonies` | 蜂群台账（技术员）：按群势与状态筛选，批量改状态、批量记录检查备注；维护投放点箱位安排、并群 / 拆群变更与失败重试 |
| `/routes` | 转场路线规划：地图依次选点生成顺序与里程，拖动或上下移动调整顺序并实时重算，写回路线表 |
| `/export` | 导出授粉安排清单 / 转场路线表（CSV，清单含群号与箱数）、全量 JSON 备份，并提供横向/纵向打印视图 |

## 八、分并与容量重算约定

- **并群**：被并群在各投放点的箱位整串转到留下的群（同一点合并计数），蜂群删除、群系保留；现场若有投放点超容则整单**失败保留**，蜂群与箱位不动；
- **拆群**：按两组群势之比在每个投放点拆分原群箱位（最大余数法，强组保底）；某点一箱都分不到的组生成**溢出槽**并退回「待投放」；
- **容量改动即重算**：任何投放点保存（含改容量）、箱位调整后都跑统一 reconcile，顺序为：
  1. 超容量裁剪（按群号倒序逐群减，减空的群退回待投放）；
  2. 重放「待执行 / 失败」的分并变更（按登记先后）；
  3. 拆群溢出箱位按剩余容量回原投放点入座，蜂群恢复在园；
  4. 兜底再裁一次保证不超容；
- **失败留单**：分并不成只记原因，不删单、不改既有投放安排，容量调整后可单张或全部重试；成功记录可删除（不影响已落定的蜂群与箱位）。

## 九、其他计算约定

- 建议箱数 = ⌈面积(亩) × 需蜂强度(箱/亩)⌉，最少 1 箱；
- 转场里程按 Haversine 球面距离累计，耗时按平均 32 km/h + 0.25 h 装卸估算；
- 花期重叠：两地块盛花期区间交集天数 ≥ 1 即视为重叠；同一群号在重叠期内被排入两个地块 → 冲突。
