// 图库「铺开」模式：图片按原始比例摆在一张能拖动、能缩放的画布上，可以对齐、组合。
import React from 'react'
import { saveBoardLayout, toast } from './desk.js'
import { createHistory, historyState, pushHistory, redoHistory, undoHistory } from './history.js'
import { t } from './i18n.js'
import { hitsInRect, invertSelection, mergeSelection, rectFrom, worldRect, dragTarget } from './select.js'
import { snapDragFrom } from './snap.js'
import { Icon } from './ui.jsx'

const GAP = 26
const ROW_W = 1480
const WIDE_W = 300
const TALL_W = 240
const MIN_ZOOM = 0.2
const MAX_ZOOM = 4
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

/** 读出一张卡片存下来的画布布局；没存过就返回默认值。 */
export function boardOf(item) {
  const board = item.art?.board
  const pan = board?.pan && typeof board.pan === 'object' ? board.pan : {}
  const items = board?.items && typeof board.items === 'object' ? board.items : {}
  return {
    zoom: Number.isFinite(board?.zoom) ? board.zoom : 1,
    pan: { x: Number(pan.x) || 0, y: Number(pan.y) || 0 },
    items: { ...items },
  }
}

/**
 * 铺开的画布。位置、缩放、组合都会防抖存回 host（`art/board`），下次打开还是这个样子。
 * @param {{item: object, variants: object[], mode: string}} props - 卡片、这一版图、当前预览模式。
 */
export function GalleryBoard({ item, variants, mode }) {
  const [board, setBoard] = React.useState(() => boardOf(item))
  const [dims, setDims] = React.useState({})
  const [selected, setSelected] = React.useState(() => new Set())
  const [guides, setGuides] = React.useState(null)
  const [marquee, setMarquee] = React.useState(null)
  const [spaceHeld, setSpaceHeld] = React.useState(false)
  const surface = React.useRef(null)
  const drag = React.useRef(null)
  const guideRef = React.useRef(null)
  const zoomRef = React.useRef(board.zoom)
  const boardRef = React.useRef(board)
  const firstRun = React.useRef(true)
  zoomRef.current = board.zoom
  boardRef.current = board

  // 画布自己的撤销栈：挪位置、对齐、均分、组合、方向键微移都算一步。
  // 铺开的排版是「不占插件撤销栈」的（host 侧 undoable: false），所以 Ctrl+Z 得在这里自己接住，
  // 否则会一路冒泡到插件的全局撤销，把毫不相干的卡片操作撤掉。纯逻辑在 ./history.js。
  const history = React.useRef(createHistory())
  const [hist, setHist] = React.useState({ undo: 0, redo: 0 })
  const syncHist = () => setHist(historyState(history.current))

  /** 记一步。`key` 相同的连续操作（比如按住方向键微移）在 800ms 内合并成一步。 */
  const remember = (items = boardRef.current.items, key = null) => {
    pushHistory(history.current, items, key)
    syncHist()
  }

  const undo = () => {
    const items = undoHistory(history.current, boardRef.current.items)
    if (!items) return
    setBoard((prev) => ({ ...prev, items }))
    syncHist()
  }

  const redo = () => {
    const items = redoHistory(history.current, boardRef.current.items)
    if (!items) return
    setBoard((prev) => ({ ...prev, items }))
    syncHist()
  }

  React.useEffect(() => {
    history.current = createHistory()
    syncHist()
  }, [item.id])

  // 排版改动防抖落盘：拖完停手 0.7 秒再存，失败只提示不打断
  React.useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return undefined
    }
    const timer = setTimeout(() => {
      saveBoardLayout(item.id, { ...board, mode }).catch(error => toast(error.message, { error: true }))
    }, 700)
    return () => clearTimeout(timer)
  }, [board, mode, item.id])

  React.useEffect(() => {
    setSelected(new Set())
    setMarquee(null)
  }, [item.id])

  // 空格键暂时把「框选」切成「平移」——画布铺满了图的时候，空白处不好找。
  // 在输入框里打字不算，别把空格偷走。
  React.useEffect(() => {
    const typing = (el) => Boolean(el) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    const down = (event) => {
      if (event.code !== 'Space' || typing(event.target)) return
      if (surface.current && surface.current.contains(document.activeElement)) event.preventDefault()
      setSpaceHeld(true)
    }
    const up = (event) => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    const blur = () => setSpaceHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // 把还没摆过的图按原比例货架式排进来。宽高比没量到就临时当正方形，
  // 量到之后再修宽度——不能等宽高比才摆，否则「位置要有宽高比、宽高比又要先渲染」会死循环，打开就是一片空白。
  React.useEffect(() => {
    setBoard((prev) => {
      const items = { ...prev.items }
      let changed = false
      const targetOf = (shot) => {
        const dim = dims[shot.id]
        const ratio = dim && dim.w && dim.h ? dim.w / dim.h : 1
        return { ratio, width: ratio >= 0.92 ? WIDE_W : TALL_W }
      }
      // 已经摆好、但当时没量到宽高比的：补一次宽度
      for (const shot of variants) {
        const box = items[shot.id]
        if (!box || !dims[shot.id]) continue
        const { width } = targetOf(shot)
        if ((box.w === WIDE_W || box.w === TALL_W) && box.w !== width) {
          items[shot.id] = { ...box, w: width }
          changed = true
        }
      }
      const missing = variants.filter(shot => !items[shot.id])
      if (missing.length) {
        const rows = Object.entries(items)
        let floor = 0
        for (const [id, box] of rows) {
          const dim = dims[id]
          const ratio = dim && dim.w && dim.h ? dim.w / dim.h : 1
          floor = Math.max(floor, (Number(box.y) || 0) + (Number(box.w) || 0) / ratio)
        }
        let cursorX = 0
        let cursorY = rows.length ? Math.round(floor) + GAP : 0
        let rowH = 0
        for (const shot of missing) {
          const { ratio, width } = targetOf(shot)
          const height = width / ratio
          if (cursorX > 0 && cursorX + width > ROW_W) {
            cursorX = 0
            cursorY += rowH + GAP
            rowH = 0
          }
          items[shot.id] = { x: Math.round(cursorX), y: Math.round(cursorY), w: Math.round(width) }
          cursorX += width + GAP
          rowH = Math.max(rowH, height)
        }
        changed = true
      }
      return changed ? { ...prev, items } : prev
    })
  }, [variants, dims])

  const root = React.useRef(null)

  React.useEffect(() => {
    const onKey = (event) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const el = event.target
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const box = root.current && (root.current.closest('.myd-gal') ?? root.current)
      if (!box) return
      const active = document.activeElement
      const inside = active === document.body || active === box || box.contains(active)
      if (!inside) return
      const key = String(event.key || '').toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
        undo()
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault()
        event.stopPropagation()
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
        redo()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const measure = (shot, event) => {
    const el = event.currentTarget
    if (!el.naturalWidth || !el.naturalHeight) return
    setDims(prev => (prev[shot.id] ? prev : { ...prev, [shot.id]: { w: el.naturalWidth, h: el.naturalHeight } }))
  }

  // 量不出来的图（文件没了、格式坏了）也给它一块正方形的位置，总比什么都不显示好
  const measureFailed = (shot) => {
    setDims(prev => (prev[shot.id] ? prev : { ...prev, [shot.id]: { w: 1024, h: 1024 } }))
  }

  // 还没量过宽高的图：先用屏外的 img 量一下。画布上的图必须先有位置才渲染，
  // 而位置又要有宽高比才算得出来——少了这一层，图就永远摆不进去（打开铺开一片空白）。
  const unmeasured = variants.filter(shot => !dims[shot.id])

  // 滚轮缩放：以光标为锚点，和主画布一个手感（必须 passive:false 才能 preventDefault）
  React.useEffect(() => {
    const el = surface.current
    if (!el) return undefined
    const onWheel = (event) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const step = event.deltaMode === 1 ? 0.05 : 0.0016
      const scale = zoomRef.current * Math.exp(-event.deltaY * step)
      setBoard((prev) => {
        const next = clamp(scale, MIN_ZOOM, MAX_ZOOM)
        const px = event.clientX - rect.left
        const py = event.clientY - rect.top
        const wx = (px - prev.pan.x) / prev.zoom
        const wy = (py - prev.pan.y) / prev.zoom
        return { ...prev, zoom: next, pan: { x: Math.round(px - wx * next), y: Math.round(py - wy * next) } }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const zoomAt = (next, px, py) => {
    setBoard((prev) => {
      const scale = clamp(next, MIN_ZOOM, MAX_ZOOM)
      const wx = (px - prev.pan.x) / prev.zoom
      const wy = (py - prev.pan.y) / prev.zoom
      return { ...prev, zoom: scale, pan: { x: Math.round(px - wx * scale), y: Math.round(py - wy * scale) } }
    })
  }

  const zoomStep = (factor) => {
    const el = surface.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    zoomAt(board.zoom * factor, rect.width / 2, rect.height / 2)
  }

  const startPan = (event) => {
    setGuides(null)
    drag.current = { type: 'pan', id: event.pointerId, sx: event.clientX, sy: event.clientY, pan: { ...board.pan } }
    surface.current?.setPointerCapture?.(event.pointerId)
  }

  const onSurfaceDown = (event) => {
    // 右键 / 中键拖动 = 平移（右键是主用法，中键留给习惯它的人）
    if (event.button === 2 || event.button === 1) {
      event.preventDefault()
      startPan(event)
      return
    }
    if (event.button !== 0) return
    if (spaceHeld) {
      startPan(event)
      return
    }
    setGuides(null)
    const additive = event.shiftKey || event.metaKey || event.ctrlKey
    const rect = surface.current?.getBoundingClientRect()
    const sx = event.clientX - (rect?.left ?? 0)
    const sy = event.clientY - (rect?.top ?? 0)
    // 空白处按下 = 框选。点一下就走（位移不到 3px）不会改选区，交给 pointerup 处理。
    drag.current = { type: 'marquee', id: event.pointerId, sx, sy, additive, base: additive ? new Set(selected) : new Set() }
    setMarquee({ x: sx, y: sy, w: 0, h: 0 })
    surface.current?.setPointerCapture?.(event.pointerId)
  }

  const onItemDown = (shot, event) => {
    if (event.button === 2 || event.button === 1 || (event.button === 0 && spaceHeld)) {
      event.stopPropagation()
      startPan(event)
      return
    }
    if (event.button !== 0) return
    event.stopPropagation()
    const additive = event.shiftKey || event.metaKey || event.ctrlKey
    const group = board.items[shot.id]?.group
    const { ids, collapse } = dragTarget({ id: shot.id, group, selected, items: board.items, additive })
    const moving = new Set(ids)
    setSelected(moving)
    const start = {}
    for (const id of moving) {
      const box = board.items[id]
      if (box) start[id] = { x: box.x, y: box.y }
    }
    drag.current = { type: 'move', id: event.pointerId, sx: event.clientX, sy: event.clientY, start, lock: [null, null], before: board.items, collapse }
    surface.current?.setPointerCapture?.(event.pointerId)
  }

  // 一张图在画布上的矩形（高度按量到的宽高比算）
  const boxOf = (id, items = board.items) => {
    const box = items[id]
    if (!box) return null
    const dim = dims[id]
    const ratio = dim && dim.w && dim.h ? dim.w / dim.h : 1
    return { x: box.x, y: box.y, w: box.w, h: box.w / ratio }
  }

  /**
   * 拖动时把选区吸到别的图上：左/中/右、上/中/下 三组基准互相靠近 7px 就对齐，
   * 返回修正后的位移和要画出来的参考线（世界坐标）。
   */
  const snapMove = (state, dx, dy, scale) => {
    const boxes = {}
    for (const shot of variants) {
      const box = boxOf(shot.id)
      if (box) boxes[shot.id] = box
    }
    // snapDragFrom 会把正在拖的这几张换回按下时的位置再算包围盒；
    // 直接用当前位置会把位移重复加一遍，拖久了吸附就会在奇怪的地方乱跳。
    const snapped = snapDragFrom({ boxes, start: state.start, moving: Object.keys(state.start), dx, dy, scale, lock: state.lock })
    // 记住这一帧吸住的是哪个基准，下一帧优先继续吸同一个，免得两个目标互相抢着来回跳。
    state.lock = snapped.lock
    return snapped
  }

  /** 参考线只在真的换了位置时才更新，省掉没必要的重渲染。 */
  const showGuides = (guide) => {
    const next = guide && (guide.x !== null || guide.y !== null) ? guide : null
    const prev = guideRef.current
    if (next === prev) return
    if (next && prev && next.x === prev.x && next.y === prev.y) return
    guideRef.current = next
    setGuides(next)
  }

  const onMove = (event) => {
    const state = drag.current
    if (!state || state.id !== event.pointerId) return
    if (state.type === 'pan') {
      const dx = event.clientX - state.sx
      const dy = event.clientY - state.sy
      setBoard(prev => ({ ...prev, pan: { x: state.pan.x + dx, y: state.pan.y + dy } }))
      return
    }
    if (state.type === 'marquee') {
      const el = surface.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const cx = clamp(event.clientX - rect.left, 0, rect.width)
      const cy = clamp(event.clientY - rect.top, 0, rect.height)
      const screen = rectFrom(state.sx, state.sy, cx, cy)
      setMarquee(screen)
      const current = boardRef.current
      const boxes = {}
      for (const shot of variants) {
        const box = boxOf(shot.id, current.items)
        if (box) boxes[shot.id] = box
      }
      const hits = hitsInRect(boxes, worldRect(screen, current.pan, current.zoom))
      state.box = screen
      setSelected(mergeSelection(state.base, hits, state.additive))
      return
    }
    const scale = zoomRef.current || 1
    let dx = (event.clientX - state.sx) / scale
    let dy = (event.clientY - state.sy) / scale
    let guide = null
    if (event.altKey) {
      state.lock = [null, null]
    } else {
      const snapped = snapMove(state, dx, dy, scale)
      dx = snapped.dx
      dy = snapped.dy
      guide = snapped.guide
    }
    showGuides(guide)
    setBoard((prev) => {
      const items = { ...prev.items }
      for (const [id, origin] of Object.entries(state.start)) {
        items[id] = { ...items[id], x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) }
      }
      return { ...prev, items }
    })
  }

  const onUp = (event) => {
    const state = drag.current
    if (!state || state.id !== event.pointerId) return
    drag.current = null
    guideRef.current = null
    setGuides(null)
    surface.current?.releasePointerCapture?.(event.pointerId)
    if (state.type === 'marquee') {
      setMarquee(null)
      // 只是点了一下空白：不按 Shift 就清空选区
      const box = state.box
      const clicked = !box || (box.w < 3 && box.h < 3)
      if (clicked && !state.additive) setSelected(new Set())
    }
    if (state.type === 'move') {
      // 真的挪动过才记一步；点一下没动不该占撤销
      const items = boardRef.current.items
      const moved = Object.keys(state.start).some((id) => {
        const row = items[id]
        return row && (row.x !== state.start[id].x || row.y !== state.start[id].y)
      })
      if (moved && state.before) remember(state.before)
      // 在多选上点了一下（没拖）→ 收敛成只选这一张
      if (!moved && state.collapse) setSelected(new Set([state.collapse]))
    }
  }

  const onKeyDown = (event) => {
    const mod = event.metaKey || event.ctrlKey
    if (mod && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault()
      selectAll()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setSelected(new Set())
      setMarquee(null)
      drag.current = null
      return
    }
    const step = event.shiftKey ? 10 : 1
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]
    if (!delta || !selected.size) return
    event.preventDefault()
    remember(undefined, 'nudge')
    setBoard((prev) => {
      const items = { ...prev.items }
      for (const id of selected) {
        if (!items[id]) continue
        items[id] = { ...items[id], x: items[id].x + delta[0], y: items[id].y + delta[1] }
      }
      return { ...prev, items }
    })
  }

  const picked = variants.filter(shot => selected.has(shot.id) && board.items[shot.id])

  const boxesOf = (list) => list.map((shot) => {
    const box = board.items[shot.id]
    const dim = dims[shot.id]
    const ratio = dim && dim.w && dim.h ? dim.w / dim.h : 1
    return { id: shot.id, x: box.x, y: box.y, w: box.w, h: box.w / ratio }
  })

  const applyBoxes = (boxes, fn) => {
    setBoard((prev) => {
      const items = { ...prev.items }
      fn(boxes, items)
      return { ...prev, items }
    })
  }

  const align = (edge) => {
    const boxes = boxesOf(picked)
    if (boxes.length < 2) return
    remember()
    const left = Math.min(...boxes.map(box => box.x))
    const right = Math.max(...boxes.map(box => box.x + box.w))
    const top = Math.min(...boxes.map(box => box.y))
    const bottom = Math.max(...boxes.map(box => box.y + box.h))
    applyBoxes(boxes, (list, items) => {
      for (const box of list) {
        const row = { ...items[box.id] }
        if (edge === 'left') row.x = Math.round(left)
        else if (edge === 'centerX') row.x = Math.round((left + right) / 2 - box.w / 2)
        else if (edge === 'right') row.x = Math.round(right - box.w)
        else if (edge === 'top') row.y = Math.round(top)
        else if (edge === 'centerY') row.y = Math.round((top + bottom) / 2 - box.h / 2)
        else if (edge === 'bottom') row.y = Math.round(bottom - box.h)
        items[box.id] = row
      }
    })
  }

  // 两端不动，中间等间距摆开
  const spread = (axis) => {
    const boxes = boxesOf(picked)
    if (boxes.length < 3) return
    remember()
    const sorted = [...boxes].sort((a, b) => (axis === 'x' ? a.x - b.x : a.y - b.y))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const start = axis === 'x' ? first.x : first.y
    const end = axis === 'x' ? last.x + last.w : last.y + last.h
    const used = sorted.reduce((sum, box) => sum + (axis === 'x' ? box.w : box.h), 0)
    const gap = (end - start - used) / (sorted.length - 1)
    applyBoxes(sorted, (list, items) => {
      let cursor = start
      for (const box of list) {
        const row = { ...items[box.id] }
        if (axis === 'x') {
          row.x = Math.round(cursor)
          cursor += box.w + gap
        } else {
          row.y = Math.round(cursor)
          cursor += box.h + gap
        }
        items[box.id] = row
      }
    })
  }

  const makeGroup = () => {
    if (picked.length < 2) return
    remember()
    const id = `g${Date.now().toString(36)}`
    applyBoxes(picked, (list, items) => {
      for (const shot of list) items[shot.id] = { ...items[shot.id], group: id }
    })
    toast(t('这 {n} 张已经组合在一起', { n: picked.length }))
  }

  const ungroup = () => {
    if (!picked.length) return
    remember()
    applyBoxes(picked, (list, items) => {
      for (const shot of list) {
        const row = { ...items[shot.id] }
        delete row.group
        items[shot.id] = row
      }
    })
    toast(t('取消组合'))
  }

  const placed = variants.filter(shot => board.items[shot.id]).map(shot => shot.id)
  const selectAll = () => setSelected(new Set(placed))
  const invert = () => setSelected(invertSelection(placed, selected))
  const clearSelection = () => setSelected(new Set())

  const fit = () => {
    const el = surface.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const boxes = boxesOf(picked.length >= 2 ? picked : variants)
    if (!boxes.length) return
    const left = Math.min(...boxes.map(box => box.x))
    const right = Math.max(...boxes.map(box => box.x + box.w))
    const top = Math.min(...boxes.map(box => box.y))
    const bottom = Math.max(...boxes.map(box => box.y + box.h))
    const width = Math.max(right - left, 1)
    const height = Math.max(bottom - top, 1)
    const scale = clamp(Math.min((rect.width - 120) / width, (rect.height - 150) / height), MIN_ZOOM, 2)
    setBoard(prev => ({
      ...prev,
      zoom: scale,
      pan: {
        x: Math.round((rect.width - width * scale) / 2 - left * scale),
        y: Math.round((rect.height - height * scale) / 2 - top * scale),
      },
    }))
  }

  return (
    <div className="myd-bd" ref={root}>
      <div
        className={`myd-bd-surface${spaceHeld ? ' is-space' : ''}${marquee ? ' is-marquee' : ''}`}
        ref={surface}
        tabIndex={0}
        role="application"
        aria-label={t('图库画布')}
        onPointerDown={onSurfaceDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKeyDown}
        // 右键已经用来看平移画布了，别再弹浏览器菜单
        onContextMenu={event => event.preventDefault()}
      >
        <div className="myd-bd-world" style={{ transform: `translate3d(${board.pan.x}px, ${board.pan.y}px, 0) scale(${board.zoom})` }}>
          {variants.map((shot) => {
            const box = board.items[shot.id]
            if (!box) return null
            return (
              <figure
                key={shot.id}
                data-shot={shot.id}
                className={`myd-bd-item${selected.has(shot.id) ? ' is-on' : ''}${box.group ? ' is-grouped' : ''}`}
                style={{ left: box.x, top: box.y, width: box.w }}
                onPointerDown={event => onItemDown(shot, event)}
              >
                <img src={shot.src} alt="" draggable={false} referrerPolicy="no-referrer"
                  onLoad={event => measure(shot, event)} onError={() => measureFailed(shot)} />
              </figure>
            )
          })}
        </div>
        <div className="myd-bd-measure" aria-hidden="true">
          {unmeasured.map(shot => (
            <img key={shot.id} src={shot.src} alt="" draggable={false} referrerPolicy="no-referrer"
              onLoad={event => measure(shot, event)} onError={() => measureFailed(shot)} />
          ))}
        </div>
        {guides && guides.x !== null && guides.x !== undefined ? (
          <span className="myd-bd-guide is-v" style={{ left: Math.round(board.pan.x + guides.x * board.zoom) }} />
        ) : null}
        {guides && guides.y !== null && guides.y !== undefined ? (
          <span className="myd-bd-guide is-h" style={{ top: Math.round(board.pan.y + guides.y * board.zoom) }} />
        ) : null}
        {marquee && (marquee.w > 1 || marquee.h > 1) ? (
          <span className="myd-bd-marq" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
        ) : null}
        {variants.length ? null : <p className="myd-bd-empty">{t('还没有图：先用右边的面板画几张，或者把本地图片拖进来。')}</p>}
      </div>

      <div className={`myd-bd-bar${picked.length ? ' has-picked' : ''}`}>
        <button type="button" className="myd-bd-btn" onClick={selectAll}>{t('全选')}</button>
        <button type="button" className="myd-bd-btn" onClick={invert} disabled={!placed.length}>{t('反选')}</button>
        {picked.length ? <button type="button" className="myd-bd-btn" onClick={clearSelection}>{t('清除选择')}</button> : null}
        <span className={`myd-bd-state${picked.length ? ' is-on' : ''}`}>
          {picked.length
            ? t('选了 {n} 张', { n: picked.length })
            : t('拖空白处框选（Shift 追加），右键或按住空格拖动平移，滚轮缩放；拖动会吸附，按住 Alt 关掉')}
        </span>
        {picked.length >= 2 ? (
          <div className="myd-bd-tools">
            <span className="myd-bd-label">{t('对齐')}</span>
            {[['left', t('左')], ['centerX', t('横中')], ['right', t('右')], ['top', t('上')], ['centerY', t('纵中')], ['bottom', t('下')]].map(([edge, label]) => (
              <button type="button" key={edge} className="myd-bd-btn" onClick={() => align(edge)}>{label}</button>
            ))}
            {picked.length >= 3 ? (
              <>
                <button type="button" className="myd-bd-btn" onClick={() => spread('x')}>{t('横均分')}</button>
                <button type="button" className="myd-bd-btn" onClick={() => spread('y')}>{t('纵均分')}</button>
              </>
            ) : null}
            <button type="button" className="myd-bd-btn" onClick={makeGroup}>{t('组合')}</button>
          </div>
        ) : null}
        {picked.length ? <button type="button" className="myd-bd-btn" onClick={ungroup}>{t('取消组合')}</button> : null}
        <div className="myd-bd-tools">
          <button type="button" className="myd-bd-icon" onClick={undo} disabled={!hist.undo}
            title={t('撤销（Ctrl+Z）')} aria-label={t('撤销')}><Icon name="undo" size={14} /></button>
          <button type="button" className="myd-bd-icon" onClick={redo} disabled={!hist.redo}
            title={t('重做（Ctrl+Shift+Z）')} aria-label={t('重做')}>
            <span className="myd-bd-flip"><Icon name="undo" size={14} /></span>
          </button>
        </div>
        <span className="myd-bd-gap" />
        <div className="myd-bd-zoom">
          <button type="button" className="myd-bd-icon" onClick={() => zoomStep(1 / 1.25)} title={t('缩小')} aria-label={t('缩小')}><Icon name="zoomOut" size={14} /></button>
          <button type="button" className="myd-bd-pct" onClick={() => setBoard(prev => ({ ...prev, zoom: 1 }))} title={t('回到 100%')}>{Math.round(board.zoom * 100)}%</button>
          <button type="button" className="myd-bd-icon" onClick={() => zoomStep(1.25)} title={t('放大')} aria-label={t('放大')}><Icon name="zoomIn" size={14} /></button>
          <button type="button" className="myd-bd-icon" onClick={fit} title={t('适应窗口')} aria-label={t('适应窗口')}><Icon name="target" size={14} /></button>
        </div>
      </div>
    </div>
  )
}
