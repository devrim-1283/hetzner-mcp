/**
 * The generic catalog tools, with `fetch` replaced.
 *
 * The suite is organised around the properties that cannot regress, which is a
 * shorter list than "everything these five tools do":
 *
 *   - Every door admits its own danger class and NAMES the door that would take
 *     the operation. A refusal the model cannot act on costs the same turn as no
 *     refusal at all.
 *   - An operation id is resolved against the catalog before anything else, and
 *     there is no parameter anywhere that accepts a raw method or path.
 *   - A surface mismatch is refused by name, on both sides. This is the mistake
 *     the model will actually make, and it is asserted rather than assumed.
 *   - Path parameters cannot introduce a separator, a query string or a
 *     traversal segment, and the RRSet routes really do take three of them.
 *
 * `fetch` is stubbed and never called for real; where a call must not happen at
 * all, that is asserted on the stub rather than inferred from the error text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureTransport } from '../src/http/client.js';
import {
  describeOperationTool,
  executeDestructiveOperationTool,
  executeReadOperationTool,
  executeWriteOperationTool,
  genericTools,
  searchOperationsTool,
} from '../src/tools/generic.js';
import { SURFACE_AUTH, SURFACE_BASE_URLS } from '../src/types.js';
import type {
  Connection,
  ResolvedCredential,
  ServerConfig,
  Surface,
  ToolDef,
  ToolResult,
} from '../src/types.js';

const TOKEN = 'hcloud_9f2Ab7QxZm4LtVeR8sNpKdYc3JwHuG6XoTiB1lS0EnMqPrDaFvUyCkZjWgXh';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => json({}));
  vi.stubGlobal('fetch', fetchMock);
  configureTransport({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  configureTransport({});
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function connection(
  name: string,
  surface: Surface,
  overrides: Partial<Connection> = {},
): Connection {
  return {
    name,
    surface,
    baseUrl: SURFACE_BASE_URLS[surface],
    readOnly: false,
    allowDestructive: true,
    timeoutMs: 30_000,
    credential: {
      kind: SURFACE_AUTH[surface],
      resolve: async (): Promise<ResolvedCredential> =>
        SURFACE_AUTH[surface] === 'bearer'
          ? { kind: 'bearer', token: TOKEN }
          : { kind: 'basic', user: '#4711+ws', password: 'sV8nQ2rLpX4mZ7tK' },
    },
    ...overrides,
  };
}

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const connections = new Map<string, Connection>([
    ['main', connection('main', 'cloud')],
    ['account', connection('account', 'hetzner')],
  ]);
  return {
    registry: { connections, defaultName: 'main', source: 'env', shadowed: [] },
    allowDestructive: true,
    readOnly: false,
    logLevel: 'error',
    ...overrides,
  };
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

async function call(
  tool: ToolDef,
  args: Record<string, unknown>,
  cfg: ServerConfig = config(),
): Promise<ToolResult> {
  return tool.handler(args, cfg, {});
}

function text(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

interface Envelope {
  connection?: string;
  surface?: string;
  data: unknown;
  meta: Record<string, unknown>;
}

function envelope(result: ToolResult): Envelope {
  expect(result.isError).toBeFalsy();
  return JSON.parse(text(result)) as Envelope;
}

function rows(result: ToolResult): Array<Record<string, unknown>> {
  return envelope(result).data as Array<Record<string, unknown>>;
}

function urlOf(index = 0): string {
  return String(fetchMock.mock.calls[index]?.[0]);
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('genericTools', () => {
  it('exports the five tools in the documented order', () => {
    expect(genericTools.map((tool) => tool.name)).toEqual([
      'search_operations',
      'describe_operation',
      'execute_read_operation',
      'execute_write_operation',
      'execute_destructive_operation',
    ]);
  });

  it('carries destructiveHint only on the destructive door', () => {
    const hinted = genericTools.filter((tool) => tool.annotations.destructiveHint);
    expect(hinted.map((tool) => tool.name)).toEqual(['execute_destructive_operation']);
  });

  it('requires an explicit connection on every execute door', () => {
    const cfg = config();
    for (const tool of [
      executeReadOperationTool,
      executeWriteOperationTool,
      executeDestructiveOperationTool,
    ]) {
      expect(Object.keys(tool.inputSchema(cfg))).toContain('connection');
    }
  });
});

// ---------------------------------------------------------------------------
// search_operations
// ---------------------------------------------------------------------------

describe('search_operations', () => {
  it('filters by surface', async () => {
    const result = await call(searchOperationsTool, { surface: 'hetzner', limit: 100 });
    const found = rows(result);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((row) => row['surface'] === 'hetzner')).toBe(true);
  });

  it('filters by family', async () => {
    const result = await call(searchOperationsTool, { family: 'zones', limit: 100 });
    const found = rows(result);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((row) => row['family'] === 'zones')).toBe(true);
  });

  it('filters by danger class', async () => {
    const result = await call(searchOperationsTool, { danger: 'destructive', limit: 100 });
    const found = rows(result);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((row) => row['danger'] === 'destructive')).toBe(true);
    expect(found.map((row) => row['id'])).toContain('delete_server');
  });

  it('omits destructive operations when this server has no door for them', async () => {
    const cfg = config({ allowDestructive: false });
    const all = rows(await call(searchOperationsTool, { limit: 100 }, cfg));
    expect(all.some((row) => row['danger'] === 'destructive')).toBe(false);

    const asked = await call(searchOperationsTool, { danger: 'destructive' }, cfg);
    expect(rows(asked)).toHaveLength(0);
    expect(String(envelope(asked).meta['hint'])).toContain('Destructive operations are off');
  });

  it('marks costly operations and states that they open a bill', async () => {
    const result = await call(searchOperationsTool, { query: 'create server' });
    const created = rows(result).find((row) => row['id'] === 'create_server');
    expect(created).toBeDefined();
    expect(created?.['costly']).toBe(true);
    expect(created?.['danger']).toBe('write');
    expect(String(envelope(result).meta['hint'])).toContain('open a bill');
  });
});

// ---------------------------------------------------------------------------
// describe_operation
// ---------------------------------------------------------------------------

describe('describe_operation', () => {
  it('returns the request body schema and the door that runs it', async () => {
    const detail = envelope(await call(describeOperationTool, { operation_id: 'create_server' }))
      .data as Record<string, unknown>;

    expect(detail['method']).toBe('POST');
    expect(detail['surface']).toBe('cloud');
    expect(detail['runs_through']).toBe('execute_write_operation');
    expect(detail['costly']).toBe(true);
    expect(detail['returns_action']).toBe(true);

    const body = detail['request_body'] as { properties?: Record<string, unknown> };
    expect(Object.keys(body.properties ?? {})).toContain('server_type');
  });

  it("returns Hetzner's filter parameters and hides the paging ones", async () => {
    const result = await call(describeOperationTool, { operation_id: 'list_servers' });
    const detail = envelope(result).data as Record<string, unknown>;
    const names = (detail['query_params'] as Array<{ name: string }>).map((param) => param.name);

    expect(names).toEqual(expect.arrayContaining(['label_selector', 'sort', 'status', 'name']));
    expect(names).not.toContain('page');
    expect(names).not.toContain('per_page');
    expect(detail['paginated']).toBe(true);
    expect(String(envelope(result).meta['hint'])).toContain('`cursor`');
  });

  it('returns all three path parameters of an RRSet route', async () => {
    const detail = envelope(await call(describeOperationTool, { operation_id: 'get_zone_rrset' }))
      .data as Record<string, unknown>;
    const params = detail['path_params'] as Array<{ name: string; required?: boolean }>;

    expect(params.map((param) => param.name)).toEqual(['id_or_name', 'rr_name', 'rr_type']);
    expect(params.every((param) => param.required === true)).toBe(true);
  });

  it('refuses an id that is not in the catalog', async () => {
    const result = await call(describeOperationTool, { operation_id: 'delete_everything' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No operation with id "delete_everything"');
  });
});

// ---------------------------------------------------------------------------
// The doors
// ---------------------------------------------------------------------------

describe('door gating', () => {
  it('refuses a write operation at the read door and names the write door', async () => {
    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'create_server',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('`create_server` is a write operation');
    // The refusal is worded once, by `assertDanger` in the seam, so the door's
    // admitted class is named with the catalog's own vocabulary — `safe` — in
    // every door's refusal rather than a per-door synonym for it.
    expect(text(result)).toContain('execute_read_operation runs safe operations only');
    expect(text(result)).toContain('runs through execute_write_operation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a destructive operation at the write door and names the destructive door', async () => {
    const result = await call(executeWriteOperationTool, {
      connection: 'main',
      operation_id: 'delete_server',
      path_params: { id: 42 },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('`delete_server` is a destructive operation');
    expect(text(result)).toContain('execute_write_operation runs write operations only');
    expect(text(result)).toContain('runs through execute_destructive_operation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a write operation at the destructive door', async () => {
    const result = await call(executeDestructiveOperationTool, {
      connection: 'main',
      operation_id: 'poweron_server',
      path_params: { id: 42 },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('`poweron_server` is a write operation');
    expect(text(result)).toContain('runs through execute_write_operation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an unknown operation id before touching the network', async () => {
    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'GET /servers',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No operation with id "GET /servers"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a destructive id when this server has no destructive door', async () => {
    const result = await call(
      executeWriteOperationTool,
      { connection: 'main', operation_id: 'delete_server', path_params: { id: 1 } },
      config({ allowDestructive: false }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('destructive operations are off for this server');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

describe('surface gating', () => {
  it('refuses a cloud operation on an account connection, naming both surfaces', async () => {
    const result = await call(executeReadOperationTool, {
      connection: 'account',
      operation_id: 'list_servers',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('`list_servers` belongs to the `cloud` surface');
    expect(text(result)).toContain('connection `account` is on the `hetzner` surface');
    expect(text(result)).toContain('Connections on `cloud`: main');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs an account operation on the account connection', async () => {
    fetchMock.mockImplementation(async () => json({ storage_boxes: [], meta: {} }));

    const result = await call(executeReadOperationTool, {
      connection: 'account',
      operation_id: 'list_storage_boxes',
    });

    expect(envelope(result).surface).toBe('hetzner');
    expect(urlOf()).toContain('https://api.hetzner.com/v1/storage_boxes');
  });
});

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

describe('path parameter substitution', () => {
  it('names a missing path parameter', async () => {
    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'get_server',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('`get_server` needs path parameter `id`');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL-encodes a supplied value', async () => {
    fetchMock.mockImplementation(async () => json({ zone: {} }));

    await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'get_zone',
      path_params: { id_or_name: 'exämple.com' },
    });

    expect(urlOf()).toBe('https://api.hetzner.cloud/v1/zones/ex%C3%A4mple.com');
  });

  it('refuses a traversal segment', async () => {
    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'get_zone',
      path_params: { id_or_name: '..' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('is a relative path segment');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a value that would introduce a second path segment', async () => {
    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'get_zone',
      path_params: { id_or_name: 'example.com/actions' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('contains a separator');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a value that would introduce a query string', async () => {
    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'get_server',
      path_params: { id: '1?per_page=50' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('contains a separator');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('substitutes all three parameters of an RRSet route', async () => {
    fetchMock.mockImplementation(async () => json({ rrset: { name: 'www', type: 'A' } }));

    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'get_zone_rrset',
      path_params: { id_or_name: 'example.com', rr_name: 'www', rr_type: 'A' },
    });

    expect(result.isError).toBeFalsy();
    expect(urlOf()).toBe('https://api.hetzner.cloud/v1/zones/example.com/rrsets/www/A');
  });

  it('refuses a path parameter the operation does not declare', async () => {
    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'get_server',
      path_params: { id: 1, zone: 'example.com' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('has no path parameter `zone`');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

describe('query parameters', () => {
  it("passes Hetzner's filters through", async () => {
    fetchMock.mockImplementation(async () => json({ servers: [], meta: {} }));

    await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'list_servers',
      query: { label_selector: 'env=prod', sort: 'name:asc' },
    });

    expect(urlOf()).toContain('label_selector=env%3Dprod');
    expect(urlOf()).toContain('sort=name%3Aasc');
  });

  it('refuses a query parameter the operation does not accept', async () => {
    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'list_servers',
      query: { labels: 'env=prod' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('has no query parameter `labels`');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses paging parameters, which belong to the cursor', async () => {
    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'list_servers',
      query: { page: 3 },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('is paginated, so `page` is not accepted');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('pagination', () => {
  function page(index: number, count: number) {
    return json({
      servers: Array.from({ length: count }, (_, row) => ({
        id: index * 100 + row,
        name: `s${row}`,
      })),
      meta: { pagination: { page: index, per_page: 25, total_entries: 30, last_page: 2 } },
    });
  }

  it('round-trips a cursor to the next page', async () => {
    fetchMock.mockImplementation(async () => page(1, 25));

    const first = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'list_servers',
    });
    const firstEnvelope = envelope(first);
    const cursor = firstEnvelope.meta['next_cursor'];

    expect(Array.isArray(firstEnvelope.data)).toBe(true);
    expect((firstEnvelope.data as unknown[]).length).toBe(25);
    expect(firstEnvelope.meta['total']).toBe(30);
    expect(typeof cursor).toBe('string');
    expect(urlOf()).toContain('page=1');

    fetchMock.mockImplementation(async () => page(2, 5));
    const second = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'list_servers',
      cursor,
    });

    expect((envelope(second).data as unknown[]).length).toBe(5);
    expect(envelope(second).meta['next_cursor']).toBeUndefined();
    expect(urlOf(1)).toContain('page=2');
    expect(urlOf(1)).toContain('per_page=25');
  });

  it('unwraps the key the operation path names, not whatever array is present', async () => {
    // The rows key is derived from the operation (/zones/{id_or_name}/rrsets ->
    // `rrsets`), so a sibling array in the same body cannot be mistaken for it.
    fetchMock.mockImplementation(async () =>
      json({
        rrsets: [{ name: 'www', type: 'A' }],
        meta: { pagination: { page: 1, per_page: 25, total_entries: 1, last_page: 1 } },
      }),
    );

    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'list_zone_rrsets',
      path_params: { id_or_name: 'example.com' },
    });

    expect(envelope(result).data).toEqual([{ name: 'www', type: 'A' }]);
    expect(String(envelope(result).meta['hint'])).toContain('`rrsets` array');
  });

  it('returns the body verbatim and says so when the expected array is absent', async () => {
    fetchMock.mockImplementation(async () => json({ unexpected: [{ id: 1 }] }));

    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'list_servers',
    });

    expect(envelope(result).data).toEqual({ unexpected: [{ id: 1 }] });
    expect(String(envelope(result).meta['hint'])).toContain('carried no `servers` array');
    expect(envelope(result).meta['next_cursor']).toBeUndefined();
  });

  it('returns a single read as Hetzner sent it, wrapper key and all', async () => {
    fetchMock.mockImplementation(async () => json({ server: { id: 42, name: 'web' } }));

    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'get_server',
      path_params: { id: 42 },
    });

    expect(envelope(result).data).toEqual({ server: { id: 42, name: 'web' } });
  });

  it('refuses a cursor from another operation', async () => {
    fetchMock.mockImplementation(async () => page(1, 25));
    const first = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'list_servers',
    });
    const cursor = envelope(first).meta['next_cursor'];

    const replay = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'list_volumes',
      cursor,
    });

    expect(replay.isError).toBe(true);
    expect(text(replay)).toContain('does not belong to list_volumes');
  });

  it('refuses a cursor supplied alongside query filters', async () => {
    const result = await call(executeReadOperationTool, {
      connection: 'main',
      operation_id: 'list_servers',
      cursor: 'htz1.whatever.00000000',
      query: { name: 'web' },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('`query` cannot be combined with `cursor`');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe('action-returning operations', () => {
  it('reports a finished action in meta.action', async () => {
    fetchMock.mockImplementation(async () =>
      json({
        action: {
          id: 42,
          command: 'start_server',
          status: 'success',
          progress: 100,
          started: '2026-08-14T10:00:00Z',
          finished: '2026-08-14T10:00:07Z',
        },
      }),
    );

    const result = await call(executeWriteOperationTool, {
      connection: 'main',
      operation_id: 'poweron_server',
      path_params: { id: 42 },
    });

    expect(envelope(result).meta['action']).toEqual({ id: 42, status: 'success', awaited: true });
  });

  it('says plainly when it stopped waiting on a running action', async () => {
    fetchMock.mockImplementation(async () =>
      json(
        {
          server: { id: 7, name: 'web' },
          action: {
            id: 99,
            command: 'create_server',
            status: 'running',
            progress: 20,
            started: '2026-08-14T10:00:00Z',
          },
        },
        { status: 201 },
      ),
    );

    const result = await call(executeWriteOperationTool, {
      connection: 'main',
      operation_id: 'create_server',
      body: { name: 'web', server_type: 'cx22', image: 'debian-12', location: 'fsn1' },
      wait_seconds: 0,
    });

    const meta = envelope(result).meta;
    expect(meta['action']).toEqual({ id: 99, status: 'running', awaited: false });
    expect(String(meta['hint'])).toContain('still running');
    // The bill is stated next to the act, not left for the invoice.
    expect(String(meta['hint'])).toContain('open a bill');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a destructive action through the destructive door', async () => {
    fetchMock.mockImplementation(async () =>
      json({
        action: {
          id: 7,
          command: 'delete_server',
          status: 'success',
          progress: 100,
          started: '2026-08-14T10:00:00Z',
        },
      }),
    );

    const result = await call(executeDestructiveOperationTool, {
      connection: 'main',
      operation_id: 'delete_server',
      path_params: { id: 42 },
    });

    expect(envelope(result).meta['action']).toEqual({ id: 7, status: 'success', awaited: true });
    expect(urlOf()).toBe('https://api.hetzner.cloud/v1/servers/42');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });
});
