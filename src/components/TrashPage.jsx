import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-react'
import { bookmarksAPI, billingAPI } from '../api/api'
import { useDocumentMeta } from '../utils/useDocumentMeta'
import { decodeHtmlEntities } from '../utils/decodeHtmlEntities'
import { displayUrl, formatSavedDate } from '../utils/bookmarkDisplay'
import { INPUT_LIMITS } from '../utils/inputLimits'
import { TRASH_RETENTION_DAYS, daysLeftInTrash, describeDaysLeft } from '../utils/trash'
import { BookmarkTagList } from './BookmarkParts'
import TrashBar from './TrashBar'
import './TrashPage.css'

const PAGE_SIZE = 50

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
const errorText = (err, fallback) => err?.response?.data?.error || fallback

// The owner's trash (/trash): bookmarks deleted in the last TRASH_RETENTION_DAYS days, each with
// its deletion date and days left. A page of its own, in the same app shell as /tags and
// /settings (App.jsx supplies the header/footer), reusing the library's card and toolbar
// styling. `onLibraryChange` lets App refresh its bookmark list and tag cloud after a restore.
export default function TrashPage({ onLibraryChange }) {
  useDocumentMeta({ title: 'Trash - Tagstash', path: '/trash', noindex: true })

  const [items, setItems] = useState([])
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [selectionNote, setSelectionNote] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [status, setStatus] = useState('')
  const [problem, setProblem] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirmingId, setConfirmingId] = useState(null)
  const [upgrading, setUpgrading] = useState(false)
  const statusRef = useRef(null)
  const problemRef = useRef(null)

  const load = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true)
      const response = await bookmarksAPI.getTrash()
      setItems(response.data.bookmarks || [])
      setAvailable(response.data.available !== false)
      setLoadError('')
    } catch {
      setLoadError('Failed to load the trash.')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Only what is still in the trash counts as selected (a refresh can drop items from it).
  const selected = useMemo(() => items.filter((item) => selectedIds.has(item.id)), [items, selectedIds])
  const shown = items.slice(0, visibleCount)

  const toggleSelected = (id) => {
    setSelectionNote('')
    if (!selectedIds.has(id) && selectedIds.size >= INPUT_LIMITS.bulkBookmarkIds) {
      setSelectionNote(`You can select up to ${INPUT_LIMITS.bulkBookmarkIds} bookmarks at once.`)
      return
    }
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectItems = (list) => {
    const next = new Set(selectedIds)
    let capped = false
    for (const item of list) {
      if (next.has(item.id)) continue
      if (next.size >= INPUT_LIMITS.bulkBookmarkIds) {
        capped = true
        break
      }
      next.add(item.id)
    }
    setSelectedIds(next)
    setSelectionNote(capped ? `Selection limited to ${INPUT_LIMITS.bulkBookmarkIds} bookmarks, the most you can change at once.` : '')
  }

  const clearSelection = () => {
    setSelectedIds(new Set())
    setSelectionNote('')
  }

  // Outcomes are announced (role=status / role=alert) and focus moves to them: the item that had
  // focus is usually gone by then.
  const focusMessage = () => setTimeout(() => (problemRef.current || statusRef.current)?.focus(), 0)

  const reportSuccess = (text) => {
    setProblem(null)
    setStatus(text)
    focusMessage()
  }

  const reportFailure = (err, fallback) => {
    setStatus('')
    setProblem({ text: errorText(err, fallback), limitReached: Boolean(err?.response?.data?.limitReached) })
    focusMessage()
  }

  // Runs one action: busy while it runs, then refreshes the list (and tells App to refresh the
  // library when `changesLibrary`).
  const run = async (action, { changesLibrary = false } = {}) => {
    setBusy(true)
    setConfirmingId(null)
    try {
      await action()
      await load({ silent: true })
      if (changesLibrary) await onLibraryChange?.()
    } finally {
      setBusy(false)
    }
  }

  const restoreSelected = () => run(async () => {
    try {
      const { data } = await bookmarksAPI.bulkRestore(selected.map((item) => item.id))
      clearSelection()
      reportSuccess(
        `Restored ${plural(data.restored, 'bookmark')}.${data.skipped > 0 ? ` ${plural(data.skipped, 'bookmark')} could not be found.` : ''}`
      )
    } catch (err) {
      reportFailure(err, 'Could not restore the bookmarks. They are still in the trash.')
    }
  }, { changesLibrary: true })

  const restoreOne = (item) => run(async () => {
    try {
      await bookmarksAPI.restore(item.id)
      setSelectedIds((previous) => {
        const next = new Set(previous)
        next.delete(item.id)
        return next
      })
      reportSuccess(`Restored “${decodeHtmlEntities(item.title || item.url)}”.`)
    } catch (err) {
      reportFailure(err, 'Could not restore the bookmark. It is still in the trash.')
    }
  }, { changesLibrary: true })

  const purgeSelected = () => run(async () => {
    try {
      const { data } = await bookmarksAPI.bulkPurge(selected.map((item) => item.id))
      clearSelection()
      reportSuccess(`Deleted ${plural(data.deleted, 'bookmark')} forever.`)
    } catch (err) {
      reportFailure(err, 'Could not delete the bookmarks. Nothing was deleted.')
    }
  })

  const purgeOne = (item) => run(async () => {
    try {
      await bookmarksAPI.deleteForever(item.id)
      setSelectedIds((previous) => {
        const next = new Set(previous)
        next.delete(item.id)
        return next
      })
      reportSuccess(`Deleted “${decodeHtmlEntities(item.title || item.url)}” forever.`)
    } catch (err) {
      reportFailure(err, 'Could not delete the bookmark. It is still in the trash.')
    }
  })

  const emptyAll = () => run(async () => {
    try {
      const { data } = await bookmarksAPI.emptyTrash()
      clearSelection()
      reportSuccess(`Emptied the trash. ${plural(data.deleted, 'bookmark')} deleted forever.`)
    } catch (err) {
      reportFailure(err, 'Could not empty the trash. Nothing was deleted.')
    }
  })

  const startUpgrade = async (plan) => {
    try {
      setUpgrading(true)
      const response = await billingAPI.createCheckoutSession(plan)
      const checkoutUrl = response?.data?.url
      if (!checkoutUrl) throw new Error('Missing checkout URL')
      window.location.assign(checkoutUrl)
    } catch (err) {
      reportFailure(err, 'Failed to start checkout. Please try again.')
      setUpgrading(false)
    }
  }

  const cancelConfirm = (id) => {
    setConfirmingId(null)
    setTimeout(() => document.getElementById(`trash-forever-${id}`)?.focus(), 0)
  }

  return (
    <div className="trash-page">
      <h1 className="trash-title">Trash</h1>
      <p className="trash-intro">
        Deleted bookmarks wait here for {TRASH_RETENTION_DAYS} days, then they are deleted for good. Restoring one puts it back in your
        library with its tags. Bookmarks in the trash don&rsquo;t count toward the free plan&rsquo;s limit, but restoring them does.
      </p>

      <p className="trash-status" role="status" tabIndex={-1} ref={statusRef}>{status}</p>
      <div role="alert" className="live-region">
        {problem && (
          <div className="error-message trash-problem" tabIndex={-1} ref={problemRef}>
            <p>{problem.text}</p>
            {problem.limitReached && (
              <div className="trash-upgrade">
                <button type="button" className="btn-primary" onClick={() => startUpgrade('monthly')} disabled={upgrading}>
                  {upgrading ? 'Opening checkout...' : 'Upgrade (Monthly)'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => startUpgrade('annual')} disabled={upgrading}>
                  Upgrade (Annual)
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="loading-message">Loading the trash…</div>
      ) : loadError ? (
        <div className="empty-state" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn-secondary" onClick={() => load()}>Try again</button>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <p>
            {available
              ? `The trash is empty. Bookmarks you delete wait here for ${TRASH_RETENTION_DAYS} days before they are removed for good.`
              : 'The trash is not available yet, so deleted bookmarks are removed right away. Please try again later.'}
          </p>
          <Link className="btn-secondary trash-back" to="/">Back to your bookmarks</Link>
        </div>
      ) : (
        <>
          <TrashBar
            selectedCount={selected.length}
            total={items.length}
            pageCount={shown.length}
            matchingCount={items.length}
            note={selectionNote}
            busy={busy}
            onSelectPage={() => selectItems(shown)}
            onSelectAll={() => selectItems(items)}
            onClear={clearSelection}
            onRestore={restoreSelected}
            onPurge={purgeSelected}
            onEmpty={emptyAll}
          />
          <h2 className="sr-only">Deleted bookmarks</h2>
          <p className="results-count" aria-live="polite">{plural(items.length, 'bookmark')} in the trash</p>
          <div className="bookmarks-grid">
            {shown.map((item) => {
              const title = decodeHtmlEntities(item.title || '') || item.url
              const description = decodeHtmlEntities(item.description || '')
              const daysLeft = daysLeftInTrash(item.deleted_at)
              const isSelected = selectedIds.has(item.id)
              return (
                <article
                  key={item.id}
                  className={`bookmark-card is-selectable trash-card ${isSelected ? 'is-selected' : ''}`}
                  id={`trash-${item.id}`}
                >
                  <div className="bookmark-header">
                    <input
                      type="checkbox"
                      className="bookmark-select"
                      checked={isSelected}
                      onChange={() => toggleSelected(item.id)}
                      aria-label={`Select ${title}`}
                    />
                    <span className="favicon-slot" aria-hidden="true">
                      {item.favicon_url && (
                        <img src={item.favicon_url} alt="" className="favicon" onError={(e) => { e.target.style.visibility = 'hidden' }} />
                      )}
                    </span>
                    <h3 className="bookmark-title">{title}</h3>
                    <div className="bookmark-actions trash-actions">
                      <button
                        type="button"
                        className="btn-ghost trash-action"
                        onClick={() => restoreOne(item)}
                        disabled={busy}
                        aria-label={`Restore ${title}`}
                      >
                        <RotateCcw size={14} aria-hidden="true" /> <span>Restore</span>
                      </button>
                      <button
                        type="button"
                        id={`trash-forever-${item.id}`}
                        className="btn-ghost trash-action trash-action--danger"
                        onClick={() => setConfirmingId(item.id)}
                        disabled={busy}
                        aria-expanded={confirmingId === item.id}
                        aria-label={`Delete ${title} forever`}
                      >
                        <Trash2 size={14} aria-hidden="true" /> <span>Delete forever</span>
                      </button>
                    </div>
                  </div>
                  <div className="bookmark-meta">
                    <span className="bookmark-url">{displayUrl(item.url)}</span>
                    <span className="bookmark-date trash-expiry">
                      Deleted {formatSavedDate(item.deleted_at)} · <strong>{describeDaysLeft(daysLeft)}</strong>
                    </span>
                  </div>
                  {description && <p className="bookmark-description">{description}</p>}
                  <BookmarkTagList tags={item.tags} />
                  {confirmingId === item.id && (
                    <TrashCardConfirm
                      title={title}
                      busy={busy}
                      onConfirm={() => purgeOne(item)}
                      onCancel={() => cancelConfirm(item.id)}
                    />
                  )}
                </article>
              )
            })}
          </div>
          {items.length > shown.length && (
            <div className="trash-more">
              <button type="button" className="btn-secondary" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                Show more ({items.length - shown.length} more)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function TrashCardConfirm({ title, busy, onConfirm, onCancel }) {
  const cancelRef = useRef(null)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  return (
    <div className="bulk-panel bulk-panel--danger trash-card-confirm" role="group" aria-labelledby="trash-card-confirm-text">
      <p id="trash-card-confirm-text" className="bulk-delete-text">
        <AlertTriangle size={16} aria-hidden="true" />
        <span>Permanently delete <strong>{title}</strong>? This cannot be undone.</span>
      </p>
      <div className="bulk-panel-actions">
        <button type="button" className="btn-danger" onClick={onConfirm} disabled={busy}>
          {busy ? 'Deleting...' : 'Delete forever'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy} ref={cancelRef}>
          Cancel
        </button>
      </div>
    </div>
  )
}
