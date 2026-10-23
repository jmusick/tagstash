import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ExternalLink, Download, Tags, Trash2 } from 'lucide-react'
import { INPUT_LIMITS } from '../utils/inputLimits'
import { BULK_OPEN_CONFIRM_THRESHOLD, BULK_OPEN_MAX, getOpenableUrls, openUrlsInTabs } from '../utils/bulkOpen'
import { handleToolbarArrowKeys } from '../utils/toolbarKeys'
import { TRASH_RETENTION_DAYS } from '../utils/trash'

const EXPORT_FORMATS = ['html', 'csv', 'json']

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

// Comma-separated tag input, normalized like the server does (trim, lowercase, no spaces).
function parseTagInput(raw) {
  const names = []
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase()
    if (!name) continue
    if (/\s/.test(name)) return { error: `Tag "${name}" must be a single word with no spaces` }
    if (name.length > INPUT_LIMITS.tagName) return { error: `Tags must be ${INPUT_LIMITS.tagName} characters or less` }
    if (!names.includes(name)) names.push(name)
  }
  if (names.length > INPUT_LIMITS.tagsPerBookmark) {
    return { error: `You can add at most ${INPUT_LIMITS.tagsPerBookmark} tags at once` }
  }
  return { names }
}

const errorText = (err, fallback) => err?.response?.data?.error || fallback

// The owner's multi-select toolbar and its inline panels (tags, export, open, delete). It only
// renders while select mode is on. BookmarkBrowser owns the selection; this component owns the
// panel state and runs the actions it is handed. Buttons are native; the toolbar adds arrow-key
// movement (Left/Right/Home/End) on top of normal Tab order.
export default function BulkBar({
  selected,
  pageCount,
  matchingCount,
  note,
  onSelectPage,
  onSelectAll,
  onClear,
  onDone,
  actions,
}) {
  const count = selected.length
  const [panel, setPanel] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  // Ids moved to the trash by the last delete, while "Undo" is still offered.
  const [undoIds, setUndoIds] = useState(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const [undoError, setUndoError] = useState('')
  const [addInput, setAddInput] = useState('')
  const [removeNames, setRemoveNames] = useState([])
  const [blockedUrls, setBlockedUrls] = useState([])
  const toolbarRef = useRef(null)
  const panelRef = useRef(null)

  const selectionTags = useMemo(() => {
    const counts = new Map()
    for (const bookmark of selected) {
      for (const tag of bookmark.tags || []) {
        if (tag?.name) counts.set(tag.name, (counts.get(tag.name) || 0) + 1)
      }
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [selected])

  const focusAction = (name) => {
    // Wait a tick: the trigger may have been disabled while the panel was open.
    setTimeout(() => toolbarRef.current?.querySelector(`[data-bulk-action="${name}"]:not(:disabled)`)?.focus(), 0)
  }

  const openPanel = (name) => {
    setError('')
    setPanel(panel === name ? null : name)
  }

  const closePanel = (returnTo) => {
    setPanel(null)
    setError('')
    setAddInput('')
    setRemoveNames([])
    if (returnTo) focusAction(returnTo)
  }

  // Move focus into a panel as it opens: its first field if it has one, else the panel itself.
  useEffect(() => {
    if (!panel) return
    const target = panelRef.current?.querySelector('[data-autofocus]') || panelRef.current
    target?.focus()
  }, [panel])

  // A panel about "the selection" has nothing to act on once the selection is empty.
  useEffect(() => {
    if (count === 0 && panel && panel !== 'blocked') setPanel(null)
  }, [count, panel])

  const handleToolbarKeyDown = (event) => handleToolbarArrowKeys(event, toolbarRef.current)

  // Every outcome message goes through here; only a delete offers Undo, and the next outcome
  // replaces it.
  const showResult = (text, undo = null) => {
    setResult(text)
    setUndoIds(undo)
    setUndoError('')
  }

  const handleTagsSubmit = async (event) => {
    event.preventDefault()
    const parsed = parseTagInput(addInput)
    if (parsed.error) return setError(parsed.error)
    if (parsed.names.length === 0 && removeNames.length === 0) {
      return setError('Type a tag to add or tick a tag to remove.')
    }
    if (parsed.names.some((name) => removeNames.includes(name))) {
      return setError('A tag cannot be added and removed at the same time.')
    }
    setBusy(true)
    setError('')
    try {
      const data = await actions.onTags(selected.map((bookmark) => bookmark.id), { add: parsed.names, remove: removeNames })
      const notes = []
      if (data.overLimit > 0) {
        notes.push(`${plural(data.overLimit, 'bookmark')} already at the ${INPUT_LIMITS.tagsPerBookmark}-tag limit ${data.overLimit === 1 ? 'was' : 'were'} left alone.`)
      }
      if (data.skipped > 0) notes.push(`${plural(data.skipped, 'bookmark')} could not be found.`)
      showResult([`Updated tags on ${plural(data.matched - data.overLimit, 'bookmark')}.`, ...notes].join(' '))
      closePanel('tags')
    } catch (err) {
      setError(errorText(err, 'Could not update tags. Nothing was changed.'))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    setBusy(true)
    setError('')
    try {
      const ids = selected.map((bookmark) => bookmark.id)
      const data = await actions.onDelete(ids)
      // Moved to the trash (Undo restores them); `trashed: false` only before the trash migration.
      if (data.trashed === false) showResult(`Deleted ${plural(data.deleted, 'bookmark')}.`)
      else showResult(`Moved ${plural(data.deleted, 'bookmark')} to the trash.`, data.deleted > 0 ? ids : null)
      closePanel()
      // The delete button is disabled now that nothing is selected; keep focus inside the toolbar.
      setTimeout(() => toolbarRef.current?.querySelector('button:not(:disabled)')?.focus(), 0)
    } catch (err) {
      setError(errorText(err, 'Could not move the bookmarks to the trash. Nothing was deleted.'))
    } finally {
      setBusy(false)
    }
  }

  const handleUndo = async () => {
    setUndoBusy(true)
    setUndoError('')
    try {
      const data = await actions.onUndo(undoIds)
      showResult(`Restored ${plural(data.restored, 'bookmark')}.`)
    } catch (err) {
      setUndoError(errorText(err, 'Could not restore the bookmarks. They are still in the trash.'))
    } finally {
      setUndoBusy(false)
    }
  }

  const handleExport = (format) => {
    setError('')
    try {
      const exported = actions.onExport(selected, format)
      showResult(`Downloaded ${plural(exported, 'bookmark')} as ${format.toUpperCase()}.`)
      closePanel('export')
    } catch {
      setError('Could not create the export file.')
    }
  }

  // Runs synchronously inside the click that triggered it (no await before window.open):
  // browsers only allow pop-ups from a user gesture.
  const runOpen = (urls, skipped) => {
    const { opened, blocked } = openUrlsInTabs(urls)
    const parts = [`Opened ${plural(opened, 'tab')}.`]
    if (skipped > 0) parts.push(`${plural(skipped, 'bookmark')} skipped because ${skipped === 1 ? 'it is' : 'they are'} not web links.`)
    if (blocked.length > 0) {
      parts.push(`Your browser blocked ${blocked.length} of them.`)
      setBlockedUrls(blocked)
      showResult(parts.join(' '))
      setPanel('blocked')
    } else {
      showResult(parts.join(' '))
      closePanel('open')
    }
  }

  const handleOpen = () => {
    setError('')
    const { urls, skipped } = getOpenableUrls(selected)
    if (urls.length === 0) {
      setPanel(null)
      showResult('None of the selected bookmarks are web links, so nothing was opened.')
      return
    }
    if (urls.length > BULK_OPEN_MAX) {
      setPanel('open-limit')
      return
    }
    if (urls.length > BULK_OPEN_CONFIRM_THRESHOLD) {
      setPanel('open-confirm')
      return
    }
    runOpen(urls, skipped)
  }

  const openable = panel === 'open-confirm' ? getOpenableUrls(selected) : null

  return (
    <div className="bulk-bar">
      <p className="bulk-count" role="status" aria-live="polite" aria-atomic="true">
        <strong>{count}</strong> selected{note ? `. ${note}` : ''}
      </p>

      <div
        className="bulk-toolbar"
        role="toolbar"
        aria-label="Bulk actions for selected bookmarks"
        ref={toolbarRef}
        onKeyDown={handleToolbarKeyDown}
      >
        <button type="button" className="btn-secondary bulk-btn" onClick={onSelectPage} disabled={busy || pageCount === 0}>
          Select this page ({pageCount})
        </button>
        {matchingCount > pageCount && (
          <button type="button" className="btn-secondary bulk-btn" onClick={onSelectAll} disabled={busy}>
            Select all {matchingCount} results
          </button>
        )}
        <button type="button" className="btn-secondary bulk-btn" onClick={onClear} disabled={busy || count === 0}>
          Clear selection
        </button>
        <span className="bulk-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className="btn-secondary bulk-btn"
          data-bulk-action="tags"
          aria-expanded={panel === 'tags'}
          onClick={() => openPanel('tags')}
          disabled={busy || count === 0}
        >
          <Tags size={15} aria-hidden="true" /> Tags
        </button>
        <button
          type="button"
          className="btn-secondary bulk-btn"
          data-bulk-action="open"
          aria-expanded={panel === 'open-confirm' || panel === 'open-limit' || panel === 'blocked'}
          onClick={handleOpen}
          disabled={busy || count === 0}
        >
          <ExternalLink size={15} aria-hidden="true" /> Open in tabs
        </button>
        <button
          type="button"
          className="btn-secondary bulk-btn"
          data-bulk-action="export"
          aria-expanded={panel === 'export'}
          onClick={() => openPanel('export')}
          disabled={busy || count === 0}
        >
          <Download size={15} aria-hidden="true" /> Export
        </button>
        <button
          type="button"
          className="btn-secondary bulk-btn bulk-btn--danger"
          data-bulk-action="delete"
          aria-expanded={panel === 'delete'}
          onClick={() => openPanel('delete')}
          disabled={busy || count === 0}
        >
          <Trash2 size={15} aria-hidden="true" /> Delete
        </button>
        <span className="bulk-toolbar-divider" aria-hidden="true" />
        <button type="button" className="btn-ghost bulk-done" onClick={onDone} disabled={busy}>
          Done
        </button>
      </div>

      <div className="bulk-result-row">
        <p className="bulk-result" role="status">{result}</p>
        {undoIds && (
          <button type="button" className="btn-secondary bulk-btn" onClick={handleUndo} disabled={undoBusy}>
            {undoBusy ? 'Restoring...' : 'Undo'}
          </button>
        )}
      </div>
      {undoError && <p className="bulk-error" role="alert">{undoError}</p>}

      {panel === 'tags' && (
        <div className="bulk-panel" role="group" aria-labelledby="bulk-tags-title" ref={panelRef} tabIndex={-1}>
          <p className="bulk-panel-title" id="bulk-tags-title">Change tags on {plural(count, 'bookmark')}</p>
          <form onSubmit={handleTagsSubmit}>
            <div className="form-group">
              <label htmlFor="bulk-add-tags">Add tags</label>
              <input
                id="bulk-add-tags"
                type="text"
                value={addInput}
                onChange={(event) => setAddInput(event.target.value)}
                aria-describedby="bulk-add-tags-hint"
                autoComplete="off"
                data-autofocus
              />
              <p className="bulk-hint" id="bulk-add-tags-hint">Separate tags with commas. Each tag is a single word.</p>
            </div>
            <fieldset className="bulk-remove-tags">
              <legend>Remove tags</legend>
              {selectionTags.length === 0 ? (
                <p className="bulk-hint">The selected bookmarks have no tags to remove.</p>
              ) : (
                <ul className="bulk-tag-options">
                  {selectionTags.map(([name, tagCount]) => (
                    <li key={name}>
                      <label>
                        <input
                          type="checkbox"
                          checked={removeNames.includes(name)}
                          onChange={(event) => setRemoveNames((prev) => (
                            event.target.checked ? [...prev, name] : prev.filter((entry) => entry !== name)
                          ))}
                        />
                        <span>{name} <span className="bulk-tag-count">({tagCount} of {count})</span></span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
            {error && <p className="bulk-error" role="alert">{error}</p>}
            <div className="bulk-panel-actions">
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? 'Saving...' : `Apply to ${plural(count, 'bookmark')}`}
              </button>
              <button type="button" className="btn-secondary" onClick={() => closePanel('tags')} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {panel === 'export' && (
        <div className="bulk-panel" role="group" aria-labelledby="bulk-export-title" ref={panelRef} tabIndex={-1}>
          <p className="bulk-panel-title" id="bulk-export-title">Export {plural(count, 'selected bookmark')}</p>
          <p className="bulk-hint">Same files as Settings → Export, with only the selected bookmarks. Private bookmarks are included.</p>
          <div className="bulk-panel-actions">
            {EXPORT_FORMATS.map((format, index) => (
              <button
                key={format}
                type="button"
                className="btn-secondary"
                onClick={() => handleExport(format)}
                {...(index === 0 ? { 'data-autofocus': true } : {})}
              >
                Download {format.toUpperCase()}
              </button>
            ))}
            <button type="button" className="btn-ghost" onClick={() => closePanel('export')}>Cancel</button>
          </div>
          {error && <p className="bulk-error" role="alert">{error}</p>}
        </div>
      )}

      {panel === 'open-limit' && (
        <div className="bulk-panel" role="group" aria-labelledby="bulk-open-limit-title" ref={panelRef} tabIndex={-1}>
          <p className="bulk-panel-title" id="bulk-open-limit-title">Too many tabs to open at once</p>
          <p className="bulk-hint">
            You can open up to {BULK_OPEN_MAX} bookmarks at a time, and {getOpenableUrls(selected).urls.length} of
            the selected bookmarks are web links. Select fewer bookmarks and try again.
          </p>
          <div className="bulk-panel-actions">
            <button type="button" className="btn-secondary" onClick={() => closePanel('open')} data-autofocus>OK</button>
          </div>
        </div>
      )}

      {panel === 'open-confirm' && openable && (
        <div className="bulk-panel" role="group" aria-labelledby="bulk-open-title" ref={panelRef} tabIndex={-1}>
          <p className="bulk-panel-title" id="bulk-open-title">Open {plural(openable.urls.length, 'tab')}?</p>
          <p className="bulk-hint">
            Your browser may block some of them as pop-ups.
            {openable.skipped > 0 && ` ${plural(openable.skipped, 'selected bookmark')} will be skipped because ${openable.skipped === 1 ? 'it is' : 'they are'} not web links.`}
          </p>
          <div className="bulk-panel-actions">
            <button type="button" className="btn-primary" onClick={() => runOpen(openable.urls, openable.skipped)} data-autofocus>
              Open {plural(openable.urls.length, 'tab')}
            </button>
            <button type="button" className="btn-secondary" onClick={() => closePanel('open')}>Cancel</button>
          </div>
        </div>
      )}

      {panel === 'blocked' && (
        <div className="bulk-panel" role="group" aria-labelledby="bulk-blocked-title" ref={panelRef} tabIndex={-1}>
          <p className="bulk-panel-title" id="bulk-blocked-title">{plural(blockedUrls.length, 'tab')} blocked by your browser</p>
          <p className="bulk-hint">
            Allow pop-ups for this site to open many tabs at once, or open the rest from this list.
          </p>
          <ul className="bulk-blocked-list">
            {blockedUrls.map((url) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
              </li>
            ))}
          </ul>
          <div className="bulk-panel-actions">
            <button type="button" className="btn-secondary" onClick={() => { setBlockedUrls([]); closePanel('open') }} data-autofocus>
              Close
            </button>
          </div>
        </div>
      )}

      {panel === 'delete' && (
        <div className="bulk-panel bulk-panel--danger" role="group" aria-labelledby="bulk-delete-text" ref={panelRef} tabIndex={-1}>
          <p id="bulk-delete-text" className="bulk-delete-text">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              Move <strong>{plural(count, 'bookmark')}</strong> to the trash? You can restore {count === 1 ? 'it' : 'them'} from
              Trash for {TRASH_RETENTION_DAYS} days, then {count === 1 ? 'it is' : 'they are'} deleted for good.
            </span>
          </p>
          {error && <p className="bulk-error" role="alert">{error}</p>}
          <div className="bulk-panel-actions">
            <button type="button" className="btn-danger" onClick={handleDelete} disabled={busy}>
              {busy ? 'Moving...' : `Move ${plural(count, 'bookmark')} to trash`}
            </button>
            <button type="button" className="btn-secondary" onClick={() => closePanel('delete')} disabled={busy} data-autofocus>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
