import { onRequest } from '../../functions/api/[[path]].js';

// Calls the real API dispatcher. `body` objects are JSON-encoded; strings and streams are sent as-is.
export const call = (env, path, { method = 'GET', headers = {}, body, contentType = 'application/json' } = {}) => {
  const init = { method, headers: { ...(contentType ? { 'Content-Type': contentType } : {}), ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body);
    if (body instanceof ReadableStream) init.duplex = 'half';
  }
  return onRequest({ env, request: new Request(`https://tagsta.sh/api/${path}`, init) });
};

// Bearer-token login for the seeded user (id 1) from createAuthEnv.
export async function loginHeaders(env) {
  const response = await call(env, 'auth/login', {
    method: 'POST', body: { email: 'session@example.com', password: env.password },
  });
  if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
  const { token } = await response.json();
  return { Authorization: `Bearer ${token}` };
}
