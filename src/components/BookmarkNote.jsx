import { useState, lazy, Suspense } from 'react'
import { StickyNote, ChevronDown } from 'lucide-react'

const NoteMarkdown = lazy(() => import('./NoteMarkdown'))

// The owner's private note on a bookmark card (issue #60). Collapsed by default so a long note
// never stretches the card; "Show note" renders it as Markdown (see src/utils/noteMarkdown.js for
// the safety rules). Only App.jsx's owner card renders this: notes never reach public profiles.
export default function BookmarkNote({ bookmarkId, note, linkProps }) {
  const [open, setOpen] = useState(false)
  if (typeof note !== 'string' || !note.trim()) return null
  const bodyId = `bookmark-note-${bookmarkId}`

  return (
    <div className={`bookmark-note ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="bookmark-note-toggle"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <StickyNote size={14} aria-hidden="true" />
        <span>{open ? 'Hide note' : 'Show note'}</span>
        <ChevronDown size={14} aria-hidden="true" className="bookmark-note-chevron" />
      </button>
      {open && (
        <div id={bodyId} className="bookmark-note-body">
          <Suspense fallback={<p className="bookmark-note-loading">Loading note…</p>}>
            <NoteMarkdown text={note} linkProps={linkProps} />
          </Suspense>
        </div>
      )}
    </div>
  )
}
