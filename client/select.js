// 「铺开」画布的框选计算：把屏幕上的橡皮筋换成世界坐标里的矩形，再挑出被它碰到的图。
// 单独放一份是为了能直接单测——组件里的指针事件不好测，这里的纯函数好测。

/** 两个屏幕坐标点 → 规范化矩形（左上角 + 宽高，永远是正数）。 */
export function rectFrom(ax, ay, bx, by) {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }
}

/** 屏幕矩形 → 世界坐标矩形（画布有平移和缩放）。 */
export function worldRect(rect, pan = { x: 0, y: 0 }, zoom = 1) {
  const scale = zoom || 1
  return {
    x: (rect.x - (pan.x || 0)) / scale,
    y: (rect.y - (pan.y || 0)) / scale,
    w: rect.w / scale,
    h: rect.h / scale,
  }
}

/** 矩形相交（不要求完全包住，碰到就算，和常见设计工具一致）。 */
export function overlaps(box, rect) {
  if (!box) return false
  return box.x < rect.x + rect.w && box.x + box.w > rect.x && box.y < rect.y + rect.h && box.y + box.h > rect.y
}

/**
 * 框选命中的 id。`boxes` 是 `{ id: {x, y, w, h} }`。
 * `min` 用来忽略「手一抖」产生的几像素矩形，免得点一下空白就清空选区又选回自己。
 */
export function hitsInRect(boxes, rect, min = 3) {
  if (!rect || (rect.w < min && rect.h < min)) return []
  return Object.keys(boxes).filter(id => overlaps(boxes[id], rect))
}

/** 框选结束后的选区：按住 Shift/Cmd 是追加，否则整体替换。 */
export function mergeSelection(base, hits, additive) {
  if (!additive) return new Set(hits)
  const next = new Set(base || [])
  for (const id of hits) next.add(id)
  return next
}

/** 反选：在这张画布上有位置的图里，选中没选的那些。 */
export function invertSelection(ids, selected) {
  const next = new Set()
  for (const id of ids) if (!selected?.has(id)) next.add(id)
  return next
}

/**
 * 按在某一张图上时，这次拖动该带上哪些图。
 *
 * 规则（和常见画布工具一致）：
 * - 按在**已选中**的图上、且没按修饰键 → 保持整个选区一起拖（否则多选就永远动不了）；
 *   但只是点一下没拖的话，松手时收敛成这一张（返回的 `collapse`）。
 * - 按在**没选中**的图上 → 单独拖它；它有 `group` 就把整组带上。
 * - 按住 Shift/Cmd/Ctrl → 在现有选区上增减这一张。
 *
 * `items` 是 `{ id: {x, y, w, group} }`，只用来判存在与找同组。
 * @returns {{ ids: string[], collapse: string|null }}
 */
export function dragTarget({ id, group = null, selected, items = {}, additive = false }) {
  const exists = (key) => Boolean(items[key])
  const band = group ?? items[id]?.group ?? null
  const moving = new Set()
  let collapse = null
  if (additive) {
    for (const key of selected || []) if (exists(key)) moving.add(key)
    if (moving.has(id)) moving.delete(id)
    else moving.add(id)
  } else if (selected?.has(id)) {
    for (const key of selected) if (exists(key)) moving.add(key)
    if (!moving.size) moving.add(id)
    collapse = id
  } else if (band) {
    for (const key of Object.keys(items)) if (items[key]?.group === band) moving.add(key)
    if (!moving.size) moving.add(id)
  } else {
    moving.add(id)
  }
  return { ids: [...moving], collapse }
}
