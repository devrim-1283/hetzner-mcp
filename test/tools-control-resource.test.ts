/**
 * `control_resource`, with `fetch` replaced.
 *
 * What is asserted here is mostly what the tool REFUSES, because that is where
 * its value is:
 *
 *   - `rebuild` is unreachable, and the refusal says where it lives. A model
 *     told only "invalid value" retries spellings; a model told the operation is
 *     destructive and named `rebuild_server` stops.
 *   - An illegal action/resource_type pair names what IS legal for that type, so
 *     the correction takes one turn rather than a search.
 *   - A parameter the combination does not read is an error, not a silent
 *     no-op. Hetzner ignores unread body fields, which is the failure mode where
 *     the call reports success and the request that ran is not the one made.
 *   - `connection` is required even with one connection configured.
 *
 * Plus the two things every action shares: the body Hetzner actually expects,
 * and an Action that is awaited or honestly reported as unfinished.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { controlResourceTool } from '../src/tools/control-resource.js';
import { configureTransport } from '../src/http/client.js';
import { SURFACE_BASE_URLS } from '../src/types.js';
import type {
  Connection,
  ResolvedCredential,
  ServerConfig,
  ToolEnvelope,
  ToolResult,
} from '../src/types.js';

const TOKEN = 'hcloud_3Vb8Kt2ZqLmXr7yWfN5sJd9aEuC4gPoHiT6nQbYcZkSwRpMhUxGjE1lO';

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

function json(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function action(command: string, status: 'running' | 'success' = 'success') {
  return {
    id: 909,
    command,
    status,
    progress: status === 'running' ? 0 : 100,
    started: '2026-08-14T10:00:00+00:00',
    finished: status === 'running' ? null : '2026-08-14T10:00:03+00:00',
    error: null,
    resources: [{ id: 42, type: 'server' }],
  };
}

/** The action endpoints answer `{ action }`; polling reads the same shape back. */
function respond(command: string, status: 'running' | 'success' = 'success'): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/v1/actions/')) return json({ action: action(command) }, 200);
    return json({ action: action(command, status) });
  });
}

async function run(args: Record<string, unknown>, cfg = config()): Promise<ToolResult> {
  return controlResourceTool.handler(args, cfg, {});
}

function envelopeOf(result: ToolResult): ToolEnvelope<Record<string, unknown>> {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? '') as ToolEnvelope<Record<string, unknown>>;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

function bodyOf(call = 0): Record<string, unknown> {
  const raw = fetchMock.mock.calls[call]?.[1]?.body;
  return raw === undefined ? {} : (JSON.parse(String(raw)) as Record<string, unknown>);
}

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
// Refusals
// ---------------------------------------------------------------------------

describe('rebuild', () => {
  it('is not offered in the published action enum', () => {
    const schema = controlResourceTool.inputSchema(config());
    expect(JSON.stringify(schema['action'])).not.toContain('"rebuild"');
  });

  it('is refused with the operation id and the tool that carries it', async () => {
    respond('rebuild_server');
    const result = await run({
      connection: 'prod',
      resource_type: 'server',
      action: 'rebuild',
      id: 42,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not available from control_resource');
    expect(textOf(result)).toContain('rebuild_server');
    expect(textOf(result)).toContain('execute_destructive_operation');
    expect(textOf(result)).toContain('destructive');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('an illegal action for the resource type', () => {
  it('names what the type does accept, and where the action lives instead', async () => {
    respond('resize_volume');
    const result = await run({
      connection: 'prod',
      resource_type: 'server',
      action: 'resize',
      id: 42,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('`resize` is not an action on a server');
    expect(textOf(result)).toContain('poweron, poweroff, shutdown, reboot, reset');
    expect(textOf(result)).toContain('is an action on volume');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a parameter the combination does not read', () => {
  it('is refused rather than silently dropped', async () => {
    respond('poweron_server');
    const result = await run({
      connection: 'prod',
      resource_type: 'server',
      action: 'poweron',
      id: 42,
      size: 50,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('`size` is not read by `poweron` on a server');
    expect(textOf(result)).toContain('resize on a volume');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is required when Hetzner requires it, naming the parameter', async () => {
    respond('attach_volume');
    const result = await run({
      connection: 'prod',
      resource_type: 'volume',
      action: 'attach',
      id: 7,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('`server` is required for `attach` on a volume');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('connection', () => {
  it('is published even when exactly one connection is configured', () => {
    expect(Object.keys(controlResourceTool.inputSchema(config()))).toContain('connection');
  });

  it('is required, and nothing is sent without it', async () => {
    respond('poweroff_server');
    const result = await run({ resource_type: 'server', action: 'poweroff', id: 42 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('`connection` is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

describe('the request', () => {
  it('posts to the action endpoint with no body when the action takes none', async () => {
    respond('poweroff_server');

    const envelope = envelopeOf(
      await run({ connection: 'prod', resource_type: 'server', action: 'poweroff', id: 42 }),
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.hetzner.cloud/v1/servers/42/actions/poweroff',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(envelope.meta.action).toEqual({ id: 909, status: 'success', awaited: true });
  });

  it('distinguishes the hard verbs from the graceful ones in the hint', async () => {
    respond('poweroff_server');
    const hard = envelopeOf(
      await run({ connection: 'prod', resource_type: 'server', action: 'poweroff', id: 42 }),
    );

    respond('shutdown_server');
    const graceful = envelopeOf(
      await run({ connection: 'prod', resource_type: 'server', action: 'shutdown', id: 42 }),
    );

    expect(hard.meta.hint).toContain('not yet written to disk is gone');
    expect(hard.meta.hint).toContain('`shutdown` is the graceful form');
    expect(graceful.meta.hint).toContain('ACPI shutdown request');
    expect(graceful.meta.hint).toContain('`poweroff` cuts power regardless');
  });

  it('maps a primary IP assignment onto assignee_type/assignee_id', async () => {
    respond('assign_primary_ip');

    await run({
      connection: 'prod',
      resource_type: 'primary_ip',
      action: 'assign',
      id: 5,
      server: 42,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.hetzner.cloud/v1/primary_ips/5/actions/assign',
    );
    expect(bodyOf()).toEqual({ assignee_type: 'server', assignee_id: 42 });
  });

  it('nests a load balancer target under its type', async () => {
    respond('add_load_balancer_target');

    await run({
      connection: 'prod',
      resource_type: 'load_balancer',
      action: 'add_target',
      id: 9,
      target_type: 'server',
      target_server_id: 42,
      use_private_ip: true,
    });

    expect(bodyOf()).toEqual({ type: 'server', server: { id: 42 }, use_private_ip: true });
  });

  it('states the cost of enabling backups', async () => {
    respond('enable_server_backup');

    const envelope = envelopeOf(
      await run({ connection: 'prod', resource_type: 'server', action: 'enable_backup', id: 42 }),
    );

    expect(envelope.meta.hint).toContain('20%');
    expect(envelope.meta.hint).toContain('surcharge');
  });

  it('states that a volume resize cannot be undone and re-rates the volume', async () => {
    respond('resize_volume');

    const envelope = envelopeOf(
      await run({
        connection: 'prod',
        resource_type: 'volume',
        action: 'resize',
        id: 7,
        size: 100,
      }),
    );

    expect(bodyOf()).toEqual({ size: 100 });
    expect(envelope.meta.hint).toContain('cannot be undone');
    expect(envelope.meta.hint).toContain('billed at the new size');
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe('the returned Action', () => {
  it('is awaited to success', async () => {
    respond('poweron_server', 'running');

    const envelope = envelopeOf(
      await withTimers(() =>
        run({ connection: 'prod', resource_type: 'server', action: 'poweron', id: 42 }),
      ),
    );

    expect(envelope.meta.action).toEqual({ id: 909, status: 'success', awaited: true });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      'https://api.hetzner.cloud/v1/actions/909',
    );
  });

  it('reports awaited: false when the wait gives up', async () => {
    respond('poweron_server', 'running');

    const envelope = envelopeOf(
      await run({
        connection: 'prod',
        resource_type: 'server',
        action: 'poweron',
        id: 42,
        wait_seconds: 0,
      }),
    );

    expect(envelope.meta.action).toEqual({ id: 909, status: 'running', awaited: false });
    expect(envelope.meta.hint).toContain('still running when this call stopped waiting');
  });

  it('surfaces a one-time rescue password and flags it', async () => {
    fetchMock.mockImplementation(async () =>
      json({ action: action('enable_rescue'), root_password: 'Qw7ReTy2UiOp4AsD' }),
    );

    const envelope = envelopeOf(
      await run({
        connection: 'prod',
        resource_type: 'server',
        action: 'enable_rescue',
        id: 42,
        ssh_keys: [2323],
      }),
    );

    expect(bodyOf()).toEqual({ ssh_keys: [2323] });
    expect(envelope.meta.one_time_secrets).toContain('result.root_password');
    expect(envelope.meta.hint).toContain('not recoverable');
  });
});

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

describe('the tool declaration', () => {
  it('is a write tool on the cloud surface and claims nothing destructive', () => {
    expect(controlResourceTool.surface).toBe('write');
    expect(controlResourceTool.apiSurfaces).toEqual(['cloud']);
    expect(controlResourceTool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(controlResourceTool.annotations.title.length).toBeGreaterThan(0);
  });

  it('states the hard/graceful distinction and where rebuild lives, without directing behaviour', () => {
    const description = controlResourceTool.description;
    expect(description).toContain('poweroff and reset cut power immediately');
    expect(description).toContain('execute_destructive_operation');
    expect(description.toLowerCase()).not.toContain('ask the user');
    expect(description.toLowerCase()).not.toContain('you should');
  });
});
