// 「铺开」画布自己的撤销栈：压栈、合并连续微移、撤销/重做、上限。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COALESCE_MS, HISTORY_LIMIT, createHistory, historyState, pushHistory, redoHistory, undoHistory } from '../client/history.js'

const at = (x) => ({ a: { x, y: 0, w: 100 } })

test('压栈记的是改动前的快照，撤销能回到上一步', () => {
  const h = createHistory()
  assert.deepEqual(historyState(h), { undo: 0, redo: 0 })
  assert.equal(undoHistory(h, at(1)), null) // 没得撤

  pushHistory(h, at(0)) // 从 0 拖到 1 之前，记下 0
  const items = undoHistory(h, at(1))
  assert.deepEqual(items, at(0))
  assert.deepEqual(historyState(h), { undo: 0, redo: 1 })
})

test('撤销之后重做能回到原处，重做栈被新改动清空', () => {
  const h = createHistory()
  pushHistory(h, at(0))
  undoHistory(h, at(1))
  assert.deepEqual(redoHistory(h, at(0)), at(1))
  assert.deepEqual(historyState(h), { undo: 1, redo: 0 })

  // 新的改动发生在「撤销之后」，旧的重做分支作废
  pushHistory(h, at(5))
  assert.deepEqual(historyState(h), { undo: 2, redo: 0 })
})

test('同一个 key 的连续操作在时间窗内合并成一步', () => {
  const h = createHistory()
  const now = 1000
  assert.equal(pushHistory(h, at(0), 'nudge', now), true)
  assert.equal(pushHistory(h, at(1), 'nudge', now + 100), false) // 合并
  assert.equal(pushHistory(h, at(2), 'nudge', now + COALESCE_MS - 1), false) // 仍在窗内
  assert.equal(historyState(h).undo, 1)
  // 时间窗从「上一次操作」起算：隔得足够久才另起一步
  assert.equal(pushHistory(h, at(2), 'nudge', now + COALESCE_MS * 2), true)

  // 撤销一次就回到这次合并动作开始之前的那份快照
  assert.deepEqual(undoHistory(h, at(3)), at(2))
})

test('不带 key 的操作永远各算一步，拖动不会被合并', () => {
  const h = createHistory()
  const now = 1000
  assert.equal(pushHistory(h, at(0), null, now), true)
  assert.equal(pushHistory(h, at(1), null, now + 10), true)
  assert.equal(historyState(h).undo, 2)
})

test('历史超过上限时丢掉最老的一步', () => {
  const h = createHistory()
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) pushHistory(h, at(i))
  assert.equal(h.past.length, HISTORY_LIMIT)
  // 最老的几步已经滚掉，撤到底停在能留住的最后一格
  let cur = at(HISTORY_LIMIT + 5)
  let last = null
  while (historyState(h).undo) last = undoHistory(h, cur)
  assert.deepEqual(last, at(5))
})

test('撤销把当前快照放进重做栈，重做再放回撤销栈（不丢状态）', () => {
  const h = createHistory()
  pushHistory(h, at(0))
  pushHistory(h, at(1))
  assert.deepEqual(undoHistory(h, at(2)), at(1))
  assert.deepEqual(undoHistory(h, at(1)), at(0))
  assert.deepEqual(historyState(h), { undo: 0, redo: 2 })
  assert.deepEqual(redoHistory(h, at(0)), at(1))
  assert.deepEqual(redoHistory(h, at(1)), at(2))
  assert.deepEqual(historyState(h), { undo: 2, redo: 0 })
})
