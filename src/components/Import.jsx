import { useState, useRef } from 'react';
import { X, Upload, FileText, CheckCircle } from 'lucide-react';
import { bookmarksAPI } from '../api/api';
import { parseBookmarksCSV, parseTagstashJSON } from '../utils/bookmarkImport';
import './Import.css';

// Parse a browser Netscape-style HTML bookmark export into bookmark objects.
// Walks the folder hierarchy and uses folder names as tags.
function parseBrowserBookmarksHTML(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const SKIP_FOLDERS = new Set([
    'bookmarks menu',
    'bookmarks toolbar',
    'bookmarks bar',
    'other bookmarks',
    'mobile bookmarks',
    'imported from firefox',
    'toolbar',
    'bookmarks',
    'menu',
  ]);

  const bookmarks = [];
  const anchors = doc.querySelectorAll('a[href]');

  anchors.forEach((a) => {
    const url = a.getAttribute('href');
    const title = a.textContent.trim();
    if (!url || !title) return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;

    // Walk up the DOM collecting folder names from H3s that precede sibling DLs.
    const folderNames = [];
    let el = a.parentElement;
    while (el && el.tagName !== 'BODY') {
      if (el.tagName === 'DL') {
        let prev = el.previousElementSibling;
        while (prev) {
          if (prev.tagName === 'DT') {
            const h3 = prev.querySelector('h3');
            if (h3) {
              folderNames.push(h3.textContent.trim());
              break;
            }
          }
          prev = prev.previousElementSibling;
        }
      }
      el = el.parentElement;
    }

    const tags = folderNames
      .reverse()
      .filter((f) => f && !SKIP_FOLDERS.has(f.toLowerCase()))
      .map((f) => f.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))
      .filter((t) => t.length > 0);

    // Tag-aware Netscape exports (including Tagstash) also carry TAGS and a DD description.
    // Tagstash's own export keeps the private note in a NOTE attribute (newlines as &#10;).
    const exportedTags = (a.getAttribute('tags') || '').split(',')
      .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
    const dd = a.closest('dt')?.nextElementSibling;
    const description = dd?.tagName === 'DD' ? dd.textContent.trim() || null : null;
    const noteText = a.getAttribute('note') || '';
    const bookmark = { title, url, description, tags: [...new Set([...tags, ...exportedTags])] };
    if (noteText.trim()) bookmark.note = noteText;
    bookmarks.push(bookmark);
  });

  return bookmarks;
}

function Import({ onImportComplete }) {
  const [stage, setStage] = useState('idle'); // idle | preview | importing | done
  const [parsed, setParsed] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState('raindrop');
  const fileInputRef = useRef(null);

  const isBrowserHtmlSource = source === 'firefox' || source === 'chrome';

  const handleFile = (file) => {
    if (!file) return;

    if (isBrowserHtmlSource) {
      if (!file.name.toLowerCase().endsWith('.html') && !file.name.toLowerCase().endsWith('.htm')) {
        setError('Please select an HTML bookmarks export file.');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const html = e.target.result;
        if (!html.includes('NETSCAPE-Bookmark-file')) {
          setError('This does not look like a bookmarks HTML export file. Please export bookmarks as HTML and try again.');
          return;
        }
        const bookmarks = parseBrowserBookmarksHTML(html);
        if (bookmarks.length === 0) {
          setError('No valid bookmarks found in this file.');
          return;
        }
        setError('');
        setParsed(bookmarks);
        setStage('preview');
      };
      reader.readAsText(file);
      return;
    }

    if (source === 'tagstash') {
      const name = file.name.toLowerCase();
      const isJson = name.endsWith('.json');
      if (!isJson && !name.endsWith('.csv')) {
        setError('Please select a Tagstash JSON or CSV export.');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        const bookmarks = isJson ? parseTagstashJSON(text) : parseBookmarksCSV(text);
        if (bookmarks === null) {
          setError('This file does not look like a Tagstash export. Export from Settings → Export as JSON or CSV and try again.');
          return;
        }
        if (bookmarks.length === 0) {
          setError('No valid bookmarks found in this file.');
          return;
        }
        setError('');
        setParsed(bookmarks);
        setStage('preview');
      };
      reader.readAsText(file);
      return;
    }

    if (source === 'raindrop') {
      if (!file.name.toLowerCase().endsWith('.csv')) {
        setError('Please select a CSV file.');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        const bookmarks = parseBookmarksCSV(text);
        if (bookmarks === null) {
          setError('This file does not look like a Raindrop.io CSV export. Expected columns: title, url, tags…');
          return;
        }
        if (bookmarks.length === 0) {
          setError('No valid bookmarks found in this file.');
          return;
        }
        setError('');
        setParsed(bookmarks);
        setStage('preview');
      };
      reader.readAsText(file);
      return;
    }

    setError('This import source is not available yet.');
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const handleFileInput = (e) => {
    handleFile(e.target.files[0]);
  };

  const handleImport = async () => {
    setStage('importing');
    setError('');
    try {
      const response = await bookmarksAPI.importBookmarks(parsed);
      setResult(response.data);
      setStage('done');
      if (typeof onImportComplete === 'function') {
        onImportComplete();
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed. Please try again.');
      setStage('preview');
    }
  };

  const handleReset = () => {
    setStage('idle');
    setParsed([]);
    setResult(null);
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSourceChange = (e) => {
    setSource(e.target.value);
    setError('');
    handleReset();
  };

  const PREVIEW_LIMIT = 25;

  const content = (
    <>
      <div className="import-header">
        <h2 id="import-title">
          <Upload size={18} className="import-title-icon" />
          Import Bookmarks
        </h2>
      </div>

      <div className="import-source-picker">
        <label htmlFor="import-source">Source</label>
        <select id="import-source" value={source} onChange={handleSourceChange}>
          <option value="raindrop">Raindrop.io (CSV)</option>
          <option value="tagstash">Tagstash export (JSON or CSV)</option>
          <option value="firefox">Firefox Bookmarks (HTML)</option>
          <option value="chrome">Google Chrome Bookmarks (HTML)</option>
          <option value="pinboard">Pinboard.in (coming soon)</option>
        </select>
      </div>

      {source === 'pinboard' && (
        <div className="import-upcoming">
          Pinboard.in import support is planned. For now, select Raindrop.io or Firefox Bookmarks.
        </div>
      )}

      <div role="alert" className="live-region">
        {error && (
          <div className="import-error">
            {error}
            <button type="button" onClick={() => setError('')} aria-label="Dismiss error">
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      <p role="status" className="sr-only">
        {stage === 'importing'
          ? 'Importing bookmarks…'
          : stage === 'done' && result
            ? `Import complete. ${result.imported} imported${result.skipped > 0 ? `, ${result.skipped} skipped` : ''}.`
            : ''}
      </p>

      {(source === 'raindrop' || source === 'tagstash' || source === 'firefox' || source === 'chrome') && stage === 'idle' && (
        <>
          <p className="import-hint">
            {source === 'firefox'
              ? 'Export from Firefox: Bookmarks -> Manage Bookmarks -> Import and Backup -> Export Bookmarks to HTML. Then upload the file here.'
              : source === 'chrome'
                ? 'Export from Chrome: Bookmark Manager -> Organize -> Export bookmarks. Then upload the HTML file here.'
                : source === 'tagstash'
                  ? 'Upload a JSON or CSV file from Settings → Export. Descriptions, tags and notes come back with your bookmarks. (For a Tagstash HTML export, choose Firefox or Chrome.)'
                  : 'Export your bookmarks from Raindrop.io as a CSV file, then upload it here.'}
          </p>
          <button
            type="button"
            className={`drop-zone${dragging ? ' drop-zone--active' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            aria-label={isBrowserHtmlSource ? 'Upload HTML bookmark file' : source === 'tagstash' ? 'Upload Tagstash export file' : 'Upload CSV file'}
          >
            <FileText size={36} className="drop-zone-icon" />
            <span className="drop-zone-title">
              {source === 'firefox'
                ? 'Drop your Firefox bookmarks HTML here'
                : source === 'chrome'
                  ? 'Drop your Chrome bookmarks HTML here'
                  : source === 'tagstash'
                    ? 'Drop your Tagstash JSON or CSV export here'
                    : 'Drop your Raindrop.io CSV here'}
            </span>
            <span className="drop-zone-sub">or click to browse</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={isBrowserHtmlSource ? '.html,.htm' : source === 'tagstash' ? '.json,.csv' : '.csv'}
            className="hidden-file-input"
            onChange={handleFileInput}
          />
        </>
      )}

      {stage === 'preview' && (
        <>
          <p className="import-count">
            <strong>{parsed.length}</strong> bookmark{parsed.length !== 1 ? 's' : ''} ready to import
          </p>
          <div className="import-preview-table-wrap">
            <table className="import-preview-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>URL</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {parsed.slice(0, PREVIEW_LIMIT).map((bm, i) => (
                  <tr key={i}>
                    <td className="preview-title">{bm.title}</td>
                    <td className="preview-url">
                      {/^https?:\/\//i.test(bm.url) ? (
                        <a href={bm.url} target="_blank" rel="noopener noreferrer">
                          {bm.url}
                        </a>
                      ) : bm.url}
                    </td>
                    <td className="preview-tags">
                      {bm.tags.map((t) => (
                        <span key={t} className="tag-stock">{t}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsed.length > PREVIEW_LIMIT && (
              <p className="preview-overflow">
                ...and {parsed.length - PREVIEW_LIMIT} more
              </p>
            )}
          </div>
          <p className="import-note">
            Bookmarks with duplicate URLs will be skipped automatically.
            {source === 'firefox'
              ? ' Folder names are converted to tags.'
              : ' Multi-word tags (e.g. “health insurance”) are converted to hyphenated form.'}
          </p>
          <div className="import-actions">
            <button className="btn-primary" onClick={handleImport}>
              Import {parsed.length} bookmark{parsed.length !== 1 ? 's' : ''}
            </button>
            <button className="btn-secondary" onClick={handleReset}>
              Choose different file
            </button>
          </div>
        </>
      )}

      {stage === 'importing' && (
        <div className="import-progress">
          <p>Importing bookmarks...</p>
        </div>
      )}

      {stage === 'done' && result && (
        <div className="import-done">
          <CheckCircle size={40} className="import-done-icon" />
          <h3>Import complete</h3>
          <p><strong>{result.imported}</strong> bookmark{result.imported !== 1 ? 's' : ''} imported</p>
          {result.skipped > 0 && (
            <p className="import-skipped"><strong>{result.skipped}</strong> skipped (duplicates or missing data)</p>
          )}
          {result.limitReached && (
            <p className="import-skipped">
              Free plan limit reached during import. Upgrade to paid for unlimited bookmarks.
            </p>
          )}
          <div className="import-actions">
            <button className="btn-secondary" onClick={handleReset}>Import another file</button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="import-inline" role="region" aria-labelledby="import-title">
      {content}
    </div>
  );
}

export default Import;
