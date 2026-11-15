import { useState } from 'react';

// A working miniature of the app for the home page: pick tags, watch the list
// narrow. Sample data only; nothing here talks to the API.
const DEMO_TAGS = ['recipes', 'reference', 'design', 'hiking', 'weeknight'];

const DEMO_BOOKMARKS = [
  { title: 'Weeknight chili with dried chiles', domain: 'seriouseats.com', tags: ['recipes', 'weeknight'] },
  { title: 'CSS grid layout guide', domain: 'developer.mozilla.org', tags: ['reference', 'design'] },
  { title: 'Practical Typography', domain: 'practicaltypography.com', tags: ['design', 'reference'] },
  { title: 'Rattlesnake Ledge trail notes', domain: 'alltrails.com', tags: ['hiking'] },
  { title: 'Sheet-pan gnocchi', domain: 'bonappetit.com', tags: ['recipes', 'weeknight'] },
  { title: 'Ten essentials packing list', domain: 'rei.com', tags: ['hiking', 'reference'] },
];

function HomeTagDemo() {
  const [selected, setSelected] = useState([]);

  const toggle = (tag) => {
    setSelected((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const visible = DEMO_BOOKMARKS.filter((b) => selected.every((tag) => b.tags.includes(tag)));

  return (
    <div className="tag-demo">
      <p className="tag-demo-prompt" id="tag-demo-prompt">
        Pick tags to filter. Combine them to narrow down.
      </p>
      <div className="tag-demo-rack" role="group" aria-labelledby="tag-demo-prompt">
        {DEMO_TAGS.map((tag) => {
          const isOn = selected.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              className={`tag-stock ${isOn ? 'tag-stock--active' : ''}`}
              aria-pressed={isOn}
              onClick={() => toggle(tag)}
            >
              {tag}
            </button>
          );
        })}
        <button type="button" className="tag-demo-clear" disabled={!selected.length} onClick={() => setSelected([])}>Clear tags</button>
      </div>
      <ul className="tag-demo-list" aria-live="polite" aria-label="Sample bookmarks" tabIndex={0}>
        {visible.map((b) => (
          <li key={b.title} className="tag-demo-item">
            <span className="tag-demo-title">{b.title}</span>
            <span className="tag-demo-domain">{b.domain}</span>
            <span className="tag-demo-tags">{b.tags.map(tag => <span key={tag} className="tag-stock">{tag}</span>)}</span>
          </li>
        ))}
        {visible.length === 0 && (
          <li className="tag-demo-empty">No bookmarks have all of those tags.</li>
        )}
      </ul>
      <p className="tag-demo-count">
        {visible.length} of {DEMO_BOOKMARKS.length} bookmarks
      </p>
    </div>
  );
}

export default HomeTagDemo;
