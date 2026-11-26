/**
 * 图库「铺开」画布自己的撤销栈。
 *
 * 为什么要有它：画布上的位置/组合存在 `item.art.board` 里，host 侧用 `undoable: false`
 * 存盘（排版不算内容改动），所以它不进插件的撤销栈。用户在画布里按 Ctrl+Z 时，
 * 如果不在这里接住，事件会一路冒泡到插件的全局撤销，把根画布上毫不相干的卡片操作撤掉。
 *
 * 这里只放纯逻辑：快照是「items 对象」——调用方每次改动都换新对象，所以直接存引用即可，
 * 不需要深拷贝。历史只在内存里，刷新即清空。
 */

/** 最多记多少步。 */
export const HISTORY_LIMIT = 60

/** 同一个 key 的连续操作在这个时间窗内合并成一步（方向键微移不该一步一毫米地堆）。 */
export const COALESCE_MS = 800

export function createHistory() {
  return { past: [], future: [], key: null, at: 0 }
}

/**
 * 记一步。`items` 是改动**之前**的快照。
 * 返回是否真的压了新的一步（被合并时返回 false）。
 */
export function pushHistory(hist, items, key = null, now = Date.now()) {
  if (key && hist.key === key && now - hist.at < COALESCE_MS) {
    hist.at = now
    return false
  }
  hist.past.push(items)
  if (hist.past.length > HISTORY_LIMIT) hist.past.shift()
  hist.future.length = 0
  hist.key = key
  hist.at = now
  return true
}

/** 撤销：`current` 是此刻的 items，会被放进重做栈。没得撤时返回 null。 */
export function undoHistory(hist, current) {
  if (!hist.past.length) return null
  const items = hist.past.pop()
  hist.future.push(current)
  hist.key = null
  return items
}

/** 重做：`current` 是此刻的 items，会被放回撤销栈。没得重做时返回 null。 */
export function redoHistory(hist, current) {
  if (!hist.future.length) return null
  const items = hist.future.pop()
  hist.past.push(current)
  hist.key = null
  return items
}

export function historyState(hist) {
  return { undo: hist.past.length, redo: hist.future.length }
}
