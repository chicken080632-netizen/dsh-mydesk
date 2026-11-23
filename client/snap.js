// 拖动图片时的吸附计算：只做数学，不碰 React，方便单独测。
export const SNAP_PX = 7
// 已经吸住之后，最多再多给一点点余量才放手（只用来吃掉像素取整的毛刺）。
// 关键是「吸住之后不再重新挑最近的」：两个基准挨得近时，指针在原地一毫米来回就会在两个目标之间跳，
// 看起来就是鬼畜抖动；锁住上一个目标之后，只有真的拉出吸附距离才会换。
export const SNAP_HOLD = 1.05

/**
 * 把拖动中的一组图吸到别的图上。
 * 选区包围盒的左/中/右、上/中/下 与别的图的同名基准相差不超过 reach（世界坐标）就对齐。
 * 传进来的 lock 是上一帧的吸附结果：只要那个基准还在滞回范围内就继续吸同一个目标，
 * 不再重新挑最近的，避免两个候选互相抢。
 * @param {{
 *   boxes: Record<string, {x:number,y:number,w:number,h:number}>,
 *   moving: string[],
 *   dx: number,
 *   dy: number,
 *   scale?: number,
 *   reach?: number,
 *   lock?: ({anchor: number, target: number}|null)[]
 * }} input
 * @returns {{dx: number, dy: number, guide: {x: number|null, y: number|null}|null, lock: ({anchor: number, target: number}|null)[]}}
 */
export function snapDrag({ boxes, moving, dx, dy, scale = 1, reach = SNAP_PX, lock = [null, null] }) {
  const idle = { dx, dy, guide: null, lock: [null, null] }
  const movingIds = new Set(moving.filter(id => boxes[id]))
  if (!movingIds.size) return idle
  const others = Object.keys(boxes).filter(id => !movingIds.has(id)).map(id => boxes[id])
  if (!others.length) return idle

  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (const id of movingIds) {
    const box = boxes[id]
    left = Math.min(left, box.x + dx)
    right = Math.max(right, box.x + dx + box.w)
    top = Math.min(top, box.y + dy)
    bottom = Math.max(bottom, box.y + dy + box.h)
  }

  const limit = reach / (scale || 1)
  const hold = limit * SNAP_HOLD

  const settle = (anchors, targets, kept) => {
    // 先认上一帧吸住的目标：还在滞回圈里就不换，这一条是防抖的核心。
    if (kept && anchors[kept.anchor] !== undefined) {
      const delta = kept.target - anchors[kept.anchor]
      if (Math.abs(delta) <= hold) return { delta, target: kept.target, anchor: kept.anchor }
    }
    let best = null
    anchors.forEach((anchor, index) => {
      for (const value of targets) {
        const delta = value - anchor
        if (Math.abs(delta) > limit) continue
        // 距离相同时优先贴边、再优先数值小的，保证候选是确定的（不会左右摇摆）。
        const score = Math.abs(delta) + (index === 1 ? 1e-4 : 0) + value * 1e-9
        if (!best || score < best.score) best = { delta, target: value, anchor: index, score }
      }
    })
    return best
  }

  const xs = others.flatMap(box => [box.x, box.x + box.w / 2, box.x + box.w])
  const ys = others.flatMap(box => [box.y, box.y + box.h / 2, box.y + box.h])
  const snapX = settle([left, (left + right) / 2, right], xs, lock[0])
  const snapY = settle([top, (top + bottom) / 2, bottom], ys, lock[1])
  if (!snapX && !snapY) return idle

  return {
    dx: snapX ? dx + snapX.delta : dx,
    dy: snapY ? dy + snapY.delta : dy,
    guide: { x: snapX ? snapX.target : null, y: snapY ? snapY.target : null },
    lock: [
      snapX ? { anchor: snapX.anchor, target: snapX.target } : null,
      snapY ? { anchor: snapY.anchor, target: snapY.target } : null,
    ],
  }
}

/**
 * 组件里用的入口：拖动中的图要用「按下时」的位置算包围盒。
 * 拿当前位置算的话，每一帧都会把位移再加一遍，包围盒越算越远，吸附就会在莫名其妙的地方乱跳。
 * @param {{boxes: Record<string, {x:number,y:number,w:number,h:number}>, start: Record<string, {x:number,y:number}>, moving: string[], dx: number, dy: number, scale?: number, reach?: number, lock?: ({anchor:number,target:number}|null)[]}} input
 */
export function snapDragFrom({ boxes, start, moving, dx, dy, scale = 1, reach = SNAP_PX, lock = [null, null] }) {
  const pinned = { ...boxes }
  for (const id of moving) {
    const origin = start?.[id]
    if (origin && boxes[id]) pinned[id] = { ...boxes[id], x: origin.x, y: origin.y }
  }
  return snapDrag({ boxes: pinned, moving, dx, dy, scale, reach, lock })
}
