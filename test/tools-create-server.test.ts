/**
 * `create_server`, with `fetch` replaced.
 *
 * The suite is organised around the properties that cost money or destroy
 * information when they regress, rather than around the tool's surface:
 *
 *   - `connection` is required even when exactly one is configured. Every other
 *     tool in this server drops the parameter in that case; a write must not,
 *     and the single-connection case is precisely where the omission would look
 *     harmless.
 *   - The Action is awaited, and a wait that gives up says so. A create that
 *     reported a running Action as finished would be indistinguishable from one
 *     that finished.
 *   - `root_password` survives to the model and is flagged. Hetzner returns it
 *     once; a regression that redacted it would bill the user for a machine
 *     nobody can log into, and no later call could recover it.
 *   - A price is attached when it is known and ABSENT when it is not. A
 *     confidently wrong price is the failure this tool exists to avoid.
 *
 * Response shapes are the real ones from the vendored spec: `POST /servers`
 * answers `{ server, action, next_actions, root_password }` with the password a
 * top-level sibling of the server, not a field inside it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerTool } from '../src/tools/create-server.js';
import { configureTransport } from '../src/http/client.js';
import { SURFACE_BASE_URLS } from '../src/types.js';
import type {
  Connection,
  ResolvedCredential,
  ServerConfig,
  ToolEnvelope,
  ToolResult,
} from '../src/types.js';

const TOKEN = 'hcloud_7Kd3Nq8ZxWvB2mTfR5yPjL9sAeCuH4gXoQiV6nMbYtZrDkSwFpJhUaGcE1lO';
const ROOT_PASSWORD = 'YRfnP6xLmT4bqVsA';

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

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    name: 'prod',
    surface: 'cloud',
    baseUrl: SURFACE_BASE_URLS.cloud,
    readOnly: false,
    allowDestructive: false,
    timeoutMs: 30_000,
    credential: {
      kind: 'bearer',
      resolve: async (): Promise<ResolvedCredential> => ({ kind: 'bearer', token: TOKEN }),
    },
    ...overrides,
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

function serverRecord(location = 'fsn1'): Record<string, unknown> {
  return {
    id: 42,
    name: 'web-01',
    status: 'initializing',
    created: '2026-08-14T10:00:00+00:00',
    public_net: { ipv4: { ip: '203.0.113.10' }, ipv6: { ip: '2001:db8::/64' } },
    server_type: {
      id: 22,
      name: 'cpx21',
      cores: 3,
      memory: 4,
      disk: 80,
      architecture: 'x86',
      // The embedded table the projection drops on purpose. Present so the test
      // exercises the same payload the API sends.
      prices: [{ location, price_hourly: { gross: '9.9999' } }],
    },
    image: { name: 'ubuntu-24.04', os_flavor: 'ubuntu', os_version: '24.04' },
    datacenter: { name: `${location}-dc14`, location: { name: location, country: 'DE' } },
    labels: {},
  };
}

function createBody(
  overrides: {
    location?: string;
    actionStatus?: 'running' | 'success';
    rootPassword?: string | null;
    nextActions?: unknown[];
  } = {},
): Record<string, unknown> {
  return {
    server: serverRecord(overrides.location ?? 'fsn1'),
    action: {
      id: 1337,
      command: 'create_server',
      status: overrides.actionStatus ?? 'success',
      progress: overrides.actionStatus === 'running' ? 0 : 100,
      started: '2026-08-14T10:00:00+00:00',
      finished: overrides.actionStatus === 'running' ? null : '2026-08-14T10:00:12+00:00',
      error: null,
      resources: [{ id: 42, type: 'server' }],
    },
    next_actions: overrides.nextActions ?? [],
    root_password: overrides.rootPassword === undefined ? ROOT_PASSWORD : overrides.rootPassword,
  };
}

const PRICING = {
  pricing: {
    currency: 'EUR',
    vat_rate: '19.00',
    server_types: [
      {
        id: 22,
        name: 'cpx21',
        prices: [
          {
            location: 'fsn1',
            price_hourly: { net: '0.0100', gross: '0.0119' },
            price_monthly: { net: '6.0000', gross: '7.1400' },
          },
          {
            location: 'nbg1',
            price_hourly: { net: '0.0100', gross: '0.0119' },
            price_monthly: { net: '6.0000', gross: '7.1400' },
          },
        ],
      },
    ],
  },
};

/** Routes by path, so a test does not depend on the order of the two calls. */
function routes(
  handlers: { create?: () => Response; pricing?: () => Response; action?: () => Response } = {},
): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/pricing')) return (handlers.pricing ?? (() => json(PRICING)))();
    if (url.includes('/actions/')) {
      return (handlers.action ?? (() => json({ action: settledAction() })))();
    }
    if (url.endsWith('/servers')) return (handlers.create ?? (() => json(createBody(), 201)))();
    throw new Error(`unexpected request to ${url}`);
  });
}

function settledAction(): Record<string, unknown> {
  return {
    id: 1337,
    command: 'create_server',
    status: 'success',
    progress: 100,
    started: '2026-08-14T10:00:00+00:00',
    finished: '2026-08-14T10:00:12+00:00',
    error: null,
  };
}

const VALID_ARGS = {
  connection: 'prod',
  name: 'web-01',
  server_type: 'cpx21',
  image: 'ubuntu-24.04',
  location: 'fsn1',
};

async function run(args: Record<string, unknown>, cfg = config()): Promise<ToolResult> {
  return createServerTool.handler(args, cfg, {});
}

function envelopeOf(result: ToolResult): ToolEnvelope<Record<string, unknown>> {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? '') as ToolEnvelope<Record<string, unknown>>;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

/** Drives a wait to completion without leaving an unhandled rejection behind. */
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
// Connection
// ---------------------------------------------------------------------------

describe('connection', () => {
  it('is published even when exactly one connection is configured', () => {
    const schema = createServerTool.inputSchema(config());
    expect(Object.keys(schema)).toContain('connection');
  });

  it('is required, and nothing is sent without it', async () => {
    routes();
    const result = await run({ ...VALID_ARGS, connection: undefined });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('`connection` is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a name that is not configured', async () => {
    routes();
    const result = await run({ ...VALID_ARGS, connection: 'staging' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No connection named "staging"');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe('placement', () => {
  it('refuses location and datacenter together, naming which to keep', async () => {
    routes();
    const result = await run({ ...VALID_ARGS, datacenter: 'fsn1-dc14' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('`location` and `datacenter` cannot both be given');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a name that is not a valid host name', async () => {
    routes();
    const result = await run({ ...VALID_ARGS, name: 'web_01' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('RFC 1123');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The Action
// ---------------------------------------------------------------------------

describe('the create Action', () => {
  it('is awaited to success', async () => {
    routes({ create: () => json(createBody({ actionStatus: 'running' }), 201) });

    const envelope = envelopeOf(await withTimers(() => run(VALID_ARGS)));

    expect(envelope.meta.action).toEqual({ id: 1337, status: 'success', awaited: true });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      'https://api.hetzner.cloud/v1/actions/1337',
    );
  });

  it('reports awaited: false when the wait gives up, and says the work continues', async () => {
    routes({ create: () => json(createBody({ actionStatus: 'running' }), 201) });

    const envelope = envelopeOf(await run({ ...VALID_ARGS, wait_seconds: 0 }));

    expect(envelope.meta.action).toEqual({ id: 1337, status: 'running', awaited: false });
    expect(envelope.meta.hint).toContain('still running when this call stopped waiting');
  });

  it('names follow-up actions that were still running rather than implying they finished', async () => {
    routes({
      create: () =>
        json(
          createBody({
            nextActions: [{ id: 1338, command: 'start_server', status: 'running', progress: 0 }],
          }),
          201,
        ),
    });

    const envelope = envelopeOf(await run(VALID_ARGS));

    expect(envelope.meta.hint).toContain('start_server');
    expect(envelope.meta.hint).toContain('were not waited for');
  });
});

// ---------------------------------------------------------------------------
// The one-time credential
// ---------------------------------------------------------------------------

describe('root_password', () => {
  it('reaches the model, is named in meta.one_time_secrets, and is called unrecoverable', async () => {
    routes();

    const envelope = envelopeOf(await run(VALID_ARGS));

    expect(envelope.data['root_password']).toBe(ROOT_PASSWORD);
    expect(envelope.meta.one_time_secrets).toContain('root_password');
    expect(envelope.meta.hint).toContain('not recoverable');
    expect(envelope.meta.hint).toContain('without an SSH key');
  });

  it('appears exactly once in the rendered result', async () => {
    routes();

    const text = textOf(await run(VALID_ARGS));

    expect(text.split(ROOT_PASSWORD)).toHaveLength(2);
  });

  it('is absent, and unflagged, when the server was created with an SSH key', async () => {
    routes({ create: () => json(createBody({ rootPassword: null }), 201) });

    const envelope = envelopeOf(await run({ ...VALID_ARGS, ssh_keys: ['laptop'] }));

    expect(envelope.data['root_password']).toBeUndefined();
    expect(envelope.meta.one_time_secrets).toBeUndefined();
    expect(bodyOf(0)['ssh_keys']).toEqual(['laptop']);
  });
});

function bodyOf(call: number): Record<string, unknown> {
  const raw = fetchMock.mock.calls[call]?.[1]?.body;
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

describe('meta.billing', () => {
  it('carries the published price for the server type in the location it landed in', async () => {
    routes();

    const envelope = envelopeOf(await run(VALID_ARGS));

    expect(envelope.meta.billing).toEqual({
      monthly: '7.1400',
      hourly: '0.0119',
      currency: 'EUR',
    });
    expect(envelope.meta.hint).toContain('until it is deleted');
  });

  it('is absent, and said to be absent, when no price is published for that location', async () => {
    routes({ create: () => json(createBody({ location: 'hel1' }), 201) });

    const envelope = envelopeOf(await run({ ...VALID_ARGS, location: 'hel1' }));

    expect(envelope.meta.billing).toBeUndefined();
    expect(envelope.meta.hint).toContain('No published price could be read');
    expect(envelope.meta.hint).toContain('hel1');
  });

  it('is absent rather than fatal when the pricing lookup itself fails', async () => {
    routes({ pricing: () => json({ error: { code: 'rate_limit_exceeded' } }, 429) });

    const envelope = envelopeOf(await withTimers(() => run(VALID_ARGS)));

    expect(envelope.meta.billing).toBeUndefined();
    expect(envelope.data['server']).toMatchObject({ id: 42 });
  });
});

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

describe('the request', () => {
  it('posts to /servers with the mapped body', async () => {
    routes();

    await run({
      ...VALID_ARGS,
      firewalls: [38],
      networks: [456],
      labels: { env: 'prod' },
      start_after_create: false,
      public_net: { enable_ipv4: false },
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.hetzner.cloud/v1/servers');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(bodyOf(0)).toEqual({
      name: 'web-01',
      server_type: 'cpx21',
      image: 'ubuntu-24.04',
      location: 'fsn1',
      // Hetzner takes firewalls as single-key objects; the tool takes plain ids.
      firewalls: [{ firewall: 38 }],
      networks: [456],
      labels: { env: 'prod' },
      start_after_create: false,
      public_net: { enable_ipv4: false },
    });
  });

  it('is refused by a read-only connection before anything is created', async () => {
    routes();
    const result = await run(VALID_ARGS, config(connection({ readOnly: true })));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('read-only');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

describe('the tool declaration', () => {
  it('states that it provisions billable infrastructure, without directing behaviour', () => {
    expect(createServerTool.description).toContain('billable infrastructure');
    expect(createServerTool.description).toContain('charges');
    expect(createServerTool.description.toLowerCase()).not.toContain('ask the user');
    expect(createServerTool.description.toLowerCase()).not.toContain('confirm');
  });

  it('is a write tool on the cloud surface and claims nothing destructive', () => {
    expect(createServerTool.surface).toBe('write');
    expect(createServerTool.apiSurfaces).toEqual(['cloud']);
    expect(createServerTool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(createServerTool.annotations.title.length).toBeGreaterThan(0);
  });
});
