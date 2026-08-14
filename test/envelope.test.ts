import { describe, expect, it } from 'vitest';

import {
  attachAction,
  attachBilling,
  billingFromPrices,
  MAX_RESPONSE_BYTES,
  renderEnvelope,
  shapeResponse,
} from '../src/shaping/envelope.js';
import { decodeCursor, encodeCursor, type CursorState } from '../src/shaping/cursor.js';
import {
  defaultShape,
  downsampleMetrics,
  project,
  projectOne,
  prune,
  SERVER_FIELDS,
  SERVER_PRUNABLE,
} from '../src/shaping/project.js';

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

// ---------------------------------------------------------------------------
// Fixture
//
// A toy object would make every budget assertion meaningless, so this is the
// real shape of GET /servers/{id} — the embedded image, the embedded datacenter
// with its three arrays of available server-type ids, and the embedded
// server_type with a price entry per location. Sizes here are the whole point
// of the tests below.
// ---------------------------------------------------------------------------

const LOCATIONS = [
  'fsn1',
  'nbg1',
  'hel1',
  'ash',
  'hil',
  'sin',
  'fsn2',
  'nbg2',
  'hel2',
  'ash2',
  'hil2',
  'sin2',
];

function prices(): unknown[] {
  return LOCATIONS.map((location, index) => ({
    location,
    price_hourly: { net: '0.0100000000', gross: '0.0119000000' },
    price_monthly: { net: `${6 + index}.3000000000`, gross: `${7 + index}.4970000000` },
    included_traffic: 21990232555520,
    price_per_tb_traffic: { net: '1.0000000000', gross: '1.1900000000' },
  }));
}

const SERVER_TYPE_IDS = Array.from({ length: 64 }, (_, i) => 100 + i);

function makeServer(id: number): Record<string, unknown> {
  return {
    id,
    name: `web-${id}.example.com`,
    status: 'running',
    created: '2024-11-03T09:12:44+00:00',
    public_net: {
      ipv4: {
        id: 90000 + id,
        ip: `159.69.${id % 255}.12`,
        blocked: false,
        dns_ptr: `static.${id}.clients.your-server.de`,
      },
      ipv6: {
        id: 91000 + id,
        ip: `2a01:4f8:1c17:${id.toString(16)}::/64`,
        blocked: false,
        dns_ptr: [],
      },
      floating_ips: [],
      firewalls: [{ id: 38, status: 'applied' }],
    },
    private_net: [
      { network: 4711, ip: `10.0.0.${id % 255}`, alias_ips: [], mac_address: '86:00:ff:2a:7d:e1' },
    ],
    server_type: {
      id: 22,
      name: 'cpx31',
      description: 'CPX 31',
      cores: 4,
      memory: 8,
      disk: 160,
      deprecated: false,
      prices: prices(),
      storage_type: 'local',
      cpu_type: 'shared',
      architecture: 'x86',
      included_traffic: 21990232555520,
      deprecation: null,
    },
    datacenter: {
      id: 4,
      name: 'fsn1-dc14',
      description: 'Falkenstein DC Park 14',
      location: {
        id: 1,
        name: 'fsn1',
        description: 'Falkenstein DC Park 1',
        country: 'DE',
        city: 'Falkenstein',
        latitude: 50.47612,
        longitude: 12.370071,
        network_zone: 'eu-central',
      },
      server_types: {
        supported: SERVER_TYPE_IDS,
        available: SERVER_TYPE_IDS,
        available_for_migration: SERVER_TYPE_IDS,
      },
    },
    image: {
      id: 114690387,
      type: 'system',
      status: 'available',
      name: 'ubuntu-24.04',
      description: 'Ubuntu 24.04',
      image_size: null,
      disk_size: 5,
      created: '2024-04-25T09:12:44+00:00',
      created_from: null,
      bound_to: null,
      os_flavor: 'ubuntu',
      os_version: '24.04',
      architecture: 'x86',
      rapid_deploy: true,
      protection: { delete: false },
      deprecated: null,
      labels: {},
      deleted: null,
    },
    iso: null,
    rescue_enabled: false,
    locked: false,
    backup_window: null,
    outgoing_traffic: 123456789,
    ingoing_traffic: 987654321,
    included_traffic: 21990232555520,
    protection: { delete: false, rebuild: false },
    labels: { env: 'prod', team: 'platform', role: 'web' },
    volumes: [],
    load_balancers: [],
    primary_disk_size: 160,
    placement_group: null,
  };
}

function makeServers(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => makeServer(i + 1));
}

const PAGE_CURSOR: CursorState = {
  op: 'list_servers',
  page: 2,
  perPage: 25,
  connection: 'prod',
  query: { sort: 'name:asc' },
};

// ---------------------------------------------------------------------------
// Fixture sanity — the numbers the rest of the suite depends on
// ---------------------------------------------------------------------------

describe('the Hetzner server payload', () => {
  it('is the multi-kilobyte object the shaping layer exists for', () => {
    const size = bytes(makeServer(1));

    expect(size).toBeGreaterThan(5_000);
  });

  it('spends most of itself on a price table nobody asked for', () => {
    const server = makeServer(1);
    const priceBytes = bytes((server['server_type'] as Record<string, unknown>)['prices']);

    expect(priceBytes / bytes(server)).toBeGreaterThan(0.4);
  });

  it('busts the response budget well before a full page of 25', () => {
    expect(bytes(makeServers(25))).toBeGreaterThan(MAX_RESPONSE_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe('default server projection', () => {
  it('drops server_type.prices, which is the same table on every row', () => {
    const [row] = project([makeServer(1)], SERVER_FIELDS);
    const serverType = row?.['server_type'] as Record<string, unknown>;

    expect(serverType).toBeDefined();
    expect('prices' in serverType).toBe(false);
    expect(serverType['cores']).toBe(4);
    expect(serverType['memory']).toBe(8);
  });

  it('drops the datacenter server-type id arrays but keeps where the machine is', () => {
    const [row] = project([makeServer(1)], SERVER_FIELDS);
    const datacenter = row?.['datacenter'] as Record<string, unknown>;

    expect('server_types' in datacenter).toBe(false);
    expect(datacenter['name']).toBe('fsn1-dc14');
    expect((datacenter['location'] as Record<string, unknown>)['name']).toBe('fsn1');
  });

  it('keeps the fields a fleet question actually needs', () => {
    const [row] = project([makeServer(7)], SERVER_FIELDS);

    expect(row?.['id']).toBe(7);
    expect(row?.['status']).toBe('running');
    expect(
      ((row?.['public_net'] as Record<string, unknown>)['ipv4'] as Record<string, unknown>)['ip'],
    ).toBe('159.69.7.12');
  });

  it('cuts a server to a fraction of its wire size', () => {
    const before = bytes(makeServer(1));
    const after = bytes(projectOne(makeServer(1), SERVER_FIELDS));

    expect(after).toBeLessThan(before * 0.25);
  });

  it('traverses arrays elementwise rather than failing on them', () => {
    const [row] = project([makeServer(1)], ['private_net.ip']);

    expect(row?.['private_net']).toEqual([{ ip: '10.0.0.1' }]);
  });

  it('omits an absent field instead of emitting a null value', () => {
    expect('placement_group' in projectOne({ id: 1 }, ['id', 'placement_group'])).toBe(false);
  });

  it('does not mutate the input row', () => {
    const server = makeServer(1);

    project([server], SERVER_FIELDS);
    prune([server], SERVER_PRUNABLE);

    expect(server['labels']).toEqual({ env: 'prod', team: 'platform', role: 'web' });
  });

  it('keeps prices on the server-types family, where they are the answer', () => {
    expect(defaultShape('server-types').fields).toContain('prices');
    expect(defaultShape('servers').fields).not.toContain('prices');
  });

  it('returns no allowlist for a family it does not know, rather than guessing one', () => {
    expect(defaultShape('other')).toEqual({});
  });
});

describe('prune', () => {
  it('drops nested paths without disturbing their siblings', () => {
    const [row] = prune([projectOne(makeServer(1), SERVER_FIELDS)], ['image.os_version']);
    const image = row?.['image'] as Record<string, unknown>;

    expect('os_version' in image).toBe(false);
    expect(image['name']).toBe('ubuntu-24.04');
  });
});

// ---------------------------------------------------------------------------
// The degradation ladder
// ---------------------------------------------------------------------------

describe('degradation ladder', () => {
  const shape = defaultShape('servers');

  /**
   * Budgets are derived from the fixture rather than hardcoded. A magic number
   * here would silently start testing a different rung the first time the
   * default allowlist changes, which is exactly when these assertions matter.
   */
  const afterProjection = (rows: Array<Record<string, unknown>>): number =>
    bytes(shapeResponse(rows, {}, { ...shape, maxBytes: 10_000_000 }));

  const afterEverySacrifice = (rows: Array<Record<string, unknown>>): number =>
    bytes(
      shapeResponse(
        prune(project(rows, SERVER_FIELDS), SERVER_PRUNABLE),
        {},
        { maxBytes: 10_000_000 },
      ),
    );

  it('rung 0: returns a payload that fits untouched', () => {
    const envelope = shapeResponse(makeServers(3), {}, shape);

    expect(envelope.meta.truncation).toBeNull();
    expect(envelope.meta.truncated).toBe(0);
    expect(envelope.meta.count).toBe(3);
    expect(envelope.meta.hint).toBeUndefined();
  });

  it('rung 1: drops declared fields first, keeping every row', () => {
    const rows = makeServers(6);
    const full = bytes(shapeResponse(rows, {}, shape));

    const envelope = shapeResponse(rows, {}, { ...shape, maxBytes: full + 1024 - 200 });

    expect(envelope.meta.truncation).toBe('field_prune');
    expect(envelope.meta.count).toBe(6);
    expect(envelope.meta.truncated).toBe(0);
    // Reports what it took, and takes it from the front of the declared order.
    expect(envelope.meta.hint).toContain('labels');
    expect((envelope.data[0] as Record<string, unknown>)['labels']).toBeUndefined();
  });

  it('rung 1: never names a field the payload did not have', () => {
    const rows = makeServers(6);
    const stripped = rows.map(({ labels: _labels, ...rest }) => rest);
    const full = bytes(shapeResponse(stripped, {}, shape));

    const envelope = shapeResponse(stripped, {}, { ...shape, maxBytes: full + 1024 - 200 });

    expect(envelope.meta.hint ?? '').not.toContain('labels');
  });

  it('rung 2: drops rows once field pruning is exhausted, and says how many', () => {
    const rows = makeServers(40);
    // Below what survives even the complete prunable list, so rung 1 cannot save it.
    const maxBytes = Math.floor(afterEverySacrifice(rows) / 2);

    const envelope = shapeResponse(rows, {}, { ...shape, maxBytes });

    expect(envelope.meta.truncation).toBe('row_limit');
    expect(envelope.meta.truncated).toBeGreaterThan(0);
    expect(envelope.meta.count).toBe((envelope.data as unknown[]).length);
    expect(envelope.meta.count + envelope.meta.truncated).toBe(40);
    expect(envelope.meta.hint).toContain('of 40 rows');
  });

  it('rung 2: keeps at least one row so the record shape is still visible', () => {
    const envelope = shapeResponse(makeServers(40), {}, { ...shape, maxBytes: 1100 });

    expect((envelope.data as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('rung 2: resumes inside the same upstream page rather than skipping the remainder', () => {
    const rows = makeServers(25);

    const envelope = shapeResponse(
      rows,
      { cursor: PAGE_CURSOR, next_cursor: encodeCursor({ ...PAGE_CURSOR, page: 3 }) },
      { ...shape, maxBytes: Math.floor(afterEverySacrifice(rows) / 2) },
    );
    const resumed = decodeCursor(envelope.meta.next_cursor as string);

    expect(envelope.meta.truncated).toBeGreaterThan(0);
    // Page 2, not page 3: the rows the ladder cut are still on page 2.
    expect(resumed.page).toBe(2);
    expect(resumed.skip).toBe(envelope.meta.count);
  });

  it('rung 3: caps an oversized string value', () => {
    const data = { id: 1, user_data: 'x'.repeat(80_000) };

    const envelope = shapeResponse(data, {}, { maxBytes: 20_000 });

    expect(envelope.meta.truncation).toBe('field_value');
    expect((envelope.data as Record<string, unknown>)['id']).toBe(1);
    expect((envelope.data as Record<string, unknown>)['user_data']).toMatch(
      /^<truncated: \d+ bytes>$/,
    );
    expect(envelope.meta.hint).toContain('oversized value');
  });

  it('rung 3: caps a dense metrics time series, which no earlier rung can touch', () => {
    const values = Array.from({ length: 9000 }, (_, i) => [1700000000 + i * 60, `${i % 100}.0`]);
    const data = { metrics: { start: 'a', end: 'b', step: 60, time_series: { cpu: { values } } } };

    const envelope = shapeResponse(data, {}, { maxBytes: 20_000 });
    const series = (
      (envelope.data as Record<string, unknown>)['metrics'] as Record<string, unknown>
    )['time_series'] as Record<string, { values: unknown }>;

    expect(envelope.meta.truncation).toBe('field_value');
    expect(series['cpu']?.values).toBe(`<truncated: 9000 values, ${bytes(values)} bytes>`);
  });

  it('rung 3: leaves a short array alone — a list of ports is not a time series', () => {
    const data = { ports: [80, 443], filler: 'x'.repeat(80_000) };

    const envelope = shapeResponse(data, {}, { maxBytes: 20_000 });

    expect((envelope.data as Record<string, unknown>)['ports']).toEqual([80, 443]);
  });

  it('fires the rungs in order: the cheapest one that fits is the one that ships', () => {
    const rows = makeServers(40);
    const roomy = afterProjection(rows) + 4_096;
    const tight = afterEverySacrifice(rows) + 2_048;
    const hopeless = Math.floor(afterEverySacrifice(rows) / 2);

    const seen = [hopeless, tight, roomy].map(
      (maxBytes) => shapeResponse(rows, {}, { ...shape, maxBytes }).meta.truncation,
    );

    expect(tight).toBeLessThan(roomy);
    expect(seen).toEqual(['row_limit', 'field_prune', null]);
  });

  it('brings a moderately oversized fleet under budget on field pruning alone', () => {
    // 400 projected servers are ~3x the budget on the wire and still fit once
    // the prunable list has been spent — which is the point of ordering the
    // ladder this way: nobody loses a row.
    const rows = makeServers(400);

    const envelope = shapeResponse(rows, { cursor: PAGE_CURSOR }, shape);

    expect(bytes(rows)).toBeGreaterThan(MAX_RESPONSE_BYTES * 5);
    expect(bytes(envelope)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(envelope.meta.truncation).toBe('field_prune');
    expect(envelope.meta.count).toBe(400);
  });

  it('brings a fleet past every sacrifice under budget, and keeps the remainder reachable', () => {
    const rows = makeServers(1_200);

    const envelope = shapeResponse(rows, { cursor: PAGE_CURSOR }, shape);

    expect(bytes(envelope)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(envelope.meta.count).toBeGreaterThan(0);
    expect(envelope.meta.truncated).toBeGreaterThan(0);
    // What was dropped is recoverable rather than skipped.
    expect(decodeCursor(envelope.meta.next_cursor as string).skip).toBe(envelope.meta.count);
  });

  it('never exceeds the budget, even against structural bulk no rung can shrink', () => {
    // Thousands of tiny fields: nothing to prune, one row, no long values.
    const wide: Record<string, number> = {};
    for (let i = 0; i < 20_000; i++) wide[`f${i}`] = i;

    const envelope = shapeResponse(wide, {}, { maxBytes: 8_000 });

    expect(bytes(envelope)).toBeLessThanOrEqual(8_000);
    expect(envelope.meta.truncation).toBe('field_value');
  });
});

// ---------------------------------------------------------------------------
// Metrics downsampling
// ---------------------------------------------------------------------------

describe('downsampleMetrics', () => {
  it('thins a dense series while keeping its first and last point', () => {
    const values = Array.from({ length: 5000 }, (_, i) => [i, `${i}`]);

    const out = downsampleMetrics({ time_series: { cpu: { values } } }, 100);
    const kept = out.time_series?.['cpu']?.values as unknown[];

    expect(kept.length).toBeLessThanOrEqual(101);
    expect(kept[0]).toEqual([0, '0']);
    expect(kept[kept.length - 1]).toEqual([4999, '4999']);
  });

  it('leaves a series that is already short enough untouched', () => {
    const values = [
      [1, '1'],
      [2, '2'],
    ];

    const out = downsampleMetrics({ time_series: { cpu: { values } } }, 100);

    expect(out.time_series?.['cpu']?.values).toBe(values);
  });
});

// ---------------------------------------------------------------------------
// Meta helpers
// ---------------------------------------------------------------------------

describe('billing meta', () => {
  it('attaches a price statement without disturbing the rest of the envelope', () => {
    const base = shapeResponse({ id: 42 }, { connection: 'prod' });

    const withPrice = attachBilling(base, { monthly: '7.49', hourly: '0.0119', currency: 'EUR' });

    expect(withPrice.meta.billing).toEqual({ monthly: '7.49', hourly: '0.0119', currency: 'EUR' });
    expect(withPrice.data).toEqual(base.data);
    expect(withPrice.connection).toBe('prod');
    expect(base.meta.billing).toBeUndefined();
  });

  it('pulls the one price row that matters out of the table projection drops', () => {
    const serverType = makeServer(1)['server_type'] as Record<string, unknown>;

    const billing = billingFromPrices(serverType['prices'] as never, 'nbg1');

    expect(billing).toEqual({ monthly: '8.4970000000', hourly: '0.0119000000', currency: 'EUR' });
  });

  it('returns nothing rather than a confidently wrong price for an unknown location', () => {
    const serverType = makeServer(1)['server_type'] as Record<string, unknown>;

    expect(billingFromPrices(serverType['prices'] as never, 'mars1')).toBeUndefined();
    expect(billingFromPrices(undefined, 'fsn1')).toBeUndefined();
    expect(billingFromPrices([], 'fsn1')).toBeUndefined();
  });
});

describe('action meta', () => {
  it('records that the tool waited for the action', () => {
    const base = shapeResponse({ id: 42 });

    const out = attachAction(base, { id: 1337, status: 'success' }, true);

    expect(out.meta.action).toEqual({ id: 1337, status: 'success', awaited: true });
  });

  it('records that it did not, so "accepted" cannot read as "done"', () => {
    const out = attachAction(shapeResponse({ id: 42 }), { id: 1337, status: 'running' }, false);

    expect(out.meta.action).toEqual({ id: 1337, status: 'running', awaited: false });
  });
});

// ---------------------------------------------------------------------------
// One-time credentials and the last redaction throat
// ---------------------------------------------------------------------------

describe('one-time credentials in the envelope', () => {
  const created = {
    server: { id: 42, name: 'db-1' },
    root_password: 'YItygq1v3GYjjMomLaKc',
  };

  it('passes root_password through and flags that it exists exactly once', () => {
    const envelope = shapeResponse(created);

    expect(envelope.data.root_password).toBe('YItygq1v3GYjjMomLaKc');
    expect(envelope.meta.one_time_secrets).toEqual(['root_password']);
    expect(envelope.meta.hint).toContain('not recoverable');
  });

  it('survives serialization to the tool result', () => {
    const text = renderEnvelope(shapeResponse(created)).content[0]?.text ?? '';

    expect(text).toContain('YItygq1v3GYjjMomLaKc');
    expect(JSON.parse(text)).toBeTruthy();
  });

  it('leaves the flag off when there is nothing to flag', () => {
    expect(shapeResponse({ server: { id: 42 } }).meta.one_time_secrets).toBeUndefined();
  });

  it('still masks an API token that rode in on the payload', () => {
    const envelope = shapeResponse({ api_token: 'x'.repeat(40) });

    expect((envelope.data as Record<string, unknown>)['api_token']).toBe('***');
  });
});

describe('renderEnvelope', () => {
  it('emits valid JSON with the credential shapes stripped', () => {
    const envelope = shapeResponse({
      note: 'leftover LRK9DAWQ1ZAEFSrCNEEzLCUwhYX1U3g7wMg4dTlkkDC96fyDuyJ39nVbVjCKSDfj here',
    });

    const text = renderEnvelope(envelope).content[0]?.text ?? '';

    expect(text).not.toContain('LRK9DAWQ1ZAEFSrCNEEz');
    expect(() => JSON.parse(text) as unknown).not.toThrow();
  });
});
