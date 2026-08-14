/**
 * get_pricing, with `fetch` replaced.
 *
 * Three things are worth protecting here.
 *
 * `vat_rate` and `currency` survive every filter. A price quoted without saying
 * whether VAT is in it is wrong by that percentage, and the filters exist to
 * make the response smaller — dropping the one field that makes the numbers
 * interpretable would be the wrong saving.
 *
 * A location filter removes rows rather than emptying them. A server type not
 * sold in the requested location is not an answer to "what does it cost there",
 * and an empty `prices` array reads as a price of nothing.
 *
 * The account surface is refused BY NAME. Hetzner publishes no pricing endpoint
 * outside the cloud API, so sending the request would collect a 404 that reads
 * like a broken tool rather than like a fact about the API.
 *
 * The mocked body mirrors the vendored spec: `GET /pricing` answers
 * `{ "pricing": { currency, vat_rate, ...categories } }`, never a bare payload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../src/generated/catalog.js';
import { getPricingTool } from '../src/tools/get-pricing.js';
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
    timeoutMs: 30_000,
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

function money(net: string, gross: string): Record<string, string> {
  return { net, gross };
}

function locationPrice(location: string, hourly: string, monthly: string): unknown {
  return {
    location,
    price_hourly: money(hourly, String(Number(hourly) * 1.19)),
    price_monthly: money(monthly, String(Number(monthly) * 1.19)),
    included_traffic: 21_990_232_555_520,
    price_per_tb_traffic: money('1.0000', '1.1900'),
  };
}

/** The `{ pricing: { ... } }` envelope the vendored spec documents. */
const PRICING_BODY = {
  pricing: {
    currency: 'EUR',
    vat_rate: '19.00',
    primary_ips: [
      {
        type: 'ipv4',
        prices: [locationPrice('fsn1', '0.0008', '0.50'), locationPrice('ash', '0.0010', '0.60')],
      },
    ],
    floating_ips: [{ type: 'ipv4', prices: [locationPrice('fsn1', '0.0080', '4.76')] }],
    image: { price_per_gb_month: money('0.0119', '0.0142') },
    volume: { price_per_gb_month: money('0.0400', '0.0476') },
    server_backup: { percentage: '20' },
    server_types: [
      {
        id: 22,
        name: 'cx22',
        deprecation: null,
        prices: [locationPrice('fsn1', '0.0060', '3.79'), locationPrice('ash', '0.0070', '4.59')],
      },
      {
        id: 23,
        name: 'ccx13',
        deprecation: null,
        prices: [locationPrice('ash', '0.0200', '12.49')],
      },
    ],
    load_balancer_types: [
      { id: 1, name: 'lb11', deprecation: null, prices: [locationPrice('fsn1', '0.0080', '5.83')] },
    ],
    // Superseded shape Hetzner still returns. Not a category this tool offers.
    floating_ip: { price_monthly: money('3.92', '4.66') },
  },
};

function respond(body: unknown, status = 200): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function envelope(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;
}

function data(result: ToolResult): Record<string, unknown> {
  return envelope(result)['data'] as Record<string, unknown>;
}

function meta(result: ToolResult): Record<string, unknown> {
  return envelope(result)['meta'] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The whole table
// ---------------------------------------------------------------------------

describe('get_pricing', () => {
  it('returns every published category with the currency and VAT rate', async () => {
    respond(PRICING_BODY);

    const result = await getPricingTool.handler({}, config(), {});

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.hetzner.cloud/v1/pricing');
    const body = data(result);
    expect(Object.keys(body).sort()).toEqual(
      [
        'currency',
        'vat_rate',
        'primary_ips',
        'floating_ips',
        'image',
        'volume',
        'server_backup',
        'server_types',
        'load_balancer_types',
      ].sort(),
    );
    expect(body['vat_rate']).toBe('19.00');
    expect(body['currency']).toBe('EUR');
    expect(meta(result)['count']).toBe(7);
    expect(String(meta(result)['hint'])).toContain('19.00% VAT rate');
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('get_pricing filters', () => {
  it('returns one category, still carrying currency and vat_rate', async () => {
    respond(PRICING_BODY);

    const result = await getPricingTool.handler({ category: 'server_types' }, config(), {});

    expect(Object.keys(data(result)).sort()).toEqual(['currency', 'server_types', 'vat_rate']);
    expect(data(result)['vat_rate']).toBe('19.00');
    expect(meta(result)['count']).toBe(1);
  });

  it('keeps only the rows priced in the requested location', async () => {
    respond(PRICING_BODY);

    const result = await getPricingTool.handler(
      { category: 'server_types', location: 'fsn1' },
      config(),
      {},
    );

    const types = data(result)['server_types'] as Array<Record<string, unknown>>;
    // ccx13 is only sold in ash, so it is absent rather than present with an
    // empty price list.
    expect(types.map((row) => row['name'])).toEqual(['cx22']);
    const prices = types[0]?.['prices'] as Array<Record<string, unknown>>;
    expect(prices).toHaveLength(1);
    expect(prices[0]?.['location']).toBe('fsn1');
    expect(data(result)['vat_rate']).toBe('19.00');
    expect(String(meta(result)['hint'])).toContain('Restricted to location fsn1');
  });

  it('leaves per-project categories whole under a location filter', async () => {
    respond(PRICING_BODY);

    const result = await getPricingTool.handler({ location: 'ash' }, config(), {});

    expect(data(result)['volume']).toEqual({
      price_per_gb_month: { net: '0.0400', gross: '0.0476' },
    });
    expect(data(result)['server_backup']).toEqual({ percentage: '20' });
    expect(String(meta(result)['hint'])).toContain('priced per project');
    const types = data(result)['server_types'] as Array<Record<string, unknown>>;
    expect(types.map((row) => row['name'])).toEqual(['cx22', 'ccx13']);
  });

  it('names the locations that exist rather than answering empty', async () => {
    respond(PRICING_BODY);

    const result = await getPricingTool.handler({ location: 'nbg1' }, config(), {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No price row names location `nbg1`');
    expect(result.content[0]?.text).toContain('ash, fsn1');
  });

  it('resolves a costly operation to the category that quotes its bill', async () => {
    respond(PRICING_BODY);

    const result = await getPricingTool.handler({ operation: 'create_volume' }, config(), {});

    expect(Object.keys(data(result)).sort()).toEqual(['currency', 'vat_rate', 'volume']);
  });

  it('refuses a category and an operation that disagree', async () => {
    const result = await getPricingTool.handler(
      { operation: 'create_volume', category: 'server_types' },
      config(),
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('`create_volume` is priced under `volume`');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an operation that opens no published bill', async () => {
    const result = await getPricingTool.handler({ operation: 'list_servers' }, config(), {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no published price category');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a category Hetzner does not publish', async () => {
    const result = await getPricingTool.handler({ category: 'traffic' }, config(), {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('is not a price category');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

describe('get_pricing surface', () => {
  it('refuses the account surface by name instead of collecting a 404', async () => {
    const result = await getPricingTool.handler({}, config(connection('acct', 'hetzner')), {});

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('no pricing endpoint');
    expect(text).toContain('account-scoped');
    expect(text).toContain('Only Hetzner Cloud publishes machine-readable prices');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses Robot the same way', async () => {
    const result = await getPricingTool.handler({}, config(connection('dedi', 'robot')), {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no pricing endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe('get_pricing contract', () => {
  it('is a cloud-only read tool with the mandatory annotations', () => {
    expect(getPricingTool.surface).toBe('read');
    expect(getPricingTool.apiSurfaces).toEqual(['cloud']);
    expect(getPricingTool.annotations).toMatchObject({
      title: 'Get pricing',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('accepts no parameter that could carry a URL, host or credential', () => {
    expect(Object.keys(getPricingTool.inputSchema(config())).sort()).toEqual([
      'category',
      'location',
      'operation',
    ]);
  });
});
