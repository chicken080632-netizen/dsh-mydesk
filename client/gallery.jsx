// 图库：一边管图，一边出图。左边是已经画出来的所有图，右边是生图面板。
import React from 'react'
import { addGalleryFiles, closeItem, dispatchOps, dropVariant, galleryMake, saveBoardLayout, toast, uploadFile, useDesk, useVariant } from './desk.js'
import { GalleryBoard } from './board.jsx'
import { t } from './i18n.js'
import { fmtWhen } from './util.js'
import { Icon, IconButton, Segmented } from './ui.jsx'

const RATIOS = [{ value: '', label: '默认' }, { value: '1:1', label: '1:1' }, { value: '3:4', label: '3:4' }, { value: '4:3', label: '4:3' }, { value: '9:16', label: '9:16' }, { value: '16:9', label: '16:9' }]
const COUNTS = [1, 2, 4]
// 一次拖进来最多收这些张，免得手滑拖了整个相册把页面拖住
const DROP_MAX = 24
const IDEA_CHIPS = [
  '同一套配色的封面',
  '海报感的大字标题',
  '干净的留白构图',
  '像杂志内页的排版',
  '接着这个风格再来几张',
  '换个光线和色调',
]

function Tile({ shot, index, active, busy, onPick, onView, onCover, onDrop }) {
  return (
    <figure className={`myd-gal-tile${active ? ' is-on' : ''}`} data-index={index}>
      <button type="button" className="myd-gal-shot" disabled={busy} onClick={() => onPick(shot)} aria-label={t('选中第 {n} 张当参考', { n: index + 1 })}>
        <img src={shot.src} alt="" loading="lazy" draggable={false} referrerPolicy="no-referrer" />
        {active ? <span className="myd-gal-picked"><Icon name="check" size={12} stroke={2.4} />{t('参考图')}</span> : null}
      </button>
      <div className="myd-gal-acts">
        <button type="button" className="myd-gal-act" disabled={busy} onClick={() => onView(shot)} title={t('看大图')}><Icon name="expand" size={13} /></button>
        <button type="button" className="myd-gal-act" disabled={busy} onClick={() => onCover(shot)} title={t('设为封面')}><Icon name="image" size={13} /></button>
        <button type="button" className="myd-gal-act is-quiet" disabled={busy} onClick={() => onDrop(shot)} title={t('删掉这张')}><Icon name="trash" size={13} /></button>
      </div>
      {shot.prompt ? <figcaption title={shot.prompt}>{shot.prompt}</figcaption> : null}
    </figure>
  )
}

export function GalleryStudio({ item }) {
  const settings = useDesk(s => s.settings)
  const capabilities = settings?.art
  const variants = Array.isArray(item.art?.variants) ? item.art.variants : []
  const latest = variants.length ? variants[variants.length - 1] : null
  const [prompt, setPrompt] = React.useState(item.art?.prompt ?? '')
  const [ratio, setRatio] = React.useState('')
  const [count, setCount] = React.useState(1)
  const [picked, setPicked] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [waiting, setWaiting] = React.useState(0)
  const [shown, setShown] = React.useState(null)
  const [dragging, setDragging] = React.useState(0)
  const [receiving, setReceiving] = React.useState(null)
  const [mode, setMode] = React.useState(() => (item.art?.board?.mode === 'board' ? 'board' : 'grid'))
  const startedAt = React.useRef(0)
  const input = React.useRef(null)

  React.useEffect(() => {
    setPrompt(item.art?.prompt ?? '')
    setPicked(null)
    setShown(null)
    setMode(item.art?.board?.mode === 'board' ? 'board' : 'grid')
  }, [item.id])

  // 预览模式存在卡片自己的布局里（和位置、缩放一起），换卡片或刷新都还记着
  const switchMode = (next) => {
    if (next === mode) return
    setMode(next)
    const board = item.art?.board && typeof item.art.board === 'object' ? item.art.board : {}
    saveBoardLayout(item.id, { ...board, mode: next }).catch(() => {})
  }

  React.useEffect(() => {
    if (!busy) {
      setWaiting(0)
      return undefined
    }
    const timer = setInterval(() => setWaiting(Math.round((Date.now() - startedAt.current) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [busy])

  React.useEffect(() => {
    if (!shown) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setShown(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown])

  // 拖进来 / 粘进来：先逐张传到 files/，再让 host 把它们挂成一版一版的图
  const receive = React.useCallback(async (files) => {
    const images = [...files].filter(file => file && file.size > 0 && String(file.type).startsWith('image/')).slice(0, DROP_MAX)
    setDragging(0)
    if (!images.length) {
      toast(t('这些文件不是图片，没收到图库里'), { error: true })
      return
    }
    setReceiving({ done: 0, total: images.length })
    const sources = []
    try {
      for (let index = 0; index < images.length; index += 1) {
        const uploaded = await uploadFile(images[index])
        if (uploaded?.src) sources.push(uploaded.src)
        setReceiving({ done: index + 1, total: images.length })
      }
      if (!sources.length) {
        toast(t('这些文件不是图片，没收到图库里'), { error: true })
        return
      }
      const data = await addGalleryFiles(item.id, sources)
      setPicked(null)
      toast(t('收了 {n} 张图', { n: data.added?.length ?? sources.length }))
    } catch (error) {
      toast(error.message, { error: true })
    } finally {
      setReceiving(null)
    }
  }, [item.id])

  // 图库页开着的时候，Ctrl+V 粘一张截图也收进来（正文里粘文字不受影响）
  React.useEffect(() => {
    const onPaste = (event) => {
      const rows = [...(event.clipboardData?.items ?? [])]
      const files = rows.filter(row => row.kind === 'file').map(row => row.getAsFile()).filter(Boolean)
      if (!files.length) return
      event.preventDefault()
      receive(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [receive])

  const hasFiles = event => Array.from(event.dataTransfer?.types ?? []).includes('Files')

  const actionable = Boolean(capabilities?.ready)
  // host 半片还是旧版时 settings 里没有 art 这个键：说清楚是要重启 DSH，别让人干等
  const staleHost = Boolean(settings) && !('art' in settings)
  const reference = picked ? variants.find(row => row.id === picked) ?? null : null
  const indexOf = shot => variants.findIndex(row => row.id === shot.id) + 1
  const shots = [...variants].reverse()

  const run = async () => {
    const text = prompt.trim()
    if (!text) {
      toast(t('先写一句想要什么画面'), { error: true })
      return
    }
    startedAt.current = Date.now()
    setBusy(true)
    try {
      const data = await galleryMake(item.id, {
        prompt: text,
        count,
        ...(ratio ? { ratio } : {}),
        ...(picked ? { source: picked } : {}),
      })
      const first = data.added?.[0]
      if (first) {
        setPicked(first.id)
        setShown(first.src)
      }
      if (data.added?.length && count > data.added.length) toast(t('只画出来 {n} 张，其余几张失败了', { n: data.added.length }), { error: true })
    } catch (error) {
      toast(error.message, { error: true })
    } finally {
      setBusy(false)
    }
  }

  const makeCover = async (shot) => {
    try {
      await useVariant(item.id, shot.id)
      toast(t('这张已经设为封面'))
    } catch (error) {
      toast(error.message, { error: true })
    }
  }

  const remove = async (shot) => {
    try {
      await dropVariant(item.id, shot.id)
      if (picked === shot.id) setPicked(null)
      if (shown === shot.src) setShown(null)
      toast(t('删掉了一张'))
    } catch (error) {
      toast(error.message, { error: true })
    }
  }

  // 删掉整个图库卡片（连带里面所有图），服务端留一步撤销
  const removeCard = async () => {
    try {
      closeItem()
      await dispatchOps([{ op: 'delete_item', id: item.id }], { label: t('删除《{title}》', { title: item.title }) })
    } catch (error) {
      toast(error.message, { error: true })
    }
  }

  const pick = (shot) => {
    const next = picked === shot.id ? null : shot.id
    setPicked(next)
    setPrompt(text => (next && !text.trim() && shot.prompt ? shot.prompt : text))
    if (next) input.current?.focus()
  }

  return (
    <div
      className={`myd-gal${dragging > 0 ? ' is-dropping' : ''}`}
      onDragEnter={(event) => { if (!hasFiles(event)) return; event.preventDefault(); setDragging(count => count + 1) }}
      onDragOver={(event) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDragLeave={(event) => { if (!hasFiles(event)) return; setDragging(count => Math.max(0, count - 1)) }}
      onDrop={(event) => {
        const files = [...(event.dataTransfer?.files ?? [])]
        if (!files.length) return
        event.preventDefault()
        setDragging(0)
        receive(files)
      }}
    >
      <section className="myd-gal-main">
        <header className="myd-art-head">
          <IconButton icon="chevL" label={t('返回灵感')} onClick={closeItem} />
          <h2 className="myd-art-name">{item.title || t('图库')}</h2>
          <span className="myd-art-count">{t('{n} 张', { n: variants.length })}</span>
          <span className="myd-art-gap" />
          <Segmented value={mode} label={t('预览模式')} onChange={switchMode} options={[
            { value: 'grid', label: t('缩略图'), title: t('缩略图：一张张方图排下去') },
            { value: 'board', label: t('铺开'), title: t('铺开：按原比例摆在一块画布上') },
          ]} />
          <span className="myd-gal-hint">{mode === 'grid' && shots.length ? t('点一张选中，作为下一轮的参考') : ''}</span>
          <IconButton icon="trash" label={t('删除卡片')} onClick={() => removeCard()} />
        </header>

        {mode === 'board' ? (
          <GalleryBoard item={item} variants={variants} mode={mode} />
        ) : (
        <div className="myd-gal-scroll">
          {shots.length || busy ? (
            <div className="myd-gal-grid">
              {busy ? Array.from({ length: count }, (_, index) => (
                <div className="myd-gal-tile is-wait" key={`wait-${index}`}>
                  <div className="myd-gal-shot myd-shimmer"><span>{t('正在画')}</span></div>
                </div>
              )) : null}
              {shots.map(shot => (
                <Tile key={shot.id} shot={shot} index={indexOf(shot)} active={picked === shot.id} busy={busy}
                  onPick={pick} onView={row => setShown(row.src)} onCover={makeCover} onDrop={remove} />
              ))}
            </div>
          ) : (
            <div className="myd-gal-empty">
              <Icon name="image" size={22} />
              <p>{t('这个图库还是空的：在右边写一句想要什么，画出来的图都会存在这里。')}</p>
              <p className="myd-gal-empty-hint">{t('也可以把本地图片拖进来，或者直接 Ctrl+V 粘贴。')}</p>
              <button type="button" className="myd-art-chip" onClick={() => input.current?.focus()}>{t('开始画第一张')}</button>
            </div>
          )}
        </div>
        )}
      </section>

      <aside className="myd-gal-panel">
        <label className="myd-art-label" htmlFor="myd-gal-prompt">{t('想让 AI 画什么')}</label>
        <textarea id="myd-gal-prompt" ref={input} className="myd-art-input" rows={4} value={prompt} disabled={busy}
          placeholder={t('比如：一组留白很大的封面，深色背景，中间一行大字，冷静但有一点暖光')}
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              if (!busy) run()
            }
          }} />

        <div className="myd-gal-ref">
          <Icon name={reference ? 'check' : 'image'} size={12} />
          <span>{reference ? t('参考第 {n} 张', { n: indexOf(reference) }) : t('不用参考图，从零画')}</span>
          <span className="myd-art-gap" />
          {reference ? <button type="button" className="myd-art-chip" onClick={() => setPicked(null)}>{t('取消参考')}</button> : null}
        </div>

        <div className="myd-art-chips">
          {IDEA_CHIPS.map(chip => (
            <button type="button" key={chip} className="myd-art-chip" disabled={busy}
              onClick={() => setPrompt(text => (text.trim() ? `${text.trim()}，${t(chip)}` : t(chip)))}>
              {t(chip)}
            </button>
          ))}
        </div>

        <div className="myd-art-field">
          <span className="myd-art-label">{t('画幅')}</span>
          <div className="myd-art-ratios">
            {RATIOS.map(option => (
              <button type="button" key={option.value || 'auto'} className={ratio === option.value ? 'is-on' : ''} disabled={busy}
                onClick={() => setRatio(option.value)}>
                {t(option.label)}
              </button>
            ))}
          </div>
        </div>

        <div className="myd-art-field">
          <span className="myd-art-label">{t('这次画几张')}</span>
          <div className="myd-art-ratios">
            {COUNTS.map(value => (
              <button type="button" key={value} className={count === value ? 'is-on' : ''} disabled={busy} onClick={() => setCount(value)}>
                {t('{n} 张', { n: value })}
              </button>
            ))}
          </div>
        </div>

        <button type="button" className="myd-art-go" disabled={busy || !actionable} onClick={run}>
          {busy ? <><span className="myd-shimmer">{t('正在画…')}</span>{waiting ? <em>{t('{n} 秒', { n: waiting })}</em> : null}</> : <><Icon name="spark" size={15} />{variants.length ? t('再画几张') : t('画出来')}</>}
        </button>

        <p className="myd-art-note">
          {staleHost
            ? t('这个工作台的后端还是旧版（没有生图接口），重启 DSH 后再来。')
            : !capabilities
              ? t('正在检查可用的图像工具…')
              : !actionable
                ? t('还没有可用的图像工具，先去设置里接入生图模型。')
                : reference
                  ? t('会拿选中的那张当参考，接着它画；一次最多 4 张。')
                  : t('不用参考图，按描述从零画；画好的图都在左边，可以挑一张当封面。')}
        </p>
        <p className="myd-gal-hint-line">{t('本地图片可以直接拖到左边，或 Ctrl+V 粘贴。')}</p>
        {latest ? <p className="myd-gal-stamp">{t('最近一次：{when}', { when: fmtWhen(latest.createdAt) })}</p> : null}
      </aside>

      {dragging > 0 || receiving ? (
        <div className="myd-gal-drop">
          <Icon name={receiving ? 'upload' : 'image'} size={22} />
          <p>{receiving ? t('正在收图 {done}/{total}', receiving) : t('松手就收进这个图库')}</p>
          <small>{receiving ? t('大图会慢一点') : t('也可以直接 Ctrl+V 粘贴截图')}</small>
        </div>
      ) : null}

      {shown ? (
        <div className="myd-gal-view" role="dialog" aria-label={t('看大图')} onPointerDown={event => { if (event.target === event.currentTarget) setShown(null) }}>
          <img src={shown} alt="" draggable={false} />
          <div className="myd-gal-view-bar">
            <a className="myd-art-get" href={shown} download target="_blank" rel="noreferrer noopener"><Icon name="save" size={13} />{t('下载')}</a>
            <span className="myd-art-gap" />
            <IconButton icon="close" label={t('关闭')} onClick={() => setShown(null)} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
