/**
 * Exercises the exact request sequence the frontend performs, from the Vite
 * origin, so the auth flow is verified end to end without a browser:
 *
 *   login -> bearer call -> refresh (cookie rotation) -> call with the new
 *   token -> replay the old cookie (must be refused) -> logout
 *
 * Run with the API on :3000.  node scripts/smoke-client-flow.mjs
 */
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173';
const IDENTIFIER = process.env.IDENTIFIER ?? '01711000001';
const PASSWORD = process.env.PASSWORD ?? 'Admin#2026';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Pulls the refresh cookie out of Set-Cookie, as a browser would. */
function refreshCookie(response) {
  const header = response.headers.getSetCookie?.() ?? [];
  const cookie = header.find((value) => value.startsWith('kz_refresh='));
  return cookie ? cookie.split(';')[0] : null;
}

async function call(path, { method = 'GET', token, cookie, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { response, json };
}

async function main() {
  console.log(`\nFrontend request flow against ${API} (Origin: ${ORIGIN})\n`);

  // 1. Sign in.
  const login = await call('/auth/login', { method: 'POST', body: { identifier: IDENTIFIER, password: PASSWORD } });
  check('login returns 200', login.response.status === 200, `got ${login.response.status}`);
  check('CORS allows the Vite origin with credentials', login.response.headers.get('access-control-allow-origin') === ORIGIN);
  check('response uses the { data, meta } envelope', Boolean(login.json?.data && login.json?.meta));

  const accessToken = login.json?.data?.accessToken;
  const cookie = refreshCookie(login.response);
  check('an access token came back', typeof accessToken === 'string' && accessToken.length > 20);
  check('the refresh cookie was set', cookie !== null);

  const setCookie = (login.response.headers.getSetCookie?.() ?? []).find((v) => v.startsWith('kz_refresh='));
  check('the refresh cookie is httpOnly', Boolean(setCookie?.includes('HttpOnly')));
  check('the refresh cookie is scoped to /auth', Boolean(setCookie?.includes('Path=/api/v1/auth')));

  // 2. A normal authenticated call.
  const me = await call('/auth/me', { token: accessToken });
  check('GET /auth/me with the bearer token', me.response.status === 200, `got ${me.response.status}`);
  check('the profile is the account we signed in as', me.json?.data?.role === 'ADMIN');

  // 3. Something with money in it, to confirm poisha come through as integers.
  const dashboard = await call('/dashboard/combined', { token: accessToken });
  check('GET /dashboard/combined', dashboard.response.status === 200, `got ${dashboard.response.status}`);
  const revenue = dashboard.json?.data?.today?.combined?.revenue?.current;
  check('revenue is an integer number of poisha', Number.isInteger(revenue), `got ${revenue}`);

  // 4. Rotate, exactly as the app does on a 401.
  const refreshed = await call('/auth/refresh', { method: 'POST', cookie });
  check('POST /auth/refresh with the cookie', refreshed.response.status === 200, `got ${refreshed.response.status}`);
  const newToken = refreshed.json?.data?.accessToken;
  const newCookie = refreshCookie(refreshed.response);

  // Not compared against the old one: a JWT signed in the same second with an
  // identical payload is byte-identical, so equality here says nothing. What
  // matters is that a usable token came back and that the *refresh* token —
  // which carries a fresh jti — was rotated.
  check('an access token came back', typeof newToken === 'string' && newToken.length > 20);
  check('the refresh cookie was rotated', newCookie !== null && newCookie !== cookie);

  const afterRefresh = await call('/auth/me', { token: newToken });
  check('the rotated token works', afterRefresh.response.status === 200);

  // 5. Replaying the consumed cookie must be refused — this is why the client
  //    serialises refreshes behind a mutex.
  const replay = await call('/auth/refresh', { method: 'POST', cookie });
  check('replaying the old refresh cookie is refused', replay.response.status === 401, `got ${replay.response.status}`);
  check('the refusal carries a readable message', typeof replay.json?.message === 'string');

  // 6. An unknown origin gets no CORS headers.
  const foreign = await fetch(`${API}/auth/me`, {
    headers: { origin: 'https://evil.example.com', authorization: `Bearer ${newToken}` },
  });
  check('a foreign origin gets no allow-origin header', foreign.headers.get('access-control-allow-origin') === null);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('\nSmoke run failed:', error.message, '\n');
  process.exitCode = 1;
});
