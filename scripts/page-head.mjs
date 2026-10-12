// Rewrites the per-page head tags of the built SPA shell (dist/index.html) so each
// prerendered public page ships its own title, description, canonical and social
// tags in the raw HTML. Mirrors what useDocumentMeta sets client-side.
const escapeHtml = (value) =>
  value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

export function applyPageHead(html, { title, description, path }, origin = 'https://tagsta.sh') {
  const safeTitle = escapeHtml(title)
  const safeDescription = escapeHtml(description)
  const canonical = `${origin}${path}`
  const replaced = html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${safeTitle}</title>`)
    .replace(/(<meta (?:name="description"|property="og:description"|name="twitter:description") content=")[^"]*("\s*\/?>)/g, (_, open, close) => `${open}${safeDescription}${close}`)
    .replace(/(<meta (?:property="og:title"|name="twitter:title") content=")[^"]*("\s*\/?>)/g, (_, open, close) => `${open}${safeTitle}${close}`)
    .replace(/(<link rel="canonical" href=")[^"]*("\s*\/?>)/, (_, open, close) => `${open}${canonical}${close}`)
    .replace(/(<meta property="og:url" content=")[^"]*("\s*\/?>)/, (_, open, close) => `${open}${canonical}${close}`)
  if (!replaced.includes(`<link rel="canonical" href="${canonical}"`) || !replaced.includes(`<title>${safeTitle}</title>`)) {
    throw new Error(`Could not rewrite the head of the SPA shell for ${path}`)
  }
  return replaced
}
