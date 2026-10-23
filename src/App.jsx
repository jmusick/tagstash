import { useState, useEffect, useLayoutEffect, useMemo, useRef, lazy, Suspense } from 'react'
import { Routes, Route, Link, useNavigate, useLocation } from 'react-router-dom'
import { version } from '../package.json'
import './App.css'
import { useAuth } from './context/AuthContext'
import Home from './components/Home'
import BookmarkBrowser from './components/BookmarkBrowser'
import AppHeader from './components/AppHeader'
import AppFooter from './components/AppFooter'
import RouteAnnouncer from './components/RouteAnnouncer'
import { useDocumentMeta } from './utils/useDocumentMeta'
import { authAPI, bookmarksAPI, billingAPI } from './api/api'

// Lazy + catch rather than a static import: if a content blocker ever blocks this
// module's request (see the note in ConsentBanner.jsx), a static import would take
// the entire app down with it. Degrading to "no consent banner" is survivable —
// analytics simply stays off, which is the safe default — a blank site is not.
const ConsentBanner = lazy(() =>
  import('./components/ConsentBanner').catch(() => ({ default: () => null }))
)

const NotFound = lazy(() => import('./components/NotFound'))
const Settings = lazy(() => import('./components/Settings'))
const TagsPage = lazy(() => import('./components/TagsPage'))
const TrashPage = lazy(() => import('./components/TrashPage'))
const PolicyPage = lazy(() => import('./components/PolicyPage'))
const SupportPage = lazy(() => import('./components/SupportPage'))
const FeaturesPage = lazy(() => import('./components/FeaturesPage'))
const VerifyEmail = lazy(() => import('./components/VerifyEmail'))
const ResetPassword = lazy(() => import('./components/ResetPassword'))
const PublicProfile = lazy(() => import('./components/PublicProfile'))
import { decodeHtmlEntities } from './utils/decodeHtmlEntities'
import { THEME_STORAGE_KEY, isValidTheme } from './utils/theme'
import { LINK_TARGET_STORAGE_KEY, getInitialLinkTarget, isValidLinkTarget, linkTargetProps } from './utils/linkTarget'
import { getBookmarkDomain, countDomains } from './utils/bookmarkFilters'
import { INPUT_LIMITS } from './utils/inputLimits'
import { downloadBookmarks } from './utils/downloadBookmarks'
import { BookmarkTagList } from './components/BookmarkParts'
import { displayUrl, formatSavedDate } from './utils/bookmarkDisplay'
import { isSnapshotPath, removeProfileSnapshot } from './utils/profileSnapshot'
import { Settings as SettingsIcon, Bookmark as BookmarkIcon, Plus, Pencil, Trash2, Star, X, RefreshCw, Globe, Scissors, FileText, Info, Eye, EyeOff, Tags, Shuffle, Link2, ExternalLink } from 'lucide-react'

const FREE_BOOKMARK_LIMIT = 50

const normalizeBookmarkUrl = (value) => {
  const raw = (value || '').trim()
  if (!raw) return ''

  let normalized
  if (/^https?:\/\//i.test(raw)) {
    normalized = raw
  } else {
    const cleaned = raw
      .replace(/^https?:/i, '')
      .replace(/^\/\//, '')
      .trim()

    normalized = cleaned ? `https://${cleaned}` : ''
  }
  if (!normalized) return ''

  // Keep a trailing slash on bare roots, including URLs produced by Base URL.
  try {
    const parsed = new URL(normalized)
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
      return `${parsed.origin}/`
    }
  } catch {}

  return normalized
}

const ActionInfo = ({ text }) => (
  <span className="action-info-inline" aria-hidden="true">
    <Info size={11} />
    <span className="action-info-tooltip" role="tooltip">{text}</span>
  </span>
)

const getInitialTheme = () => {
  if (typeof window === 'undefined') {
    return 'slate'
  }

  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (isValidTheme(storedTheme)) {
    return storedTheme
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'slate'
}

function App() {
  const { user, loading: authLoading, logout } = useAuth()
  const [theme, setTheme] = useState(getInitialTheme)
  const [linkTarget, setLinkTarget] = useState(getInitialLinkTarget)
  const [bookmarks, setBookmarks] = useState([])
  const [showAddForm, setShowAddForm] = useState(false)
  const [browserResetKey, setBrowserResetKey] = useState(0)
  const [focusBookmarkId, setFocusBookmarkId] = useState(null)
  // "Moved to the trash" notice with Undo after a single delete: { message, ids, busy, error }.
  const [trashNotice, setTrashNotice] = useState(null)
  const trashNoticeRef = useRef(null)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  // The profile snapshot belongs to the first page loaded; drop it on any other route.
  useLayoutEffect(() => {
    if (!isSnapshotPath(pathname)) removeProfileSnapshot()
  }, [pathname])
  // The signed-in bookmark view had no title of its own, so it kept the previous
  // page's (e.g. "Manage Tags") and route announcements read the wrong one.
  useDocumentMeta({ title: 'Bookmarks - Tagstash', path: '/', noindex: true, enabled: !!user && pathname === '/' })
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [fetchingDescription, setFetchingDescription] = useState(false)
  const [lastFetchedDescriptionUrl, setLastFetchedDescriptionUrl] = useState('')
  const [editingBookmarkId, setEditingBookmarkId] = useState(null)
  const [editFormData, setEditFormData] = useState({
    title: '',
    url: '',
    description: '',
    tags: '',
  })
  const [fetchingEditDescription, setFetchingEditDescription] = useState(false)
  const [fetchingEditTitle, setFetchingEditTitle] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)
  const [formData, setFormData] = useState({
    title: '',
    url: '',
    tags: '',
    description: ''
  })
  const [tagDraft, setTagDraft] = useState('')
  const [editTagDraft, setEditTagDraft] = useState('')
  const [tagsRefreshKey, setTagsRefreshKey] = useState(0)
  const [usageUpgradePlan, setUsageUpgradePlan] = useState('monthly')
  const [startingUpgrade, setStartingUpgrade] = useState(false)
  const [billingMessage, setBillingMessage] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('billing') || ''
  })

  // Clear billing query param from URL without reload
  useEffect(() => {
    if (billingMessage) {
      const url = new URL(window.location.href)
      url.searchParams.delete('billing')
      window.history.replaceState({}, '', url.toString())
    }
  }, [billingMessage])

  const membershipTier = user?.membership_tier || 'free'
  const isPaidMember = membershipTier === 'paid'
  const bookmarkUsageCount = bookmarks.length
  const freeUsagePercent = Math.min(100, Math.round((bookmarkUsageCount / FREE_BOOKMARK_LIMIT) * 100))
  const isFreeLimitReached = !isPaidMember && bookmarks.length >= FREE_BOOKMARK_LIMIT
  const logoSrc = theme === 'light' ? '/logo-light.png' : '/logo-dark.png'

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark'
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  useEffect(() => {
    window.localStorage.setItem(LINK_TARGET_STORAGE_KEY, linkTarget)
  }, [linkTarget])

  // Logged-in users' saved theme preference takes precedence over the local browser default.
  useEffect(() => {
    if (user && isValidTheme(user.theme)) {
      setTheme(user.theme)
    }
  }, [user])

  // Same for the saved link-opening preference (null for accounts that never picked one).
  useEffect(() => {
    if (user && isValidLinkTarget(user.link_target)) {
      setLinkTarget(user.link_target)
    }
  }, [user])

  useEffect(() => {
    if (user) {
      fetchBookmarks()
    }
  }, [user])

  // Bookmarks saved via the browser extension don't push updates to this tab,
  // so poll quietly in the background (mirrors the extension sidebar's own refresh interval).
  useEffect(() => {
    if (!user) return

    const interval = setInterval(() => {
      fetchBookmarks({ silent: true })
      setTagsRefreshKey((prev) => prev + 1)
    }, 5 * 60 * 1000)

    return () => clearInterval(interval)
  }, [user])

  const selectTheme = (nextTheme) => {
    setTheme(nextTheme)
    if (user) {
      authAPI.updateTheme(nextTheme).catch(() => {})
    }
  }

  // Saved to the account like the theme. The browser extension has its own
  // extension-local setting and never reads this one.
  const selectLinkTarget = (nextLinkTarget) => {
    if (!isValidLinkTarget(nextLinkTarget)) return
    setLinkTarget(nextLinkTarget)
    if (user) {
      authAPI.updateLinkTarget(nextLinkTarget).catch(() => {})
    }
  }

  const handleLogoClick = () => {
    navigate('/')
    setShowAddForm(false)
    setEditingBookmarkId(null)
    setFocusBookmarkId(null)
    setBrowserResetKey((prev) => prev + 1)
  }

  const fetchBookmarks = async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true)
      const response = await bookmarksAPI.getAll()
      setBookmarks(response.data.bookmarks)
      setError((previousError) => previousError === 'Failed to fetch bookmarks' ? '' : previousError)
    } catch (err) {
      setError('Failed to fetch bookmarks')
      console.error(err)
    } finally {
      if (!silent) setLoading(false)
    }
  }

  const handleRefreshBookmarks = async () => {
    setRefreshing(true)
    try {
      await fetchBookmarks({ silent: true })
      setTagsRefreshKey((prev) => prev + 1)
    } finally {
      setRefreshing(false)
    }
  }

  const handleUpgradeFromUsageCard = async () => {
    try {
      setStartingUpgrade(true)
      const response = await billingAPI.createCheckoutSession(usageUpgradePlan)
      const checkoutUrl = response?.data?.url

      if (!checkoutUrl) {
        throw new Error('Missing checkout URL')
      }

      window.location.assign(checkoutUrl)
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to start checkout. Please try again.')
      setStartingUpgrade(false)
    }
  }

  const availableTagNames = useMemo(() => {
    const tagNames = bookmarks.flatMap((bookmark) => (
      Array.isArray(bookmark.tags)
        ? bookmark.tags.map((tag) => tag.name?.trim().toLowerCase()).filter(Boolean)
        : []
    ))

    return Array.from(new Set(tagNames)).sort((left, right) => left.localeCompare(right))
  }, [bookmarks])

  const domainCounts = useMemo(() => countDomains(bookmarks), [bookmarks])

  const handleTagFavoriteToggle = async (tag) => {
    if (!tag?.id) return

    try {
      await bookmarksAPI.toggleTagFavorite(tag.id)
      setTagsRefreshKey((prev) => prev + 1)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update favorite tag')
    }
  }

  const parseTags = (raw) => (
    (raw || '')
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag.length > 0)
  )

  const joinTags = (tags) => tags.join(', ')

  // Mirrors the server's tag rules so problems show up while typing, not on save.
  const buildTagList = (rawTags, rawDraft) => {
    const allTags = [...parseTags(rawTags), ...parseTags(rawDraft)]
    const invalidTag = allTags.find((tag) => tag.includes(' '))
    if (invalidTag) {
      return { tags: [], error: `Tag "${invalidTag}" must be a single word with no spaces` }
    }
    const longTag = allTags.find((tag) => tag.length > INPUT_LIMITS.tagName)
    if (longTag) {
      return { tags: [], error: `Tags must be ${INPUT_LIMITS.tagName} characters or less` }
    }
    const tags = Array.from(new Set(allTags))
    if (tags.length > INPUT_LIMITS.tagsPerBookmark) {
      return { tags: [], error: `A bookmark can have at most ${INPUT_LIMITS.tagsPerBookmark} tags` }
    }
    return { tags, error: null }
  }

  const lockAddDraftTags = (draft = tagDraft) => {
    const { tags, error: tagError } = buildTagList(formData.tags, draft)
    if (tagError) {
      setError(tagError)
      return false
    }
    setFormData((prev) => ({ ...prev, tags: joinTags(tags) }))
    setTagDraft('')
    return true
  }

  const lockEditDraftTags = (draft = editTagDraft) => {
    const { tags, error: tagError } = buildTagList(editFormData.tags, draft)
    if (tagError) {
      setError(tagError)
      return false
    }
    setEditFormData((prev) => ({ ...prev, tags: joinTags(tags) }))
    setEditTagDraft('')
    return true
  }

  const removeAddTag = (tagToRemove) => {
    const nextTags = parseTags(formData.tags).filter((tag) => tag !== tagToRemove)
    setFormData((prev) => ({ ...prev, tags: joinTags(nextTags) }))
  }

  const removeEditTag = (tagToRemove) => {
    const nextTags = parseTags(editFormData.tags).filter((tag) => tag !== tagToRemove)
    setEditFormData((prev) => ({ ...prev, tags: joinTags(nextTags) }))
  }

  const getSuggestedTag = (draft, lockedTags) => {
    const normalizedDraft = draft.trim().toLowerCase()
    if (!normalizedDraft) return null

    const lockedTagSet = new Set(lockedTags)

    const exactMatch = availableTagNames.find((tag) => (
      tag === normalizedDraft && !lockedTagSet.has(tag)
    ))

    if (exactMatch) {
      return exactMatch
    }

    return availableTagNames.find((tag) => (
      tag.startsWith(normalizedDraft) && !lockedTagSet.has(tag)
    )) || null
  }

  const addTagSuggestion = getSuggestedTag(tagDraft, parseTags(formData.tags))
  const editTagSuggestion = getSuggestedTag(editTagDraft, parseTags(editFormData.tags))

  const handleAddTagDraftKeyDown = (e) => {
    if (e.key === 'Tab') {
      // Only a plain Tab accepts the suggestion, and only when it can actually be
      // locked in; otherwise Tab/Shift+Tab must keep moving focus (no keyboard trap).
      if (!addTagSuggestion || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
      if (buildTagList(formData.tags, addTagSuggestion).invalidTag) return

      e.preventDefault()
      setError('')
      lockAddDraftTags(addTagSuggestion)
      return
    }

    const isDelimiter = e.key === ',' || e.key === ' ' || e.key === 'Spacebar'
    if (!isDelimiter || !tagDraft.trim()) return

    e.preventDefault()

    setError('')
    lockAddDraftTags()
  }

  const handleEditTagDraftKeyDown = (e) => {
    if (e.key === 'Tab') {
      if (!editTagSuggestion || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
      if (buildTagList(editFormData.tags, editTagSuggestion).invalidTag) return

      e.preventDefault()
      setError('')
      lockEditDraftTags(editTagSuggestion)
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveEdit(editingBookmarkId)
      return
    }

    const isDelimiter = e.key === ',' || e.key === ' ' || e.key === 'Spacebar'
    if (!isDelimiter || !editTagDraft.trim()) return

    e.preventDefault()

    setError('')
    lockEditDraftTags()
  }

  const handleInputChange = (e) => {
    if (e.target.name === 'url') {
      setLastFetchedDescriptionUrl('')
    }

    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    })
  }

  const handleBaseUrl = () => {
    try {
      const u = new URL(normalizeBookmarkUrl(formData.url))
      setFormData(prev => ({ ...prev, url: `${u.origin}/` }))
    } catch {}
  }

  const handleTrimUrl = () => {
    try {
      const u = new URL(normalizeBookmarkUrl(formData.url))
      setFormData(prev => ({ ...prev, url: u.origin + u.pathname }))
    } catch {}
  }

  const handleEditBaseUrl = () => {
    try {
      const u = new URL(normalizeBookmarkUrl(editFormData.url))
      setEditFormData(prev => ({ ...prev, url: `${u.origin}/` }))
    } catch {}
  }

  const handleEditTrimUrl = () => {
    try {
      const u = new URL(normalizeBookmarkUrl(editFormData.url))
      setEditFormData(prev => ({ ...prev, url: u.origin + u.pathname }))
    } catch {}
  }

  const handleFetchDescription = async (force = false) => {
    const rawUrl = formData.url.trim()
    if (!rawUrl) {
      if (force) {
        setError('Enter a URL first to fetch description')
      }
      return
    }

    const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`
    if (!force && normalizedUrl === lastFetchedDescriptionUrl) {
      return
    }

    try {
      setError('')
      setFetchingDescription(true)
      const response = await bookmarksAPI.fetchDescription(rawUrl)
      const fetchedDescription = response.data?.description || ''

      setFormData((prev) => ({
        ...prev,
        description: fetchedDescription,
      }))
      setLastFetchedDescriptionUrl(normalizedUrl)
    } catch (err) {
      if (force) {
        setError(err.response?.data?.error || 'Failed to fetch description')
      }
    } finally {
      setFetchingDescription(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (isFreeLimitReached) {
      setError(`Free users can save up to ${FREE_BOOKMARK_LIMIT} bookmarks. Upgrade to paid for unlimited bookmarks.`)
      return
    }

    try {
      const { tags, error: tagError } = buildTagList(formData.tags, tagDraft)
      if (tagError) {
        setError(tagError)
        return
      }

      const normalizedUrl = normalizeBookmarkUrl(formData.url)
      if (!normalizedUrl) {
        setError('Title and URL are required')
        return
      }

      const bookmarkData = {
        title: formData.title,
        url: normalizedUrl,
        description: formData.description || null,
        tags
      }

      await bookmarksAPI.create(bookmarkData)
      
      // Reset form and refresh bookmarks
      setFormData({ title: '', url: '', tags: '', description: '' })
      setTagDraft('')
      setLastFetchedDescriptionUrl('')
      setShowAddForm(false)
      fetchBookmarks()
      // Refresh tag cloud to include new tags
      setTagsRefreshKey(prev => prev + 1)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create bookmark')
    }
  }

  // Deleting moves the bookmark to the trash (restorable for 30 days), so there is no confirm
  // dialog: a notice with Undo replaces it, and focus moves to that notice because the card
  // that had focus is gone.
  const handleDelete = async (bookmark) => {
    try {
      const response = await bookmarksAPI.delete(bookmark.id)
      const title = decodeHtmlEntities(bookmark.title || '') || bookmark.url
      const trashed = response.data?.trashed !== false
      setTrashNotice({
        message: trashed ? `Moved “${title}” to the trash.` : `Deleted “${title}”.`,
        ids: trashed ? [bookmark.id] : null,
        busy: false,
        error: '',
      })
      setTimeout(() => trashNoticeRef.current?.focus(), 0)
      fetchBookmarks()
      // Refresh tag cloud to update counts
      setTagsRefreshKey(prev => prev + 1)
    } catch {
      setError('Failed to delete bookmark')
    }
  }

  const handleUndoDelete = async () => {
    if (!trashNotice?.ids) return
    setTrashNotice((prev) => ({ ...prev, busy: true, error: '' }))
    try {
      await bookmarksAPI.bulkRestore(trashNotice.ids)
      setTrashNotice(null)
      await refreshAfterBulkChange()
    } catch (err) {
      setTrashNotice((prev) => ({
        ...prev,
        busy: false,
        error: err.response?.data?.error || 'Could not restore the bookmark. It is still in the trash.',
      }))
    }
  }

  // Multi-select actions (BookmarkBrowser's select mode). Each call throws on failure so the
  // toolbar can show the server's message; on success the library and tag cloud are refreshed
  // quietly (no loading state, so focus and scroll position stay where they are).
  const refreshAfterBulkChange = async () => {
    await fetchBookmarks({ silent: true })
    setTagsRefreshKey((prev) => prev + 1)
  }

  const bulkActions = {
    maxSelection: INPUT_LIMITS.bulkBookmarkIds,
    onDelete: async (ids) => {
      const response = await bookmarksAPI.bulkDelete(ids)
      await refreshAfterBulkChange()
      return response.data
    },
    // Undo for a bulk delete: puts the same bookmarks back from the trash.
    onUndo: async (ids) => {
      const response = await bookmarksAPI.bulkRestore(ids)
      await refreshAfterBulkChange()
      return response.data
    },
    onTags: async (ids, changes) => {
      const response = await bookmarksAPI.bulkTags(ids, changes)
      await refreshAfterBulkChange()
      return response.data
    },
    onExport: (bookmarks, format) => downloadBookmarks(bookmarks, format, 'tagstash-selected'),
  }

  const handleBookmarkToggle = async (apiCall, id, fallbackErrorMessage) => {
    try {
      await apiCall(id)
      fetchBookmarks()
    } catch (err) {
      setError(err.response?.data?.error || fallbackErrorMessage)
    }
  }

  const handleBookmarkFavoriteToggle = (id) =>
    handleBookmarkToggle(bookmarksAPI.toggleFavorite, id, 'Failed to update bookmark favorite')

  const handleBookmarkPrivateToggle = (id) =>
    handleBookmarkToggle(bookmarksAPI.togglePrivate, id, 'Failed to update bookmark privacy')

  const handleStartEdit = (bookmark) => {
    setError('')
    setEditingBookmarkId(bookmark.id)
    const tagsString = bookmark.tags && bookmark.tags.length > 0
      ? bookmark.tags.map(tag => tag.name).join(', ')
      : ''
    setEditFormData({
      title: decodeHtmlEntities(bookmark.title || ''),
      url: bookmark.url || '',
      description: decodeHtmlEntities(bookmark.description || ''),
      tags: tagsString,
    })
    setEditTagDraft('')
  }

  const handleRandomBookmark = () => {
    if (bookmarks.length === 0) return
    const randomBookmark = bookmarks[Math.floor(Math.random() * bookmarks.length)]
    setShowAddForm(false)
    handleStartEdit(randomBookmark)
    setFocusBookmarkId(randomBookmark.id)
  }

  const handleCancelEdit = () => {
    setEditingBookmarkId(null)
    setEditFormData({ title: '', url: '', description: '', tags: '' })
    setEditTagDraft('')
    setFocusBookmarkId(null)
  }

  const handleEditInputChange = (e) => {
    setEditFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }))
  }

  const getFaviconPreviewUrl = (url) => {
    const rawUrl = (url || '').trim()
    if (!rawUrl) {
      return null
    }

    const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`

    try {
      const parsedUrl = new URL(normalizedUrl)
      return `https://www.google.com/s2/favicons?sz=64&domain=${parsedUrl.hostname}`
    } catch {
      return null
    }
  }

  const handleSaveEdit = async (bookmarkId) => {
    if (!editFormData.title.trim() || !editFormData.url.trim()) {
      setError('Title and URL are required')
      return
    }

    try {
      const { tags, error: tagError } = buildTagList(editFormData.tags, editTagDraft)
      if (tagError) {
        setError(tagError)
        return
      }

      setSavingEdit(true)
      setError('')
      const normalizedUrl = normalizeBookmarkUrl(editFormData.url)
      if (!normalizedUrl) {
        setError('Title and URL are required')
        setSavingEdit(false)
        return
      }

      await bookmarksAPI.update(bookmarkId, {
        title: editFormData.title.trim(),
        url: normalizedUrl,
        description: editFormData.description.trim() || null,
        tags,
      })
      handleCancelEdit()
      fetchBookmarks()
      // Refresh tag cloud to include any new tags
      setTagsRefreshKey(prev => prev + 1)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update bookmark')
    } finally {
      setSavingEdit(false)
    }
  }

  const handleFetchEditDescription = async () => {
    if (!editFormData.url.trim()) {
      setError('Enter a URL first to fetch description')
      return
    }

    try {
      setError('')
      setFetchingEditDescription(true)
      const response = await bookmarksAPI.fetchDescription(editFormData.url)
      const fetchedDescription = response.data?.description || ''

      setEditFormData((prev) => ({
        ...prev,
        description: fetchedDescription,
      }))
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch description')
    } finally {
      setFetchingEditDescription(false)
    }
  }

  const handleFetchEditTitle = async () => {
    if (!editFormData.url.trim()) {
      setError('Enter a URL first to fetch title')
      return
    }

    try {
      setError('')
      setFetchingEditTitle(true)
      const response = await bookmarksAPI.fetchMetadata(editFormData.url)
      const fetchedTitle = response.data?.title?.trim()

      if (!fetchedTitle) {
        setError('No page title found for this URL')
        return
      }

      setEditFormData((prev) => ({
        ...prev,
        title: fetchedTitle,
      }))
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch title')
    } finally {
      setFetchingEditTitle(false)
    }
  }

  const renderOwnerCard = (bookmark, { onShowRelated, onTagSelect, selectedTags, selection } = {}) => {
    const isEditing = editingBookmarkId === bookmark.id
    const isFavorite = Boolean(bookmark.is_favorite)
    const isPrivate = Boolean(bookmark.is_private)
    const faviconSrc = isEditing
      ? (getFaviconPreviewUrl(editFormData.url) || bookmark.favicon_url)
      : bookmark.favicon_url
    const displayTitle = decodeHtmlEntities(bookmark.title || '')
    const displayDescription = decodeHtmlEntities(bookmark.description || '')
    const bookmarkDomain = getBookmarkDomain(bookmark.url)
    const hasRelated = bookmarkDomain && (domainCounts.get(bookmarkDomain) || 0) > 1

    return (
      <article
        className={`bookmark-card ${isEditing ? 'is-editing' : ''} ${selection ? 'is-selectable' : ''} ${selection?.selected ? 'is-selected' : ''}`}
        id={`bookmark-${bookmark.id}`}
      >
        <div className="bookmark-header">
          {selection && (
            <input
              type="checkbox"
              className="bookmark-select"
              checked={selection.selected}
              onChange={selection.onToggle}
              aria-label={`Select ${displayTitle || bookmark.url}`}
            />
          )}
          <span className="favicon-slot" aria-hidden="true">
            {faviconSrc && (
              <img src={faviconSrc} alt="" className="favicon" onError={(e) => { e.target.style.visibility = 'hidden' }} />
            )}
          </span>
          <h3 className="bookmark-title">
            {isEditing ? displayTitle : (
              <a href={bookmark.url} {...linkTargetProps(linkTarget)}>{displayTitle}</a>
            )}
          </h3>
          <div className="bookmark-actions">
            {hasRelated && (
              <button
                type="button"
                onClick={() => onShowRelated?.(bookmark.url)}
                className="icon-btn related-btn"
                title={`Show other bookmarks from ${bookmarkDomain}`}
                aria-label={`Show other bookmarks from ${bookmarkDomain}`}
              >
                <Link2 size={15} />
              </button>
            )}
            <button
              type="button"
              onClick={() => handleStartEdit(bookmark)}
              className="icon-btn edit-btn"
              title="Edit bookmark"
              aria-label="Edit bookmark"
            >
              <Pencil size={15} />
            </button>
            <button
              type="button"
              onClick={() => handleBookmarkFavoriteToggle(bookmark.id)}
              className={`icon-btn favorite-btn ${isFavorite ? 'active' : ''}`}
              title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              aria-pressed={isFavorite}
            >
              <Star size={15} fill={isFavorite ? 'currentColor' : 'none'} />
            </button>
            <button
              type="button"
              onClick={() => handleBookmarkPrivateToggle(bookmark.id)}
              className={`icon-btn private-btn ${isPrivate ? 'active' : ''}`}
              title={isPrivate ? 'Private: hidden from your public profile. Click to make public.' : 'Public: shown on your public profile. Click to make private.'}
              aria-label={isPrivate ? 'Make bookmark public' : 'Make bookmark private'}
              aria-pressed={isPrivate}
            >
              {isPrivate ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            <button
              type="button"
              onClick={() => handleDelete(bookmark)}
              className="icon-btn delete-btn"
              title="Move bookmark to the trash"
              aria-label="Move bookmark to the trash"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
        {isEditing ? (
          <div className="bookmark-edit-form">
            <div className="form-group">
              <div className="field-header">
                <label htmlFor={`edit-title-${bookmark.id}`}>Title</label>
                <button
                  type="button"
                  className="btn-field-action"
                  onClick={handleFetchEditTitle}
                  disabled={!editFormData.url.trim() || fetchingEditTitle}
                >
                  <RefreshCw size={13} />
                  <span>{fetchingEditTitle ? 'Fetching...' : 'Fetch Title'}</span>
                  <ActionInfo text="Attempts to read page metadata and replace the title field with the page title." />
                </button>
              </div>
              <input
                id={`edit-title-${bookmark.id}`}
                type="text"
                name="title"
                value={editFormData.title}
                onChange={handleEditInputChange}
                maxLength={INPUT_LIMITS.title}
                required
              />
            </div>
            <div className="form-group">
              <div className="field-header">
                <label htmlFor={`edit-url-${bookmark.id}`}>URL</label>
                {editFormData.url && (
                  <div className="field-actions">
                    <a
                      className="btn-field-action"
                      href={normalizeBookmarkUrl(editFormData.url)}
                      {...linkTargetProps(linkTarget)}
                    >
                      <ExternalLink size={13} /><span>Open</span>
                      <ActionInfo text={`Opens the URL currently in the field in ${linkTarget === 'same' ? 'this browser tab' : 'a new browser tab'}.`} />
                    </a>
                    <button type="button" className="btn-field-action" onClick={handleEditBaseUrl}>
                      <Globe size={13} /><span>Base URL</span>
                      <ActionInfo text="Keeps only the site root (protocol + domain), removing all path and query parts. Example: https://example.com/docs/page?ref=nav becomes https://example.com/." />
                    </button>
                    <button type="button" className="btn-field-action" onClick={handleEditTrimUrl}>
                      <Scissors size={13} /><span>Trim URL</span>
                      <ActionInfo text="Keeps protocol + domain + path, and removes query string and hash fragments. Example: https://example.com/docs/page?ref=nav#intro becomes https://example.com/docs/page." />
                    </button>
                  </div>
                )}
              </div>
              <input
                id={`edit-url-${bookmark.id}`}
                type="url"
                name="url"
                value={editFormData.url}
                onChange={handleEditInputChange}
                maxLength={INPUT_LIMITS.url}
                required
              />
            </div>
            <div className="form-group">
              <div className="field-header">
                <label htmlFor={`edit-description-${bookmark.id}`}>Description</label>
                <button
                  type="button"
                  className="btn-field-action"
                  onClick={handleFetchEditDescription}
                  disabled={!editFormData.url.trim() || fetchingEditDescription}
                >
                  <FileText size={13} /><span>{fetchingEditDescription ? 'Fetching...' : 'Fetch From Site'}</span>
                  <ActionInfo text="Attempts to read the page metadata and fill the description field. If a site blocks scraping, this may fail." />
                </button>
              </div>
              <textarea
                id={`edit-description-${bookmark.id}`}
                name="description"
                value={editFormData.description}
                onChange={handleEditInputChange}
                maxLength={INPUT_LIMITS.description}
                rows="3"
              />
            </div>
            <div className="form-group">
              <label htmlFor={`edit-tags-${bookmark.id}`}>Tags</label>
              <div className="tag-input-shell">
                {parseTags(editFormData.tags).map((tag) => (
                  <span key={tag} className="tag-stock tag-input-pill">
                    <span>{tag}</span>
                    <button
                      type="button"
                      className="tag-pill-remove"
                      aria-label={`Remove tag ${tag}`}
                      onClick={() => removeEditTag(tag)}
                    >
                      x
                    </button>
                  </span>
                ))}
                <input
                  id={`edit-tags-${bookmark.id}`}
                  type="text"
                  value={editTagDraft}
                  maxLength={INPUT_LIMITS.tagName}
                  onChange={(e) => setEditTagDraft(e.target.value)}
                  onKeyDown={handleEditTagDraftKeyDown}
                  aria-describedby={`edit-tags-hint-${bookmark.id}`}
                  placeholder="Type tag, press comma"
                />
              </div>
              {editTagSuggestion && (
                <div className="tag-input-suggestion" aria-live="polite">
                  Press Tab to use <strong>{editTagSuggestion}</strong>
                </div>
              )}
              <small id={`edit-tags-hint-${bookmark.id}`}>Press Comma or Space to lock in a new tag &middot; Enter to save</small>
            </div>
            <div className="bookmark-edit-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() => handleSaveEdit(bookmark.id)}
                disabled={savingEdit}
              >
                {savingEdit ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleCancelEdit}
                disabled={savingEdit}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="bookmark-meta">
              <a className="bookmark-url" href={bookmark.url} {...linkTargetProps(linkTarget)} tabIndex={-1} aria-hidden="true">
                {displayUrl(bookmark.url)}
              </a>
              <span className="bookmark-date">{formatSavedDate(bookmark.created_at)}</span>
            </div>
            {displayDescription && (
              <p className="bookmark-description">{displayDescription}</p>
            )}
            <BookmarkTagList tags={bookmark.tags} selectedTags={selectedTags} onTagSelect={onTagSelect} />
          </>
        )}
      </article>
    )
  }

  if (authLoading) {
    return (
      <div className="loading-container">
        <p>Loading...</p>
      </div>
    )
  }

  const renderHeaderNav = (active) => {
    const navItems = [
      { id: 'bookmarks', label: 'Bookmarks', Icon: BookmarkIcon, onClick: () => { navigate('/'); fetchBookmarks() } },
      { id: 'tags', label: 'Tags', Icon: Tags, onClick: () => navigate('/tags') },
      { id: 'trash', label: 'Trash', Icon: Trash2, onClick: () => navigate('/trash') },
      { id: 'settings', label: 'Settings', Icon: SettingsIcon, onClick: () => navigate('/settings') },
    ]

    return (
      <>
        <nav className="app-nav" aria-label="Main">
          {navItems.map(({ id, label, Icon, onClick }) => (
            <button
              key={id}
              type="button"
              className={`nav-link ${active === id ? 'is-active' : ''}`}
              aria-current={active === id ? 'page' : undefined}
              onClick={onClick}
            >
              <Icon size={16} className="btn-icon" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <span className="app-user">{user.username}</span>
        <button type="button" onClick={logout} className="nav-link nav-link--quiet">
          Log out
        </button>
      </>
    )
  }

  const homeElement = (
    <Home logoSrc={logoSrc} theme={theme} onSelectTheme={selectTheme} onNavigate={(page) => navigate('/' + page)} />
  )

  return (
    <>
    <a className="skip-link" href="#main">Skip to content</a>
    <RouteAnnouncer />
    <Suspense fallback={<div className="loading-container"><p>Loading...</p></div>}>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmail logoSrc={logoSrc} />} />
        <Route path="/reset-password" element={<ResetPassword logoSrc={logoSrc} />} />
        <Route path="/u/:username" element={<PublicProfile logoSrc={logoSrc} theme={theme} onSelectTheme={selectTheme} linkTarget={linkTarget} />} />
        <Route path="/privacy" element={<PolicyPage logoSrc={logoSrc} onBack={() => navigate('/')} />} />
        <Route path="/features" element={<FeaturesPage logoSrc={logoSrc} theme={theme} onSelectTheme={selectTheme} signedIn={!!user} />} />
        <Route
          path="/support"
          element={<SupportPage logoSrc={logoSrc} prefillEmail={user?.email || ''} onBack={() => navigate('/')} />}
        />
        <Route
          path="/settings"
          element={
            user ? (
              <div className="app">
                <AppHeader
                  logoSrc={logoSrc}
                  onLogoClick={handleLogoClick}
                  theme={theme}
                  onSelectTheme={selectTheme}
                >
                  {renderHeaderNav('settings')}
                </AppHeader>

                <main id="main" tabIndex={-1} className="app-main settings-page-main">
                  <div className="main-content settings-page-content">
                    <Settings
                      pageMode
                      onImportComplete={fetchBookmarks}
                      linkTarget={linkTarget}
                      onSelectLinkTarget={selectLinkTarget}
                    />
                  </div>
                </main>
                <AppFooter version={version}>
                  <Link className="footer-privacy-link" to="/privacy">Privacy Policy</Link>
                  <Link className="footer-privacy-link" to="/support">Support</Link>
                </AppFooter>
              </div>
            ) : homeElement
          }
        />
        <Route
          path="/tags"
          element={
            user ? (
              <div className="app">
                <AppHeader
                  logoSrc={logoSrc}
                  onLogoClick={handleLogoClick}
                  theme={theme}
                  onSelectTheme={selectTheme}
                >
                  {renderHeaderNav('tags')}
                </AppHeader>

                <main id="main" tabIndex={-1} className="app-main settings-page-main">
                  <div className="main-content settings-page-content">
                    <TagsPage />
                  </div>
                </main>
                <AppFooter version={version}>
                  <Link className="footer-privacy-link" to="/privacy">Privacy Policy</Link>
                  <Link className="footer-privacy-link" to="/support">Support</Link>
                </AppFooter>
              </div>
            ) : homeElement
          }
        />
        <Route
          path="/trash"
          element={
            user ? (
              <div className="app">
                <AppHeader
                  logoSrc={logoSrc}
                  onLogoClick={handleLogoClick}
                  theme={theme}
                  onSelectTheme={selectTheme}
                >
                  {renderHeaderNav('trash')}
                </AppHeader>

                <main id="main" tabIndex={-1} className="app-main settings-page-main">
                  <div className="main-content settings-page-content">
                    <TrashPage onLibraryChange={refreshAfterBulkChange} />
                  </div>
                </main>
                <AppFooter version={version}>
                  <Link className="footer-privacy-link" to="/privacy">Privacy Policy</Link>
                  <Link className="footer-privacy-link" to="/support">Support</Link>
                </AppFooter>
              </div>
            ) : homeElement
          }
        />
        <Route
          path="/"
          element={
            user ? (
              <div className="app">
                <AppHeader
                  logoSrc={logoSrc}
                  onLogoClick={handleLogoClick}
                  theme={theme}
                  onSelectTheme={selectTheme}
                >
                  {renderHeaderNav('bookmarks')}
                </AppHeader>

                <main id="main" tabIndex={-1} className="app-main">
                  <BookmarkBrowser
                    key={browserResetKey}
                    bookmarks={bookmarks}
                    loading={loading}
                    linkTarget={linkTarget}
                    tagsRefreshKey={tagsRefreshKey}
                    onTagFavoriteToggle={handleTagFavoriteToggle}
                    renderCard={renderOwnerCard}
                    showUntaggedFilter
                    showDomainFilter
                    showDateFilter
                    focusBookmarkId={focusBookmarkId}
                    onClearFocus={handleCancelEdit}
                    bulkActions={bulkActions}
                    toolbarExtra={(
            <>
              <button
                type="button"
                className="btn-ghost random-btn"
                onClick={handleRandomBookmark}
                disabled={bookmarks.length === 0}
                title="Jump to a random bookmark in edit mode"
                aria-label="Random bookmark"
              >
                <Shuffle size={16} className="btn-icon" />
                <span className="btn-label">Random</span>
              </button>
              <button
                type="button"
                className={`btn-ghost refresh-btn ${refreshing ? 'spinning' : ''}`}
                onClick={handleRefreshBookmarks}
                disabled={refreshing}
                title="Refresh bookmarks (e.g. after saving via the browser extension)"
                aria-label="Refresh bookmarks"
              >
                <RefreshCw size={16} className="btn-icon" />
                <span className="btn-label">Refresh</span>
              </button>
              <button
                className="btn-primary"
                onClick={() => setShowAddForm(!showAddForm)}
                disabled={isFreeLimitReached && !showAddForm}
                aria-expanded={showAddForm}
                aria-controls="add-bookmark-form"
              >
                {!showAddForm && <Plus size={16} className="btn-icon" />}
                <span>{showAddForm ? 'Cancel' : 'Add bookmark'}</span>
              </button>
            </>
          )}
        >
          <h1 className="sr-only">Your bookmarks</h1>
          <div role="status" className="live-region">
            {billingMessage === 'success' && (
              <div className="billing-banner billing-banner--success">
                <span>Your subscription is active. Welcome to Pro.</span>
                <button type="button" onClick={() => setBillingMessage('')} aria-label="Dismiss">
                  <X size={14} />
                </button>
              </div>
            )}
            {billingMessage === 'cancelled' && (
              <div className="billing-banner billing-banner--info">
                <span>Checkout cancelled. You can upgrade anytime from Settings.</span>
                <button type="button" onClick={() => setBillingMessage('')} aria-label="Dismiss">
                  <X size={14} />
                </button>
              </div>
            )}
          </div>

          <div role="status" className="live-region">
            {trashNotice && (
              <div className="trash-notice" tabIndex={-1} ref={trashNoticeRef}>
                <span>{trashNotice.message}</span>
                {trashNotice.ids && (
                  <button type="button" className="btn-secondary bulk-btn" onClick={handleUndoDelete} disabled={trashNotice.busy}>
                    {trashNotice.busy ? 'Restoring...' : 'Undo'}
                  </button>
                )}
                {trashNotice.ids && <Link className="footer-privacy-link" to="/trash">Open trash</Link>}
                <button type="button" className="trash-notice-dismiss" onClick={() => setTrashNotice(null)} aria-label="Dismiss">
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
          {trashNotice?.error && <p className="bulk-error" role="alert">{trashNotice.error}</p>}

          <div role="alert" className="live-region">
            {error && (
              <div className="error-message">
                {error}
                <button onClick={() => setError('')} className="error-close" aria-label="Dismiss error">
                  <X size={16} />
                </button>
              </div>
            )}
          </div>

          {showAddForm && (
            <div className="add-bookmark-form" id="add-bookmark-form">
              <h2>Add a bookmark</h2>
              {isFreeLimitReached && (
                <p className="usage-limit-warning">
                  Free plan limit reached ({FREE_BOOKMARK_LIMIT} bookmarks). Upgrade to paid to continue adding bookmarks.
                </p>
              )}
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <div className="field-header">
                    <label htmlFor="url">URL *</label>
                    {formData.url && (
                      <div className="field-actions">
                        <button type="button" className="btn-field-action" onClick={handleBaseUrl}>
                          <Globe size={13} /><span>Base URL</span>
                          <ActionInfo text="Keeps only the site root (protocol + domain), removing all path and query parts. Example: https://example.com/docs/page?ref=nav becomes https://example.com/." />
                        </button>
                        <button type="button" className="btn-field-action" onClick={handleTrimUrl}>
                          <Scissors size={13} /><span>Trim URL</span>
                          <ActionInfo text="Keeps protocol + domain + path, and removes query string and hash fragments. Example: https://example.com/docs/page?ref=nav#intro becomes https://example.com/docs/page." />
                        </button>
                      </div>
                    )}
                  </div>
                  <input
                    type="url"
                    id="url"
                    name="url"
                    value={formData.url}
                    onChange={handleInputChange}
                    onBlur={() => handleFetchDescription(false)}
                    maxLength={INPUT_LIMITS.url}
                    placeholder="https://example.com"
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="title">Title *</label>
                  <input
                    type="text"
                    id="title"
                    name="title"
                    value={formData.title}
                    onChange={handleInputChange}
                    maxLength={INPUT_LIMITS.title}
                    placeholder="My Awesome Bookmark"
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="tags">Tags</label>
                  <div className="tag-input-shell">
                    {parseTags(formData.tags).map((tag) => (
                      <span key={tag} className="tag-stock tag-input-pill">
                        <span>{tag}</span>
                        <button
                          type="button"
                          className="tag-pill-remove"
                          aria-label={`Remove tag ${tag}`}
                          onClick={() => removeAddTag(tag)}
                        >
                          x
                        </button>
                      </span>
                    ))}
                    <input
                      type="text"
                      id="tags"
                      value={tagDraft}
                      maxLength={INPUT_LIMITS.tagName}
                      onChange={(e) => setTagDraft(e.target.value)}
                      onKeyDown={handleAddTagDraftKeyDown}
                      aria-describedby="tags-hint"
                      placeholder="Type tag, press comma"
                    />
                  </div>
                  {addTagSuggestion && (
                    <div className="tag-input-suggestion" aria-live="polite">
                      Press Tab to use <strong>{addTagSuggestion}</strong>
                    </div>
                  )}
                  <small id="tags-hint">Press Comma or Space to lock in a new tag &middot; Enter to save</small>
                </div>
                <div className="form-group">
                  <div className="field-header">
                    <label htmlFor="description">Description (optional)</label>
                    <button
                      type="button"
                      className="btn-field-action"
                      onClick={() => handleFetchDescription(true)}
                      disabled={!formData.url.trim() || fetchingDescription}
                    >
                      <FileText size={13} /><span>{fetchingDescription ? 'Fetching...' : 'Fetch From Site'}</span>
                      <ActionInfo text="Attempts to read the page metadata and fill the description field. If a site blocks scraping, this may fail." />
                    </button>
                  </div>
                  <textarea
                    id="description"
                    name="description"
                    value={formData.description}
                    onChange={handleInputChange}
                    maxLength={INPUT_LIMITS.description}
                    rows="3"
                    placeholder="Brief description of this bookmark"
                  ></textarea>
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn-primary">Save bookmark</button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setShowAddForm(false)
                      setFormData({ title: '', url: '', tags: '', description: '' })
                      setTagDraft('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {!isPaidMember && (
            <section className="membership-summary membership-summary-free">
              <div className="membership-summary-head">
                <strong>Free Plan</strong>
                <span>{bookmarkUsageCount} / {FREE_BOOKMARK_LIMIT} bookmarks used</span>
              </div>
              <div className="usage-meter" aria-hidden="true">
                <div className="usage-meter-bar" style={{ width: `${freeUsagePercent}%` }} />
              </div>
              <div className="membership-summary-actions">
                <div className="upgrade-plan-toggle" role="group" aria-label="Choose billing plan">
                  <button
                    type="button"
                    className={`upgrade-plan-btn ${usageUpgradePlan === 'monthly' ? 'active' : ''}`}
                    aria-pressed={usageUpgradePlan === 'monthly'}
                    onClick={() => setUsageUpgradePlan('monthly')}
                    disabled={startingUpgrade}
                  >
                    Monthly
                  </button>
                  <button
                    type="button"
                    className={`upgrade-plan-btn ${usageUpgradePlan === 'annual' ? 'active' : ''}`}
                    aria-pressed={usageUpgradePlan === 'annual'}
                    onClick={() => setUsageUpgradePlan('annual')}
                    disabled={startingUpgrade}
                  >
                    Annual
                  </button>
                </div>
                <button
                  type="button"
                  className="upgrade-placeholder-link"
                  onClick={handleUpgradeFromUsageCard}
                  disabled={startingUpgrade}
                >
                  {startingUpgrade ? 'Opening checkout...' : `Upgrade (${usageUpgradePlan === 'monthly' ? 'Monthly' : 'Annual'})`}
                </button>
              </div>
              {isFreeLimitReached && (
                <p className="usage-limit-warning">You reached the free limit. Upgrade to paid to keep adding bookmarks.</p>
              )}
            </section>
          )}
                  </BookmarkBrowser>
                </main>
                <AppFooter version={version}>
                  <Link className="footer-privacy-link" to="/privacy">Privacy Policy</Link>
                  <Link className="footer-privacy-link" to="/support">Support</Link>
                </AppFooter>
              </div>
            ) : homeElement
          }
        />
        <Route path="*" element={<NotFound logoSrc={logoSrc} theme={theme} onSelectTheme={selectTheme} />} />
      </Routes>
    </Suspense>
    <Suspense fallback={null}>
      <ConsentBanner />
    </Suspense>
    </>
  )
}

export default App
