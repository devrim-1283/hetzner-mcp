/**
 * The transport, with `fetch` replaced.
 *
 * The suite is organised around the things that cannot be allowed to regress,
 * which is not the same list as "the things the client does":
 *
 *   - The gates run BEFORE the credential is resolved. Asserted with a spy on
 *     `credential.resolve`, because "it threw" would pass either way and the
 *     property being protected is that a blocked call never touches the secret
 *     store.
 *   - The credential never leaves. Asserted on a response that echoes it back,
 *     which is what a request-echo endpoint or a misconfigured proxy produces.
 *   - A POST is not retried. This is the single most expensive mistake the file
 *     can make — a retried `POST /servers` provisions and bills a second
 *     machine — so it is asserted per status class rather than once.
 *
 * `fetch` is stubbed, never called for real. Where a wait has to elapse, fake
 * timers drive it: `AbortSignal.timeout` uses Node's internal timer rather than
 * the global one, so it stays real and cannot fire during a faked test.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HetznerError, SURFACE_AUTH, SURFACE_BASE_URLS } from '../src/types.js';
import type {
  Connection,
  HetznerRequest,
  HttpMethod,
  ResolvedCredential,
  Surface,
} from '../src/types.js';
import {
  MAX_ATTEMPTS,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  USER_AGENT,
  configureTransport,
  request,
} from '../src/http/client.js';

/** Long enough to exercise the scrubber, which ignores short values on purpose. */
const TOKEN = 'hcloud_9f2Ab7QxZm4LtVeR8sNpKdYc3JwHuG6XoTiB1lS0EnMqPrDaFvUyCkZjWgXh';
const ROBOT_USER = '#4711+ws';
const ROBOT_PASSWORD = 'sV8nQ2rLpX4mZ7tK';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // The transport context is module state; a test that sets a ceiling must not
  // leak it into the next file.
  configureTransport({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  configureTransport({});
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function credentialFor(surface: Surface) {
  return {
    kind: SURFACE_AUTH[surface],
    resolve: vi.fn(async (): Promise<ResolvedCredential> =>
      SURFACE_AUTH[surface] === 'bearer'
        ? { kind: 'bearer', token: TOKEN }
        : { kind: 'basic', user: ROBOT_USER, password: ROBOT_PASSWORD },
    ),
  };
}

function connection(overrides: Partial<Connection> = {}): Connection {
  const surface = overrides.surface ?? 'cloud';
  return {
    name: 'main',
    surface,
    baseUrl: SURFACE_BASE_URLS[surface],
    readOnly: false,
    allowDestructive: true,
    timeoutMs: 30_000,
    credential: credentialFor(surface),
    ...overrides,
  };
}

function get(overrides: Partial<HetznerRequest> = {}): HetznerRequest {
  return { connection: connection(), method: 'GET', path: '/servers', ...overrides };
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/**
 * A fresh `Response` per call, never one shared instance.
 *
 * A `Response` body can only be read once, so a mock that hands the same object
 * to every attempt makes the second read throw — which would look exactly like
 * a transport failure and quietly turn every retry assertion into a test of the
 * wrong code path.
 */
function always(make: () => Response): void {
  fetchMock.mockImplementation(async () => make());
}

function headersOf(call = 0): Record<string, string> {
  const init = fetchMock.mock.calls[call]?.[1];
  return (init?.headers ?? {}) as Record<string, string>;
}

function urlOf(call = 0): string {
  return String(fetchMock.mock.calls[call]?.[0]);
}

async function rejection(promise: Promise<unknown>): Promise<HetznerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HetznerError) return error;
    throw error;
  }
  throw new Error('expected the request to be refused');
}

/**
 * Settles a request that has to wait, without leaving an unhandled rejection
 * hanging while the fake clock runs forward.
 */
async function withTimers<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const settled = start().then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if (result.ok) return result.value;
  throw result.error;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('User-Agent', () => {
  it('stays in step with package.json', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { name: string; version: string };

    expect(PACKAGE_NAME).toBe(manifest.name);
    expect(PACKAGE_VERSION).toBe(manifest.version);
  });

  it('is sent, and names the package and its version', async () => {
    always(() => json({ servers: [] }));
    await request(get());

    expect(headersOf()['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toContain(PACKAGE_NAME);
    expect(USER_AGENT).toContain(PACKAGE_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Per-surface authentication
// ---------------------------------------------------------------------------

describe('authentication is decided by the surface', () => {
  it.each(['cloud', 'hetzner'] as Surface[])('sends a bearer token on %s', async (surface) => {
    always(() => json({ ok: true }));
    await request(get({ connection: connection({ surface }) }));

    expect(headersOf()['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('sends HTTP Basic on robot, base64 of user:password', async () => {
    always(() => json({ ok: true }));
    await request(get({ connection: connection({ surface: 'robot' }) }));

    const expected = Buffer.from(`${ROBOT_USER}:${ROBOT_PASSWORD}`, 'utf8').toString('base64');
    expect(headersOf()['authorization']).toBe(`Basic ${expected}`);
  });

  it("targets the surface's own host", async () => {
    always(() => json({ ok: true }));
    await request(get({ connection: connection({ surface: 'robot' }), path: '/server' }));

    expect(urlOf()).toBe('https://robot-ws.your-server.de/server');
  });

  it('refuses when a bearer surface produced no token', async () => {
    const conn = connection();
    conn.credential.resolve = vi.fn(async (): Promise<ResolvedCredential> => ({
      kind: 'bearer',
      token: '   ',
    }));

    const error = await rejection(request(get({ connection: conn })));

    expect(error.kind).toBe('unauthenticated');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when robot produced only half of a basic credential', async () => {
    const conn = connection({ surface: 'robot' });
    conn.credential.resolve = vi.fn(async (): Promise<ResolvedCredential> => ({
      kind: 'basic',
      user: ROBOT_USER,
      password: '',
    }));

    const error = await rejection(request(get({ connection: conn })));

    expect(error.kind).toBe('unauthenticated');
    expect(error.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The credential never leaves
// ---------------------------------------------------------------------------

describe('the credential never appears in output', () => {
  it('scrubs a body that echoes the Authorization header', async () => {
    always(() => json({ headers: { authorization: `Bearer ${TOKEN}` }, note: 'echo service' }));

    const response = await request(get());

    expect(JSON.stringify(response.data)).not.toContain(TOKEN);
    expect(JSON.stringify(response.data)).toContain('***');
  });

  it('scrubs it out of an error body too, so it cannot reach a hint', async () => {
    always(() =>
      json(
        { error: { code: 'unauthorized', message: `token ${TOKEN} rejected` } },
        { status: 401 },
      ),
    );

    const error = await rejection(request(get()));

    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('***');
    expect(JSON.stringify({ m: error.message, h: error.hint })).not.toContain(TOKEN);
  });

  it('scrubs the basic blob and the password on robot', async () => {
    const encoded = Buffer.from(`${ROBOT_USER}:${ROBOT_PASSWORD}`, 'utf8').toString('base64');
    always(() => json({ seen: `Basic ${encoded}`, also: `password=${ROBOT_PASSWORD}` }));

    const response = await request(get({ connection: connection({ surface: 'robot' }) }));
    const body = JSON.stringify(response.data);

    expect(body).not.toContain(encoded);
    expect(body).not.toContain(ROBOT_PASSWORD);
  });

  it("does not leak a credential helper's own error text", async () => {
    const conn = connection();
    conn.credential.resolve = vi.fn(async () => {
      throw new Error(`vault read failed for ${TOKEN}`);
    });

    const error = await rejection(request(get({ connection: conn })));

    // The helper put the secret in its own message. Quoting that text is the
    // obvious thing to do and the wrong thing to do: we cannot scrub a value we
    // never learned, so the shape of the failure is reported and the text is
    // left where it was written.
    expect(error.message).not.toContain(TOKEN);
    expect(error.hint).not.toContain(TOKEN);
    expect(error.message).toContain('threw Error');
  });

  it('never puts the credential in the URL', async () => {
    always(() => json({ ok: true }));
    await request(get({ query: { page: 2 } }));

    expect(urlOf()).not.toContain(TOKEN);
    expect(urlOf()).toBe('https://api.hetzner.cloud/v1/servers?page=2');
  });
});

// ---------------------------------------------------------------------------
// Origin pinning
// ---------------------------------------------------------------------------

describe('origin pinning', () => {
  it('refuses an absolute URL smuggled in as the path', async () => {
    const error = await rejection(request(get({ path: 'https://evil.example.com/steal' })));

    expect(error.kind).toBe('validation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a protocol-relative path, which would change the host', async () => {
    const error = await rejection(request(get({ path: '//evil.example.com/steal' })));

    expect(error.message).toMatch(/protocol-relative/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/servers/../../etc',
    '/servers/%2e%2e/%2e%2e/etc',
    '/servers/./42',
    '/servers/%2E%2E/admin',
  ])('refuses traversal in %s', async (path) => {
    const error = await rejection(request(get({ path })));

    expect(error.kind).toBe('validation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['/servers?page=2', '/servers#frag', '/servers\\42', '/servers 42'])(
    'refuses %s',
    async (path) => {
      await rejection(request(get({ path })));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('refuses a control character in the path', async () => {
    await rejection(request(get({ path: `/servers/${String.fromCharCode(10)}42` })));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the API prefix on cloud', async () => {
    always(() => json({ ok: true }));
    await request(get({ path: '/servers/42/actions' }));

    expect(urlOf()).toBe('https://api.hetzner.cloud/v1/servers/42/actions');
  });

  it('drops undefined query values rather than sending "undefined"', async () => {
    always(() => json({ ok: true }));
    await request(get({ query: { page: 1, label_selector: undefined, sort: 'name' } }));

    expect(urlOf()).toBe('https://api.hetzner.cloud/v1/servers?page=1&sort=name');
  });
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

describe('redirects are refused, never followed', () => {
  it.each([301, 302, 303, 307, 308])('refuses %i to another host', async (status) => {
    always(
      () =>
        new Response(null, { status, headers: { location: 'https://evil.example.com/collect' } }),
    );

    const error = await rejection(request(get()));

    expect(error.kind).toBe('network');
    expect(error.message).toMatch(/Refused to follow a redirect/);
    expect(error.message).toContain('evil.example.com');
  });

  it('states that the credential was not sent to the target', async () => {
    always(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.com/collect' },
        }),
    );

    const error = await rejection(request(get()));

    expect(error.hint).toContain('credential was NOT sent to the redirect target');
  });

  it('refuses a same-host redirect too', async () => {
    always(() => new Response(null, { status: 307, headers: { location: '/v1/servers/other' } }));

    const error = await rejection(request(get()));

    expect(error.kind).toBe('network');
  });

  it('asks fetch not to follow redirects itself', async () => {
    always(() => json({ ok: true }));
    await request(get());

    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe('the read-only gate', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as HttpMethod[])(
    'refuses %s before any socket opens',
    async (method) => {
      const conn = connection({ readOnly: true });

      const error = await rejection(request({ connection: conn, method, path: '/servers/42' }));

      expect(error.kind).toBe('read_only_connection');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(conn.credential.resolve).not.toHaveBeenCalled();
    },
  );

  it('still allows GET', async () => {
    always(() => json({ servers: [] }));
    await request(get({ connection: connection({ readOnly: true }) }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is a ceiling: the global flag closes a connection the file left open', async () => {
    configureTransport({ readOnly: true });
    const conn = connection({ readOnly: false });

    const error = await rejection(request({ connection: conn, method: 'POST', path: '/servers' }));

    expect(error.kind).toBe('read_only_connection');
    expect(error.hint).toMatch(/whole server is running read-only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a ceiling: a connection cannot re-open what the global flag closed', async () => {
    // Every combination of a "more permissive" connection setting, to make the
    // asymmetry explicit rather than incidental.
    configureTransport({ readOnly: true });

    for (const conn of [connection({ readOnly: false }), connection({ allowDestructive: true })]) {
      const error = await rejection(
        request({ connection: conn, method: 'PATCH', path: '/servers/1' }),
      );
      expect(error.kind).toBe('read_only_connection');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names a writable sibling on the same surface when one exists', async () => {
    const writable = connection({ name: 'ops' });
    const registry = {
      connections: new Map([
        ['main', connection({ readOnly: true })],
        ['ops', writable],
      ]),
      source: 'file' as const,
      shadowed: [],
    };
    configureTransport({ registry });

    const error = await rejection(
      request({ connection: connection({ readOnly: true }), method: 'POST', path: '/servers' }),
    );

    expect(error.hint).toContain('`ops`');
  });
});

describe('the destructive gate', () => {
  it('blocks a DELETE with no catalog help at all', async () => {
    const conn = connection({ allowDestructive: false });

    const error = await rejection(
      request({ connection: conn, method: 'DELETE', path: '/servers/42' }),
    );

    expect(error.kind).toBe('destructive_blocked');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(conn.credential.resolve).not.toHaveBeenCalled();
  });

  it('blocks a rebuild, which is a POST and returns 201', async () => {
    const conn = connection({ allowDestructive: false });

    const error = await rejection(
      request({ connection: conn, method: 'POST', path: '/servers/42/actions/rebuild' }),
    );

    expect(error.kind).toBe('destructive_blocked');
  });

  it('blocks a snapshot rollback, which overwrites live data', async () => {
    const conn = connection({ allowDestructive: false });

    const error = await rejection(
      request({
        connection: conn,
        method: 'POST',
        path: '/storage_boxes/9/actions/rollback_snapshot',
      }),
    );

    expect(error.kind).toBe('destructive_blocked');
  });

  it('takes the catalog verdict when it is STRICTER than the baseline', async () => {
    configureTransport({ classifyOperation: () => 'destructive' });
    const conn = connection({ allowDestructive: false });

    const error = await rejection(
      request({
        connection: conn,
        method: 'POST',
        path: '/servers/42/actions/poweroff',
        operationId: 'poweroff_server',
      }),
    );

    expect(error.kind).toBe('destructive_blocked');
  });

  it('ignores a catalog verdict that is LOOSER — a misfiled DELETE cannot unlock', async () => {
    configureTransport({ classifyOperation: () => 'safe' });
    const conn = connection({ allowDestructive: false });

    const error = await rejection(
      request({
        connection: conn,
        method: 'DELETE',
        path: '/servers/42',
        operationId: 'delete_server',
      }),
    );

    expect(error.kind).toBe('destructive_blocked');
  });

  it('reads the generated catalog when no classifier was configured', async () => {
    // `import_zone_zonefile` is a POST — a baseline `write` — that the catalog
    // classifies as destructive because it replaces the whole zone. Nothing is
    // stubbed here on purpose: this is the only test that exercises the real
    // lazy import of src/generated, which is owned by another agent.
    const conn = connection({ allowDestructive: false });

    const error = await rejection(
      request({
        connection: conn,
        method: 'POST',
        path: '/zones/example.com/actions/import_zonefile',
        operationId: 'import_zone_zonefile',
        body: { zonefile: '...' },
      }),
    );

    expect(error.kind).toBe('destructive_blocked');
    expect(conn.credential.resolve).not.toHaveBeenCalled();
  });

  it('lets a plain write through when the catalog agrees it is a write', async () => {
    always(() => json({ server: { id: 42 } }));

    const response = await request({
      connection: connection({ allowDestructive: false }),
      method: 'POST',
      path: '/servers/42/actions/poweron',
      operationId: 'poweron_server',
    });

    expect(response.status).toBe(200);
  });

  it('survives a classifier that throws, falling back to the baseline', async () => {
    configureTransport({
      classifyOperation: () => {
        throw new Error('catalog is mid-rewrite');
      },
    });
    const conn = connection({ allowDestructive: false });

    const error = await rejection(
      request({
        connection: conn,
        method: 'DELETE',
        path: '/servers/42',
        operationId: 'delete_server',
      }),
    );

    expect(error.kind).toBe('destructive_blocked');
  });

  it('lets a destructive call through when the connection allows it', async () => {
    always(() => json({ action: { id: 1 } }));
    await request({
      connection: connection({ allowDestructive: true }),
      method: 'DELETE',
      path: '/servers/42',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a refused request never resolves the credential', () => {
  const REFUSALS: Array<[label: string, conn: Connection, method: HttpMethod, path: string]> = [
    ['a destructive block', connection({ allowDestructive: false }), 'DELETE', '/servers/42'],
    ['a read-only block', connection({ readOnly: true }), 'POST', '/servers'],
    ['an invalid path', connection(), 'GET', '//evil.example.com'],
  ];

  it.each(REFUSALS)('does not touch the secret store on %s', async (_label, conn, method, path) => {
    await rejection(request({ connection: conn, method, path }));

    expect(conn.credential.resolve).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rate limit headers
// ---------------------------------------------------------------------------

describe('rate limit headers', () => {
  it('parses all three, with the reset as epoch seconds', async () => {
    const resetAt = Math.round(Date.now() / 1000) + 600;
    always(() =>
      json(
        { servers: [] },
        {
          headers: {
            'RateLimit-Limit': '3600',
            'RateLimit-Remaining': '3421',
            'RateLimit-Reset': String(resetAt),
          },
        },
      ),
    );

    const response = await request(get());

    expect(response.rateLimit).toEqual({ limit: 3600, remaining: 3421, resetAt });
  });

  it('normalizes a delta-seconds reset into an absolute epoch', async () => {
    always(() =>
      json(
        {},
        {
          headers: {
            'RateLimit-Limit': '3600',
            'RateLimit-Remaining': '10',
            'RateLimit-Reset': '60',
          },
        },
      ),
    );

    const response = await request(get());
    const expected = Math.round(Date.now() / 1000) + 60;

    expect(response.rateLimit?.resetAt).toBeGreaterThanOrEqual(expected - 2);
    expect(response.rateLimit?.resetAt).toBeLessThanOrEqual(expected + 2);
  });

  it('reports limit and remaining without a reset', async () => {
    always(() => json({}, { headers: { 'RateLimit-Limit': '3600', 'RateLimit-Remaining': '1' } }));

    expect(await request(get())).toMatchObject({ rateLimit: { limit: 3600, remaining: 1 } });
  });

  it('omits rateLimit entirely when Robot sends no headers', async () => {
    always(() => json([{ server: {} }]));

    const response = await request(
      get({ connection: connection({ surface: 'robot' }), path: '/server' }),
    );

    expect(response.rateLimit).toBeUndefined();
  });

  it('omits it rather than guessing when only one of the pair arrived', async () => {
    always(() => json({}, { headers: { 'RateLimit-Remaining': '12' } }));

    expect((await request(get())).rateLimit).toBeUndefined();
  });

  it('ignores an unparseable header instead of reporting NaN', async () => {
    always(() => json({}, { headers: { 'RateLimit-Limit': 'lots', 'RateLimit-Remaining': '3' } }));

    expect((await request(get())).rateLimit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

describe('429 handling', () => {
  it('honours Retry-After and succeeds on the retry', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(
          { error: { code: 'rate_limit_exceeded' } },
          { status: 429, headers: { 'retry-after': '1' } },
        ),
      )
      .mockResolvedValueOnce(json({ servers: [] }));

    const response = await withTimers(() => request(get()));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('backs off on its own when Hetzner sent no Retry-After', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 }))
      .mockResolvedValueOnce(json({ servers: [] }));

    const response = await withTimers(() => request(get()));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt bound and reports rate_limited with the reset time', async () => {
    const resetAt = Math.round(Date.now() / 1000) + 300;
    always(() =>
      json(
        { error: { code: 'rate_limit_exceeded', message: 'limit exceeded' } },
        {
          status: 429,
          headers: {
            'retry-after': '1',
            'RateLimit-Limit': '3600',
            'RateLimit-Remaining': '0',
            'RateLimit-Reset': String(resetAt),
          },
        },
      ),
    );

    const error = await rejection(withTimers(() => request(get())));

    expect(error.kind).toBe('rate_limited');
    expect(error.hint).toMatch(/resets in about 5 minutes/);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('does not sit through a Retry-After longer than the request timeout', async () => {
    always(() =>
      json(
        { error: { code: 'rate_limit_exceeded' } },
        { status: 429, headers: { 'retry-after': '3600' } },
      ),
    );

    const error = await rejection(withTimers(() => request(get())));

    expect(error.kind).toBe('rate_limited');
    // Handed straight back to the caller instead of holding the turn open.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('5xx and transport retries', () => {
  it('retries a GET on 500 up to the attempt bound', async () => {
    always(() => json({ error: { code: 'service_error' } }, { status: 500 }));

    const error = await rejection(withTimers(() => request(get())));

    expect(error.kind).toBe('unknown');
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('retries a GET on a transport failure', async () => {
    fetchMock
      .mockRejectedValueOnce(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
        }),
      )
      .mockResolvedValueOnce(json({ servers: [] }));

    const response = await withTimers(() => request(get()));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['PUT', 'PATCH', 'DELETE'] as HttpMethod[])(
    'retries %s, which lands on the same state twice',
    async (method) => {
      fetchMock
        .mockResolvedValueOnce(json({ error: { code: 'service_error' } }, { status: 502 }))
        .mockResolvedValueOnce(json({ ok: true }));

      const response = await withTimers(() =>
        request({ connection: connection(), method, path: '/servers/42', body: { name: 'x' } }),
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('does not retry a 4xx that is not a 429', async () => {
    always(() => json({ error: { code: 'not_found' } }, { status: 404 }));

    await rejection(request(get()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a POST is never re-sent once it may have been received', () => {
  const post = (): HetznerRequest => ({
    connection: connection(),
    method: 'POST',
    path: '/servers',
    body: { name: 'web-1', server_type: 'cx22', image: 'debian-12' },
  });

  it.each([500, 502, 504])(
    'does not retry on %i — the machine may already exist and be billed',
    async (status) => {
      always(() => json({ error: { code: 'service_error' } }, { status }));

      await rejection(withTimers(() => request(post())));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry a 503 with no Retry-After', async () => {
    always(() => json({ error: { code: 'unavailable' } }, { status: 503 }));

    await rejection(withTimers(() => request(post())));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('DOES retry a 503 that carries Retry-After — a load shedder declined the work', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ error: { code: 'unavailable' } }, { status: 503, headers: { 'retry-after': '1' } }),
      )
      .mockResolvedValueOnce(json({ server: { id: 1 } }, { status: 201 }));

    const response = await withTimers(() => request(post()));

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('DOES retry a 429, which Hetzner refused before processing', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(
          { error: { code: 'rate_limit_exceeded' } },
          { status: 429, headers: { 'retry-after': '1' } },
        ),
      )
      .mockResolvedValueOnce(json({ server: { id: 1 } }, { status: 201 }));

    const response = await withTimers(() => request(post()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(201);
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])(
    'DOES retry after %s, where nothing was ever delivered',
    async (code) => {
      fetchMock
        .mockRejectedValueOnce(
          new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) }),
        )
        .mockResolvedValueOnce(json({ server: { id: 1 } }, { status: 201 }));

      const response = await withTimers(() => request(post()));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(response.status).toBe(201);
    },
  );

  it.each(['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET'])(
    'does not retry after %s, where the request may already have been acted on',
    async (code) => {
      fetchMock.mockRejectedValue(
        new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code }) }),
      );

      await rejection(withTimers(() => request(post())));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('pagination', () => {
  it('extracts meta.pagination', async () => {
    always(() =>
      json({
        servers: [{ id: 1 }],
        meta: {
          pagination: {
            page: 2,
            per_page: 25,
            previous_page: 1,
            next_page: 3,
            last_page: 7,
            total_entries: 163,
          },
        },
      }),
    );

    const response = await request(get());

    expect(response.pagination).toEqual({ page: 2, perPage: 25, lastPage: 7, totalEntries: 163 });
  });

  it('tolerates the nulls Hetzner sends on the last page', async () => {
    always(() =>
      json({
        meta: {
          pagination: { page: 1, per_page: 25, next_page: null, last_page: 1, total_entries: 3 },
        },
      }),
    );

    expect((await request(get())).pagination).toEqual({
      page: 1,
      perPage: 25,
      lastPage: 1,
      totalEntries: 3,
    });
  });

  it('omits pagination when the response carries none', async () => {
    always(() => json({ server: { id: 1 } }));

    expect((await request(get())).pagination).toBeUndefined();
  });

  it('does not auto-paginate — one call in, one request out', async () => {
    always(() =>
      json({ servers: [], meta: { pagination: { page: 1, per_page: 25, last_page: 9 } } }),
    );

    await request(get());

    // The shaping layer owns the budget and drives paging through cursors.
    // Fetching page 2 here would spend a budget this file cannot see, on a rate
    // limit shared with every other client on the token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

describe('response bodies', () => {
  it('returns null data for a 204 without trying to parse it', async () => {
    always(() => new Response(null, { status: 204 }));

    const response = await request({
      connection: connection(),
      method: 'DELETE',
      path: '/servers/42',
    });

    expect(response.status).toBe(204);
    expect(response.data).toBeNull();
  });

  it('turns an HTML error page into a mapped error, not a parse exception', async () => {
    always(
      () =>
        new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const error = await rejection(request(get()));

    expect(error).toBeInstanceOf(HetznerError);
    expect(error.message).toContain('text/html');
    expect(error.message).toContain('Bad Gateway');
  });

  it('turns malformed JSON into a mapped error too', async () => {
    always(
      () =>
        new Response('{"servers": [', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const error = await rejection(request(get()));

    expect(error.kind).toBe('unknown');
    expect(error.message).toContain('instead of JSON');
  });

  it('does not assume a cloud envelope for a Robot response', async () => {
    // Robot answers a bare array of wrappers with no `meta` anywhere in sight.
    always(() => json([{ server: { server_ip: '1.2.3.4' } }]));

    const response = await request(
      get({ connection: connection({ surface: 'robot' }), path: '/server' }),
    );

    expect(response.data).toEqual([{ server: { server_ip: '1.2.3.4' } }]);
    expect(response.pagination).toBeUndefined();
  });
});

describe('request bodies', () => {
  it('sends JSON on cloud', async () => {
    always(() => json({ server: {} }, { status: 201 }));
    await request({
      connection: connection(),
      method: 'POST',
      path: '/servers',
      body: { name: 'web-1' },
    });

    expect(headersOf()['content-type']).toBe('application/json');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"name":"web-1"}');
  });

  it('sends form encoding on robot, which predates the cloud API', async () => {
    always(() => json({ boot: {} }));
    await request({
      connection: connection({ surface: 'robot' }),
      method: 'POST',
      path: '/boot/1.2.3.4/rescue',
      body: { os: 'linux', authorized_key: ['aa:bb', 'cc:dd'] },
    });

    expect(headersOf()['content-type']).toBe('application/x-www-form-urlencoded');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      'os=linux&authorized_key%5B%5D=aa%3Abb&authorized_key%5B%5D=cc%3Add',
    );
  });

  it('sends no body, and no content-type, for a bodiless action POST', async () => {
    always(() => json({ action: { id: 1 } }));
    await request({
      connection: connection(),
      method: 'POST',
      path: '/servers/42/actions/poweron',
    });

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(headersOf()['content-type']).toBeUndefined();
  });

  it('sends no body on a GET', async () => {
    always(() => json({ servers: [] }));
    await request(get({ body: { ignored: true } }));

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

describe('timeouts and cancellation are told apart', () => {
  /** Hangs until the composed signal aborts, like a real socket with no answer. */
  function hangUntilAborted() {
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          // Real fetch rejects immediately on an already-aborted signal; a mock
          // that only listens for the event would hang forever when the caller
          // aborted before the socket opened.
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
  }

  it('reports the connection timeout as a timeout', async () => {
    hangUntilAborted();

    const error = await rejection(request(get({ connection: connection({ timeoutMs: 25 }) })));

    expect(error.kind).toBe('network');
    expect(error.message).toMatch(/timed out after 25 ms/);
  });

  it('reports a caller abort as a cancellation, not as a network error', async () => {
    hangUntilAborted();
    const controller = new AbortController();
    const promise = request(get({ signal: controller.signal }));
    controller.abort();

    const error = await rejection(promise);

    expect(error.kind).toBe('cancelled');
    expect(error.message).toMatch(/cancelled by the caller/);
  });

  it('keeps a cancellation and a blown deadline distinguishable', async () => {
    // Both end in an aborted socket. One is a failure the user must see, the
    // other is a turn that was withdrawn — a single kind for the pair would
    // make the tool layer unable to suppress the second without hiding the first.
    hangUntilAborted();
    const timedOut = await rejection(request(get({ connection: connection({ timeoutMs: 25 }) })));

    const controller = new AbortController();
    const promise = request(get({ signal: controller.signal }));
    controller.abort();
    const cancelled = await rejection(promise);

    expect(timedOut.kind).toBe('network');
    expect(cancelled.kind).toBe('cancelled');
    expect(timedOut.kind).not.toBe(cancelled.kind);
  });

  it("prefers the caller's intent when the deadline fired too", async () => {
    hangUntilAborted();
    const controller = new AbortController();
    const promise = request(
      get({ connection: connection({ timeoutMs: 25 }), signal: controller.signal }),
    );
    controller.abort();

    const error = await rejection(promise);

    expect(error.kind).toBe('cancelled');
    expect(error.message).toMatch(/cancelled/);
  });

  it('does not retry after a cancellation', async () => {
    hangUntilAborted();
    const controller = new AbortController();
    const promise = request(get({ signal: controller.signal }));
    controller.abort();
    await rejection(promise);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
