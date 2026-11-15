import { publicNavigationLinks } from '../../src/content/publicNavigation.js';

// Only fixed navigation data is rendered here; no request or user input. The
// snapshot remains usable without JavaScript and always shows anonymous actions.
export function renderPublicHeader() {
  const logo = (variant) => `<picture class="logo-picture ssr-logo--${variant}"><source srcset="/logo-${variant}.webp 255w, /logo-${variant}-large.webp 560w" sizes="80px" type="image/webp" /><img src="/logo-${variant}-small.png" alt="Tagstash" width="560" height="440" class="app-header-logo" /></picture>`;
  const links = publicNavigationLinks().map((link, index, all) => `<a href="${link.href}"${index === all.length - 1 ? ' class="public-header-action"' : ''}>${link.label}</a>`).join('');
  return `<header class="public-header"><a href="/" class="app-header-logo-btn" title="Back to Tagstash">${logo('dark')}${logo('light')}</a><nav class="public-header-nav" aria-label="Main">${links}</nav></header>`;
}
