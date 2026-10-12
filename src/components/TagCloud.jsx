import { useState, useEffect, useCallback } from 'react';
import { bookmarksAPI } from '../api/api';
import { Search, Plus, Star, X } from 'lucide-react';
import './TagCloud.css';

function TagCloud({ tags: providedTags, selectedTags = [], onTagSelect, onTagAdd, onTagFavoriteToggle, refreshKey = 0, showActions = true }) {
  const selfManaged = providedTags === undefined;
  const [fetchedTags, setFetchedTags] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tagSearch, setTagSearch] = useState('');

  const fetchTags = useCallback(async () => {
    try {
      setLoading(true);
      const response = await bookmarksAPI.getAllTags();
      setFetchedTags(response.data.tags);
    } catch (error) {
      console.error('Failed to fetch tags:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selfManaged) {
      fetchTags();
    }
  }, [selfManaged, refreshKey, fetchTags]);

  const tags = selfManaged ? fetchedTags : providedTags;

  // Size each tag by how much it's used relative to the busiest tag, so the
  // rack doubles as a picture of the library. Log scale, because tag counts are
  // long-tailed: a few heavy tags and many used once or twice. Five steps, 1-5.
  const maxCount = tags.reduce((max, tag) => Math.max(max, Number(tag.count) || 0), 0);
  const getTagSize = (count) => {
    if (maxCount <= 1) return 3;
    const weight = Math.log(Math.max(1, Number(count) || 0)) / Math.log(maxCount);
    return 1 + Math.round(weight * 4);
  };

  const query = tagSearch.trim().toLowerCase();
  const visibleTags = !query
    ? tags
    : tags.filter((tag) => tag.name?.toLowerCase().includes(query));

  return (
    <div className="tag-cloud">
      <div className="tag-cloud-header">
        <h3>Tags</h3>
        <span className="tag-count">{tags.length}</span>
      </div>

      <div className="tag-cloud-search">
        <Search size={14} className="tag-cloud-search-icon" />
        <input
          type="text"
          value={tagSearch}
          onChange={(e) => setTagSearch(e.target.value)}
          placeholder="Filter tags"
          aria-label="Filter tags"
        />
        {tagSearch && (
          <button
            type="button"
            className="tag-cloud-search-clear"
            onClick={() => setTagSearch('')}
            aria-label="Clear tag filter"
            title="Clear tag filter"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {loading ? (
        <div className="tag-cloud-loading">Loading tags...</div>
      ) : tags.length === 0 ? (
        <div className="tag-cloud-empty">
          <p>Tags you add to bookmarks show up here.</p>
        </div>
      ) : visibleTags.length === 0 ? (
        <div className="tag-cloud-empty">
          <p>No tags match that filter.</p>
        </div>
      ) : (
        <div className="tag-cloud-items">
          {visibleTags.map((tag) => {
            const normalizedTag = tag.name?.toLowerCase();
            const isSelected = selectedTags.includes(normalizedTag);
            const isFavorite = Boolean(tag.is_favorite);

            return (
              <div
                key={tag.id ?? tag.name}
                className={`tag-stock tag-cloud-item tag-size-${getTagSize(tag.count)} ${showActions ? 'tag-cloud-item--actions' : ''} ${isSelected ? 'tag-stock--active active' : ''} ${isFavorite ? 'is-favorite' : ''}`}
                title={`${tag.name}: ${tag.count} bookmark${tag.count !== 1 ? 's' : ''}`}
              >
                <button
                  type="button"
                  className="tag-cloud-chip-name"
                  aria-pressed={isSelected}
                  aria-label={`${tag.name}, ${tag.count} bookmark${tag.count !== 1 ? 's' : ''}`}
                  onClick={() => onTagSelect?.(tag.name)}
                >
                  <span className="tag-name">{tag.name}</span>
                  <span className="tag-badge">{tag.count}</span>
                </button>
                {showActions && (
                  <span className="tag-chip-actions">
                    <button
                      type="button"
                      className={`tag-cloud-chip-plus ${isSelected ? 'active' : ''}`}
                      onClick={() => onTagAdd?.(tag.name)}
                      title={isSelected ? 'Already in filter' : `Add ${tag.name} to filter`}
                      aria-label={isSelected ? `${tag.name} already in filter` : `Add ${tag.name} to filter`}
                      disabled={isSelected}
                    >
                      <Plus size="0.85em" aria-hidden="true" />
                    </button>
                    {onTagFavoriteToggle && (
                      <button
                        type="button"
                        className={`tag-cloud-chip-star ${isFavorite ? 'active' : ''}`}
                        onClick={() => onTagFavoriteToggle(tag)}
                        title={isFavorite ? `Remove ${tag.name} from favorites` : `Mark ${tag.name} as a favorite`}
                        aria-label={`Favorite ${tag.name}`}
                        aria-pressed={isFavorite}
                      >
                        <Star size="0.85em" fill={isFavorite ? 'currentColor' : 'none'} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default TagCloud;
