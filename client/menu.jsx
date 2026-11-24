// 卡片上的右键菜单：删除这类不常驻的动作收在这里，卡片本身保持干净。
import React from 'react'
import { Icon } from './ui.jsx'

/**
 * 贴着指针弹出的小菜单。
 * at 是视口坐标（clientX/clientY），菜单自己会翻到还在屏幕内的一侧。
 */
export function ContextMenu({ at, items, onClose }) {
  const ref = React.useRef(null)
  const [pos, setPos] = React.useState({ x: at.x, y: at.y })

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const x = Math.min(at.x, window.innerWidth - box.width - 8)
    const y = Math.min(at.y, window.innerHeight - box.height - 8)
    setPos({ x: Math.max(8, x), y: Math.max(8, y) })
  }, [at.x, at.y])

  React.useEffect(() => {
    // 捕获阶段拦：别让画布的平移/缩放先吃掉这次点击，也别让 Esc 顺手把二级页面关掉
    const onDown = event => { if (!ref.current?.contains(event.target)) onClose() }
    const onKey = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onClose, { passive: true, capture: true })
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', onClose, { capture: true })
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="myd-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()}
    >
      {items.map(entry => (
        <button
          key={entry.label}
          type="button"
          role="menuitem"
          className={`myd-menu-item${entry.danger ? ' is-danger' : ''}`}
          onClick={() => { onClose(); entry.onClick() }}
        >
          <Icon name={entry.icon} size={15} />
          <span>{entry.label}</span>
        </button>
      ))}
    </div>
  )
}
