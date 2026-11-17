import { IMPORT_GUIDE_PATHS } from '../src/content/importGuides.js';
import { EXTENSION_META } from '../src/content/browserExtension.js';

// Pages otherwise serves the SPA shell with status 200 for unknown addresses.
const PAGE_PATHS = new Set(['/', '/features', '/pricing', '/developers', EXTENSION_META.path, '/privacy', '/support', '/settings', '/tags', '/trash', '/duplicates', '/share', '/verify-email', '/reset-password', ...IMPORT_GUIDE_PATHS]);

export async function onRequest({ request, next }) {
  const response = await next();
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  if (PAGE_PATHS.has(pathname) || /^\/u\/[^/]+$/.test(pathname) || pathname === '/api' || pathname.startsWith('/api/')) {
    return response;
  }
  if (response.status !== 200 || !(response.headers.get('Content-Type') || '').includes('text/html')) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex');
  return new Response(response.body, { status: 404, headers });
}
