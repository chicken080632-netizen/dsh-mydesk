// 「铺开」画布的框选计算：矩形规范化、坐标换算、命中判断、追加/反选。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dragTarget, hitsInRect, invertSelection, mergeSelection, overlaps, rectFrom, worldRect } from '../client/select.js'

test('rectFrom 把任意两个点规范成左上角 + 正宽高', () => {
  assert.deepEqual(rectFrom(10, 20, 40, 5), { x: 10, y: 5, w: 30, h: 15 })
  assert.deepEqual(rectFrom(40, 5, 10, 20), { x: 10, y: 5, w: 30, h: 15 })
  assert.deepEqual(rectFrom(7, 7, 7, 7), { x: 7, y: 7, w: 0, h: 0 })
})

test('worldRect 按平移和缩放把屏幕矩形换回画布坐标', () => {
  // 画布向右下各移 100、放大 2 倍：屏幕上 (100,100)-(300,300) → 世界 (0,0)-(100,100)
  assert.deepEqual(worldRect({ x: 100, y: 100, w: 200, h: 200 }, { x: 100, y: 100 }, 2), { x: 0, y: 0, w: 100, h: 100 })
  // 没有平移、缩放为 1 时原样
  assert.deepEqual(worldRect({ x: 5, y: 6, w: 7, h: 8 }), { x: 5, y: 6, w: 7, h: 8 })
})

test('overlaps 碰到就算选中，完全在外就不算', () => {
  const box = { x: 100, y: 100, w: 50, h: 50 }
  assert.equal(overlaps(box, { x: 0, y: 0, w: 110, h: 110 }), true) // 只压到左上角
  assert.equal(overlaps(box, { x: 140, y: 140, w: 200, h: 200 }), true) // 只压到右下角
  assert.equal(overlaps(box, { x: 0, y: 0, w: 90, h: 90 }), false) // 差一点
  assert.equal(overlaps(null, { x: 0, y: 0, w: 9, h: 9 }), false) // 没摆好的图
})

test('hitsInRect 挑出相交的图，忽略手抖产生的小矩形', () => {
  const boxes = {
    a: { x: 0, y: 0, w: 100, h: 100 },
    b: { x: 200, y: 0, w: 100, h: 100 },
    c: { x: 0, y: 200, w: 100, h: 100 },
  }
  assert.deepEqual(hitsInRect(boxes, { x: 50, y: -10, w: 180, h: 60 }).sort(), ['a', 'b'])
  assert.deepEqual(hitsInRect(boxes, { x: 500, y: 500, w: 10, h: 10 }), [])
  assert.deepEqual(hitsInRect(boxes, { x: 10, y: 10, w: 2, h: 2 }), []) // 点一下空白
  assert.deepEqual(hitsInRect(boxes, null), [])
})

test('mergeSelection：不按修饰键就整体替换，按了就追加', () => {
  const base = new Set(['a'])
  assert.deepEqual([...mergeSelection(base, ['b', 'c'], false)].sort(), ['b', 'c'])
  assert.deepEqual([...mergeSelection(base, ['b'], true)].sort(), ['a', 'b'])
  // 追加时原来的选区不能被清空
  assert.deepEqual([...mergeSelection(base, [], true)], ['a'])
  assert.deepEqual([...mergeSelection(null, [], false)], [])
})

test('invertSelection 只在该画布上有位置的图里反选', () => {
  const placed = ['a', 'b', 'c']
  assert.deepEqual([...invertSelection(placed, new Set(['a']))].sort(), ['b', 'c'])
  assert.deepEqual([...invertSelection(placed, new Set(placed))], [])
  assert.deepEqual([...invertSelection(placed, new Set())].sort(), ['a', 'b', 'c'])
})

const ITEMS = {
  a: { x: 0, y: 0, w: 100 },
  b: { x: 200, y: 0, w: 100 },
  c: { x: 400, y: 0, w: 100 },
  d: { x: 600, y: 0, w: 100, group: 'g1' },
  e: { x: 800, y: 0, w: 100, group: 'g1' },
}

test('dragTarget：按在已选中的一张上，整个选区一起拖', () => {
  const selected = new Set(['a', 'b', 'c'])
  const { ids, collapse } = dragTarget({ id: 'b', selected, items: ITEMS })
  assert.deepEqual(ids.sort(), ['a', 'b', 'c'])
  assert.equal(collapse, 'b')
})

test('dragTarget：按在没选中的一张上，只拖它', () => {
  const selected = new Set(['a', 'b'])
  const { ids, collapse } = dragTarget({ id: 'c', selected, items: ITEMS })
  assert.deepEqual(ids, ['c'])
  assert.equal(collapse, null)
})

test('dragTarget：按在有 group 的图上会带上整组', () => {
  const { ids } = dragTarget({ id: 'd', selected: new Set(), items: ITEMS })
  assert.deepEqual(ids.sort(), ['d', 'e'])
})

test('dragTarget：按住 Shift 在选区里增减，且不影响其它已选', () => {
  const selected = new Set(['a', 'b'])
  assert.deepEqual(dragTarget({ id: 'c', selected, items: ITEMS, additive: true }).ids.sort(), ['a', 'b', 'c'])
  assert.deepEqual(dragTarget({ id: 'a', selected, items: ITEMS, additive: true }).ids, ['b'])
})

test('dragTarget：选区里混进已不在画布上的 id 也不会崩', () => {
  const selected = new Set(['a', 'gone'])
  assert.deepEqual(dragTarget({ id: 'a', selected, items: ITEMS }).ids, ['a'])
  // 按的那张自己没位置时至少还算它一张，不会返回空
  assert.deepEqual(dragTarget({ id: 'gone', selected: new Set(['gone']), items: ITEMS }).ids, ['gone'])
})
