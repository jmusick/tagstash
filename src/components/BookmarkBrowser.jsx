import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { Star, Search, X, ChevronLeft, ChevronRight } from 'lucide-react'
import TagCloud from './TagCloud'
import { decodeHtmlEntities } from '../utils/decodeHtmlEntities'
import { DEFAULT_LINK_TARGET, linkTargetProps } from '../utils/linkTarget'
import { BookmarkTagList } from './BookmarkParts'
import { displayUrl, formatSavedDate } from '../utils/bookmarkDisplay'
import { hasNoTags, countUntagged, getBookmarkDomain, countDomains, getCreatedMonth, countCreatedMonths, formatCreatedMonth } from '../utils/bookmarkFilters'

// Honor the OS "reduce motion" setting for script-driven scrolling; CSS
// scroll-behavior is already neutralised in index.css, but an explicit
// behavior: 'smooth' passed to scrollIntoView bypasses that.
const prefersReducedMotion = () => (
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
)

function DefaultCard({ bookmark, linkTarget, selectedTags, onTagSelect }) {
  const displayTitle = decodeHtmlEntities(bookmark.title || '')
  const displayDescription = decodeHtmlEntities(bookmark.description || '')

  return (
    <article className="bookmark-card">
      <div className="bookmark-header">
        <span className="favicon-slot" aria-hidden="true">
          {bookmark.favicon_url && (
            <img src={bookmark.favicon_url} alt="" className="favicon" onError={(e) => { e.target.style.visibility = 'hidden' }} />
          )}
        </span>
        <h3 className="bookmark-title">
          <a href={bookmark.url} {...linkTargetProps(linkTarget)}>{displayTitle}</a>
        </h3>
      </div>
      <div className="bookmark-meta">
        <span className="bookmark-url">{displayUrl(bookmark.url)}</span>
        <span className="bookmark-date">{formatSavedDate(bookmark.created_at)}</span>
      </div>
      {displayDescription && (
        <p className="bookmark-description">{displayDescription}</p>
      )}
      <BookmarkTagList tags={bookmark.tags} selectedTags={selectedTags} onTagSelect={onTagSelect} />
    </article>
  )
}

function BookmarkBrowser({
  bookmarks,
  loading = false,
  linkTarget = DEFAULT_LINK_TARGET,
  tags,
  tagsRefreshKey = 0,
  onTagFavoriteToggle,
  showFavoritesFilter = true,
  showUntaggedFilter = false,
  showDomainFilter = false,
  showDateFilter = false,
  toolbarExtra,
  renderCard,
  emptyStateMessage = 'No bookmarks yet. Add your first one to get started!',
  initialSelectedTags,
  onSelectedTagsChange,
  focusBookmarkId,
  onClearFocus,
  children,
}) {
  const [searchTerm, setSearchTerm] = useState('')
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
  const [showUntaggedOnly, setShowUntaggedOnly] = useState(false)
  const [selectedTags, setSelectedTags] = useState(() => initialSelectedTags || [])
  const [sortBy, setSortBy] = useState('date')
  const [sortDirection, setSortDirection] = useState('desc')
  const [itemsPerPage, setItemsPerPage] = useState(20)
  const [currentPage, setCurrentPage] = useState(1)
  const [domainFilter, setDomainFilter] = useState(null)
  const [monthFilter, setMonthFilter] = useState('')
  const [pageAnnouncement, setPageAnnouncement] = useState('')
  const resultsHeadingRef = useRef(null)

  useEffect(() => {
    onSelectedTagsChange?.(selectedTags)
    // Only fire when the selection itself changes, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTags])

  const sortedBookmarks = useMemo(() => {
    const items = [...bookmarks]

    switch (sortBy) {
      case 'lastUpdated':
        items.sort((a, b) => {
          const aDate = new Date(a.updated_at || a.created_at || 0)
          const bDate = new Date(b.updated_at || b.created_at || 0)
          return bDate - aDate
        })
        break
      case 'alpha':
        items.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
        break
      case 'url':
        items.sort((a, b) => a.url.localeCompare(b.url, undefined, { sensitivity: 'base' }))
        break
      case 'date':
      default:
        items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        break
    }

    if (sortDirection === 'asc') {
      items.reverse()
    }

    return items
  }, [bookmarks, sortBy, sortDirection])

  // Ignore the toggle's state if the filter isn't offered, so it can never filter invisibly.
  const untaggedActive = showUntaggedFilter && showUntaggedOnly
  const untaggedCount = useMemo(() => countUntagged(bookmarks), [bookmarks])
  const domainActive = showDomainFilter ? domainFilter : null
  const monthActive = showDateFilter ? monthFilter : ''
  const domains = useMemo(() => [...countDomains(bookmarks)].sort(([a], [b]) => a.localeCompare(b)), [bookmarks])
  const months = useMemo(() => countCreatedMonths(bookmarks), [bookmarks])

  const filteredBookmarks = useMemo(() => {
    if (focusBookmarkId) {
      return sortedBookmarks.filter((bookmark) => bookmark.id === focusBookmarkId)
    }

    const query = searchTerm.trim().toLowerCase()
    return sortedBookmarks.filter((bookmark) => {
      const tagsText = Array.isArray(bookmark.tags)
        ? bookmark.tags.map((tag) => tag.name).join(' ')
        : ''

      const searchable = [
        decodeHtmlEntities(bookmark.title || ''),
        bookmark.url || '',
        decodeHtmlEntities(bookmark.description || ''),
        tagsText,
      ]
        .join(' ')
        .toLowerCase()

      const matchesSearch = !query || searchable.includes(query)

      const bookmarkTagNames = Array.isArray(bookmark.tags)
        ? bookmark.tags.map((tag) => tag.name?.toLowerCase()).filter(Boolean)
        : []

      const matchesTag = selectedTags.length === 0 ||
        selectedTags.every((selectedTag) => bookmarkTagNames.includes(selectedTag.toLowerCase()))

      const matchesFavorite = !showFavoritesOnly || Boolean(bookmark.is_favorite)

      const matchesUntagged = !untaggedActive || hasNoTags(bookmark)
      const matchesDomain = !domainActive || getBookmarkDomain(bookmark.url) === domainActive
      const matchesMonth = !monthActive || getCreatedMonth(bookmark.created_at) === monthActive

      return matchesSearch && matchesTag && matchesFavorite && matchesUntagged && matchesDomain && matchesMonth
    })
  }, [sortedBookmarks, searchTerm, selectedTags, showFavoritesOnly, untaggedActive, focusBookmarkId, domainActive, monthActive])

  useEffect(() => {
    setCurrentPage(1)
    setPageAnnouncement('')
  }, [searchTerm, selectedTags, showFavoritesOnly, untaggedActive, sortBy, sortDirection, itemsPerPage, domainActive, monthActive])

  const totalPages = Math.max(1, Math.ceil(filteredBookmarks.length / itemsPerPage))

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  // Pager buttons sit above and below the grid and the one that was pressed may
  // become disabled, so after a page change move focus to the top of the results
  // and announce the new page.
  const handlePageChange = (page) => {
    setCurrentPage(page)
    setPageAnnouncement(`Page ${page} of ${totalPages}`)
    resultsHeadingRef.current?.focus()
  }

  const paginatedBookmarks = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage
    return filteredBookmarks.slice(start, start + itemsPerPage)
  }, [filteredBookmarks, currentPage, itemsPerPage])

  // Clear the underlying search/tag/favorites controls so they don't reappear
  // stale once a focused bookmark (e.g. from the Random button) is cleared.
  useEffect(() => {
    if (!focusBookmarkId) return
    setSearchTerm('')
    setSelectedTags([])
    setShowFavoritesOnly(false)
    setShowUntaggedOnly(false)
    setDomainFilter(null)
    setMonthFilter('')
    setCurrentPage(1)
  }, [focusBookmarkId])

  // Clicking "Related" replaces whatever filter was active with a same-domain view.
  const handleShowRelated = (url) => {
    const domain = getBookmarkDomain(url)
    if (!showDomainFilter || !domain) return
    handleClearAllFilters()
    setDomainFilter(domain)
  }

  const handleClearDomainFilter = () => setDomainFilter(null)

  // Scroll the focused bookmark into view once it's rendered as the sole card.
  useEffect(() => {
    if (!focusBookmarkId) return
    if (!paginatedBookmarks.some((bookmark) => bookmark.id === focusBookmarkId)) return
    const el = document.getElementById(`bookmark-${focusBookmarkId}`)
    el?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' })
  }, [focusBookmarkId, paginatedBookmarks])

  const handleTagSelect = (tagName) => {
    const normalized = tagName?.trim().toLowerCase()
    if (!normalized) return

    // "Without tags" and a tag filter can never both match, so picking a tag replaces it.
    setShowUntaggedOnly(false)
    if (focusBookmarkId) onClearFocus?.()
    setSelectedTags([normalized])
  }

  const handleTagAdd = (tagName) => {
    const normalized = tagName?.trim().toLowerCase()
    if (!normalized) return

    setShowUntaggedOnly(false)
    if (focusBookmarkId) onClearFocus?.()
    setSelectedTags((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]))
  }

  const handleTagRemove = (tagName) => {
    const normalized = tagName?.trim().toLowerCase()
    if (!normalized) return
    setSelectedTags((prev) => prev.filter((tag) => tag !== normalized))
  }

  const handleToggleUntagged = () => {
    if (focusBookmarkId) onClearFocus?.()
    // Mutually exclusive with tag selection; search and favorites still combine with it.
    if (!showUntaggedOnly) setSelectedTags([])
    setShowUntaggedOnly((prev) => !prev)
  }

  const hasActiveFilters = Boolean(
    searchTerm.trim() || selectedTags.length > 0 || showFavoritesOnly || untaggedActive || domainActive || monthActive || focusBookmarkId
  )

  const activeFilterChipLabel = focusBookmarkId
    ? 'Random'
    : null

  const handleClearAllFilters = () => {
    setSearchTerm('')
    setSelectedTags([])
    setShowFavoritesOnly(false)
    setShowUntaggedOnly(false)
    setDomainFilter(null)
    setMonthFilter('')
    if (focusBookmarkId) onClearFocus?.()
  }

  return (
    <>
      <div className="main-content">
        <div className="toolbar">
          <div className="toolbar-row toolbar-row-actions">
            <div className="search-control">
              <Search size={16} className="search-icon" />
              {activeFilterChipLabel && (
                <span className="search-filter-chip">{activeFilterChipLabel}</span>
              )}
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => {
                  if (focusBookmarkId) onClearFocus?.()
                  setSearchTerm(e.target.value)
                }}
                placeholder={activeFilterChipLabel ? '' : 'Search titles, links, notes and tags'}
                aria-label="Search bookmarks"
              />
              {showFavoritesFilter && (
                <button
                  type="button"
                  className={`favorites-filter-btn ${showFavoritesOnly ? 'active' : ''}`}
                  onClick={() => {
                    if (focusBookmarkId) onClearFocus?.()
                    setShowFavoritesOnly((prev) => !prev)
                  }}
                  aria-label={showFavoritesOnly ? 'Show all bookmarks' : 'Show favorite bookmarks only'}
                  title={showFavoritesOnly ? 'Showing favorites only' : 'Show favorite bookmarks only'}
                  aria-pressed={showFavoritesOnly}
                >
                  <Star size={16} fill={showFavoritesOnly ? 'currentColor' : 'none'} />
                </button>
              )}
              {hasActiveFilters && (
                <button
                  type="button"
                  className="clear-filters-btn"
                  onClick={handleClearAllFilters}
                  aria-label="Clear all filters"
                  title="Clear search, tags, favorites, untagged, domain, and month filters"
                >
                  <X size={16} />
                </button>
              )}
            </div>
            {toolbarExtra}
          </div>
        </div>

        {children}

        <div className="bookmarks-section">
          <h2 ref={resultsHeadingRef} tabIndex={-1} className="sr-only">Bookmarks</h2>
          <p className="sr-only" role="status">{pageAnnouncement}</p>
          {filteredBookmarks.length > 0 && (
            <div className="results-bar">
              <p className="results-count" aria-live="polite">
                {filteredBookmarks.length === bookmarks.length
                  ? `${bookmarks.length} ${bookmarks.length === 1 ? 'bookmark' : 'bookmarks'}`
                  : `${filteredBookmarks.length} of ${bookmarks.length} bookmarks`}
              </p>
              <div className="results-controls">
                <div className="sort-control">
                  <label htmlFor="sortBy">Sort</label>
                  <select
                    id="sortBy"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                  >
                    <option value="date">Date saved</option>
                    <option value="lastUpdated">Last updated</option>
                    <option value="alpha">Title</option>
                    <option value="url">URL</option>
                  </select>
                  <select
                    id="sortDirection"
                    aria-label="Sort direction"
                    value={sortDirection}
                    onChange={(e) => setSortDirection(e.target.value)}
                  >
                    <option value="desc">{sortBy === 'alpha' || sortBy === 'url' ? 'Z to A' : 'Newest first'}</option>
                    <option value="asc">{sortBy === 'alpha' || sortBy === 'url' ? 'A to Z' : 'Oldest first'}</option>
                  </select>
                </div>
                <div className="pagination-page-size">
                  <label htmlFor="itemsPerPage">Per page</label>
                  <select
                    id="itemsPerPage"
                    value={itemsPerPage}
                    onChange={(e) => setItemsPerPage(Number(e.target.value))}
                  >
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                    <option value={40}>40</option>
                    <option value={80}>80</option>
                  </select>
                </div>
                {totalPages > 1 && (
                  <Pager currentPage={currentPage} totalPages={totalPages} onChange={handlePageChange} />
                )}
              </div>
            </div>
          )}
          {loading ? (
            <div className="loading-message">Loading bookmarks…</div>
          ) : filteredBookmarks.length === 0 ? (
            <div className="empty-state">
              {untaggedActive && untaggedCount === 0 ? (
                <>
                  <p>Every bookmark has at least one tag.</p>
                  <button type="button" className="btn-secondary" onClick={handleClearAllFilters}>
                    Clear filters
                  </button>
                </>
              ) : hasActiveFilters ? (
                <>
                  <p>No bookmarks match these filters.</p>
                  <button type="button" className="btn-secondary" onClick={handleClearAllFilters}>
                    Clear filters
                  </button>
                </>
              ) : (
                <p>{emptyStateMessage}</p>
              )}
            </div>
          ) : (
            <>
              <div className="bookmarks-grid">
                {paginatedBookmarks.map((bookmark) => (
                  <Fragment key={bookmark.id}>
                    {renderCard
                      ? renderCard(bookmark, { onShowRelated: handleShowRelated, onTagSelect: handleTagSelect, selectedTags })
                      : (
                        <DefaultCard
                          bookmark={bookmark}
                          linkTarget={linkTarget}
                          selectedTags={selectedTags}
                          onTagSelect={handleTagSelect}
                        />
                      )}
                  </Fragment>
                ))}
              </div>
              {totalPages > 1 && (
                <div className="results-bar results-bar--bottom">
                  <Pager currentPage={currentPage} totalPages={totalPages} onChange={handlePageChange} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <aside className="sidebar">
        {(domainActive || monthActive || selectedTags.length > 0) && (
          <div className="active-tag-filter">
            <div className="active-tag-filter-head">
              <span>Filtering by</span>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setSelectedTags([])
                  handleClearDomainFilter()
                  setMonthFilter('')
                }}
              >
                Clear
              </button>
            </div>
            <div className="active-tag-filter-list">
              {domainActive && (
                <span className="active-domain-filter">
                  <span>Domain: {domainActive}</span>
                  <button type="button" onClick={handleClearDomainFilter} aria-label="Clear domain filter">
                    <X size={13} />
                  </button>
                </span>
              )}
              {monthActive && (
                <span className="active-domain-filter">
                  <span>Saved: {formatCreatedMonth(monthActive)}</span>
                  <button type="button" onClick={() => setMonthFilter('')} aria-label="Clear month filter">
                    <X size={13} />
                  </button>
                </span>
              )}
              {selectedTags.map((tag) => (
                <span key={tag} className="tag-stock tag-stock--active">
                  <span>{tag}</span>
                  <button type="button" className="tag-stock-remove" onClick={() => handleTagRemove(tag)} aria-label={`Remove ${tag} from filter`}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            {selectedTags.length > 1 && (
              <p className="active-tag-filter-hint">Showing bookmarks that have all of these tags.</p>
            )}
          </div>
        )}
        {(showDomainFilter || showDateFilter) && (
          <div className="library-filters">
            {showDomainFilter && (
              <div className="library-filter-control">
                <label htmlFor="bookmark-domain">Domain</label>
                <select id="bookmark-domain" value={domainActive || ''} onChange={(e) => {
                  if (focusBookmarkId) onClearFocus?.()
                  setDomainFilter(e.target.value || null)
                }}>
                  <option value="">All domains</option>
                  {domainActive && !domains.some(([domain]) => domain === domainActive) && (
                    <option value={domainActive}>{domainActive} (0)</option>
                  )}
                  {domains.map(([domain, count]) => <option key={domain} value={domain}>{domain} ({count})</option>)}
                </select>
              </div>
            )}
            {showDateFilter && (
              <div className="library-filter-control">
                <label htmlFor="bookmark-month">Month saved</label>
                <select id="bookmark-month" value={monthActive} aria-describedby="bookmark-month-hint" onChange={(e) => {
                  if (focusBookmarkId) onClearFocus?.()
                  setMonthFilter(e.target.value)
                }}>
                  <option value="">All months</option>
                  {monthActive && !months.some(({ value }) => value === monthActive) && (
                    <option value={monthActive}>{formatCreatedMonth(monthActive)} (0)</option>
                  )}
                  {months.map(({ value, label, count }) => <option key={value} value={value}>{label} ({count})</option>)}
                </select>
                <p id="bookmark-month-hint">Months use your local time zone. Counts reflect your whole library.</p>
              </div>
            )}
          </div>
        )}
        {showUntaggedFilter && (
          <button
            type="button"
            className={`untagged-filter-btn ${untaggedActive ? 'active' : ''}`}
            onClick={handleToggleUntagged}
            aria-pressed={untaggedActive}
            title="Show only bookmarks that have no tags"
          >
            <span>Without tags</span>
            {!loading && <span className="untagged-filter-count">{untaggedCount}</span>}
          </button>
        )}
        <TagCloud
          tags={tags}
          selectedTags={selectedTags}
          onTagSelect={handleTagSelect}
          onTagAdd={handleTagAdd}
          onTagFavoriteToggle={onTagFavoriteToggle}
          refreshKey={tagsRefreshKey}
        />
      </aside>
    </>
  )
}

function Pager({ currentPage, totalPages, onChange }) {
  return (
    <div className="pagination-controls">
      <button
        type="button"
        className="pagination-btn"
        onClick={() => onChange(Math.max(1, currentPage - 1))}
        disabled={currentPage === 1}
        aria-label="Previous page"
      >
        <ChevronLeft size={16} />
      </button>
      <span className="pagination-status">Page {currentPage} of {totalPages}</span>
      <button
        type="button"
        className="pagination-btn"
        onClick={() => onChange(Math.min(totalPages, currentPage + 1))}
        disabled={currentPage === totalPages}
        aria-label="Next page"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  )
}

export default BookmarkBrowser
