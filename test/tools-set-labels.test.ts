/**
 * `set_labels`, with `fetch` replaced.
 *
 * Two properties carry the whole tool, and both are asserted on the REQUEST
 * BODY rather than on the response:
 *
 *   - Merge. Hetzner's PUT replaces the entire label map, so "unrelated labels
 *     survived" is a claim about what the tool sent, not about what Hetzner
 *     echoed. A mock that returns the labels it was given would make a
 *     response-shaped assertion pass for a tool that erased everything.
 *   - Replace. The opposite property, asserted the same way, so that the
 *     destructive option is proven to actually be destructive and therefore
 *     worth requiring by name.
 *
 * Validation is asserted on the message text: an invalid label is otherwise a
 * generic 400 from Hetzner, and the point of checking locally is that the
 * refusal names the key and the rule.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { setLabelsTool } from '../src/tools/set-labels.js';
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
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function config(): ServerConfig {
  const connection: Connection = {
    name: 'main',
    surface: 'cloud',
    baseUrl: BASE,
    readOnly: false,
    allowDestructive: false,
    timeoutMs: 30_000,
    credential: { kind: 'bearer', resolve: async () => ({ kind: 'bearer', token: TOKEN }) },
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

function queue(...bodies: unknown[]): void {
  for (const body of bodies) fetchMock.mockImplementationOnce(async () => json(body));
}

function call(args: Record<string, unknown>): Promise<ToolResult> {
  return setLabelsTool.handler({ connection: 'main', ...args }, config(), {});
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

/** A server whose labels the caller did not ask about, which must survive. */
function serverWith(labels: Record<string, string>): unknown {
  return { server: { id: 42, name: 'web-01', labels } };
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

describe('set_labels declaration', () => {
  it('is a cloud write tool that does not claim to be read-only or destructive', () => {
    expect(setLabelsTool.surface).toBe('write');
    expect(setLabelsTool.apiSurfaces).toEqual(['cloud']);
    expect(setLabelsTool.annotations.readOnlyHint).toBe(false);
    expect(setLabelsTool.annotations.destructiveHint).toBe(false);
    expect(setLabelsTool.annotations.openWorldHint).toBe(true);
    expect(setLabelsTool.annotations.title).toBeTruthy();
  });

  it('requires connection even though only one is configured', () => {
    expect(setLabelsTool.inputSchema(config())['connection']).toBeDefined();
  });

  it('exposes no parameter that could carry a URL, host or credential', () => {
    expect(Object.keys(setLabelsTool.inputSchema(config()))).toEqual([
      'connection',
      'resource_type',
      'id',
      'labels',
      'replace',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe('merge (the default)', () => {
  it('preserves labels the request never mentioned', async () => {
    queue(
      serverWith({ env: 'prod', team: 'core' }),
      serverWith({ env: 'prod', team: 'core', role: 'web' }),
    );

    const result = await call({ resource_type: 'server', id: 42, labels: { role: 'web' } });

    expect(urlOf(0)).toBe(`${BASE}/servers/42`);
    expect(methodOf(0)).toBe('GET');
    expect(methodOf(1)).toBe('PUT');
    // The whole point: Hetzner's PUT overwrites, so `env` and `team` had to be
    // read and sent back or they would be gone.
    expect(bodyOf(1)).toEqual({ labels: { env: 'prod', team: 'core', role: 'web' } });

    const data = envelopeOf(result)['data'] as Record<string, unknown>;
    expect(data['mode']).toBe('merge');
    expect(data['added']).toEqual(['role']);
    expect(data['removed']).toEqual([]);
    expect(data['unchanged']).toBe(2);
  });

  it('updates an existing key in place and reports it as an update, not an add', async () => {
    queue(serverWith({ env: 'staging' }), serverWith({ env: 'prod' }));

    const result = await call({ resource_type: 'server', id: 42, labels: { env: 'prod' } });

    expect(bodyOf(1)).toEqual({ labels: { env: 'prod' } });
    const data = envelopeOf(result)['data'] as Record<string, unknown>;
    expect(data['updated']).toEqual(['env']);
    expect(data['added']).toEqual([]);
  });

  it('removes a key given a null value and leaves the others alone', async () => {
    queue(serverWith({ env: 'prod', team: 'core' }), serverWith({ env: 'prod' }));

    const result = await call({ resource_type: 'server', id: 42, labels: { team: null } });

    expect(bodyOf(1)).toEqual({ labels: { env: 'prod' } });
    const data = envelopeOf(result)['data'] as Record<string, unknown>;
    expect(data['removed']).toEqual(['team']);
  });

  it('treats an empty string as a real value rather than a removal', async () => {
    queue(serverWith({ env: 'prod' }), serverWith({ env: 'prod', marker: '' }));

    await call({ resource_type: 'server', id: 42, labels: { marker: '' } });

    expect(bodyOf(1)).toEqual({ labels: { env: 'prod', marker: '' } });
  });

  it('states that the merge is a read followed by a write', async () => {
    queue(serverWith({ env: 'prod' }), serverWith({ env: 'prod', role: 'web' }));

    const result = await call({ resource_type: 'server', id: 42, labels: { role: 'web' } });

    const meta = envelopeOf(result)['meta'] as { hint?: string };
    expect(meta.hint).toContain('two requests');
  });
});

// ---------------------------------------------------------------------------
// Replace
// ---------------------------------------------------------------------------

describe('replace: true', () => {
  it('writes the request through unmerged and reports what it dropped', async () => {
    queue(serverWith({ env: 'prod', team: 'core' }), serverWith({ role: 'web' }));

    const result = await call({
      resource_type: 'server',
      id: 42,
      labels: { role: 'web' },
      replace: true,
    });

    expect(bodyOf(1)).toEqual({ labels: { role: 'web' } });
    const data = envelopeOf(result)['data'] as Record<string, unknown>;
    expect(data['mode']).toBe('replace');
    expect(data['removed']).toEqual(['env', 'team']);
    const meta = envelopeOf(result)['meta'] as { hint?: string };
    expect(meta.hint).toContain('removed');
  });

  it('still reads the resource first, so the response can name the losses', async () => {
    queue(serverWith({ env: 'prod' }), serverWith({ role: 'web' }));

    await call({ resource_type: 'server', id: 42, labels: { role: 'web' }, replace: true });

    expect(methodOf(0)).toBe('GET');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('label validation', () => {
  it('rejects an invalid key by naming the rule it breaks, before any request', async () => {
    const result = await call({
      resource_type: 'server',
      id: 42,
      labels: { '-leading-dash': 'x' },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('-leading-dash');
    expect(text).toContain('begin and end with a letter or digit');
    expect(text).toContain('1-63 characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a key longer than 63 characters in the name segment', async () => {
    const result = await call({
      resource_type: 'server',
      id: 42,
      labels: { [`a${'b'.repeat(63)}`]: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('1-63 characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects the reserved hetzner.cloud prefix by name', async () => {
    const result = await call({
      resource_type: 'server',
      id: 42,
      labels: { 'hetzner.cloud/managed': 'yes' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('reserved by Hetzner');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a key with more than one slash', async () => {
    const result = await call({
      resource_type: 'server',
      id: 42,
      labels: { 'a/b/c': 'x' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('single slash');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid value by naming the value rule', async () => {
    const result = await call({
      resource_type: 'server',
      id: 42,
      labels: { env: 'prod!' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"prod!"');
    expect(textOf(result)).toContain('must be empty or 1-63 characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a prefixed key, which is legal', async () => {
    queue(serverWith({}), serverWith({ 'example.com/owner': 'team-core' }));

    const result = await call({
      resource_type: 'server',
      id: 42,
      labels: { 'example.com/owner': 'team-core' },
    });

    expect(result.isError).toBeUndefined();
    expect(bodyOf(1)).toEqual({ labels: { 'example.com/owner': 'team-core' } });
  });

  it('refuses an empty labels object rather than silently doing nothing', async () => {
    const result = await call({ resource_type: 'server', id: 42, labels: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('replace: true');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------

describe('resource types', () => {
  it.each([
    ['volume', 'volumes'],
    ['network', 'networks'],
    ['firewall', 'firewalls'],
    ['load_balancer', 'load_balancers'],
    ['floating_ip', 'floating_ips'],
    ['primary_ip', 'primary_ips'],
    ['image', 'images'],
    ['certificate', 'certificates'],
    ['placement_group', 'placement_groups'],
  ])('routes %s to /%s/{id}', async (resourceType, segment) => {
    queue(
      { [resourceType]: { id: 7, labels: {} } },
      { [resourceType]: { id: 7, labels: { a: 'b' } } },
    );

    await call({ resource_type: resourceType, id: 7, labels: { a: 'b' } });

    expect(urlOf(0)).toBe(`${BASE}/${segment}/7`);
    expect(urlOf(1)).toBe(`${BASE}/${segment}/7`);
  });

  it('rejects a resource type that carries no labels', async () => {
    const result = await call({ resource_type: 'ssh_key', id: 7, labels: { a: 'b' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not a labelable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts an id that arrived as a string, as it does from a previous result', async () => {
    queue(serverWith({}), serverWith({ a: 'b' }));

    await call({ resource_type: 'server', id: '42', labels: { a: 'b' } });

    expect(urlOf(0)).toBe(`${BASE}/servers/42`);
  });
});
