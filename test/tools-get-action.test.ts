/**
 * get_action, with `fetch` replaced.
 *
 * The suite is built around the four claims this tool makes that nothing else
 * can check:
 *
 *   - `meta.action.awaited` is the truth about whether the work finished. A
 *     running Action reported as done is the failure this whole file exists to
 *     prevent, so both directions are asserted: settled to success, and a wait
 *     that gave up.
 *   - A failed Action is an ERROR. Hetzner records asynchronous failure inside
 *     the Action, not in the HTTP status, so a 200 carrying a failed Action must
 *     not read as success — and the code Hetzner supplied has to survive into
 *     the rendered text, which is where the caller reads it.
 *   - The poll loop backs off. The quota is 3600 requests/hour shared with every
 *     other client on the token, so the call count over a fake timeline is
 *     asserted rather than assumed.
 *   - The read path follows the SURFACE. The account API has no global Actions
 *     endpoint, and sending a cloud path to it would 404 in a way that looks
 *     like the Action never existed.
 *
 * Timers are faked where a wait has to elapse. `AbortSignal.timeout` inside the
 * transport uses Node's internal timer and stays real, so the per-request
 * deadline cannot fire during a faked test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Loaded eagerly on purpose. The transport imports the generated catalog
// LAZILY, on the first request that carries an operationId, and a dynamic
// import cannot complete while timers are faked — the very first faked test
// would otherwise stall forever on module loading rather than on the poll it
// meant to drive. Importing it here puts it in the registry before any test runs.
import '../src/generated/catalog.js';
import { getActionTool } from '../src/tools/get-action.js';
import { configureTransport } from '../src/http/client.js';
import { SURFACE_AUTH, SURFACE_BASE_URLS } from '../src/types.js';
import type {
  Connection,
  ResolvedCredential,
  ServerConfig,
  Surface,
  ToolResult,
} from '../src/types.js';

const TOKEN = 'hcloud_9f2Ab7QxZm4LtVeR8sNpKdYc3JwHuG6XoTiB1lS0EnMqPrDaFvUyCkZjWgXh';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
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

function connection(name = 'main', surface: Surface = 'cloud'): Connection {
  return {
    name,
    surface,
    baseUrl: SURFACE_BASE_URLS[surface],
    readOnly: false,
    allowDestructive: false,
    timeoutMs: 600_000,
    credential: {
      kind: SURFACE_AUTH[surface],
      resolve: async (): Promise<ResolvedCredential> =>
        SURFACE_AUTH[surface] === 'bearer'
          ? { kind: 'bearer', token: TOKEN }
          : { kind: 'basic', user: '#4711+ws', password: 'sV8nQ2rLpX4mZ7tK' },
    },
  };
}

function config(...connections: Connection[]): ServerConfig {
  const rows = connections.length > 0 ? connections : [connection()];
  return {
    registry: {
      connections: new Map(rows.map((row) => [row.name, row])),
      defaultName: rows[0]?.name,
      source: 'env',
      shadowed: [],
    },
    allowDestructive: false,
    readOnly: false,
    logLevel: 'error',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fresh Response per call: a body can only be read once. */
function respond(...bodies: unknown[]): void {
  let index = 0;
  fetchMock.mockImplementation(async () => {
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return json(body);
  });
}

function action(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    command: 'start_server',
    status: 'running',
    progress: 0,
    started: '2024-05-01T12:00:00+00:00',
    finished: null,
    error: null,
    resources: [{ id: 7, type: 'server' }],
    ...overrides,
  };
}

function envelope(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

function meta(result: ToolResult): Record<string, unknown> {
  return envelope(result)['meta'] as Record<string, unknown>;
}

function urls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

// ---------------------------------------------------------------------------
// Awaiting
// ---------------------------------------------------------------------------

describe('get_action awaiting', () => {
  it('polls a running action until it succeeds and reports awaited: true', async () => {
    vi.useFakeTimers();
    respond(
      { action: action({ status: 'running', progress: 0 }) },
      { action: action({ status: 'running', progress: 40 }) },
      {
        action: action({
          status: 'success',
          progress: 100,
          finished: '2024-05-01T12:00:09+00:00',
        }),
      },
    );

    const pending = getActionTool.handler({ id: 42, wait_seconds: 30 }, config(), {});
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(result.isError).toBeUndefined();
    expect(meta(result)['action']).toEqual({ id: 42, status: 'success', awaited: true });
    expect(String(meta(result)['hint'])).toContain('finished with status success');
    expect(urls()[0]).toBe('https://api.hetzner.cloud/v1/actions/42');
  });

  it('reports awaited: false and the unsettled hint when the wait runs out', async () => {
    vi.useFakeTimers();
    respond({ action: action({ status: 'running', progress: 10 }) });

    const pending = getActionTool.handler({ id: 42, wait_seconds: 5 }, config(), {});
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result.isError).toBeUndefined();
    expect(meta(result)['action']).toEqual({ id: 42, status: 'running', awaited: false });
    // The exact promise the seam makes: the work continues on Hetzner's side.
    expect(String(meta(result)['hint'])).toContain(
      'was still running when this call stopped waiting',
    );
  });

  it('does not poll at all when wait_seconds is 0', async () => {
    respond({ action: action({ status: 'running' }) });

    const result = await getActionTool.handler({ id: 42, wait_seconds: 0 }, config(), {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(meta(result)['action']).toEqual({ id: 42, status: 'running', awaited: false });
  });

  it('reports an already-terminal action as awaited without waiting', async () => {
    respond({ action: action({ status: 'success', progress: 100 }) });

    const result = await getActionTool.handler({ id: 42, wait_seconds: 0 }, config(), {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(meta(result)['action']).toEqual({ id: 42, status: 'success', awaited: true });
    expect(String(meta(result)['hint'])).toContain('nothing was waited for');
  });
});

// ---------------------------------------------------------------------------
// Asynchronous failure
// ---------------------------------------------------------------------------

describe('get_action failure', () => {
  it("turns a failed action into an error carrying the action's own code", async () => {
    respond({
      action: action({
        command: 'attach_volume',
        status: 'error',
        progress: 100,
        finished: '2024-05-01T12:00:03+00:00',
        error: { code: 'server_already_attached', message: 'Server already has a volume attached' },
      }),
    });

    const result = await getActionTool.handler({ id: 42 }, config(), {});

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    // The HTTP call succeeded; only the Action says otherwise.
    expect(text).toContain('attach_volume action failed');
    expect(text).toContain('Server already has a volume attached');
    // The closed-vocabulary code is the useful half, and the error boundary
    // renders only message and hint — so it has to be in one of them.
    expect(text).toContain('server_already_attached');
  });

  it('fails when an action goes to error during the wait', async () => {
    vi.useFakeTimers();
    respond(
      { action: action({ status: 'running' }) },
      {
        action: action({
          status: 'error',
          progress: 100,
          error: { code: 'resource_unavailable', message: 'No capacity in this location' },
        }),
      },
    );

    const pending = getActionTool.handler({ id: 42, wait_seconds: 30 }, config(), {});
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('resource_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

describe('get_action polling', () => {
  it('backs off instead of hammering the shared rate limit', async () => {
    vi.useFakeTimers();
    respond({ action: action({ status: 'running' }) });

    const pending = getActionTool.handler({ id: 42, wait_seconds: 60 }, config(), {});

    // The first poll is a second away; the initial read is the only call so far.
    await vi.advanceTimersByTimeAsync(900);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_500);
    const result = await pending;

    // A one-second fixed interval would be 60 polls. The seam's 1s start, 1.5x
    // growth and 5s ceiling puts it near 15; the assertion is loose enough to
    // survive a tuning change and tight enough to fail a regression to
    // fixed-interval polling.
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThan(3);
    expect(calls).toBeLessThanOrEqual(20);
    expect(meta(result)['action']).toEqual({ id: 42, status: 'running', awaited: false });
  });
});

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

describe('get_action surfaces', () => {
  it('reads an account-surface action under the Storage Box product', async () => {
    respond({ action: action({ command: 'update_storage_box', status: 'success' }) });

    const result = await getActionTool.handler(
      { id: 42, wait_seconds: 0 },
      config(connection('acct', 'hetzner')),
      {},
    );

    expect(urls()[0]).toBe('https://api.hetzner.com/v1/storage_boxes/actions/42');
    expect(String(meta(result)['hint'])).toContain('no global Actions endpoint');
  });

  it('uses the per-resource form when the Storage Box is named', async () => {
    respond({ action: action({ command: 'update_storage_box', status: 'success' }) });

    await getActionTool.handler(
      { id: 42, resource_type: 'storage_box', resource_id: 9, wait_seconds: 0 },
      config(connection('acct', 'hetzner')),
      {},
    );

    expect(urls()[0]).toBe('https://api.hetzner.com/v1/storage_boxes/9/actions/42');
  });

  it("refuses a resource that does not live on the connection's surface", async () => {
    const result = await getActionTool.handler(
      { resource_type: 'server', resource_id: 7 },
      config(connection('acct', 'hetzner')),
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('account-scoped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses Robot by name rather than sending a request', async () => {
    const result = await getActionTool.handler({ id: 42 }, config(connection('dedi', 'robot')), {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no Action model');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Listing a resource's actions
// ---------------------------------------------------------------------------

describe('get_action listing', () => {
  it("lists a resource's recent actions newest first", async () => {
    respond({
      actions: [
        action({ id: 51, command: 'reboot_server', status: 'success' }),
        action({
          id: 50,
          command: 'attach_volume',
          status: 'error',
          error: { code: 'locked', message: 'Server is locked' },
        }),
      ],
      meta: { pagination: { page: 1, per_page: 10, total_entries: 2 } },
    });

    const result = await getActionTool.handler(
      { resource_type: 'server', resource_id: 7 },
      config(),
      {},
    );

    const url = new URL(urls()[0] ?? '');
    expect(url.pathname).toBe('/v1/servers/7/actions');
    expect(url.searchParams.get('sort')).toBe('started:desc');
    expect(url.searchParams.get('per_page')).toBe('10');

    const body = envelope(result);
    expect(Array.isArray(body['data'])).toBe(true);
    expect((body['data'] as unknown[]).length).toBe(2);
    // A history is expected to contain failures; showing it is the point.
    expect(result.isError).toBeUndefined();
    expect(String(meta(result)['hint'])).toContain('1 of them failed');
    expect(meta(result)['total']).toBe(2);
    expect(meta(result)['action']).toBeUndefined();
  });

  it('refuses a resource_type without a resource_id', async () => {
    const result = await getActionTool.handler({ resource_type: 'server' }, config(), {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('`resource_id` is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a call that names neither an action nor a resource', async () => {
    const result = await getActionTool.handler({}, config(), {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Name either an Action or a resource');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe('get_action contract', () => {
  it('is a read tool with the mandatory annotations', () => {
    expect(getActionTool.surface).toBe('read');
    expect(getActionTool.apiSurfaces).toEqual(['cloud', 'hetzner']);
    expect(getActionTool.annotations).toMatchObject({
      title: 'Get action',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('omits `connection` when only one is configured, and offers it when two are', () => {
    expect(getActionTool.inputSchema(config())['connection']).toBeUndefined();
    const both = config(connection('main', 'cloud'), connection('acct', 'hetzner'));
    expect(getActionTool.inputSchema(both)['connection']).toBeDefined();
  });

  it('accepts no parameter that could carry a URL, host or credential', () => {
    const keys = Object.keys(getActionTool.inputSchema(config()));
    expect(keys.sort()).toEqual(
      ['id', 'limit', 'resource_id', 'resource_type', 'status', 'wait_seconds'].sort(),
    );
  });
});
