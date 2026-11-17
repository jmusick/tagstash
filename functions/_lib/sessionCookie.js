// The web session lives in an HttpOnly cookie. Shared by the API (which reads and sets
// it) and the homepage SSR (which only checks whether one was sent).
export const isLocalRequest = (request) => {
  const url = new URL(request.url);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
};

export const sessionCookieName = (request) => isLocalRequest(request) ? 'tagstash-session' : '__Host-tagstash-session';

export const getSessionCookie = (request) => {
  const name = `${sessionCookieName(request)}=`;
  return (request.headers.get('Cookie') || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(name))?.slice(name.length) || null;
};
