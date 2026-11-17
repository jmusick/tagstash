import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Info, LoaderCircle, Plus, Sparkles } from 'lucide-react'
import { bookmarksAPI } from '../api/api'
import { INPUT_LIMITS } from '../utils/inputLimits'

// Mounted only for an open form, keyed by account, route and bookmark in App.
export default function TagRecommendations({ input, draftKey, validationError, paid, onAccept }) {
  const disclosureId = useId()
  const actionRef = useRef(null)
  const listRef = useRef(null)
  const focusAfterAccept = useRef(null)
  const active = useRef(null)
  const [result, setResult] = useState(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const signature = JSON.stringify([input, draftKey, paid])
  // Any change drops a pending or failed request. A finished result survives tag edits
  // (accepting a suggestion is one), so the rest stay without another call; it is
  // dropped only when the URL, title, description or plan changes.
  const { selectedTags, ...bookmarkInput } = input
  const context = JSON.stringify([bookmarkInput, paid])
  const [previousSignature, setPreviousSignature] = useState(signature)
  if (previousSignature !== signature) {
    setPreviousSignature(signature)
    if (result && (result.context !== context || !result.done)) setResult(null)
  }
  useLayoutEffect(() => {
    active.current = null
    return () => { active.current = null }
  }, [signature])
  const current = result?.context === context ? result : null
  const full = selectedTags.length >= INPUT_LIMITS.tagsPerBookmark
  const selected = new Set(selectedTags.map(name => name.toLowerCase()))
  const visible = full ? [] : (current?.suggestions || []).filter(name => !selected.has(name.toLowerCase()))
  // A finished result blocks repeating the identical request, and blocks a new one
  // while unused suggestions are still on screen.
  const settled = !!current?.done && (current.signature === signature || visible.length > 0)
  const unavailable = !!current?.pending || settled || full

  useLayoutEffect(() => {
    if (!focusAfterAccept.current) return
    const name = focusAfterAccept.current
    focusAfterAccept.current = null
    const next = name === true ? null
      : [...(listRef.current?.querySelectorAll('button') || [])].find(button => button.dataset.tag === name)
    ;(next || actionRef.current)?.focus()
  })

  async function request() {
    if (!paid || active.current || unavailable) return
    if (validationError || !input.url) {
      setResult({ signature, context, message: validationError || 'Enter a bookmark URL first.' })
      return
    }
    const token = {}
    active.current = token
    setResult({ signature, context, pending: true, message: 'Finding tag suggestions…' })
    try {
      const { data } = await bookmarksAPI.suggestTags(input)
      if (active.current !== token) return
      const seen = new Set(selected)
      const suggestions = (Array.isArray(data.suggestions) ? data.suggestions : [])
        .filter(name => {
          if (typeof name !== 'string' || !name || /\s/.test(name)
            || name.length > INPUT_LIMITS.tagName || seen.has(name.toLowerCase())) return false
          seen.add(name.toLowerCase())
          return true
        }).slice(0, 5)
      setResult({ signature, context, done: true, suggestions, message: suggestions.length
        ? 'Choose a suggestion to add it. Your bookmark is not saved yet.'
        : 'No matching tags found. You can still add tags yourself.' })
    } catch (error) {
      if (active.current !== token) return
      const status = error.response?.status
      const message = status === 429 ? 'Too many suggestions requested. Wait a while, then try again.'
        : status === 503 ? 'AI tag suggestions are unavailable right now. Try again later.'
          : status === 403 ? 'AI tag suggestions require an active Pro plan.'
            : 'Could not suggest tags. Please try again.'
      setResult({ signature, context, message })
    } finally {
      if (active.current === token) active.current = null
    }
  }

  function accept(name, index) {
    if (full) return
    // Keep keyboard focus in the list: the neighbor that slides into this place.
    focusAfterAccept.current = visible[index + 1] || visible[index - 1] || true
    onAccept(name)
  }

  const message = full ? `A bookmark can have at most ${INPUT_LIMITS.tagsPerBookmark} tags.`
    : current?.done && current.suggestions.length && !visible.length
      ? 'All suggestions added. Your bookmark is not saved yet.'
      : current?.message

  return (
    <div className="tag-recommendations">
      <div className="tag-recommendations-row">
        <span className="tag-suggest-group">
          {paid ? <button ref={actionRef} type="button" className="btn-field-action tag-suggest-button"
            aria-describedby={disclosureId} aria-disabled={unavailable} onClick={request}>
            {current?.pending
              ? <LoaderCircle size={14} className="tag-suggest-spinner" aria-hidden="true" />
              : <Sparkles size={14} aria-hidden="true" />}
            <span>Suggest tags</span>
          </button>
            : <p className="tag-recommendations-upsell">AI tag suggestions are a Pro feature. <Link to="/settings?tab=billing">Upgrade to Pro</Link></p>}
          <button type="button" className="tag-recommendations-about" aria-label="About AI tag suggestions"
            aria-expanded={aboutOpen} aria-controls={disclosureId} onClick={() => setAboutOpen(open => !open)}>
            <Info size={15} aria-hidden="true" />
          </button>
        </span>
        <p role="status" className={visible.length ? 'sr-only' : 'tag-recommendations-status'}>{message}</p>
        {!!visible.length && <div ref={listRef} className="tag-recommendation-list" role="group" aria-label="Suggested tags">
          {visible.map((name, index) => <button key={name} type="button" data-tag={name}
            className="tag-stock tag-suggestion" aria-label={`Add suggested tag ${name}`}
            onClick={() => accept(name, index)}>
            <Plus size={12} strokeWidth={2.75} aria-hidden="true" />{name}
          </button>)}
        </div>}
      </div>
      <small id={disclosureId} className="tag-recommendations-about-text" hidden={!aboutOpen}>When you click Suggest tags, bookmark URL, title, description and candidate tags from your library (including private bookmarks) are processed by Cloudflare AI. Notes are excluded. Nothing is made public.</small>
    </div>
  )
}
