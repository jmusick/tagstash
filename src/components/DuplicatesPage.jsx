import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { findDuplicateGroups, chooseDuplicateKeeper, duplicateTrashIds } from '../utils/duplicates'
import { decodeHtmlEntities } from '../utils/decodeHtmlEntities'
import { formatSavedDate } from '../utils/bookmarkDisplay'
import { linkTargetProps } from '../utils/linkTarget'
import { TRASH_RETENTION_DAYS } from '../utils/trash'
import { INPUT_LIMITS } from '../utils/inputLimits'
import { useDocumentMeta } from '../utils/useDocumentMeta'
import { BookmarkTagList } from './BookmarkParts'
import './DuplicatesPage.css'

const plural = (count) => `${count} bookmark${count === 1 ? '' : 's'}`

export default function DuplicatesPage({ bookmarks, loading, loadError, onRefresh, actions, linkTarget }) {
  useDocumentMeta({ title: 'Duplicate finder - Tagstash', path: '/duplicates', noindex: true })
  const groups = useMemo(() => findDuplicateGroups(bookmarks), [bookmarks])
  const [keepers, setKeepers] = useState({})
  const [confirmation, setConfirmation] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const noticeRef = useRef(null)
  const cancelRef = useRef(null)
  const pageRef = useRef(null)

  useEffect(() => { if (confirmation) cancelRef.current?.focus() }, [confirmation])
  useEffect(() => { if (notice) noticeRef.current?.focus() }, [notice])

  const choose = (group, id) => {
    setKeepers((previous) => ({ ...previous, [group.key]: id }))
    setConfirmation(null)
  }

  const cancel = () => {
    const key = confirmation.key
    setConfirmation(null)
    pageRef.current?.querySelector(`[data-duplicate-action="${groups.findIndex((group) => group.key === key)}"]`)?.focus()
  }

  const moveToTrash = async () => {
    if (busy || !confirmation) return
    const { key, keepId, ids } = confirmation
    const currentIds = duplicateTrashIds(groups.find((group) => group.key === key), keepId)
    // A background refresh must never silently change an already-confirmed selection.
    if (keepers[key] !== keepId || JSON.stringify(currentIds) !== JSON.stringify(ids)) {
      setConfirmation(null)
      setKeepers((previous) => ({ ...previous, [key]: null }))
      setNotice({ error: 'This group changed. Review it and choose which bookmark to keep again.' })
      return
    }
    setBusy(true)
    try {
      const data = await actions.onDelete(ids)
      setConfirmation(null)
      setNotice({
        message: `${data.trashed === false ? 'Deleted' : 'Moved'} ${plural(data.deleted)}${data.trashed === false ? '.' : ' to the trash.'}${data.skipped ? ` ${plural(data.skipped)} skipped because they were no longer available.` : ''}`,
        ids: data.trashed !== false && data.deleted > 0 ? ids : null,
      })
    } catch (error) {
      setNotice({ error: error.response?.data?.error || 'Could not move the bookmarks to the trash. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const undo = async () => {
    if (busy || !notice?.ids) return
    setBusy(true)
    try {
      const data = await actions.onUndo(notice.ids)
      setNotice({ message: `Restored ${plural(data.restored)}.${data.skipped ? ` ${plural(data.skipped)} could no longer be restored.` : ''}` })
    } catch (error) {
      setNotice((previous) => ({ ...previous, error: error.response?.data?.error || 'Could not restore the bookmarks. They are still in the trash.' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="duplicates-page" ref={pageRef}>
      <div className="duplicates-heading">
        <h1>Duplicate finder</h1>
        <button type="button" className="btn-secondary" onClick={onRefresh} disabled={busy || loading}>
          <RefreshCw size={16} aria-hidden="true" /> Refresh duplicates
        </button>
      </div>
      <p>Review bookmarks that point to the same page. Choose one to keep in each group, then move the others to the trash. Titles and tags are kept as they are.</p>
      <details className="duplicates-matching">
        <summary>How matching works</summary>
        <p>We compare URLs without http/https, a leading www., default ports, fragments or one trailing path slash. We ignore utm_* parameters, fbclid, gclid, dclid and msclkid. Other paths, ports and query strings stay distinct, including query order and repeated values. We do not follow redirects or include trashed bookmarks.</p>
      </details>

      {notice && (
        <div className="trash-notice" tabIndex={-1} ref={noticeRef}>
          {notice.message && <span role="status">{notice.message}</span>}
          {notice.ids && <button type="button" className="btn-secondary" onClick={undo} disabled={busy}>{busy ? 'Working…' : 'Undo'}</button>}
          <Link to="/trash" className="footer-privacy-link">Open trash</Link>
          {notice.error && <p className="bulk-error" role="alert">{notice.error}</p>}
        </div>
      )}

      {loading ? <p className="loading-message">Loading duplicates…</p> : loadError ? (
        <div className="empty-state" role="alert"><p>Could not load your bookmarks. Refresh to try again.</p></div>
      ) : groups.length === 0 ? (
        <div className="empty-state"><p>No duplicates found in your live bookmarks.</p><Link to="/">Back to your bookmarks</Link></div>
      ) : (
        <>
          <p className="results-count" role="status">{groups.length} duplicate group{groups.length === 1 ? '' : 's'}. Choose a bookmark to keep before moving any others.</p>
          {groups.map((group, index) => {
            const keepId = keepers[group.key]
            const ids = duplicateTrashIds(group, keepId)
            const confirming = confirmation?.key === group.key
            return (
              <section className="duplicate-group" key={group.key} aria-labelledby={`duplicate-group-${index}`}>
                <h2 id={`duplicate-group-${index}`}>{decodeHtmlEntities(group.bookmarks[0].title || '') || group.bookmarks[0].url}</h2>
                <div className="duplicates-actions">
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => choose(group, chooseDuplicateKeeper(group.bookmarks, 'newest'))}>Keep newest</button>
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => choose(group, chooseDuplicateKeeper(group.bookmarks, 'oldest'))}>Keep oldest</button>
                </div>
                <fieldset disabled={busy || confirming} className="duplicates-choices">
                  <legend>Choose one of these {plural(group.bookmarks.length)} to keep</legend>
                  {group.bookmarks.map((bookmark) => {
                    const title = decodeHtmlEntities(bookmark.title || '') || bookmark.url
                    return (
                      <div className={`duplicate-item ${keepId === bookmark.id ? 'is-kept' : ''}`} key={bookmark.id}>
                        <label className="duplicate-keep">
                          <input type="radio" name={`duplicate-keeper-${index}`} checked={keepId === bookmark.id} onChange={() => choose(group, bookmark.id)} />
                          <span>Keep <strong>{title}</strong></span>
                        </label>
                        <a className="duplicate-url" href={bookmark.url} {...linkTargetProps(linkTarget)}>{bookmark.url}</a>
                        <p className="duplicate-date">Saved {formatSavedDate(bookmark.created_at) || 'on an unknown date'}</p>
                        {bookmark.tags?.length ? <BookmarkTagList tags={bookmark.tags} /> : <p className="duplicate-date">No tags</p>}
                      </div>
                    )
                  })}
                </fieldset>
                <p className="duplicate-selection" role="status">{ids.length ? `${plural(group.bookmarks.length - 1)} to move to the trash; 1 to keep.` : 'No bookmark chosen to keep.'}</p>
                {group.bookmarks.length - 1 > INPUT_LIMITS.bulkBookmarkIds && <p>Move up to {INPUT_LIMITS.bulkBookmarkIds} at a time. Review this group again for the remaining bookmarks.</p>}
                <button type="button" className="btn-secondary bulk-btn--danger" disabled={busy || !ids.length || confirming} data-duplicate-action={index} onClick={() => setConfirmation({ key: group.key, keepId, ids })}>
                  Move {plural(ids.length)} to trash
                </button>
                {confirming && (
                  <div className="bulk-panel bulk-panel--danger" role="group" aria-labelledby={`duplicate-confirm-${index}`}>
                    <p id={`duplicate-confirm-${index}`}>Move {plural(confirmation.ids.length)} to the trash? Keep “{decodeHtmlEntities(group.bookmarks.find((bookmark) => bookmark.id === confirmation.keepId)?.title || '') || group.bookmarks.find((bookmark) => bookmark.id === confirmation.keepId)?.url}”. You can restore them for {TRASH_RETENTION_DAYS} days.</p>
                    <div className="bulk-panel-actions">
                      <button type="button" className="btn-danger" onClick={moveToTrash} disabled={busy}>{busy ? 'Moving…' : `Move ${plural(confirmation.ids.length)} to trash`}</button>
                      <button type="button" className="btn-secondary" onClick={cancel} ref={cancelRef} disabled={busy}>Cancel</button>
                    </div>
                  </div>
                )}
              </section>
            )
          })}
        </>
      )}
    </div>
  )
}
