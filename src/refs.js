// 对话里的参考图：把图库、图片卡片里选中的图带给模型看。
// 只认插件数据目录里的图（mydesk/files/...），最多 4 张，单张超过 40MB 直接跳过。
import { readImageFile, sourcePathOf } from './art.js'
import { tr } from './i18n.js'

export const MAX_REFS = 4

const PREFIX = 'mydesk/files/'

const MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

export function mediaTypeOf(ext) {
  return MEDIA_TYPES[String(ext ?? '').toLowerCase()] ?? 'image/png'
}

function nameOf(src) {
  return String(src ?? '').startsWith(PREFIX) ? String(src).slice(PREFIX.length) : 'reference'
}

function labelOf(row, index) {
  const text = typeof row?.label === 'string' ? row.label.trim() : ''
  return text.slice(0, 60) || tr('第 {n} 张', { n: index + 1 })
}

/**
 * 图片交给 attachments 存成附件，再包成模型能收的 image block。
 * 附件服务没接上时返回空数组：这次就当只发了文字，不让整轮对话失败。
 */
async function imageBlocks(ctx, refs) {
  const attachments = ctx?.get?.('attachments')
  if (typeof attachments?.saveImage !== 'function') return []
  const allowed = attachments.imageLimits?.mediaTypes
  const blocks = []
  for (const ref of refs) {
    if (!ref.image) continue
    const mediaType = mediaTypeOf(ref.image.ext)
    // DSH 声明收不了这种格式时直接跳过，别让整轮对话失败
    if (Array.isArray(allowed) && !allowed.includes(mediaType)) continue
    try {
      const attachment = await attachments.saveImage({
        data: ref.image.buffer,
        mediaType,
        name: nameOf(ref.src),
      })
      if (attachment?.attachmentId) blocks.push({ type: 'image', attachment })
    } catch {
      // 存不进附件就只发文字
    }
  }
  return blocks
}

/**
 * 界面发来的引用（选中图库里的图）：校验、去重、取字节，最后得出两份东西——
 * 给提示词用的 refs（文字说明）和真正能交给模型的 blocks（图片本身）。
 * @param {object} ctx Cordis 上下文（用来取 attachments 服务）。
 * @param {unknown} raw 请求里的 refs，元素可以是 src 字符串或 { src, label, prompt }。
 */
export async function resolveRefs(ctx, raw) {
  const rows = (Array.isArray(raw) ? raw : []).slice(0, MAX_REFS)
  const refs = []
  for (const row of rows) {
    const src = typeof row === 'string' ? row : row?.src
    if (refs.some(entry => entry.src === src)) continue
    const path = await sourcePathOf(src)
    if (!path) continue
    let image = null
    try {
      image = await readImageFile(path)
    } catch {
      image = null
    }
    refs.push({
      src,
      path,
      image,
      label: labelOf(row, refs.length),
      prompt: typeof row?.prompt === 'string' ? row.prompt.trim().slice(0, 300) : '',
    })
  }
  const blocks = await imageBlocks(ctx, refs)
  return {
    refs: refs.map(({ path, image, ...rest }) => rest),
    blocks,
  }
}

/** 提示词里的那一段：说清楚附了哪几张图，模型看图时才有对应的名字。 */
export function refsBlock(refs) {
  const rows = Array.isArray(refs) ? refs.filter(row => row?.src) : []
  if (!rows.length) return ''
  const lines = rows.map((row, index) => `第 ${index + 1} 张：${row.label}（${row.src}${row.prompt ? `，画它时用的提示词：${row.prompt}` : ''}）`)
  return `<references>用户随这条消息附了 ${rows.length} 张参考图，图片本身就在消息里：\n${lines.join('\n')}</references>`
}
