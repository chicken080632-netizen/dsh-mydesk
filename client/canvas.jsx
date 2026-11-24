// 首页：一句话记一个灵感。灵感可以散落在空间里，也可以按时间排成信息流。
import React from 'react'
import { Card, openCapture } from './card.jsx'
import { captureFiles, captureUrl, closeInline, dispatchOps, openInline, openItem, setDesk, useDesk } from './desk.js'
import { plural, t } from './i18n.js'
import { Icon, IconButton, Segmented } from './ui.jsx'
import { InlineCard } from './inline.jsx'
import { ContextMenu } from './menu.jsx'
import { MiniStamps } from './stamps.jsx'
import { cardSize, scatterLayout } from './layout.js'
import { relatedIdeas, relatedLayout } from './related.js'
import { SPRING_SOFT, computeStreak, displayItem, hash, posterOf, reducedMotion, isIdea } from './util.js'

function useCamera(stageRef, worldRef) {
  const cam = React.useRef({ x: 0, y: 0, s: 1, vx: 0, vy: 0, vs: 0, tx: 0, ty: 0, ts: 1, raf: 0 })
  const apply = React.useCallback(() => {
    const c = cam.current
    const world = worldRef.current
    const stage = stageRef.current
    if (!world || !stage) return
    world.style.transform = `translate3d(${c.x}px, ${c.y}px, 0) scale(${c.s})`
    world.style.setProperty('--px', `${c.x / c.s}px`)
    world.style.setProperty('--py', `${c.y / c.s}px`)
    stage.style.setProperty('--grid-x', `${c.x}px`)
    stage.style.setProperty('--grid-y', `${c.y}px`)
    stage.style.setProperty('--grid-size', `${28 * c.s}px`)
  }, [stageRef, worldRef])
  const tick = React.useCallback(() => {
    const c = cam.current
    const k = c.stiffness ?? 90
    const d = c.damping ?? 17
    const dt = 1 / 60
    c.vx += (k * (c.tx - c.x) - d * c.vx) * dt
    c.vy += (k * (c.ty - c.y) - d * c.vy) * dt
    c.vs += (k * (c.ts - c.s) - d * c.vs) * dt
    c.x += c.vx * dt
    c.y += c.vy * dt
    c.s += c.vs * dt
    apply()
    const idle = Math.abs(c.tx - c.x) < 0.2 && Math.abs(c.ty - c.y) < 0.2 && Math.abs(c.ts - c.s) < 0.0005 && Math.abs(c.vx) + Math.abs(c.vy) < 0.5
    if (idle) {
      Object.assign(c, { x: c.tx, y: c.ty, s: c.ts, vx: 0, vy: 0, vs: 0, raf: 0 })
      apply()
      return
    }
    c.raf = requestAnimationFrame(tick)
  }, [apply])
  const flyTo = React.useCallback((target, { instant = false, stiffness = 90, damping = 17 } = {}) => {
    const c = cam.current
    Object.assign(c, { tx: target.x, ty: target.y, ts: target.s, stiffness, damping })
    if (instant || reducedMotion()) {
      cancelAnimationFrame(c.raf)
      Object.assign(c, { x: c.tx, y: c.ty, s: c.ts, vx: 0, vy: 0, vs: 0, raf: 0 })
      apply()
      return
    }
    if (!c.raf) c.raf = requestAnimationFrame(tick)
  }, [apply, tick])
  const halt = React.useCallback(() => {
    const c = cam.current
    cancelAnimationFrame(c.raf)
    Object.assign(c, { raf: 0, vx: 0, vy: 0, vs: 0, tx: c.x, ty: c.y, ts: c.s })
  }, [])
  React.useEffect(() => () => cancelAnimationFrame(cam.current.raf), [])
  return { cam, flyTo, halt }
}

function Inline({ src }) {
  if (!src) return <span className="myd-inline-pic is-empty" />
  return <img className="myd-inline-pic" src={src} alt="" draggable={false} />
}

/** 首屏那句话：有图、有字、有数字，下面是一句话记灵感和最近的邮票。 */
function Hero() {
  const items = useDesk(s => s.state.items)
  const roots = items.filter(isIdea)
  const pending = roots.filter(i => i.status === 'idea' && !i.production)
  const week = new Date()
  week.setDate(week.getDate() + 7)
  const upcoming = items.filter(i => i.scheduledAt && i.status !== 'published' && new Date(i.scheduledAt) >= new Date() && new Date(i.scheduledAt) <= week)
  const streak = computeStreak(items)
  const pic = list => list.map(posterOf).find(Boolean)
  const related = useDesk(s => s.related)
  const [text, setText] = React.useState('')
  const submit = async (event) => {
    event.preventDefault()
    const value = text.trim()
    if (!value) return
    setText('')
    if (/^https?:\/\//i.test(value)) return captureUrl(value)
    // 记下的同时，把提到同一件事的旧灵感拉到眼前
    const ids = relatedIdeas(roots, value)
    setDesk({ related: ids.length ? { query: value, ids, newId: null } : null })
    await dispatchOps([{ op: 'add_item', kind: 'note', title: value.split(/[。！？\n]|[.!?](?=\s|$)/)[0].slice(0, 60), body: value.length > 60 ? value : '' }], { label: t('记下灵感') })
  }
  const now = new Date()
  return (
    <section className="myd-hero" onPointerDown={e => e.stopPropagation()}>
      <p className="myd-hero-date">{now.getFullYear()} · {t('{m} 月 {d} 日', { m: now.getMonth() + 1, d: now.getDate(), mon: now.toLocaleString('en-US', { month: 'short' }) })} · {t(WEEKDAYS[now.getDay()])}</p>
      <h1 className="myd-hero-line">
        {t('还有')} <Inline src={pic(pending)} /> <b>{t('{n} 个灵感', { n: pending.length, s: plural(pending.length, '', 's') })}</b> {t('等你成稿，')}
        <br />
        <Inline src={pic(upcoming)} /> <b>{t('{n} 条内容', { n: upcoming.length, s: plural(upcoming.length, '', 's') })}</b> {t('排在本周，')}
        <br />
        {t('你已经连续记录')} <b className="myd-hero-streak">{t('{n} 天', { n: streak, s: plural(streak, '', 's') })}</b>{t('。')}
      </h1>
      <form className="myd-hero-input" onSubmit={submit}>
        <Icon name="spark" size={16} />
        <input value={text} onChange={e => setText(e.target.value)} placeholder={t('记下一个灵感，或贴一个链接')} aria-label={t('记下灵感')} />
        <button type="submit" className="myd-send" aria-label={t('记下')} disabled={!text.trim()}><Icon name="send" size={15} /></button>
      </form>
      {related ? (
        <p className="myd-hero-related">
          <span>{t('找到 {n} 条相关的灵感，放在了旁边', { n: related.ids.length, s: plural(related.ids.length, '', 's') })}</span>
          <button type="button" className="myd-inline-link" onClick={() => setDesk({ related: null })}>{t('放回去')}</button>
        </p>
      ) : null}
      {roots.length === 0 ? <p className="myd-hero-hint">{t('写一句话、贴一个链接，或者把图片和视频拖进来。右上角的助手也能替你记。')}</p> : null}
      <MiniStamps />
    </section>
  )
}

function Node({ item, pos, index, entered, onOpen, onDelete, onMenu, tone, inline }) {
  const ref = React.useRef(null)
  React.useLayoutEffect(() => {
    if (entered.current.has(item.id)) return
    entered.current.add(item.id)
    const el = ref.current?.firstElementChild
    if (!el || reducedMotion()) return
    const k = 0.25
    el.animate([
      { transform: `translate(${-pos.x * k}px, ${-pos.y * k}px) scale(.8) rotate(${(hash(item.id) % 20) - 10}deg)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration: SPRING_SOFT.duration + 200, easing: SPRING_SOFT.easing, delay: Math.min(index * 32, 620), fill: 'backwards' })
  }, [entered, index, item.id, pos.x, pos.y])
  const size = cardSize(item)
  return (
    <div
      ref={ref}
      className={`myd-node${tone ? ` is-${tone}` : ''}${inline ? ' is-inline' : ''}`}
      data-node={item.id}
      style={{ left: pos.x, top: pos.y, ...(inline ? {} : { width: size.w }), '--r': `${inline ? 0 : pos.r ?? 0}deg`, '--d': inline ? 0 : pos.d ?? 0 }}
    >
      <div className="myd-pop">{inline ? <InlineCard item={item} /> : <Card item={item} onOpen={onOpen} onDelete={onDelete} onMenu={onMenu} />}</div>
    </div>
  )
}

function originOf(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
}

function Scatter() {
  const items = useDesk(s => s.state.items)
  const stageRef = React.useRef(null)
  const worldRef = React.useRef(null)
  const { cam, flyTo, halt } = useCamera(stageRef, worldRef)
  const dragPos = React.useRef({})
  const [, force] = React.useReducer(v => v + 1, 0)
  const entered = React.useRef(new Set())
  const suppressClick = React.useRef(false)

  const kind = useDesk(s => s.kindFilter)
  const related = useDesk(s => s.related)
  const inlineId = useDesk(s => s.inlineId)
  const roots = React.useMemo(() => items.filter(isIdea), [items])
  const shown = React.useMemo(() => roots.filter(i => kind === 'all' || displayItem(i).kind === kind), [roots, kind])
  const inlineItem = React.useMemo(() => (inlineId ? shown.find(row => row.id === inlineId) ?? null : null), [inlineId, shown])
  // 被筛掉或者被删掉的卡片，别留一个看不见的内联编辑器开着
  React.useEffect(() => { if (inlineId && !inlineItem) closeInline() }, [inlineId, inlineItem])
  // Esc 收回内联编辑：焦点可能不在画布上（比如刚点过工具条），所以挂在 window 上
  React.useEffect(() => {
    if (!inlineId) return undefined
    const onKey = event => { if (event.key === 'Escape') closeInline() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inlineId])
  const rootKey = roots.map(i => `${i.id}:${i.pos ? `${i.pos.x},${i.pos.y}` : ''}:${i.production?.cover?.src ?? ''}`).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = React.useMemo(() => scatterLayout(roots), [rootKey])

  const relatedSpots = React.useMemo(() => {
    if (!related) return {}
    const byId = new Map(roots.map(i => [i.id, i]))
    return relatedLayout(related.ids.filter(id => byId.has(id)).map(id => ({ id, ...cardSize(byId.get(id)) })))
  }, [related, roots])

  const posOf = React.useCallback((item) => {
    if (dragPos.current[item.id]) return dragPos.current[item.id]
    if (related) {
      // 相关的围在中间那句话四周，刚记下的那条放在正上方，不被底部工具条挡住
      if (item.id === related.newId) return { x: 0, y: -200 - cardSize(item).h / 2, r: 0, d: 0 }
      const spot = relatedSpots[item.id]
      if (spot) return { ...spot, r: 0, d: 0 }
    }
    if (item.pos) return { d: 0, ...item.pos }
    return layout[item.id] ?? { x: 0, y: 0, r: 0, d: 0 }
  }, [layout, related, relatedSpots])

  // 拉出相关卡片后，镜头缩放到能把它们和中间那句话一起装下
  React.useEffect(() => {
    if (!related) return
    const byId = new Map(roots.map(i => [i.id, i]))
    let half = { x: 300, y: 240 }
    for (const [id, p] of Object.entries(relatedSpots)) {
      const size = cardSize(byId.get(id))
      half = { x: Math.max(half.x, Math.abs(p.x) + size.w / 2), y: Math.max(half.y, Math.abs(p.y) + size.h / 2) }
    }
    const fresh = related.newId && byId.get(related.newId)
    if (fresh) half.y = Math.max(half.y, 200 + cardSize(fresh).h)
    const home = frameHome()
    const { w, h } = stageBox()
    flyTo({ ...home, s: Math.min(home.s, (w - 80) / (half.x * 2), (h - 150) / (half.y * 2)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relatedSpots, related?.newId])

  const toneOf = (item) => {
    if (!related) return null
    if (item.id === related.newId || related.ids.includes(item.id)) return 'related'
    return 'dim'
  }

  const stageBox = React.useCallback(() => {
    const el = stageRef.current
    return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 1000, h: 700 }
  }, [])

  const frameHome = React.useCallback(() => {
    const { w, h } = stageBox()
    return { x: w / 2, y: h / 2 + 8, s: w < 760 ? 0.66 : w < 1040 ? 0.8 : w < 1400 ? 0.92 : 1 }
  }, [stageBox])

  React.useLayoutEffect(() => {
    flyTo(frameHome(), { instant: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 二级放大时，只有放大后的卡片会被画布边缘切掉，才把镜头挪过来；
  // 能完整看见就不动镜头——相机自己动起来会让人以为画布跑了。
  const lastInline = React.useRef(null)
  React.useEffect(() => {
    if (!inlineId || !inlineItem) { lastInline.current = null; return }
    if (lastInline.current === inlineId) return
    lastInline.current = inlineId
    const pos = posOf(inlineItem)
    const { w, h } = stageBox()
    const c = cam.current
    const s = c.s || 1
    // 放大后的卡片：宽 560，高按内容估 480（超过 max-height 620 的部分自己会滚）
    const halfW = 280
    const halfH = 240
    const left = c.x + s * (pos.x - halfW)
    const right = c.x + s * (pos.x + halfW)
    const top = c.y + s * (pos.y - halfH)
    const bottom = c.y + s * (pos.y + halfH)
    const margin = 18
    if (left >= margin && right <= w - margin && top >= margin && bottom <= h - margin) return
    // 相机的 x/y 是「世界原点落在舞台上的像素位置」，所以这里要反向减掉世界坐标
    const scale = Math.min(Math.max(s, 0.8), 1.15)
    flyTo({ x: w / 2 - pos.x * scale, y: h / 2 - pos.y * scale, s: scale })
  }, [inlineId, inlineItem, posOf, flyTo, cam, stageBox])

  // 新记下的灵感可能落在屏幕外：相机带过去，让人看到它去了哪里
  const known = React.useRef(null)
  React.useEffect(() => {
    const previous = known.current
    known.current = new Set(roots.map(i => i.id))
    if (!previous) return
    const added = roots.find(i => !previous.has(i.id))
    if (!added) return
    if (related && !related.newId) {
      setDesk({ related: { ...related, newId: added.id } })
      return
    }
    const p = posOf(added)
    const size = cardSize(added)
    const { w, h } = stageBox()
    const c = cam.current
    const margin = 90
    const left = c.tx + c.ts * (p.x - size.w / 2)
    const right = c.tx + c.ts * (p.x + size.w / 2)
    const top = c.ty + c.ts * (p.y - size.h / 2)
    const bottom = c.ty + c.ts * (p.y + size.h / 2)
    const dx = left < margin ? margin - left : right > w - margin ? w - margin - right : 0
    const dy = top < margin ? margin - top : bottom > h - margin ? h - margin - bottom : 0
    if (dx || dy) flyTo({ x: c.tx + dx, y: c.ty + dy, s: c.ts })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots])

  React.useEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    let last = el.clientWidth
    const observer = new ResizeObserver(() => {
      const delta = el.clientWidth - last
      last = el.clientWidth
      if (!delta) return
      const c = cam.current
      flyTo({ x: c.tx + delta / 2, y: c.ty, s: c.ts }, { stiffness: 140, damping: 24 })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [cam, flyTo])

  const openCard = React.useCallback((item, event) => {
    if (suppressClick.current) return
    // 笔记、金句只是记录：先在画布上就地放大来改（二级），再点「放大到全屏」才是三级
    if ((item.kind === 'note' || item.kind === 'quote') && inlineId !== item.id) {
      openInline(item.id)
      return
    }
    if (inlineId === item.id) return
    openItem(item.id, originOf(event))
  }, [inlineId])

  const removeCard = React.useCallback(async (row) => {
    if (inlineId === row.id) closeInline()
    // 服务端 delete_item 自带回执和一步撤销，提示里就能撤回
    await dispatchOps([{ op: 'delete_item', id: row.id }], { label: t('删除《{title}》', { title: row.title }) })
  }, [inlineId])

  const [menu, setMenu] = React.useState(null)
  const openMenu = React.useCallback((row, event) => {
    setMenu({ id: row.id, x: event.clientX, y: event.clientY })
  }, [])
  const menuRow = menu ? shown.find(row => row.id === menu.id) ?? null : null

  const openFromMenu = (row) => {
    if (row.kind === 'note' || row.kind === 'quote') openInline(row.id)
    else openItem(row.id)
  }

  const onPointerDown = (event) => {
    if (event.button !== 0 || event.target.closest('input,textarea,button:not(.myd-card),.myd-toolrow,.myd-ministamps')) return
    const cardEl = event.target.closest('[data-node]')
    if (!cardEl && inlineId) closeInline()
    // 内联编辑中的卡片不跟着拖：免得改字的时候把卡片拖跑
    if (cardEl?.classList.contains('is-inline')) return
    const startX = event.clientX
    const startY = event.clientY
    const c = cam.current
    let moved = false
    suppressClick.current = false
    halt()
    if (cardEl) {
      const id = cardEl.dataset.node
      const origin = posOf(items.find(i => i.id === id))
      const onMove = (e) => {
        const dx = (e.clientX - startX) / c.s
        const dy = (e.clientY - startY) / c.s
        if (!moved && Math.hypot(dx, dy) < 4) return
        if (!moved) {
          moved = true
          cardEl.classList.add('is-dragging')
          suppressClick.current = true
        }
        const next = { x: origin.x + dx, y: origin.y + dy, r: origin.r, d: 0 }
        dragPos.current[id] = next
        cardEl.style.left = `${next.x}px`
        cardEl.style.top = `${next.y}px`
      }
      const onUp = async () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        cardEl.classList.remove('is-dragging')
        if (!moved) return
        const next = dragPos.current[id]
        setTimeout(() => { suppressClick.current = false }, 0)
        await dispatchOps([{ op: 'update_item', id, pos: { x: Math.round(next.x), y: Math.round(next.y), r: next.r } }], { undoable: false, silent: true })
        delete dragPos.current[id]
        force()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      return
    }
    const baseX = c.x
    const baseY = c.y
    let lastX = startX
    let lastY = startY
    let lastT = performance.now()
    let vx = 0
    let vy = 0
    stageRef.current.classList.add('is-panning')
    const onMove = (e) => {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 4) moved = true
      const now = performance.now()
      const dt = Math.max(now - lastT, 1)
      vx = (e.clientX - lastX) / dt
      vy = (e.clientY - lastY) / dt
      lastX = e.clientX
      lastY = e.clientY
      lastT = now
      flyTo({ x: baseX + e.clientX - startX, y: baseY + e.clientY - startY, s: c.s }, { instant: true })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      stageRef.current?.classList.remove('is-panning')
      if (moved) flyTo({ x: c.x + vx * 180, y: c.y + vy * 180, s: c.s }, { stiffness: 42, damping: 13 })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const zoomAt = React.useCallback((factor, cx, cy, instant = true) => {
    const c = cam.current
    const s = Math.max(0.3, Math.min(2.2, c.ts * factor))
    const k = s / c.ts
    flyTo({ x: cx - (cx - c.tx) * k, y: cy - (cy - c.ty) * k, s }, { instant, stiffness: 160, damping: 24 })
  }, [cam, flyTo])

  React.useEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    const onWheel = (event) => {
      // 光标在二级卡片上时，滚轮只滚这张卡片（长笔记常比一屏长），画布既不平移也不缩放
      const card = event.target.closest?.('.myd-inline')
      if (card) {
        if (card.scrollHeight > card.clientHeight) {
          event.preventDefault()
          card.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? card.clientHeight : 1)
        }
        return
      }
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top)
      } else {
        const c = cam.current
        flyTo({ x: c.tx - event.deltaX, y: c.ty - event.deltaY, s: c.ts }, { instant: true })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [cam, flyTo, zoomAt])

  // 键盘 Tab 到屏幕外的卡片时，相机跟过去
  const onFocusIn = (event) => {
    const node = event.target.closest?.('[data-node]')
    if (!node || !event.target.matches(':focus-visible')) return
    const stageRect = stageRef.current.getBoundingClientRect()
    const rect = node.getBoundingClientRect()
    const c = cam.current
    const margin = 72
    let dx = 0
    let dy = 0
    if (rect.left < stageRect.left + margin) dx = stageRect.left + margin - rect.left
    else if (rect.right > stageRect.right - margin) dx = stageRect.right - margin - rect.right
    if (rect.top < stageRect.top + margin) dy = stageRect.top + margin - rect.top
    else if (rect.bottom > stageRect.bottom - margin) dy = stageRect.bottom - margin - rect.bottom
    if (dx || dy) flyTo({ x: c.tx + dx, y: c.ty + dy, s: c.ts })
  }

  const center = () => {
    const { w, h } = stageBox()
    return [w / 2, h / 2]
  }

  return (
    <div
      className={`myd-stage${inlineId ? ' has-inline' : ''}`}
      ref={stageRef}
      onPointerDown={onPointerDown}
      onFocus={onFocusIn}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        // 内联编辑开着时，Esc 先收回它；否则收回「相关灵感」
        if (inlineId) { closeInline(); return }
        if (related) setDesk({ related: null })
      }}
      onDragOver={e => e.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const files = [...(event.dataTransfer?.files ?? [])]
        if (files.length) captureFiles(files)
      }}
    >
      <div className="myd-world" ref={worldRef}>
        <div className="myd-hero-anchor"><Hero /></div>
        {shown.map((item, index) => <Node key={item.id} item={item} pos={posOf(item)} index={index} entered={entered} onOpen={openCard} onDelete={removeCard} onMenu={openMenu} tone={toneOf(item)} inline={inlineId === item.id} />)}
      </div>
      {menuRow ? (
        <ContextMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            { icon: 'expand', label: t('打开'), onClick: () => openFromMenu(menuRow) },
            { icon: 'trash', label: t('删除卡片'), danger: true, onClick: () => removeCard(menuRow) },
          ]}
        />
      ) : null}
      <div className="myd-toolrow myd-toolrow-right" onPointerDown={e => e.stopPropagation()}>
        <IconButton icon="zoomOut" label={t('缩小')} onClick={() => zoomAt(0.8, ...center(), false)} />
        <IconButton icon="target" label={t('回到中心')} onClick={() => flyTo(frameHome())} />
        <IconButton icon="zoomIn" label={t('放大')} onClick={() => zoomAt(1.25, ...center(), false)} />
      </div>
    </div>
  )
}

/** 信息流：原来的瀑布流卡片，按时间从新到旧排。 */
function Feed() {
  const items = useDesk(s => s.state.items)
  const kind = useDesk(s => s.kindFilter)
  const related = useDesk(s => s.related)
  const [menu, setMenu] = React.useState(null)
  const removeCard = React.useCallback(async (row) => {
    await dispatchOps([{ op: 'delete_item', id: row.id }], { label: t('删除《{title}》', { title: row.title }) })
  }, [])
  const menuRow = menu ? items.find(row => row.id === menu.id) ?? null : null
  const rank = id => (related ? related.ids.indexOf(id) : -1)
  const sorted = React.useMemo(() => items
    .filter(i => isIdea(i) && (kind === 'all' || displayItem(i).kind === kind))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    // 有相关的灵感时排在最前面，按相关程度
    .sort((a, b) => {
      const ra = rank(a.id)
      const rb = rank(b.id)
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [items, kind, related])
  return (
    <div className="myd-wall-scroll">
      <div className="myd-feed-hero"><Hero /></div>
      <div className="myd-wall">
        {sorted.map((item, index) => (
          <div key={item.id} className={`myd-wall-cell${rank(item.id) >= 0 ? ' is-related' : ''}`} style={{ animationDelay: `${Math.min(index * 22, 400)}ms` }}>
            <Card item={item} onOpen={(row, event) => openItem(row.id, originOf(event))} onDelete={removeCard}
              onMenu={(row, event) => setMenu({ id: row.id, x: event.clientX, y: event.clientY })} />
          </div>
        ))}
      </div>
      {menuRow ? (
        <ContextMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            { icon: 'trash', label: t('删除卡片'), danger: true, onClick: () => removeCard(menuRow) },
          ]}
        />
      ) : null}
    </div>
  )
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const KIND_OPTIONS = [{ value: 'all', label: '全部' }, { value: 'image', label: '图片' }, { value: 'video', label: '视频' }, { value: 'web', label: '网页' }, { value: 'quote', label: '金句' }, { value: 'note', label: '笔记' }, { value: 'gallery', label: '图库' }]

export function HomeView() {
  const mode = useDesk(s => s.mode)
  const kind = useDesk(s => s.kindFilter)
  return (
    <div className="myd-home">
      {mode === 'feed' ? <Feed /> : <Scatter />}
      <div className="myd-dockbar" role="toolbar" aria-label={t('灵感视图')}>
        <Segmented
          label={t('展示方式')}
          value={mode}
          onChange={value => setDesk({ mode: value })}
          options={[{ value: 'scatter', icon: 'scatter', title: t('散落') }, { value: 'feed', icon: 'wall', title: t('信息流') }]}
        />
        <span className="myd-dockbar-sep" />
        <div className="myd-chips">
          {KIND_OPTIONS.map(option => (
            <button type="button" key={option.value} className={kind === option.value ? 'is-on' : ''} onClick={() => setDesk({ kindFilter: option.value })}>{t(option.label)}</button>
          ))}
        </div>
        <span className="myd-dockbar-sep" />
        <button type="button" className="myd-round is-primary" aria-label={t('记下灵感')} title={t('记下灵感')} onClick={() => openCapture('text')}><Icon name="plus" size={18} /></button>
      </div>
    </div>
  )
}


