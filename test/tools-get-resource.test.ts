/**
 * get_resource, with `fetch` replaced.
 *
 * Two of these tests are about copy rather than control flow, and they are the
 * point of the file:
 *
 *   - `resource_type` is required, and the refusal has to explain WHY. A
 *     Hetzner id is a per-type integer, so the parameter is not bureaucracy —
 *     omitting it makes the id ambiguous between real resources.
 *   - A 404 on the cloud surface has to name project scoping. A token pointed
 *     at another project answers 404 rather than 403, and a hint that only says
 *     "not found" sends the caller to check an id that was right all along.
 *
 * The third property is arithmetic: one Hetzner record can be larger than the
 * response budget, and the tool must degrade rather than blow the cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { configureTransport } from '../src/http/client.js';
import { CLOUD_PROJECT_SCOPING } from '../src/http/errors.js';
import { MAX_RESPONSE_BYTES } from '../src/shaping/envelope.js';
import { getResourceTool } from '../src/tools/get-resource.js';
import { SURFACE_BASE_URLS } from '../src/types.js';
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
        token: `Tk${name}9`.padEnd(64, 'x'),
      }),
    },
  };
}

function config(connections: readonly Connection[]): ServerConfig {
  return {
    registry: {
      connections: new Map(connections.map((entry) => [entry.name, entry])),
      defaultName: connections[0]?.name,
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

async function run(
  cfg: ServerConfig,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = await getResourceTool.handler(args, cfg, {});
  return { text: result.content[0]?.text ?? '', isError: result.isError === true };
}

function envelopeOf(text: string): ToolEnvelope<Record<string, unknown>> {
  return JSON.parse(text) as ToolEnvelope<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------

describe('get_resource — declaration', () => {
  it('is a read tool with the mandatory annotations', () => {
    expect(getResourceTool.surface).toBe('read');
    expect(getResourceTool.annotations).toMatchObject({
      title: 'Get resource',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('takes only a type, an id and — when there is a choice — a connection', () => {
    expect(Object.keys(getResourceTool.inputSchema(config([connection('main')])))).toEqual([
      'resource_type',
      'id',
    ]);
    expect(
      Object.keys(getResourceTool.inputSchema(config([connection('a'), connection('b')]))),
    ).toEqual(['resource_type', 'id', 'connection']);
  });

  it('accepts an id as a number or as a string, and never accepts "*"', () => {
    const shape = getResourceTool.inputSchema(config([connection('a'), connection('b')]));
    const schema = z.object(shape as Record<string, z.ZodType>);

    expect(schema.safeParse({ resource_type: 'server', id: 42, connection: 'a' }).success).toBe(
      true,
    );
    expect(schema.safeParse({ resource_type: 'zone', id: 'example.com' }).success).toBe(true);
    expect(schema.safeParse({ resource_type: 'server', id: 42, connection: '*' }).success).toBe(
      false,
    );
  });
});

describe('get_resource — addressing', () => {
  it('reads one record and unwraps the type key Hetzner returns it under', async () => {
    fetchMock.mockResolvedValue(json({ server: { id: 42, name: 'web-1', status: 'running' } }));

    const { text } = await run(config([connection('main')]), { resource_type: 'server', id: 42 });
    const envelope = envelopeOf(text);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/servers/42');
    expect(envelope.data).toMatchObject({ id: 42, name: 'web-1' });
    expect(envelope.meta.count).toBe(1);
    expect(envelope.connection).toBe('main');
  });

  it('addresses a DNS zone by its domain name, which Hetzner accepts directly', async () => {
    fetchMock.mockResolvedValue(json({ zone: { id: 4711, name: 'example.com' } }));

    await run(config([connection('main')]), { resource_type: 'zone', id: 'example.com' });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/zones/example.com');
  });

  it('refuses a non-numeric id for a type Hetzner addresses by id only', async () => {
    const { text, isError } = await run(config([connection('main')]), {
      resource_type: 'server',
      id: 'web-1',
    });

    expect(isError).toBe(true);
    expect(text).toContain('positive integer id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a type the connection’s surface cannot serve', async () => {
    const { text, isError } = await run(config([connection('box', 'hetzner')]), {
      resource_type: 'server',
      id: 42,
    });

    expect(isError).toBe(true);
    expect(text).toContain('Hetzner Cloud');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('get_resource — resource_type is required', () => {
  it('explains why, and names the types', async () => {
    const { text, isError } = await run(config([connection('main')]), { id: 42 });

    expect(isError).toBe(true);
    expect(text).toContain('`resource_type` is required.');
    expect(text).toContain('server');
    expect(text).toContain('the same integer can be a server and a volume');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a type outside the table instead of guessing a path', async () => {
    const { text, isError } = await run(config([connection('main')]), {
      resource_type: 'droplet',
      id: 42,
    });

    expect(isError).toBe(true);
    expect(text).toContain('must be one of');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('get_resource — the 404', () => {
  it('says a cloud 404 is also what a token for another project returns', async () => {
    fetchMock.mockResolvedValue(
      json({ error: { code: 'not_found', message: 'server not found' } }, 404),
    );

    const { text, isError } = await run(config([connection('main')]), {
      resource_type: 'server',
      id: 42,
    });

    expect(isError).toBe(true);
    expect(text).toContain('No server with id 42 on connection `main`.');
    expect(text).toContain('On Hetzner Cloud a 404 does not only mean the id is wrong.');
    // Composed from the transport's own constant rather than restated here, so
    // this assertion fails if the two ever drift apart.
    expect(text).toContain(CLOUD_PROJECT_SCOPING);
    expect(text).toContain('find_resources lists the ids this token can see');
  });

  it('does not claim project scoping on the account surface, which has no projects', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'not_found', message: 'not found' } }, 404));

    const { text } = await run(config([connection('box', 'hetzner')]), {
      resource_type: 'storage_box',
      id: 7,
    });

    expect(text).toContain('No storage_box with id 7 on connection `box`.');
    expect(text).not.toContain(CLOUD_PROJECT_SCOPING);
    expect(text).toContain('has no projects');
    expect(text).toContain('the account connection `box` authenticates as');
    expect(text).toContain('find_resources lists the ids this token can see');
  });

  it('reports an empty body as a missing record rather than as a resource', async () => {
    fetchMock.mockResolvedValue(json({}));

    const { text, isError } = await run(config([connection('main')]), {
      resource_type: 'server',
      id: 42,
    });

    expect(isError).toBe(true);
    expect(text).toContain('no `server` object');
  });
});

describe('get_resource — oversized records degrade', () => {
  it('stays inside the response budget and reports which rung fired', async () => {
    // One field larger than the whole budget: a cloud-init blob, a zone file, a
    // certificate chain. The record must survive; the field need not.
    fetchMock.mockResolvedValue(
      json({
        server: {
          id: 42,
          name: 'web-1',
          status: 'running',
          public_net: { ipv4: { ip: '203.0.113.10' } },
          user_data: 'x'.repeat(200_000),
        },
      }),
    );

    const { text } = await run(config([connection('main')]), { resource_type: 'server', id: 42 });
    const envelope = envelopeOf(text);

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(envelope.meta.truncation).toBe('field_value');
    expect(envelope.data['id']).toBe(42);
    expect(envelope.data['name']).toBe('web-1');
    expect(String(envelope.data['user_data'])).toMatch(/^<truncated: \d+ bytes>$/);
    expect(envelope.meta.hint).toContain('oversized value(s) replaced');
  });
});
