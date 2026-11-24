// 图片卡片的二级页：一张工作台，左边看这张图，右边说要怎么改，改完的新一版排在下面。
// 参考图就是这张图本身；模型改不动时 Host 会退一步按描述重画，界面上会标出来。
import React from 'react'
import { closeItem, dispatchOps, dropVariant, remixArt, toast, useDesk, useVariant } from './desk.js'
import { t } from './i18n.js'
import { Icon, IconButton } from './ui.jsx'
import { fmtWhen } from './util.js'

const RATIOS = [
  { value: '', label: '原图' },
  { value: '1:1', label: '1:1' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
  { value: '9:16', label: '9:16' },
  { value: '16:9', label: '16:9' },
]

const IDEA_CHIPS = ['换个背景', '换光线和色调', '加一行大字', '裁成封面', '去掉画面里的杂物', '画得更有质感']

function Thumb({ row, active, onPick, label }) {
  return (
    <button type="button" className={`myd-art-thumb ${active ? 'is-on' : ''}`} onClick={onPick} title={label} aria-pressed={active}>
      <img src={row.src} alt="" draggable={false} loading="lazy" />
      <span>{label}</span>
    </button>
  )
}

export function ArtStudio({ item }) {
  const settings = useDesk(s => s.settings)
  const capabilities = settings?.art ?? null
  const variants = Array.isArray(item.art?.variants) ? item.art.variants : []
  const base = item.media?.src ?? null
  const last = variants.length ? variants[variants.length - 1] : null
  const [picked, setPicked] = React.useState(null)
  const [prompt, setPrompt] = React.useState('')
  const [ratio, setRatio] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [waiting, setWaiting] = React.useState(0)
  const [broken, setBroken] = React.useState({})
  const input = React.useRef(null)

  // 换一张卡片就从这张卡自己的状态重新开始
  React.useEffect(() => {
    setPrompt(item.art?.prompt ?? '')
    setRatio('')
    setBroken({})
    setPicked(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  React.useEffect(() => {
    if (!busy) return undefined
    const start = Date.now()
    setWaiting(0)
    const timer = setInterval(() => setWaiting(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [busy])

  const current = (picked ? variants.find(row => row.id === picked) : null) ?? last
  const shown = current ?? (base ? { src: base, id: null } : null)
  const reference = current

  const run = async () => {
    const text = prompt.trim()
    if (!text) {
      toast(t('先写一句想怎么改'), { error: true })
      return
    }
    setBusy(true)
    try {
      const data = await remixArt(item.id, { prompt: text, ...(ratio ? { ratio } : {}), ...(reference ? { source: reference.id } : {}) })
      if (data.variant) setPicked(data.variant.id)
      if (data.variant?.mode === 'draw' && capabilities?.edit) toast(t('这次没能拿这张图当参考，是按你的描述重画的'))
    } catch (err) {
      toast(err.message, { error: true })
    } finally {
      setBusy(false)
    }
  }

  const makeCover = async (variant) => {
    try {
      await useVariant(item.id, variant.id)
      toast(t('这张已经换成卡片图'))
    } catch (err) {
      toast(err.message, { error: true })
    }
  }

  const remove = async (variant) => {
    try {
      await dropVariant(item.id, variant.id)
      toast(t('删掉了一版'))
    } catch (err) {
      toast(err.message, { error: true })
    }
  }

  const continueWith = (variant) => {
    setPicked(variant.id)
    setPrompt('')
    input.current?.focus()
  }

  // 删掉整张卡片（连带它所有版本），服务端留一步撤销
  const removeCard = async () => {
    try {
      closeItem()
      await dispatchOps([{ op: 'delete_item', id: item.id }], { label: t('删除《{title}》', { title: item.title }) })
    } catch (err) {
      toast(err.message, { error: true })
    }
  }

  const actionable = Boolean(capabilities?.ready)
  // host 半片还是旧版时 settings 里没有 art 这个键：说清楚是要重启 DSH，别让人干等
  const staleHost = Boolean(settings) && !('art' in settings)
  const referenceName = reference ? t('第 {n} 版', { n: variants.findIndex(row => row.id === reference.id) + 1 }) : t('卡片原图')

  return (
    <div className="myd-art">
      <header className="myd-art-head">
        <IconButton icon="chevL" label={t('返回灵感')} onClick={closeItem} />
        <h2 className="myd-art-name">{item.title || t('图片')}</h2>
        <span className="myd-art-count">{variants.length ? t('{n} 版', { n: variants.length + (base ? 1 : 0) }) : t('原图')}</span>
        <span className="myd-art-gap" />
        {shown ? (
          <a className="myd-art-get" href={shown.src} download target="_blank" rel="noreferrer noopener">
            <Icon name="save" size={13} />
            {t('下载')}
          </a>
        ) : null}
        <IconButton icon="trash" label={t('删除卡片')} onClick={() => removeCard()} />
      </header>

      <div className="myd-art-body">
        <section className="myd-art-stage">
          <div className={`myd-art-frame ${busy ? 'is-busy' : ''}`}>
            {shown ? (
              <>
                <img key={shown.src} className="myd-art-img" src={shown.src} alt="" draggable={false}
                  onError={() => setBroken(s => ({ ...s, [shown.src]: true }))} />
                {broken[shown.src] ? <span className="myd-art-broken">{t('这张图打不开了')}</span> : null}
              </>
            ) : (
              <div className="myd-art-empty">
                <Icon name="image" size={22} />
                <p>{t('这张卡片没有图')}</p>
              </div>
            )}
            {busy ? (
              <div className="myd-art-wait">
                <span className="myd-shimmer">{t('正在画，通常要等几十秒')}</span>
                {waiting ? <em>{t('{n} 秒', { n: waiting })}</em> : null}
              </div>
            ) : null}
          </div>

          <div className="myd-art-under">
            {current ? (
              <>
                <div className="myd-art-about">
                  <span className={`myd-art-mode is-${current.mode ?? 'edit'}`}>
                    {current.mode === 'draw' ? t('按描述重画') : t('参考原图改的')}
                  </span>
                  {current.prompt ? <span className="myd-art-said">“{current.prompt}”</span> : null}
                  <span className="myd-art-gap" />
                  <span className="myd-art-time">{fmtWhen(current.createdAt)}</span>
                </div>
                <div className="myd-art-acts">
                  <button type="button" className="myd-art-act is-primary" onClick={() => makeCover(current)}>
                    <Icon name="check" size={13} stroke={2.2} />
                    {t('用这张当卡片图')}
                  </button>
                  <button type="button" className="myd-art-act" disabled={busy} onClick={() => continueWith(current)}>
                    <Icon name="branch" size={13} />
                    {t('在这张上接着改')}
                  </button>
                  <span className="myd-art-gap" />
                  <button type="button" className="myd-art-act is-quiet" onClick={() => remove(current)}>
                    <Icon name="trash" size={13} />
                    {t('删掉这版')}
                  </button>
                </div>
              </>
            ) : (
              <p className="myd-art-tip">{t('在右边写一句想怎么改。改出来的新图排在下面，卡片原图不会被覆盖。')}</p>
            )}

            {variants.length ? (
              <div className="myd-art-strip">
                {base ? <Thumb row={{ src: base }} active={!current} onPick={() => setPicked(null)} label={t('原图')} /> : null}
                {variants.map((row, index) => (
                  <Thumb key={row.id} row={row} active={current?.id === row.id} onPick={() => setPicked(row.id)} label={t('第 {n} 版', { n: index + 1 })} />
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <aside className="myd-art-panel">
          <label className="myd-art-label" htmlFor="myd-art-prompt">{t('想让 AI 怎么改这张图')}</label>
          <textarea id="myd-art-prompt" ref={input} className="myd-art-input" rows={4} value={prompt} disabled={busy}
            placeholder={t('比如：把背景换成傍晚的海边，人物和衣服别动，光线暖一点')}
            onChange={event => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                if (!busy) run()
              }
            }} />

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

          <button type="button" className="myd-art-go" disabled={busy || !actionable} onClick={run}>
            {busy ? <span className="myd-shimmer">{t('正在画…')}</span> : <><Icon name="spark" size={15} />{variants.length ? t('再改一版') : t('生成一版')}</>}
          </button>

          <p className="myd-art-note">
            {staleHost
              ? t('这个工作台的后端还是旧版（没有二创接口），重启 DSH 后再来。')
              : !capabilities
                ? t('正在检查可用的图像工具…')
                : !actionable
                  ? t('还没有可用的图像工具，先去设置里接入生图模型。')
                  : capabilities.edit
                    ? t('会把这张图当参考交给模型改；万一改不了，会按你的描述重画一版并标出来。')
                    : t('当前模型只能按描述重画，不会真的沿用这张图。')}
          </p>
          {actionable ? <p className="myd-art-note is-quiet">{t('这次拿「{name}」当参考', { name: referenceName })}</p> : null}
        </aside>
      </div>
    </div>
  )
}
