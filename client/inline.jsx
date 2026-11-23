// 画布上的二级页：笔记、金句就地放大成一张能直接改的卡片，不跳到全屏。
// 还留在基础画布上（相机、别的卡片都还在），再点「放大到全屏」才是三级（RecordStudio）。
import React from 'react'
import { closeInline, dispatchOps, openItem } from './desk.js'
import { t } from './i18n.js'
import { Grow, IconButton } from './ui.jsx'
import { KIND_LABEL, fmtWhen, textLength } from './util.js'

export function InlineCard({ item }) {
  const kind = item.kind
  const title = item.title || t(KIND_LABEL[kind])
  const commit = fields => dispatchOps([{ op: 'update_item', id: item.id, ...fields }], { label: t('改《{title}》', { title }), silent: true })
  const words = textLength(item.title) + textLength(item.body)

  return (
    <article className={`myd-inline kind-${kind}`} data-inline={item.id}>
      <header className="myd-inline-head">
        <span className="myd-inline-kind">
          <i className={`myd-dot status-${item.status}`} aria-hidden="true" />
          {t(KIND_LABEL[kind])}
        </span>
        <span className="myd-inline-time">{fmtWhen(item.createdAt)}</span>
        <span className="myd-inline-gap" />
        <IconButton icon="expand" label={t('放大到全屏')} onClick={() => openItem(item.id)} />
        <IconButton icon="close" label={t('收起')} onClick={closeInline} />
      </header>

      {kind === 'quote' ? (
        <Grow className="myd-inline-quote" label={t('金句')} placeholder={t('写一句值得记住的话')} value={item.title} onCommit={next => commit({ title: next })} />
      ) : (
        <>
          <Grow className="myd-inline-title" label={t('标题')} placeholder={t('标题')} value={item.title} onCommit={next => commit({ title: next })} />
          <Grow className="myd-inline-body" label={t('正文')} placeholder={t('写点什么')} value={item.body ?? ''} onCommit={next => commit({ body: next })} />
        </>
      )}

      <footer className="myd-inline-foot">
        <span>{t('{n} 字', { n: words })}</span>
        <span className="myd-inline-dot" aria-hidden="true">·</span>
        <span>{t('改动在失焦时自动保存')}</span>
      </footer>
    </article>
  )
}
