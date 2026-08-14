/**
 * `manage_dns`, with `fetch` replaced.
 *
 * The suite is organised around the ways a DNS tool destroys data rather than
 * around its feature list:
 *
 *   - RRSet addressing. Hetzner keys a record set by (zone, name, type), so the
 *     assertion is on the whole URL, not on "a request was made". A tool that
 *     dropped one of the three would still call the API — at the wrong record
 *     set, or at the zone.
 *   - The refused verbs. `set_records` and `import_zonefile` replace everything
 *     they touch, and the test asserts on the TEXT of the refusal as well as on
 *     the absence of a request, because a refusal that does not say where the
 *     operation lives sends the caller looking for a synonym.
 *   - `add_records` sending only the additions. Asserted on the request body:
 *     "the existing records survived" is a property of what was NOT sent, and
 *     nothing else in the response can show it.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { manageDnsTool } from '../src/tools/manage-dns.js';
import { SURFACE_BASE_URLS } from '../src/types.js';
import type { Connection, ServerConfig, ToolResult } from '../src/types.js';

const TOKEN = 'hcloud_9f2Ab7QxZm4LtVeR8sNpKdYc3JwHuG6XoTiB1lS0EnMqPrDaFvUyCkZjWgXh';
const BASE = SURFACE_BASE_URLS.cloud;

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function config(overrides: Partial<Connection> = {}): ServerConfig {
  const connection: Connection = {
    name: 'main',
    surface: 'cloud',
    baseUrl: BASE,
    readOnly: false,
    allowDestructive: false,
    timeoutMs: 30_000,
    credential: { kind: 'bearer', resolve: async () => ({ kind: 'bearer', token: TOKEN }) },
    ...overrides,
  };
  return {
    registry: {
      connections: new Map([[connection.name, connection]]),
      defaultName: connection.name,
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

/** A fresh `Response` per call: a body can only be read once. */
function queue(...bodies: unknown[]): void {
  for (const body of bodies) fetchMock.mockImplementationOnce(async () => json(body));
}

function call(args: Record<string, unknown>, cfg = config()): Promise<ToolResult> {
  return manageDnsTool.handler({ connection: 'main', ...args }, cfg, {});
}

function urlOf(index: number): string {
  return String(fetchMock.mock.calls[index]?.[0]);
}

function methodOf(index: number): string {
  return String(fetchMock.mock.calls[index]?.[1]?.method);
}

function bodyOf(index: number): unknown {
  const raw = fetchMock.mock.calls[index]?.[1]?.body;
  return typeof raw === 'string' ? JSON.parse(raw) : undefined;
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

function envelopeOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

function action(status: 'running' | 'success', id = 4711): unknown {
  return {
    action: {
      id,
      command: 'add_records',
      status,
      progress: status === 'success' ? 100 : 0,
      started: '2026-08-14T10:00:00Z',
      finished: status === 'success' ? '2026-08-14T10:00:02Z' : null,
      error: null,
    },
  };
}

const RRSET = {
  rrset: {
    id: 'www/A',
    name: 'www',
    type: 'A',
    ttl: 3600,
    records: [{ value: '198.51.100.1' }, { value: '198.51.100.2' }],
  },
};

/** Drives a wait that has to elapse without leaving a rejection unhandled. */
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
// Declaration
// ---------------------------------------------------------------------------

describe('manage_dns declaration', () => {
  it('is a cloud write tool that does not claim to be read-only or destructive', () => {
    expect(manageDnsTool.surface).toBe('write');
    expect(manageDnsTool.apiSurfaces).toEqual(['cloud']);
    expect(manageDnsTool.annotations.readOnlyHint).toBe(false);
    expect(manageDnsTool.annotations.destructiveHint).toBe(false);
    expect(manageDnsTool.annotations.openWorldHint).toBe(true);
    expect(manageDnsTool.annotations.title).toBeTruthy();
  });

  it('requires connection even though only one is configured', () => {
    const shape = manageDnsTool.inputSchema(config());
    expect(shape['connection']).toBeDefined();
  });

  it('exposes no parameter that could carry a URL, host or credential', () => {
    const keys = Object.keys(manageDnsTool.inputSchema(config()));
    expect(keys).toEqual([
      'connection',
      'operation',
      'zone',
      'record_name',
      'record_type',
      'records',
      'ttl',
      'wait_seconds',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

describe('RRSet addressing', () => {
  it('addresses a record set by zone, record name and record type', async () => {
    queue(action('success'), RRSET);

    await call({
      operation: 'add_records',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
      records: [{ value: '198.51.100.2' }],
    });

    expect(urlOf(0)).toBe(`${BASE}/zones/example.com/rrsets/www/A/actions/add_records`);
    expect(methodOf(0)).toBe('POST');
  });

  it('addresses a zone by its domain name rather than a numeric id', async () => {
    queue(action('success'));

    await call({ operation: 'change_zone_ttl', zone: 'example.com', ttl: 7200 });

    expect(urlOf(0)).toBe(`${BASE}/zones/example.com/actions/change_ttl`);
  });

  it('accepts a numeric zone id in the same parameter', async () => {
    queue(action('success'));

    await call({ operation: 'change_zone_ttl', zone: '4711', ttl: 7200 });

    expect(urlOf(0)).toBe(`${BASE}/zones/4711/actions/change_ttl`);
  });

  it('percent-encodes the apex label so it survives the path', async () => {
    queue({ rrset: { name: '@', type: 'TXT', records: [] } });

    await call({
      operation: 'get_rrset',
      zone: 'example.com',
      record_name: '@',
      record_type: 'TXT',
    });

    expect(urlOf(0)).toBe(`${BASE}/zones/example.com/rrsets/%40/TXT`);
  });

  it('rejects a record name that repeats the zone, and names the relative form', async () => {
    const result = await call({
      operation: 'get_rrset',
      zone: 'example.com',
      record_name: 'www.example.com',
      record_type: 'A',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('relative to the zone');
    expect(textOf(result)).toContain('"www"');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The destructive verbs
// ---------------------------------------------------------------------------

describe('refused operations', () => {
  it('refuses set_records, says what it would have done, and names the destructive door', async () => {
    const result = await call({
      operation: 'set_records',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
      records: [{ value: '198.51.100.9' }],
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('`set_records` is not available through manage_dns');
    expect(text).toContain('is deleted');
    expect(text).toContain('add_records');
    expect(text).toContain('set_zone_rrset_records');
    expect(text).toContain('execute_destructive_operation');
    expect(text).toContain('HETZNER_ALLOW_DESTRUCTIVE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses the catalog spelling of the same operation', async () => {
    const result = await call({
      operation: 'set_zone_rrset_records',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('execute_destructive_operation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses import_zonefile and points at the export that precedes it', async () => {
    const result = await call({ operation: 'import_zonefile', zone: 'example.com' });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('`import_zonefile` is not available through manage_dns');
    expect(text).toContain('import_zone_zonefile');
    expect(text).toContain('get_zone_zonefile');
    expect(text).toContain('execute_destructive_operation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses deleting a zone and points at the export that precedes it', async () => {
    const result = await call({ operation: 'delete_zone', zone: 'example.com' });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('`delete_zone` is not available through manage_dns');
    expect(text).toContain('every name and every type at once');
    expect(text).toContain('get_zone_zonefile');
    expect(text).toContain('execute_destructive_operation');
    expect(text).toContain('HETZNER_ALLOW_DESTRUCTIVE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses deleting a whole record set and points at remove_records', async () => {
    const result = await call({
      operation: 'delete_rrset',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('remove_records');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not advertise any refused verb in the operation enum', () => {
    const shape = manageDnsTool.inputSchema(config());
    const rendered = JSON.stringify(shape['operation']);
    expect(rendered).not.toContain('"set_records"');
    expect(rendered).not.toContain('"import_zonefile"');
    expect(rendered).not.toContain('"delete_zone"');
    expect(rendered).not.toContain('"delete_rrset"');
  });

  it('offers no operation the generated catalog classifies destructive', async () => {
    // The structural guard, exercised against every advertised value rather
    // than a hand-picked one. `reachable()` runs before any argument is read,
    // so a bare call reaches it; the operations then fail on a missing
    // argument, which is not what is being asserted here.
    const options = (manageDnsTool.inputSchema(config())['operation'] as { options: string[] })
      .options;
    expect(options.length).toBeGreaterThan(0);

    for (const operation of options) {
      const result = await call({ operation });
      expect(textOf(result)).not.toContain('classifies as destructive');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Additive semantics
// ---------------------------------------------------------------------------

describe('add_records', () => {
  it('sends only the records being added, leaving the rest of the set unmentioned', async () => {
    queue(action('success'), RRSET);

    const result = await call({
      operation: 'add_records',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
      records: [{ value: '198.51.100.2' }],
    });

    // The property under test: the existing 198.51.100.1 is nowhere in the
    // request. A tool that read the set and wrote it back whole would pass a
    // response-shaped assertion and fail this one.
    expect(bodyOf(0)).toEqual({ records: [{ value: '198.51.100.2' }] });
    expect(JSON.stringify(bodyOf(0))).not.toContain('198.51.100.1');

    // ...and the read-back shows both records still present.
    const data = envelopeOf(result)['data'] as { records: Array<{ value: string }> };
    expect(data.records.map((record) => record.value)).toEqual(['198.51.100.1', '198.51.100.2']);
  });

  it('reads the record set back after the action settles', async () => {
    queue(action('success'), RRSET);

    await call({
      operation: 'add_records',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
      records: [{ value: '198.51.100.2' }],
    });

    expect(methodOf(1)).toBe('GET');
    expect(urlOf(1)).toBe(`${BASE}/zones/example.com/rrsets/www/A`);
  });

  it('says the read-back failed rather than quietly omitting the record set', async () => {
    fetchMock.mockImplementationOnce(async () => json(action('success')));
    fetchMock.mockImplementationOnce(async () => json({ error: { code: 'not_found' } }, 404));

    const result = await call({
      operation: 'add_records',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
      records: [{ value: '198.51.100.2' }],
    });

    // The write succeeded, so this is NOT an error result...
    expect(result.isError).toBeUndefined();
    const meta = envelopeOf(result)['meta'] as { action?: { awaited: boolean }; hint?: string };
    expect(meta.action?.awaited).toBe(true);
    // ...but a response missing the record set must not look like a response
    // where the write did nothing.
    expect(meta.hint).toContain('The change was applied');
    expect(meta.hint).toContain('reading the record set back afterwards failed');
    expect(meta.hint).toContain('get_rrset');
  });

  it('rejects a repeated record value before sending anything', async () => {
    const result = await call({
      operation: 'add_records',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
      records: [{ value: '198.51.100.2' }, { value: '198.51.100.2' }],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('repeats the same value');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('update_records', () => {
  it('requires a comment on every record, because that is all it changes', async () => {
    const result = await call({
      operation: 'update_records',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
      records: [{ value: '198.51.100.1' }],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('`comment`');
    expect(textOf(result)).toContain('remove_records');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('remove_records', () => {
  it('names only the values to remove', async () => {
    queue(action('success'), RRSET);

    await call({
      operation: 'remove_records',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
      records: [{ value: '198.51.100.9' }],
    });

    expect(urlOf(0)).toBe(`${BASE}/zones/example.com/rrsets/www/A/actions/remove_records`);
    expect(bodyOf(0)).toEqual({ records: [{ value: '198.51.100.9' }] });
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe('actions', () => {
  it('polls a running action to completion and reports that it waited', async () => {
    queue(action('running'), action('success'), RRSET);

    const result = await withTimers(() =>
      call({
        operation: 'add_records',
        zone: 'example.com',
        record_name: 'www',
        record_type: 'A',
        records: [{ value: '198.51.100.2' }],
      }),
    );

    expect(urlOf(1)).toBe(`${BASE}/actions/4711`);
    const meta = envelopeOf(result)['meta'] as { action?: { status: string; awaited: boolean } };
    expect(meta.action).toEqual({ id: 4711, status: 'success', awaited: true });
  });

  it('says plainly when it stopped waiting rather than claiming the change landed', async () => {
    queue(action('running'));

    const result = await call({
      operation: 'add_records',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
      records: [{ value: '198.51.100.2' }],
      wait_seconds: 0,
    });

    const meta = envelopeOf(result)['meta'] as {
      action?: { awaited: boolean };
      hint?: string;
    };
    expect(meta.action?.awaited).toBe(false);
    expect(meta.hint).toContain('still running');
    // No read-back: a snapshot taken mid-change would be presented as the outcome.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed action rather than reporting the accepted HTTP call', async () => {
    queue({
      action: {
        id: 12,
        command: 'add_records',
        status: 'error',
        progress: 100,
        started: '2026-08-14T10:00:00Z',
        finished: '2026-08-14T10:00:01Z',
        error: { code: 'invalid_input', message: 'record value is not an IPv4 address' },
      },
    });

    const result = await call({
      operation: 'add_records',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
      records: [{ value: 'not-an-address' }],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('record value is not an IPv4 address');
  });
});

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

describe('zones', () => {
  it('creates a zone from its domain name', async () => {
    queue({ zone: { id: 42, name: 'example.com', ttl: 3600 }, ...(action('success') as object) });

    await call({ operation: 'create_zone', zone: 'Example.COM.', ttl: 3600 });

    expect(urlOf(0)).toBe(`${BASE}/zones`);
    // Case folded and the trailing dot dropped: both spell the same zone, and
    // Hetzner stores the lower-case dotless form.
    expect(bodyOf(0)).toEqual({ name: 'example.com', ttl: 3600 });
  });

  it('refuses a zone reference that is neither an id nor a domain name', async () => {
    const result = await call({ operation: 'create_zone', zone: 'not a domain' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('numeric zone id or a domain name');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists record sets, filtering by name and type when given', async () => {
    queue({ rrsets: [{ name: 'www', type: 'A', records: [] }] });

    const result = await call({
      operation: 'list_rrsets',
      zone: 'example.com',
      record_name: 'www',
      record_type: 'A',
    });

    // per_page is asked for because the catalog reports this endpoint as
    // paginated, and Hetzner's default page of 25 silently truncates a zone.
    expect(urlOf(0)).toBe(`${BASE}/zones/example.com/rrsets?name=www&type=A&per_page=50`);
    expect(envelopeOf(result)['meta']).toMatchObject({ count: 1 });
  });

  it('says how many record sets it did not show when the zone runs past a page', async () => {
    queue({
      rrsets: [{ name: 'www', type: 'A', records: [] }],
      meta: { pagination: { page: 1, per_page: 50, total_entries: 120 } },
    });

    const result = await call({ operation: 'list_rrsets', zone: 'example.com' });

    const meta = envelopeOf(result)['meta'] as { hint?: string };
    expect(meta.hint).toContain('120 record sets');
  });
});
