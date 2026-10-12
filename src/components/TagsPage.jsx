import { useState, useEffect, useCallback, useMemo } from 'react'
import { GitMerge, X, AlertTriangle, ArrowRight } from 'lucide-react'
import { bookmarksAPI } from '../api/api'
import { findPluralTagPairs } from '../utils/pluralTagPairs'
import { useDocumentMeta } from '../utils/useDocumentMeta'
import TagCloud from './TagCloud'

function TagsPage() {
  useDocumentMeta({ title: 'Manage Tags - Tagstash', path: '/tags', noindex: true })

  const [tags, setTags] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [sourceTagId, setSourceTagId] = useState(null)
  const [targetTagId, setTargetTagId] = useState(null)
  const [merging, setMerging] = useState(false)
  const [pairMergingId, setPairMergingId] = useState(null)

  const fetchTags = useCallback(async () => {
    try {
      setLoading(true)
      const response = await bookmarksAPI.getAllTags()
      setTags(response.data.tags)
    } catch {
      setError('Failed to load tags')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTags()
  }, [fetchTags])

  const sourceTag = tags.find((tag) => tag.id === sourceTagId) || null
  const targetTag = tags.find((tag) => tag.id === targetTagId) || null

  const clearSelection = () => {
    setSourceTagId(null)
    setTargetTagId(null)
  }

  const handleTagSelect = (tagName) => {
    const tag = tags.find((t) => t.name === tagName)
    if (!tag) return

    setSuccess('')

    if (sourceTagId === tag.id) {
      setSourceTagId(null)
      return
    }
    if (targetTagId === tag.id) {
      setTargetTagId(null)
      return
    }
    if (!sourceTagId) {
      setSourceTagId(tag.id)
      return
    }
    if (!targetTagId) {
      setTargetTagId(tag.id)
      return
    }
    // Both slots already filled — start a new selection with this tag as the source.
    setSourceTagId(tag.id)
    setTargetTagId(null)
  }

  // Shared by the manual picker and the singular/plural report: confirm, merge, refresh.
  // Returns true when the merge went through.
  const confirmAndMerge = async (from, to) => {
    const confirmed = window.confirm(
      `Merge "${from.name}" into "${to.name}"?\n\n` +
        `All ${from.count} bookmark${from.count === 1 ? '' : 's'} tagged "${from.name}" will be re-tagged as "${to.name}", and the "${from.name}" tag will be deleted.\n\n` +
        `This cannot be undone.`
    )
    if (!confirmed) return false

    try {
      setError('')
      await bookmarksAPI.mergeTags(from.id, to.id)
      setSuccess(`Merged "${from.name}" into "${to.name}".`)
      await fetchTags()
      return true
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to merge tags')
      return false
    }
  }

  const handleMerge = async () => {
    if (!sourceTag || !targetTag) return

    setMerging(true)
    const merged = await confirmAndMerge(sourceTag, targetTag)
    if (merged) clearSelection()
    setMerging(false)
  }

  const pluralPairs = useMemo(() => findPluralTagPairs(tags), [tags])

  const handlePairMerge = async (pair, from, to) => {
    setPairMergingId(pair.plural.id)
    await confirmAndMerge(from, to)
    setPairMergingId(null)
  }

  const selectedTagNames = [sourceTag?.name, targetTag?.name].filter(Boolean)

  return (
    <div className="tags-page">
      <div role="alert" className="live-region">
        {error && (
          <div className="error-message">
            {error}
            <button onClick={() => setError('')} className="error-close" aria-label="Dismiss error">
              <X size={16} />
            </button>
          </div>
        )}
      </div>
      <div role="status" className="live-region">
        {success && <div className="tags-page-success">{success}</div>}
      </div>

      <section className="tags-page-section">
        <h2>Singular &amp; Plural Tags</h2>
        <p className="tags-page-description">
          Tags that look like the same word in singular and plural form. Pick which spelling to keep —
          the other one is merged into it and deleted.
        </p>

        {loading ? (
          <div className="loading-message">Checking tags...</div>
        ) : pluralPairs.length === 0 ? (
          <p className="tags-page-empty">No singular/plural duplicates found in your tags.</p>
        ) : (
          <ul className="tag-pair-list">
            {pluralPairs.map((pair) => {
              const busy = pairMergingId === pair.plural.id
              return (
                <li key={pair.plural.id} className="tag-pair-row">
                  <div className="tag-pair-names">
                    <span className="tag-stock tag-pair-name">
                      {pair.singular.name}
                      <span className="tag-pair-count">{pair.singular.count}</span>
                    </span>
                    <span className="tag-pair-divider" aria-hidden="true">
                      /
                    </span>
                    <span className="tag-stock tag-pair-name">
                      {pair.plural.name}
                      <span className="tag-pair-count">{pair.plural.count}</span>
                    </span>
                  </div>
                  <div className="tag-pair-actions">
                    <button
                      type="button"
                      className="btn-secondary tag-pair-btn"
                      onClick={() => handlePairMerge(pair, pair.plural, pair.singular)}
                      disabled={busy}
                    >
                      {pair.plural.name} <ArrowRight size={13} aria-hidden="true" /> {pair.singular.name}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary tag-pair-btn"
                      onClick={() => handlePairMerge(pair, pair.singular, pair.plural)}
                      disabled={busy}
                    >
                      {pair.singular.name} <ArrowRight size={13} aria-hidden="true" /> {pair.plural.name}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="tags-page-section">
        <h2>Merge Tags</h2>
        <p className="tags-page-description">
          Combine two tags into one. Click a tag below to select it as the tag to remove, then click a
          second tag to select it as the tag to keep. Every bookmark using the first tag will be
          re-tagged with the second, and the first tag will be deleted.
        </p>

        <div className="tag-merge-picker">
          <div className="tag-merge-slot">
            <span className="tag-merge-slot-label">1. Merge this tag&hellip;</span>
            {sourceTag ? (
              <span className="tag-stock tag-merge-chip tag-merge-chip-source">
                {sourceTag.name}
                <button type="button" onClick={() => setSourceTagId(null)} aria-label="Clear source tag selection">
                  <X size={13} />
                </button>
              </span>
            ) : (
              <span className="tag-merge-slot-empty">Select a tag below</span>
            )}
          </div>

          <GitMerge size={20} className="tag-merge-arrow" aria-hidden="true" />

          <div className="tag-merge-slot">
            <span className="tag-merge-slot-label">2. &hellip;into this tag</span>
            {targetTag ? (
              <span className="tag-stock tag-merge-chip tag-merge-chip-target">
                {targetTag.name}
                <button type="button" onClick={() => setTargetTagId(null)} aria-label="Clear target tag selection">
                  <X size={13} />
                </button>
              </span>
            ) : (
              <span className="tag-merge-slot-empty">
                {sourceTag ? 'Select a different tag below' : 'Select a tag below first'}
              </span>
            )}
          </div>
        </div>

        {sourceTag && targetTag && (
          <div className="tag-merge-preview">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              {sourceTag.count} bookmark{sourceTag.count === 1 ? '' : 's'} will move from{' '}
              <strong>{sourceTag.name}</strong> to <strong>{targetTag.name}</strong>, and{' '}
              <strong>{sourceTag.name}</strong> will be deleted. This cannot be undone.
            </span>
          </div>
        )}

        <div className="tag-merge-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={handleMerge}
            disabled={!sourceTag || !targetTag || merging}
          >
            {merging ? 'Merging...' : 'Merge Tags'}
          </button>
          {(sourceTag || targetTag) && (
            <button type="button" className="btn-secondary" onClick={clearSelection} disabled={merging}>
              Clear Selection
            </button>
          )}
        </div>

        {loading ? (
          <div className="loading-message">Loading tags...</div>
        ) : (
          <TagCloud
            tags={tags}
            selectedTags={selectedTagNames}
            onTagSelect={handleTagSelect}
            showActions={false}
          />
        )}
      </section>
    </div>
  )
}

export default TagsPage
