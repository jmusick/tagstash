import { useMemo } from 'react'
import { renderNoteMarkdown } from '../utils/noteMarkdown'

// Lazy-loaded by BookmarkNote, so the Markdown parser is only fetched once a note is opened.
export default function NoteMarkdown({ text, linkProps }) {
  const content = useMemo(() => renderNoteMarkdown(text, { linkProps }), [text, linkProps])
  return <div className="note-markdown">{content}</div>
}
