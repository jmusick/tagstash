import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { bookmarksAPI } from '../api/api'
import { INPUT_LIMITS } from '../utils/inputLimits'

// Mounted only for an open form, keyed by account, route and bookmark in App.
export default function TagRecommendations({ input, draftKey, validationError, paid, onAccept }) {
  const disclosureId = useId()
  const actionRef = useRef(null)
  const active = useRef(null)
  const [result, setResult] = useState(null)
  const signature = JSON.stringify([input, draftKey, paid])
  const [previousSignature, setPreviousSignature] = useState(signature)
  if (previousSignature !== signature) {
    setPreviousSignature(signature)
    setResult(null)
  }
  useLayoutEffect(() => {
    active.current = null
    return () => { active.current = null }
  }, [signature])
  const current = result?.signature === signature ? result : null
  const full = input.selectedTags.length >= INPUT_LIMITS.tagsPerBookmark

  async function request() {
    if (!paid || active.current || current?.done || full) return
    if (validationError || !input.url) {
      setResult({ signature, message: validationError || 'Enter a bookmark URL first.' })
      return
    }
    const token = {}
    active.current = token
    setResult({ signature, pending: true, message: 'Finding tag suggestions…' })
    try {
      const { data } = await bookmarksAPI.suggestTags(input)
      if (active.current !== token) return
      const selected = new Set(input.selectedTags.map(name => name.toLowerCase()))
      const suggestions = (Array.isArray(data.suggestions) ? data.suggestions : [])
        .filter(name => {
          if (typeof name !== 'string' || !name || /\s/.test(name)
            || name.length > INPUT_LIMITS.tagName || selected.has(name.toLowerCase())) return false
          selected.add(name.toLowerCase())
          return true
        }).slice(0, 5)
      setResult({ signature, done: true, suggestions, message: suggestions.length
        ? 'Choose a suggestion to add it. Your bookmark is not saved yet.'
        : 'No matching tags found. You can still add tags yourself.' })
    } catch (error) {
      if (active.current !== token) return
      const status = error.response?.status
      const message = status === 429 ? 'Too many suggestions requested. Wait a while, then try again.'
        : status === 503 ? 'AI tag suggestions are unavailable right now. Try again later.'
          : status === 403 ? 'AI tag suggestions require an active Pro plan.'
            : 'Could not suggest tags. Please try again.'
      setResult({ signature, message })
    } finally {
      if (active.current === token) active.current = null
    }
  }

  return (
    <div className="tag-recommendations">
      {paid ? <button ref={actionRef} type="button" className="btn-field-action"
        aria-describedby={disclosureId} aria-disabled={!!current?.pending || !!current?.done || full}
        onClick={request}>Suggest tags</button>
        : <p>AI tag suggestions are a Pro feature. <Link to="/settings?tab=billing">Upgrade to Pro</Link></p>}
      <small id={disclosureId}>When you click Suggest tags, bookmark URL, title, description and candidate tags from your library (including private bookmarks) are processed by Cloudflare AI. Notes are excluded. Nothing is made public.</small>
      <p role="status">{full ? `A bookmark can have at most ${INPUT_LIMITS.tagsPerBookmark} tags.` : current?.message}</p>
      {!!current?.suggestions?.length && <div className="tag-recommendation-list" role="group" aria-label="Suggested tags">
        {current.suggestions.map(name => <button key={name} type="button" className="tag-stock"
          aria-label={`Add suggested tag ${name}`} onClick={() => {
            if (full) return
            onAccept(name)
            actionRef.current?.focus()
          }}>{name}</button>)}
      </div>}
    </div>
  )
}
