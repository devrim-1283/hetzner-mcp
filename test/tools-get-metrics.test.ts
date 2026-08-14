/**
 * get_metrics, with `fetch` replaced.
 *
 * The claim under test is narrow and load-bearing: a thinned series must be
 * indistinguishable from a complete one ONLY in shape, never in what the
 * response says about itself. So the assertions are about the hint as much as
 * about the data — a silently downsampled series gets read as the real one, and
 * a reader who believes they are looking at ten-second resolution when they are
 * looking at five-minute resolution will draw a wrong conclusion confidently.
 *
 * The second claim is that thinning STRIDES rather than averages. Averaging
 * would smooth the spike that is the reason anyone opened metrics at all, so the
 * test asserts a real spike survives verbatim rather than asserting a point
 * count.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../src/generated/catalog.js';
import { getMetricsTool } from '../src/tools/get-metrics.js';
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

function respond(body: unknown, status = 200): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

/** `points` samples ten seconds apart, with one deliberate spike near the middle. */
function series(points: number, spikeAt: number): Array<[number, string]> {
  const values: Array<[number, string]> = [];
  for (let index = 0; index < points; index += 1) {
    values.push([1_714_564_800 + index * 10, index === spikeAt ? '0.97' : '0.05']);
  }
  return values;
}

function metricsBody(values: Array<[number, string]>, step = 10): unknown {
  return {
    metrics: {
      start: '2024-05-01T12:00:00+00:00',
      end: '2024-05-01T15:00:00+00:00',
      step,
      time_series: { 'cpu.load': { values } },
    },
  };
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

function keptValues(result: ToolResult): Array<[number, string]> {
  const timeSeries = data(result)['time_series'] as Record<
    string,
    { values: Array<[number, string]> }
  >;
  return timeSeries['cpu.load']?.values ?? [];
}

const WINDOW = { start: '2024-05-01T12:00:00Z', end: '2024-05-01T15:00:00Z' };

// ---------------------------------------------------------------------------
// Downsampling
// ---------------------------------------------------------------------------

describe('get_metrics downsampling', () => {
  it('thins a dense series and states in meta.hint that it did', async () => {
    respond(metricsBody(series(1_000, 500)));

    const result = await getMetricsTool.handler(
      { resource_type: 'server', id: 7, metric_type: 'cpu', ...WINDOW },
      config(),
      {},
    );

    const values = keptValues(result);
    expect(values.length).toBeLessThan(1_000);
    expect(values.length).toBeLessThanOrEqual(120);

    const hint = String(meta(result)['hint']);
    expect(hint).toContain('Downsampled');
    expect(hint).toContain('cpu.load 1000 to');
    // The number a reader needs in order not to misread the series: the spacing
    // they are actually looking at, next to the one Hetzner applied.
    expect(hint).toContain('effective resolution of 90s rather than 10s');
    expect(hint).toContain('not averaged');
    expect(data(result)['downsampled']).toBe(true);
  });

  it('keeps original samples, so a spike survives instead of being smoothed', async () => {
    // Placed on a kept index (stride 9 over 1000 points) so the assertion is
    // about averaging rather than about which samples the stride happens to hit.
    respond(metricsBody(series(1_000, 450)));

    const result = await getMetricsTool.handler(
      { resource_type: 'server', id: 7, metric_type: 'cpu', ...WINDOW },
      config(),
      {},
    );

    const values = keptValues(result);
    // Every kept point is a verbatim sample: no synthesized value exists.
    for (const [, value] of values) expect(['0.05', '0.97']).toContain(value);
    expect(values.some(([, value]) => value === '0.97')).toBe(true);
    // First and last of the source window are preserved, so the series still
    // reads as covering the window it claims to.
    expect(values[0]?.[0]).toBe(1_714_564_800);
    expect(values[values.length - 1]?.[0]).toBe(1_714_564_800 + 999 * 10);
  });

  it('returns a short series whole and says nothing was thinned', async () => {
    respond(metricsBody(series(30, 10)));

    const result = await getMetricsTool.handler(
      { resource_type: 'server', id: 7, metric_type: 'cpu', ...WINDOW },
      config(),
      {},
    );

    expect(keptValues(result).length).toBe(30);
    expect(data(result)['downsampled']).toBe(false);
    expect(String(meta(result)['hint'])).toContain('nothing was thinned');
  });

  it('honours max_points', async () => {
    respond(metricsBody(series(1_000, 500)));

    const result = await getMetricsTool.handler(
      { resource_type: 'server', id: 7, metric_type: 'cpu', max_points: 20, ...WINDOW },
      config(),
      {},
    );

    expect(keptValues(result).length).toBeLessThanOrEqual(21);
    expect(String(meta(result)['hint'])).toContain('effective resolution of 500s');
  });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('get_metrics request', () => {
  it('sends type, start, end and step to the resource-specific endpoint', async () => {
    respond(metricsBody(series(10, 1), 60));

    await getMetricsTool.handler(
      {
        resource_type: 'load_balancer',
        id: 12,
        metric_type: 'open_connections',
        step: 60,
        ...WINDOW,
      },
      config(),
      {},
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/v1/load_balancers/12/metrics');
    expect(url.searchParams.get('type')).toBe('open_connections');
    expect(url.searchParams.get('start')).toBe(WINDOW.start);
    expect(url.searchParams.get('end')).toBe(WINDOW.end);
    expect(url.searchParams.get('step')).toBe('60');
  });

  it('omits step when it was not given', async () => {
    respond(metricsBody(series(10, 1)));

    await getMetricsTool.handler(
      { resource_type: 'server', id: 7, metric_type: 'network', ...WINDOW },
      config(),
      {},
    );

    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.has('step')).toBe(false);
  });

  it('reports when Hetzner applied a coarser step than the one requested', async () => {
    respond(metricsBody(series(10, 1), 300));

    const result = await getMetricsTool.handler(
      { resource_type: 'server', id: 7, metric_type: 'cpu', step: 10, ...WINDOW },
      config(),
      {},
    );

    expect(String(meta(result)['hint'])).toContain('was not the step applied');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('get_metrics validation', () => {
  it('names the right metric set when a type belongs to the other resource', async () => {
    const result = await getMetricsTool.handler(
      { resource_type: 'load_balancer', id: 12, metric_type: 'cpu', ...WINDOW },
      config(),
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not a load_balancer metric');
    expect(result.content[0]?.text).toContain('open_connections');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a timestamp without a zone', async () => {
    const result = await getMetricsTool.handler(
      {
        resource_type: 'server',
        id: 7,
        metric_type: 'cpu',
        start: '2024-05-01T12:00:00',
        end: WINDOW.end,
      },
      config(),
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('RFC 3339');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an inverted window before sending it', async () => {
    const result = await getMetricsTool.handler(
      { resource_type: 'server', id: 7, metric_type: 'cpu', start: WINDOW.end, end: WINDOW.start },
      config(),
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('`start` is not before `end`');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-cloud connection by name', async () => {
    const result = await getMetricsTool.handler(
      { resource_type: 'server', id: 7, metric_type: 'cpu', ...WINDOW },
      config(connection('acct', 'hetzner')),
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Metrics are a Hetzner Cloud feature');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe('get_metrics contract', () => {
  it('is a cloud-only read tool with the mandatory annotations', () => {
    expect(getMetricsTool.surface).toBe('read');
    expect(getMetricsTool.apiSurfaces).toEqual(['cloud']);
    expect(getMetricsTool.annotations).toMatchObject({
      title: 'Get metrics',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('accepts no parameter that could carry a URL, host or credential', () => {
    expect(Object.keys(getMetricsTool.inputSchema(config())).sort()).toEqual(
      ['end', 'id', 'max_points', 'metric_type', 'resource_type', 'start', 'step'].sort(),
    );
  });
});
