import { useState, useRef } from 'react';
import { X, Upload, FileText, CheckCircle } from 'lucide-react';
import { bookmarksAPI } from '../api/api';
import {
  parseBookmarksCSV,
  parseTagstashJSON,
  parseBookmarksHTML,
  parsePocketCSV,
  parsePinboardJSON,
  parseInstapaperCSV,
} from '../utils/bookmarkImport';
import './Import.css';

const HTML_ERROR = 'This does not look like a bookmarks HTML export file. Please export bookmarks as HTML and try again.';
const HTML_PARSERS = { '.html': parseBookmarksHTML, '.htm': parseBookmarksHTML };
// Shared by the browser sources (Firefox, Chrome, Safari).
const BROWSER_HTML = {
  accept: ['.html', '.htm'],
  typeError: 'Please select an HTML bookmarks export file.',
  parsers: HTML_PARSERS,
  mismatch: HTML_ERROR,
  folders: true,
};

// Everything that differs per source: accepted file types, instructions, and the parser for each
// type (returns null when the file isn't from that source). The file extension picks the parser.
const SOURCES = {
  raindrop: {
    label: 'Raindrop.io (CSV)',
    accept: ['.csv'],
    typeError: 'Please select a CSV file.',
    hint: 'Export your bookmarks from Raindrop.io as a CSV file, then upload it here.',
    drop: 'Drop your Raindrop.io CSV here',
    parsers: { '.csv': parseBookmarksCSV },
    mismatch: 'This file does not look like a Raindrop.io CSV export. Expected columns: title, url, tags…',
  },
  tagstash: {
    label: 'Tagstash export (JSON or CSV)',
    accept: ['.json', '.csv'],
    typeError: 'Please select a Tagstash JSON or CSV export.',
    hint: 'Upload a JSON or CSV file from Settings → Export. Descriptions, tags and notes come back with your bookmarks. (For a Tagstash HTML export, choose Firefox or Chrome.)',
    drop: 'Drop your Tagstash JSON or CSV export here',
    parsers: { '.json': parseTagstashJSON, '.csv': parseBookmarksCSV },
    mismatch: 'This file does not look like a Tagstash export. Export from Settings → Export as JSON or CSV and try again.',
  },
  firefox: {
    ...BROWSER_HTML,
    label: 'Firefox Bookmarks (HTML)',
    hint: 'Export from Firefox: Bookmarks -> Manage Bookmarks -> Import and Backup -> Export Bookmarks to HTML. Then upload the file here.',
    drop: 'Drop your Firefox bookmarks HTML here',
  },
  chrome: {
    ...BROWSER_HTML,
    label: 'Google Chrome Bookmarks (HTML)',
    hint: 'Export from Chrome: Bookmark Manager -> Organize -> Export bookmarks. Then upload the HTML file here.',
    drop: 'Drop your Chrome bookmarks HTML here',
  },
  safari: {
    ...BROWSER_HTML,
    label: 'Safari Bookmarks (HTML)',
    hint: 'Export from Safari: File -> Export -> Bookmarks. Then upload the HTML file here.',
    drop: 'Drop your Safari bookmarks HTML here',
  },
  pocket: {
    label: 'Pocket (CSV or HTML)',
    accept: ['.csv', '.html', '.htm'],
    typeError: 'Please select a Pocket export: a CSV file or the ril_export.html file.',
    hint: 'Pocket shut down in 2025, so this is for an export file you already have: the CSV (title, url, time_added, tags, status) or the older ril_export.html. Upload it here.',
    drop: 'Drop your Pocket CSV or HTML export here',
    parsers: { '.csv': parsePocketCSV, ...HTML_PARSERS },
    mismatch: 'This file does not look like a Pocket export. Expected a CSV with columns title, url, time_added, tags, status, or the ril_export.html file.',
  },
  pinboard: {
    label: 'Pinboard.in (JSON)',
    accept: ['.json'],
    typeError: 'Please select a Pinboard JSON export.',
    hint: 'Export from Pinboard: Settings -> Backup -> JSON. Then upload the .json file here.',
    drop: 'Drop your Pinboard JSON export here',
    parsers: { '.json': parsePinboardJSON },
    mismatch: 'This file does not look like a Pinboard JSON export. Expected a list of bookmarks with href, description and tags.',
  },
  instapaper: {
    label: 'Instapaper (CSV)',
    accept: ['.csv'],
    typeError: 'Please select an Instapaper CSV export.',
    hint: 'Export from Instapaper: Settings -> Export -> Download .csv file. Then upload it here. Your own folders become tags.',
    drop: 'Drop your Instapaper CSV here',
    parsers: { '.csv': parseInstapaperCSV },
    mismatch: 'This file does not look like an Instapaper CSV export. Expected columns: URL, Title, Selection, Folder, Timestamp…',
  },
};

function Import({ onImportComplete }) {
  const [stage, setStage] = useState('idle'); // idle | preview | importing | done
  const [parsed, setParsed] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState('raindrop');
  const fileInputRef = useRef(null);

  const config = SOURCES[source];

  const handleFile = (file) => {
    if (!file) return;

    const name = file.name.toLowerCase();
    const extension = config.accept.find((ext) => name.endsWith(ext));
    if (!extension) {
      setError(config.typeError);
      return;
    }
    const parse = config.parsers[extension];
    const reader = new FileReader();
    reader.onload = (e) => {
      const bookmarks = parse(e.target.result);
      if (bookmarks === null) {
        setError(config.mismatch);
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
          {Object.entries(SOURCES).map(([id, { label }]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </div>

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

      {stage === 'idle' && (
        <>
          <p className="import-hint">{config.hint}</p>
          <button
            type="button"
            className={`drop-zone${dragging ? ' drop-zone--active' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            aria-label={`Upload ${config.label.replace(/ \(.*\)$/, '').replace(/ export$/, '')} export file`}
          >
            <FileText size={36} className="drop-zone-icon" />
            <span className="drop-zone-title">{config.drop}</span>
            <span className="drop-zone-sub">or click to browse</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={config.accept.join(',')}
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
            {config.folders
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
