import { useState } from 'react'
import { bookmarksAPI } from '../api/api'
import { downloadBookmarks } from '../utils/downloadBookmarks'

export default function Export() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function download(format) {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const response = await bookmarksAPI.getAll()
      const bookmarks = response.data.bookmarks
      if (!Array.isArray(bookmarks)) throw new Error('Invalid bookmark response')
      downloadBookmarks(bookmarks, format)
      setMessage(`Downloaded ${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}.`)
    } catch {
      setError('Could not export your bookmarks. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="export-heading">
      <h2 id="export-heading">Export your bookmarks</h2>
      <p>Download your entire library, including private bookmarks. Choose HTML for browsers, CSV for spreadsheets, or JSON to preserve dates, tags, favorites, and privacy settings.</p>
      <div className="export-actions">
        {['html', 'csv', 'json'].map((format) => (
          <button key={format} type="button" className="btn btn-secondary" disabled={busy} onClick={() => download(format)}>
            Download {format.toUpperCase()}
          </button>
        ))}
      </div>
      <p role="status">{busy ? 'Preparing download…' : message}</p>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
