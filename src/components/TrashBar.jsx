import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-react'
import { handleToolbarArrowKeys } from '../utils/toolbarKeys'

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

// The Trash view's multi-select toolbar: the same pattern as the library's BulkBar (a
// role="toolbar" with arrow-key movement on top of Tab order, a live selected count, inline
// panels instead of window.confirm that state the exact count and focus Cancel). TrashPage owns
// the selection, the list and every outcome message; this component owns the open panel and runs
// the actions it is handed. Restoring needs no confirmation (it is the safe direction); deleting
// forever and emptying the trash do.
export default function TrashBar({
  selectedCount,
  total,
  pageCount,
  matchingCount,
  note,
  busy,
  onSelectPage,
  onSelectAll,
  onClear,
  onRestore,
  onPurge,
  onEmpty,
}) {
  const [panel, setPanel] = useState(null)
  const toolbarRef = useRef(null)
  const panelRef = useRef(null)

  const focusAction = (name) => {
    // Wait a tick: the trigger may have been disabled while the panel was open.
    setTimeout(() => toolbarRef.current?.querySelector(`[data-trash-action="${name}"]:not(:disabled)`)?.focus(), 0)
  }

  const closePanel = (returnTo) => {
    setPanel(null)
    if (returnTo) focusAction(returnTo)
  }

  // Move focus into a panel as it opens: its Cancel button (the safe choice).
  useEffect(() => {
    if (!panel) return
    const target = panelRef.current?.querySelector('[data-autofocus]') || panelRef.current
    target?.focus()
  }, [panel])

  // Deleting "the selection" has nothing to act on once the selection is empty; the trash can
  // also be emptied from under an open "empty" panel (e.g. in another tab, then refreshed).
  useEffect(() => {
    if (panel === 'purge' && selectedCount === 0) setPanel(null)
    if (panel === 'empty' && total === 0) setPanel(null)
  }, [selectedCount, total, panel])

  const confirm = async (action) => {
    // The page reports the outcome (and moves focus to it); the panel closes either way.
    setPanel(null)
    await action()
  }

  return (
    <div className="bulk-bar trash-bar">
      <p className="bulk-count" role="status" aria-live="polite" aria-atomic="true">
        <strong>{selectedCount}</strong> selected{note ? `. ${note}` : ''}
      </p>

      <div
        className="bulk-toolbar"
        role="toolbar"
        aria-label="Actions for selected bookmarks in the trash"
        ref={toolbarRef}
        onKeyDown={(event) => handleToolbarArrowKeys(event, toolbarRef.current)}
      >
        <button type="button" className="btn-secondary bulk-btn" onClick={onSelectPage} disabled={busy || pageCount === 0}>
          Select shown ({pageCount})
        </button>
        {matchingCount > pageCount && (
          <button type="button" className="btn-secondary bulk-btn" onClick={onSelectAll} disabled={busy}>
            Select all {matchingCount}
          </button>
        )}
        <button type="button" className="btn-secondary bulk-btn" onClick={onClear} disabled={busy || selectedCount === 0}>
          Clear selection
        </button>
        <span className="bulk-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className="btn-secondary bulk-btn"
          data-trash-action="restore"
          onClick={onRestore}
          disabled={busy || selectedCount === 0}
        >
          <RotateCcw size={15} aria-hidden="true" /> Restore
        </button>
        <button
          type="button"
          className="btn-secondary bulk-btn bulk-btn--danger"
          data-trash-action="purge"
          aria-expanded={panel === 'purge'}
          onClick={() => setPanel(panel === 'purge' ? null : 'purge')}
          disabled={busy || selectedCount === 0}
        >
          <Trash2 size={15} aria-hidden="true" /> Delete forever
        </button>
        <span className="bulk-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className="btn-secondary bulk-btn bulk-btn--danger"
          data-trash-action="empty"
          aria-expanded={panel === 'empty'}
          onClick={() => setPanel(panel === 'empty' ? null : 'empty')}
          disabled={busy || total === 0}
        >
          Empty trash
        </button>
      </div>

      {panel === 'purge' && (
        <div className="bulk-panel bulk-panel--danger" role="group" aria-labelledby="trash-purge-text" ref={panelRef} tabIndex={-1}>
          <p id="trash-purge-text" className="bulk-delete-text">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              Permanently delete <strong>{plural(selectedCount, 'bookmark')}</strong>? This cannot be undone.
            </span>
          </p>
          <div className="bulk-panel-actions">
            <button type="button" className="btn-danger" onClick={() => confirm(onPurge)} disabled={busy}>
              {busy ? 'Deleting...' : `Delete ${plural(selectedCount, 'bookmark')} forever`}
            </button>
            <button type="button" className="btn-secondary" onClick={() => closePanel('purge')} disabled={busy} data-autofocus>
              Cancel
            </button>
          </div>
        </div>
      )}

      {panel === 'empty' && (
        <div className="bulk-panel bulk-panel--danger" role="group" aria-labelledby="trash-empty-text" ref={panelRef} tabIndex={-1}>
          <p id="trash-empty-text" className="bulk-delete-text">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>
              Permanently delete everything in the trash, <strong>{plural(total, 'bookmark')}</strong>? This cannot be undone.
            </span>
          </p>
          <div className="bulk-panel-actions">
            <button type="button" className="btn-danger" onClick={() => confirm(onEmpty)} disabled={busy}>
              {busy ? 'Deleting...' : `Empty trash (${plural(total, 'bookmark')})`}
            </button>
            <button type="button" className="btn-secondary" onClick={() => closePanel('empty')} disabled={busy} data-autofocus>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
