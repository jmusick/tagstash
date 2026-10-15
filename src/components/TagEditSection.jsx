import { useState, useEffect, useRef } from 'react'
import { X, AlertTriangle } from 'lucide-react'
import { bookmarksAPI } from '../api/api'
import { INPUT_LIMITS } from '../utils/inputLimits'
import TagCloud from './TagCloud'

const bookmarkCount = (count) => `${count} bookmark${count === 1 ? '' : 's'}`

// Mirrors the server's tag-name rules (trimmed, lowercased, one word, length limit) so the
// rename form can explain problems and spot a merge before anything is sent.
const checkTagName = (raw) => {
  const name = raw.trim().toLowerCase()
  if (!name) return { name, error: '' }
  if (/\s/.test(name)) return { name, error: 'Tag names must be a single word with no spaces.' }
  if (name.length > INPUT_LIMITS.tagName) {
    return { name, error: `Tag names must be ${INPUT_LIMITS.tagName} characters or less.` }
  }
  return { name, error: '' }
}

// Rename or delete one tag across the user's bookmarks (Tags page). Renaming onto a name the
// user already has merges the two; that and a delete both ask for confirmation inline first.
// `onDone(message)` refreshes the page's tags; `onError(message)` shows the page's error banner.
function TagEditSection({ tags, loading, onDone, onError }) {
  const [tagId, setTagId] = useState(null)
  const [newName, setNewName] = useState('')
  const [pending, setPending] = useState(null) // null | 'merge' | 'delete'
  const [busy, setBusy] = useState(false)
  const headingRef = useRef(null)
  const confirmRef = useRef(null)
  const renameButtonRef = useRef(null)
  const deleteButtonRef = useRef(null)

  const tag = tags.find((t) => t.id === tagId) || null
  const check = checkTagName(newName)
  const unchanged = Boolean(tag) && check.name === tag.name
  const mergeTarget = tag && check.name && !check.error
    ? tags.find((t) => t.name === check.name && t.id !== tag.id) || null
    : null
  const canRename = Boolean(tag) && Boolean(check.name) && !check.error && !unchanged && !busy
  const hint = check.error || (unchanged ? 'That is already the name of this tag.' : '')

  useEffect(() => {
    if (pending) confirmRef.current?.focus()
  }, [pending])

  const reset = () => {
    setTagId(null)
    setNewName('')
    setPending(null)
  }

  const handleTagSelect = (tagName) => {
    const picked = tags.find((t) => t.name === tagName)
    if (!picked || picked.id === tagId) {
      reset()
      return
    }
    setTagId(picked.id)
    setNewName(picked.name)
    setPending(null)
  }

  const cancelPending = () => {
    const returnTo = pending === 'delete' ? deleteButtonRef : renameButtonRef
    setPending(null)
    // The trigger was disabled while the confirmation was open; focus it once it is enabled again.
    setTimeout(() => returnTo.current?.focus(), 0)
  }

  const finish = async (message) => {
    reset()
    await onDone(message)
    headingRef.current?.focus()
  }

  const fail = (err, fallback) => {
    setPending(null)
    onError(err.response?.data?.error || fallback)
  }

  const rename = async () => {
    setBusy(true)
    try {
      const response = await bookmarksAPI.renameTag(tag.id, check.name)
      await finish(
        response.data.merged
          ? `Merged "${tag.name}" into "${check.name}".`
          : `Renamed "${tag.name}" to "${check.name}" on ${bookmarkCount(tag.count)}.`
      )
    } catch (err) {
      fail(err, 'Failed to rename tag')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      const response = await bookmarksAPI.deleteTag(tag.id)
      const removedFrom = response.data.removedFrom ?? tag.count
      await finish(`Deleted "${tag.name}" from ${bookmarkCount(removedFrom)}.`)
    } catch (err) {
      fail(err, 'Failed to delete tag')
    } finally {
      setBusy(false)
    }
  }

  const handleRenameSubmit = (event) => {
    event.preventDefault()
    if (!canRename || pending) return
    if (mergeTarget) {
      setPending('merge')
      return
    }
    rename()
  }

  let confirmButtonLabel = ''
  if (pending === 'delete') confirmButtonLabel = busy ? 'Deleting...' : `Delete "${tag?.name}"`
  if (pending === 'merge') confirmButtonLabel = busy ? 'Merging...' : `Merge into "${mergeTarget?.name}"`

  return (
    <section className="tags-page-section" aria-labelledby="tag-edit-heading">
      <h2 id="tag-edit-heading" ref={headingRef} tabIndex={-1}>
        Rename or Delete a Tag
      </h2>
      <p className="tags-page-description">
        Click a tag below to rename it or remove it from every bookmark that uses it. The bookmarks
        themselves are kept, and only your own bookmarks change.
      </p>

      <div className="tag-edit-panel">
        {!tag ? (
          <span className="tag-merge-slot-empty">Select a tag below</span>
        ) : (
          <>
            <div className="tag-edit-current">
              <span className="tag-merge-slot-label">Selected tag</span>
              <span className="tag-edit-current-row">
                <span className="tag-stock tag-merge-chip">
                  {tag.name}
                  <button type="button" onClick={reset} aria-label="Clear selected tag" disabled={busy}>
                    <X size={13} />
                  </button>
                </span>
                <span className="tag-edit-count">Used on {bookmarkCount(tag.count)}</span>
              </span>
            </div>

            <form className="tag-edit-form" onSubmit={handleRenameSubmit} noValidate>
              <div className="form-group tag-edit-field">
                <label htmlFor="tag-rename-input">New name</label>
                <input
                  id="tag-rename-input"
                  type="text"
                  value={newName}
                  onChange={(e) => {
                    setNewName(e.target.value)
                    setPending(null)
                  }}
                  maxLength={INPUT_LIMITS.tagName}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={check.error ? true : undefined}
                  aria-describedby="tag-rename-hint"
                  disabled={busy}
                />
                <small
                  id="tag-rename-hint"
                  className={check.error ? 'tag-edit-hint tag-edit-hint--error' : 'tag-edit-hint'}
                >
                  {hint || 'One word, no spaces. Tags are saved in lowercase.'}
                </small>
              </div>

              {mergeTarget && (
                <div className="tag-merge-preview">
                  <AlertTriangle size={16} aria-hidden="true" />
                  <span>
                    You already have a tag named <strong>{mergeTarget.name}</strong> (
                    {bookmarkCount(mergeTarget.count)}). Renaming merges <strong>{tag.name}</strong> into it:
                    its {bookmarkCount(tag.count)} will be tagged <strong>{mergeTarget.name}</strong> (no
                    bookmark gets it twice) and <strong>{tag.name}</strong> will be deleted.
                  </span>
                </div>
              )}

              <div className="tag-merge-actions tag-edit-actions">
                <button
                  type="submit"
                  ref={renameButtonRef}
                  className="btn-primary"
                  disabled={!canRename || Boolean(pending)}
                >
                  {busy && pending !== 'delete' ? 'Renaming...' : mergeTarget ? 'Rename and Merge' : 'Rename Tag'}
                </button>
                <button
                  type="button"
                  ref={deleteButtonRef}
                  className="btn-danger"
                  onClick={() => setPending('delete')}
                  disabled={busy || Boolean(pending)}
                >
                  Delete Tag
                </button>
              </div>
            </form>

            {pending && (
              <div
                className="tag-edit-confirm"
                role="group"
                aria-labelledby="tag-edit-confirm-text"
                ref={confirmRef}
                tabIndex={-1}
              >
                <p id="tag-edit-confirm-text">
                  <AlertTriangle size={16} aria-hidden="true" />
                  {pending === 'delete' ? (
                    <span>
                      Delete <strong>{tag.name}</strong>? It will be removed from {tag.count} of your
                      bookmarks. The bookmarks are kept. This cannot be undone.
                    </span>
                  ) : (
                    <span>
                      Merge <strong>{tag.name}</strong> into <strong>{mergeTarget?.name}</strong>? All{' '}
                      {bookmarkCount(tag.count)} tagged <strong>{tag.name}</strong> will be tagged{' '}
                      <strong>{mergeTarget?.name}</strong> instead. This cannot be undone.
                    </span>
                  )}
                </p>
                <div className="tag-merge-actions tag-edit-actions">
                  <button
                    type="button"
                    className={pending === 'delete' ? 'btn-danger' : 'btn-primary'}
                    onClick={pending === 'delete' ? remove : rename}
                    disabled={busy}
                  >
                    {confirmButtonLabel}
                  </button>
                  <button type="button" className="btn-secondary" onClick={cancelPending} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {loading ? (
        <div className="loading-message">Loading tags...</div>
      ) : (
        <TagCloud
          tags={tags}
          selectedTags={tag ? [tag.name.toLowerCase()] : []}
          onTagSelect={handleTagSelect}
          showActions={false}
        />
      )}
    </section>
  )
}

export default TagEditSection
