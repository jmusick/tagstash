import { createElement, Fragment } from 'react'
import { compiler } from 'markdown-to-jsx/react'

// Renders a bookmark note (owner-written Markdown) to React elements. No HTML string is ever
// produced or parsed, so nothing goes through innerHTML. On top of markdown-to-jsx's own parsing
// (raw HTML disabled), every element it asks for passes through safeElement, an allowlist:
// - only the tags below; anything else (raw HTML, footnote wrappers…) renders its children only;
// - no attribute survives except our own className, an ordered list's `start`, and a link's href;
// - links only for http(s): and mailto:, always rel="noopener noreferrer ugc nofollow"; any other
//   URL (javascript:, data:, relative, #anchors) renders as its text;
// - images never load (the CSP blocks third-party images, and a remote image in a note would be a
//   tracking pixel): they render as a link to the image, or as their alt text;
// - headings become styled paragraphs so a note can't add to the page's heading outline;
// - task-list checkboxes become text, never form controls;
// - no style attributes at all (the site's CSP is style-src 'self'; table alignment is dropped).

const NOTE_LINK_REL = 'noopener noreferrer ugc nofollow'

const SAME_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub',
])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const TAG_ALIASES = { b: 'strong', i: 'em', strike: 'del' }

export const isSafeNoteHref = (value) => {
  if (typeof value !== 'string') return false
  const href = value.trim()
  if (/^mailto:/i.test(href)) return href.length > 'mailto:'.length
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const childrenOf = (children) => (children.length ? children : [undefined])

// markdown-to-jsx's `createElement` hook (not a component).
function safeElement(linkProps) {
  return function createSafeElement(tag, props, ...children) {
    const key = props?.key
    if (typeof tag !== 'string') {
      // Not expected with no overrides configured; never render a component the parser chose.
      return createElement(Fragment, { key }, ...childrenOf(children))
    }
    const name = TAG_ALIASES[tag.toLowerCase()] || tag.toLowerCase()

    if (SAME_TAGS.has(name)) {
      const safeProps = { key }
      if (name === 'ol' && Number.isSafeInteger(Number(props?.start)) && Number(props.start) !== 1) {
        safeProps.start = Number(props.start)
      }
      if (name === 'pre') safeProps.className = 'note-code-block'
      return createElement(name, safeProps, ...childrenOf(children))
    }

    if (HEADING_TAGS.has(name)) {
      return createElement('p', { key, className: 'note-heading' }, ...childrenOf(children))
    }

    if (name === 'a') {
      if (!isSafeNoteHref(props?.href)) return createElement(Fragment, { key }, ...childrenOf(children))
      return createElement('a', { key, ...linkProps, href: props.href.trim(), rel: NOTE_LINK_REL }, ...childrenOf(children))
    }

    if (name === 'img') {
      const alt = typeof props?.alt === 'string' ? props.alt.trim() : ''
      if (isSafeNoteHref(props?.src) && !/^mailto:/i.test(props.src.trim())) {
        return createElement('a', { key, ...linkProps, href: props.src.trim(), rel: NOTE_LINK_REL }, alt ? `Image: ${alt}` : 'Image')
      }
      return alt ? createElement(Fragment, { key }, `[${alt}]`) : null
    }

    if (name === 'input') {
      // GFM task list item: "[x] done" / "[ ] to do" as text, not a control without a label.
      return createElement(Fragment, { key }, props?.checked ? '[x] ' : '[ ] ')
    }

    // div/span wrappers, footnotes and anything unexpected: keep the text, drop the element.
    return createElement(Fragment, { key }, ...childrenOf(children))
  }
}

// `linkProps` are the viewer's link-opening props (linkTargetProps); `rel` is always replaced.
export function renderNoteMarkdown(text, { linkProps = {} } = {}) {
  const openProps = { ...linkProps }
  delete openProps.rel
  return compiler(String(text ?? ''), {
    createElement: safeElement(openProps),
    disableParsingRawHTML: true,
    disableFrontmatter: true,
    forceBlock: true,
    wrapper: Fragment,
    forceWrapper: true,
  })
}
