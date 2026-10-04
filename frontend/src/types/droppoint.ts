/** DropPoint 投放点（托管队侧：只排地块与容量，不直接挂群号） */
export interface DropPoint {
  id: string
  orchardId: string
  longitude: number
  latitude: number
  /** 编号，如 A-03 */
  code: string
  /** 可容纳箱数 */
  capacityBoxes: number
  /** 遮阴条件 */
  shade: string
  /** 水源距离（米） */
  waterDistance: number
  /** 投放时间窗（起） */
  dropWindow: string
  /** 撤场时间 */
  withdrawTime: string
  /** 责任人 */
  owner: string
}
