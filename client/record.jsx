// 笔记、金句、网页的三级页（全屏）：把一条记录摊开，能改、能存、能删。
// 它们不是稿子，所以这里没有成稿、没有对话、没有分镜——点开就是这一条本身。
import React from 'react'
import { closeItem, dispatchOps } from './desk.js'
import { t } from './i18n.js'
import { Grow, Icon, IconButton } from './ui.jsx'
import { KIND_LABEL, STATUS_LABEL, fmtWhen, textLength } from './util.js'

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** 网页卡片缩略图：贴图优先，没有就留一个链接记号。 */
function PageShot({ item }) {
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => setBroken(false), [item.id])
  if (!item.media?.src || broken) {
    return (
      <div className="myd-rec-shot is-empty" aria-hidden="true">
        <Icon name="link" size={20} />
      </div>
    )
  }
  return (
    <div className="myd-rec-shot">
      <img src={item.media.src} alt="" loading="lazy" draggable={false} referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    </div>
  )
}

export function RecordStudio({ item }) {
  const kind = item.kind
  const body = item.body ?? ''
  const commit = (fields, label) => dispatchOps([{ op: 'update_item', id: item.id, ...fields }], { label, silent: true })
  const remove = () => {
    closeItem()
    dispatchOps([{ op: 'delete_item', id: item.id }], { label: t('删除《{title}》', { title: item.title || t(KIND_LABEL[kind]) }) })
  }
  const words = textLength(body) + textLength(item.title)
  return (
    <div className={`myd-rec is-${kind}`}>
      <header className="myd-rec-head">
        <IconButton icon="chevL" label={t('返回灵感')} onClick={closeItem} />
        <span className="myd-rec-kind">{t(KIND_LABEL[kind])}</span>
        <span className={`myd-status status-${item.status}`}>{t(STATUS_LABEL[item.status])}</span>
        <span className="myd-rec-gap" />
        {item.scheduledAt ? <span className="myd-rec-when"><Icon name="calendar" size={13} />{fmtWhen(item.scheduledAt)}</span> : null}
        {item.url ? (
          <a className="myd-rec-open" href={item.url} target="_blank" rel="noreferrer noopener">
            <Icon name="upRight" size={13} />
            {t('打开')}
          </a>
        ) : null}
        <IconButton icon="trash" label={t('删除')} onClick={remove} />
      </header>

      <div className="myd-rec-scroll">
        <div className="myd-rec-page">
          {kind === 'web' ? (
            <div className="myd-rec-web">
              <PageShot item={item} />
              <div className="myd-rec-web-meta">
                <Grow className="myd-rec-title" label={t('标题')} value={item.title} placeholder={t('给这个网页起个名字')}
                  onCommit={next => commit({ title: next }, t('修改标题'))} />
                <span className="myd-rec-host">{item.url ? hostOf(item.url) : t('没有链接')}</span>
              </div>
            </div>
          ) : (
            <Grow className={`myd-rec-title${kind === 'quote' ? ' is-quote' : ''}`} label={t('标题')} value={item.title}
              placeholder={kind === 'quote' ? t('写下一句值得记的话') : t('无标题')}
              onCommit={next => commit({ title: next }, t('修改标题'))} />
          )}

          {kind === 'quote' ? (
            <div className="myd-rec-quote">
              <Grow className="myd-rec-quote-body" label={t('补充')} value={body}
                placeholder={t('想补一句也行：出处、什么时候看到的、为什么记它')}
                onCommit={next => commit({ body: next }, t('修改笔记'))} />
              {item.source ? <span className="myd-rec-source">{item.source}</span> : null}
            </div>
          ) : (
            <Grow className="myd-rec-body" label={t('正文')} value={body}
              placeholder={kind === 'web' ? t('记下你看到的关键点') : t('想到什么就写什么')}
              onCommit={next => commit({ body: next }, t('修改正文'))} />
          )}

          {item.tags?.length ? (
            <div className="myd-rec-tags">
              {item.tags.map(tag => <span key={tag} className="myd-rec-tag">{tag}</span>)}
            </div>
          ) : null}
        </div>
      </div>

      <footer className="myd-rec-foot">
        <span>{t('{n} 字', { n: words })}</span>
        <span className="myd-rec-dot" />
        <span>{fmtWhen(item.createdAt)}</span>
        <span className="myd-rec-gap" />
        <span className="myd-rec-hint">{t('改动在失焦时自动保存')}</span>
      </footer>
    </div>
  )
}
