// 灵感卡片：散落、瀑布流复用同一张卡。
import React from 'react'
import { setDesk } from './desk.js'
import { t } from './i18n.js'
import { Icon } from './ui.jsx'
import { KIND_LABEL, STATUS_LABEL, displayItem, hash, relativeDay } from './util.js'

export function Media({ item, autoPlay = false, controls = false, onFirstFrame }) {
  const ref = React.useRef(null)
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => {
    const video = ref.current
    if (!video || item.kind !== 'video') return
    if (autoPlay) video.play().catch(() => {})
    else {
      video.pause()
      video.currentTime = 0
    }
  }, [autoPlay, item.kind])
  if (!item.media || broken) return <div className="myd-media-fallback"><span>{item.title.slice(0, 1)}</span></div>
  const ratio = item.media.w && item.media.h ? { aspectRatio: `${item.media.w} / ${item.media.h}` } : undefined
  if (item.kind === 'video') {
    return <video ref={ref} className="myd-media" style={ratio} src={item.media.src} poster={item.media.poster} muted={!controls} loop playsInline controls={controls} preload="metadata" onError={() => setBroken(true)} />
  }
  return <img className="myd-media" style={ratio} src={item.media.src} alt="" loading="lazy" draggable={false} referrerPolicy="no-referrer" onError={() => setBroken(true)} onLoad={onFirstFrame} />
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** 图库里的图，最近的排前面。 */
export function galleryShots(item, limit = 4) {
  const variants = Array.isArray(item.art?.variants) ? item.art.variants : []
  return variants.slice(-limit).reverse()
}

function GalleryCover({ item }) {
  const shots = galleryShots(item)
  const total = Array.isArray(item.art?.variants) ? item.art.variants.length : 0
  return (
    <div className={`myd-card-mosaic cells-${Math.max(shots.length, 1)}`} data-media={item.id}>
      {shots.length ? shots.map(shot => (
        <img key={shot.id} className="myd-mosaic-cell" src={shot.src} alt="" loading="lazy" draggable={false} referrerPolicy="no-referrer" />
      )) : (
        <span className="myd-mosaic-empty"><Icon name="image" size={15} />{t('空的图库')}</span>
      )}
      {total > shots.length ? <span className="myd-mosaic-count">{total}</span> : null}
    </div>
  )
}

export function Card({ item: raw, onOpen, onDelete, onMenu }) {
  const item = displayItem(raw)
  const inverted = item.pinned
  const running = item.production?.status === 'running'
  const [hover, setHover] = React.useState(false)
  const hasMedia = Boolean(item.media) && ['image', 'video', 'web'].includes(item.kind)
  const lines = hash(item.id) % 2 === 0

  return (
    <article
      className={`myd-card kind-${item.kind} ${inverted ? 'is-inverted' : ''} ${item.status === 'published' ? 'is-published' : ''}`}
      data-card={item.id}
      tabIndex={0}
      role="button"
      aria-label={t('{kind}：{title}', { kind: t(KIND_LABEL[item.kind]), title: item.title })}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={event => onOpen?.(raw, event)}
      onContextMenu={(event) => {
        if (!onMenu) return
        event.preventDefault()
        event.stopPropagation()
        onMenu(raw, event)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen?.(raw, event)
          return
        }
        // 卡片拿到焦点时，Delete / Backspace 直接删（服务端留了撤销）
        if ((event.key === 'Delete' || event.key === 'Backspace') && onDelete) {
          event.preventDefault()
          onDelete(raw)
        }
      }}
    >
      {onDelete ? (
        <button
          type="button"
          className="myd-card-del"
          aria-label={t('删除卡片')}
          title={t('删除卡片')}
          tabIndex={-1}
          onPointerDown={event => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onDelete(raw) }}
        >
          <Icon name="trash" size={13} />
        </button>
      ) : null}
      {hasMedia ? (
        <div className="myd-card-media" data-media={item.id}>
          <Media item={item} autoPlay={hover} />
          {item.kind === 'video' ? <span className="myd-card-play"><Icon name="play" size={12} fill /></span> : null}
        </div>
      ) : item.kind === 'gallery' ? <GalleryCover item={item} /> : null}

      {item.kind === 'quote' ? (
        <blockquote className="myd-card-quote">{item.title}</blockquote>
      ) : item.kind === 'note' ? (
        <div className="myd-card-note">
          {item.rel ? <span className="myd-card-rel">{item.rel}</span> : null}
          <h3>{item.title}</h3>
          {item.body ? <p className={lines ? 'is-ruled' : ''}>{item.body}</p> : null}
        </div>
      ) : (
        <div className="myd-card-caption"><h3>{item.title}</h3></div>
      )}

      <footer className="myd-card-foot">
        <span className={`myd-dot status-${item.status}`} title={t(STATUS_LABEL[item.status])} />
        <span className="myd-card-source">{item.kind === 'web' && item.url ? hostOf(item.url) : item.source || t(KIND_LABEL[item.kind])}</span>
        <span className="myd-card-time">{running ? <span className="myd-shimmer">{t('正在成稿')}</span> : item.production?.status === 'done' ? t('已成稿') : item.scheduledAt && item.status !== 'published' ? relativeDay(item.scheduledAt) : ''}</span>
      </footer>
    </article>
  )
}

export function openCapture(tab = 'text') {
  setDesk({ capture: { tab } })
}
