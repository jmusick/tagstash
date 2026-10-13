// functions/u/[username].js server-renders an indexable profile's bookmarks into
// <div id="ssr-profile"> just before #root, and src/App.css hides #root while it is there
// (`#ssr-profile + #root`). The app mounts and loads behind it; whoever is done with it
// removes it, which reveals #root in the same frame:
// - PublicProfile, in a layout effect, once its real list (or not-found/error state) has
//   rendered, so there is never a blank or "Loading..." frame;
// - App, as soon as the route is no longer the page the snapshot was rendered for;
// - ErrorBoundary, so a crash never stays hidden behind it.
// Without JS it simply stays, which is what non-JS crawlers should see.
export const PROFILE_SNAPSHOT_ID = 'ssr-profile'

// The snapshot only ever describes the page the browser first loaded.
const initialPathname = typeof window === 'undefined' ? '' : window.location.pathname

export function removeProfileSnapshot() {
  if (typeof document === 'undefined') return
  document.getElementById(PROFILE_SNAPSHOT_ID)?.remove()
}

export function isSnapshotPath(pathname) {
  return pathname === initialPathname
}
