/** Placement 箱位安排：某群蜂在某个投放点占多少箱（技术员侧维护，按群 id 引用） */
export interface Placement {
  id: string
  /** 蜂群 id */
  colonyId: string
  /** 投放点 id */
  dropId: string
  /** 占用箱位（箱） */
  boxes: number
}
