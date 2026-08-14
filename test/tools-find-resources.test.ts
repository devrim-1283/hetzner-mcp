/**
 * find_resources, with `fetch` replaced.
 *
 * The suite is organised around the properties that cannot regress rather than
 * around the code paths:
 *
 *   - The schema shrinks to fit the configuration. With one connection there is
 *     no `connection` parameter at all, and no `"*"` to choose either.
 *   - Server-side filters reach Hetzner. `label_selector` is the idiomatic way
 *     to find things in this API, and a version of this tool that fetched
 *     everything and filtered locally would be indistinguishable in its output
 *     and useless on a real fleet — so it is asserted on the outgoing URL.
 *   - A fan-out survives a broken connection and does NOT report a cancelled one
 *     as broken. Those are two different facts about the fleet.
 *   - A cursor round-trips into the next upstream page.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { configureTransport } from '../src/http/client.js';
import { findResourcesTool } from '../src/tools/find-resources.js';
import { HetznerError, SURFACE_BASE_URLS } from '../src/types.js';
import type {
  Connection,
  ResolvedCredential,
  ServerConfig,
  Surface,
  ToolEnvelope,
} from '../src/types.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
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

/** 64 alphanumerics, so it is shaped like a real Hetzner Cloud token. */
function tokenFor(name: string): string {
  return `Tk${name}9`.padEnd(64, 'x');
}

function connection(name: string, surface: Surface = 'cloud'): Connection {
  return {
    name,
    surface,
    baseUrl: SURFACE_BASE_URLS[surface],
    readOnly: false,
    allowDestructive: false,
    timeoutMs: 5_000,
    credential: {
      kind: 'bearer',
      resolve: async (): Promise<ResolvedCredential> => ({
        kind: 'bearer',
        token: tokenFor(name),
      }),
    },
  };
}

function config(connections: readonly Connection[], defaultName?: string): ServerConfig {
  return {
    registry: {
      connections: new Map(connections.map((entry) => [entry.name, entry])),
      defaultName: defaultName ?? connections[0]?.name,
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

function serverPage(rows: readonly unknown[], pagination?: Record<string, number>): unknown {
  return {
    servers: rows,
    meta: {
      pagination: pagination ?? { page: 1, per_page: 25, total_entries: rows.length, last_page: 1 },
    },
  };
}

/** The connection a request was made for, identified by its bearer token. */
function connectionOf(init: RequestInit | undefined): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers['authorization'] ?? '';
  return auth.replace('Bearer Tk', '').split('9')[0] ?? '';
}

function urls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

async function run(
  cfg: ServerConfig,
  args: Record<string, unknown>,
): Promise<{
  text: string;
  isError: boolean;
  envelope: ToolEnvelope<Array<Record<string, unknown>>>;
}> {
  const result = await findResourcesTool.handler(args, cfg, {});
  const text = result.content[0]?.text ?? '';
  let envelope: ToolEnvelope<Array<Record<string, unknown>>>;
  try {
    envelope = JSON.parse(text) as ToolEnvelope<Array<Record<string, unknown>>>;
  } catch {
    envelope = {
      data: [],
      meta: { count: 0, truncated: 0, truncation: null, hint: text },
    };
  }
  return { text, isError: result.isError === true, envelope };
}

function schemaOf(cfg: ServerConfig): Record<string, unknown> {
  return findResourcesTool.inputSchema(cfg);
}

// ---------------------------------------------------------------------------

describe('find_resources — declaration', () => {
  it('is a read tool with the mandatory annotations', () => {
    expect(findResourcesTool.surface).toBe('read');
    expect(findResourcesTool.annotations).toMatchObject({
      title: 'Find resources',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(findResourcesTool.apiSurfaces).toContain('cloud');
    expect(findResourcesTool.apiSurfaces).toContain('hetzner');
  });

  it('exposes no parameter that could name a host, a URL or a credential', () => {
    const keys = Object.keys(schemaOf(config([connection('a'), connection('b')])));
    expect(keys).toEqual([
      'query',
      'name',
      'label_selector',
      'resource_type',
      'limit',
      'cursor',
      'connection',
    ]);
  });
});

describe('find_resources — schema shape follows the configuration', () => {
  it('omits `connection` entirely when only one connection exists', () => {
    expect(schemaOf(config([connection('main')]))).not.toHaveProperty('connection');
  });

  it('offers the names and "*" when several exist', () => {
    const shape = schemaOf(config([connection('main'), connection('box', 'hetzner')]));
    expect(shape).toHaveProperty('connection');

    const schema = z.object(shape as Record<string, z.ZodType>);
    expect(schema.safeParse({ connection: '*' }).success).toBe(true);
    expect(schema.safeParse({ connection: 'box' }).success).toBe(true);
    expect(schema.safeParse({ connection: 'somewhere-else' }).success).toBe(false);
  });
});

describe('find_resources — server-side filtering', () => {
  it('hands `label_selector` and `name` to Hetzner rather than filtering locally', async () => {
    fetchMock.mockResolvedValue(json(serverPage([{ id: 42, name: 'web-1', status: 'running' }])));

    const { envelope } = await run(config([connection('main')]), {
      resource_type: 'server',
      label_selector: 'env=prod,role!=db',
      name: 'web-1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(urls()[0] as string);
    expect(url.pathname).toBe('/v1/servers');
    expect(url.searchParams.get('label_selector')).toBe('env=prod,role!=db');
    expect(url.searchParams.get('name')).toBe('web-1');
    expect(envelope.data).toHaveLength(1);
  });

  it('matches `query` as a substring of the name, which Hetzner cannot do', async () => {
    fetchMock.mockResolvedValue(
      json(
        serverPage([
          { id: 1, name: 'web-1', status: 'running' },
          { id: 2, name: 'db-1', status: 'running' },
        ]),
      ),
    );

    const { envelope } = await run(config([connection('main')]), {
      resource_type: 'server',
      query: 'WEB',
    });

    const url = new URL(urls()[0] as string);
    expect(url.searchParams.get('name')).toBeNull();
    expect(envelope.data.map((row) => row['name'])).toEqual(['web-1']);
    expect(envelope.meta.hint).toContain('query is matched in this process');
  });
});

describe('find_resources — rows', () => {
  it('returns everything another tool needs to act on the resource', async () => {
    fetchMock.mockResolvedValue(
      json(serverPage([{ id: 42, name: 'web-1', status: 'running', labels: { env: 'prod' } }])),
    );

    const { envelope } = await run(config([connection('main')]), { resource_type: 'server' });

    expect(envelope.data[0]).toEqual({
      id: 42,
      name: 'web-1',
      type: 'server',
      surface: 'cloud',
      connection: 'main',
      status: 'running',
      labels: { env: 'prod' },
    });
  });
});

describe('find_resources — fan-out', () => {
  it('caps the breadth and says so, instead of issuing N x M requests', async () => {
    fetchMock.mockImplementation(async () => json({ servers: [], volumes: [], zones: [] }));

    const cfg = config([connection('a'), connection('b'), connection('c')]);
    const { envelope } = await run(cfg, { connection: '*' });

    expect(fetchMock.mock.calls.length).toBe(12);
    expect(envelope.meta.hint).toContain('Capped at 12 list calls per invocation');
    expect(envelope.meta.hint).toMatch(/combination\(s\) were not searched/);
  });

  it('reports a failed connection in meta.errors and still returns the rows that came back', async () => {
    fetchMock.mockImplementation(async (_input, init) =>
      connectionOf(init) === 'broken'
        ? json({ error: { code: 'unauthorized', message: 'unable to authenticate' } }, 401)
        : json(serverPage([{ id: 7, name: 'web-1', status: 'running' }])),
    );

    const cfg = config([connection('good'), connection('broken')]);
    const { envelope, isError } = await run(cfg, { connection: '*', resource_type: 'server' });

    expect(isError).toBe(false);
    expect(envelope.data.map((row) => row['connection'])).toEqual(['good']);
    expect(envelope.meta.errors).toHaveLength(1);
    expect(envelope.meta.errors?.[0]?.connection).toBe('broken');
  });

  it('does not list a cancelled connection as a partial failure', async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      if (connectionOf(init) === 'gone') {
        throw new HetznerError('Cancelled by the caller.', 'cancelled');
      }
      return json(serverPage([{ id: 7, name: 'web-1', status: 'running' }]));
    });

    const cfg = config([connection('here'), connection('gone')]);
    const { envelope, isError } = await run(cfg, { connection: '*', resource_type: 'server' });

    expect(isError).toBe(false);
    expect(envelope.meta.errors).toBeUndefined();
    expect(envelope.data.map((row) => row['connection'])).toEqual(['here']);
  });

  it('marks the result as an error when nothing answered at all', async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: { code: 'unauthorized', message: 'unable to authenticate' } }, 401),
    );

    const cfg = config([connection('a'), connection('b')]);
    const { envelope, isError } = await run(cfg, { connection: '*', resource_type: 'server' });

    expect(isError).toBe(true);
    expect(envelope.meta.errors).toHaveLength(2);
    expect(envelope.meta.hint).toContain('No lookup answered');
  });
});

describe('find_resources — pagination', () => {
  it('round-trips a cursor into the next upstream page', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        serverPage([{ id: 1, name: 'web-1' }], {
          page: 1,
          per_page: 1,
          total_entries: 2,
          last_page: 2,
        }),
      ),
    );

    const cfg = config([connection('main')]);
    const first = await run(cfg, { resource_type: 'server', limit: 1 });
    const cursor = first.envelope.meta.next_cursor;
    expect(cursor).toBeTypeOf('string');
    expect(first.envelope.meta.total).toBe(2);

    fetchMock.mockResolvedValueOnce(
      json(
        serverPage([{ id: 2, name: 'web-2' }], {
          page: 2,
          per_page: 1,
          total_entries: 2,
          last_page: 2,
        }),
      ),
    );
    const second = await run(cfg, { resource_type: 'server', limit: 1, cursor });

    const url = new URL(urls()[1] as string);
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('per_page')).toBe('1');
    expect(second.envelope.data.map((row) => row['id'])).toEqual([2]);
    expect(second.envelope.meta.next_cursor).toBeUndefined();
  });

  it('refuses a cursor when the search spans several lookups', async () => {
    fetchMock.mockResolvedValue(json(serverPage([])));
    const cfg = config([connection('main')]);

    const first = await run(cfg, { resource_type: 'server', limit: 1 });
    const { text, isError } = await run(cfg, {
      cursor: first.envelope.meta.next_cursor ?? 'htz1.x.y',
    });

    expect(isError).toBe(true);
    expect(text).toContain('cannot be resumed');
  });

  it('rejects a cursor minted for another resource type', async () => {
    fetchMock.mockResolvedValue(
      json(
        serverPage([{ id: 1, name: 'web-1' }], {
          page: 1,
          per_page: 1,
          total_entries: 2,
          last_page: 2,
        }),
      ),
    );
    const cfg = config([connection('main')]);
    const first = await run(cfg, { resource_type: 'server', limit: 1 });

    const { text, isError } = await run(cfg, {
      resource_type: 'volume',
      cursor: first.envelope.meta.next_cursor,
    });

    expect(isError).toBe(true);
    expect(text).toContain('find_resources:server');
  });
});

describe('find_resources — surfaces', () => {
  it('refuses a type the named connection cannot serve', async () => {
    const cfg = config([connection('box', 'hetzner')]);
    const { text, isError } = await run(cfg, { resource_type: 'server' });

    expect(isError).toBe(true);
    expect(text).toContain('Hetzner Cloud');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an account-surface type to the account API only', async () => {
    fetchMock.mockImplementation(async () => json({ storage_boxes: [], servers: [] }));

    const cfg = config([connection('cloud'), connection('box', 'hetzner')]);
    await run(cfg, { connection: '*', resource_type: 'storage_box' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urls()[0]).toContain('api.hetzner.com/v1/storage_boxes');
  });
});
