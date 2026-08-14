/**
 * The HTTP transport, end to end.
 *
 * These tests run a real server on a real socket and talk to it with the real
 * MCP client transport. That is deliberate and it is the reason the file is
 * slower than the rest of the suite: the properties under test here — a 401
 * before the body is read, a rejected `Host` header, a credential that never
 * reaches a log line — are properties of the wire, and a test that called the
 * handler directly would assert on none of them.
 *
 * The tool exercised over the connection is `search_operations`, chosen because
 * it answers from the generated catalog and touches no network. A test that had
 * to stub `fetch` to prove the transport works would be testing two things and
 * failing for two reasons.
 *
 * Every server binds `port: 0`. Picking a fixed port makes a test suite that
 * fails when something else on the machine happens to be listening, and fails
 * again when two of its own cases run at once.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  serveHttp,
  HEALTH_PATH,
  MCP_PATH,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_MAX_BODY_BYTES,
} from '../src/http/serve.js';
import type { RunningHttpServer } from '../src/http/serve.js';
import { SURFACE_BASE_URLS } from '../src/types.js';
import type { Connection, ConnectionRegistry, ServerConfig } from '../src/types.js';

/** 32 characters, which is the documented minimum. */
const AUTH_TOKEN = 'test-auth-token-0123456789abcdef';

/** The shape a Hetzner Cloud token actually has: 64 alphanumeric characters. */
const HETZNER_TOKEN = 'Kp3RvT9wLmZq7XnB2sDh5JcYg1FaE4uW6iVt0NoQ8rSx7MbGdU5yHfPjAeKzCn2L';

function makeConnection(name = 'prod'): Connection {
  return {
    name,
    surface: 'cloud',
    baseUrl: SURFACE_BASE_URLS.cloud,
    readOnly: false,
    allowDestructive: false,
    timeoutMs: 30_000,
    credential: {
      kind: 'bearer',
      resolve: () => Promise.resolve({ kind: 'bearer', token: HETZNER_TOKEN }),
    },
  };
}

function makeConfig(
  logLevel: ServerConfig['logLevel'] = 'info',
  connections: Connection[] = [makeConnection()],
): ServerConfig {
  const registry: ConnectionRegistry = {
    connections: new Map(connections.map((connection) => [connection.name, connection])),
    source: 'env',
    shadowed: [],
  };
  if (connections.length === 1) registry.defaultName = connections[0]?.name;
  return {
    registry,
    readOnly: false,
    allowDestructive: false,
    logLevel,
  };
}

let running: RunningHttpServer | undefined;

async function start(
  overrides: Partial<Parameters<typeof serveHttp>[1]> = {},
  logLevel: ServerConfig['logLevel'] = 'info',
) {
  running = await serveHttp(makeConfig(logLevel), {
    host: DEFAULT_HTTP_HOST,
    port: 0,
    authToken: AUTH_TOKEN,
    ...overrides,
  });
  return running;
}

/** Collects everything the server writes to stderr for the rest of the test. */
function captureStderr(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  return written;
}

/** An authenticated MCP client, connected and initialized. */
async function connectClient(server: RunningHttpServer): Promise<Client> {
  const client = new Client({ name: 'http-serve-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}${MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
    }),
  );
  return client;
}

afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('routing', () => {
  it('answers the health check without a token, because the health checker has none', async () => {
    const server = await start();

    const response = await fetch(`${server.url}${HEALTH_PATH}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('resolves an ephemeral port into the reported url', async () => {
    const server = await start();

    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(DEFAULT_HTTP_PORT);
    expect(server.url).toBe(`http://${DEFAULT_HTTP_HOST}:${server.port}`);
  });

  it('refuses an unknown path', async () => {
    const server = await start();

    const response = await fetch(`${server.url}/admin`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    expect(response.status).toBe(404);
  });

  it('refuses GET on the MCP path, because a stateless server has no stream to open', async () => {
    const server = await start();

    const response = await fetch(`${server.url}${MCP_PATH}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    expect(response.status).toBe(405);
  });
});

describe('authentication', () => {
  it('refuses a request with no Authorization header', async () => {
    const server = await start();

    const response = await fetch(`${server.url}${MCP_PATH}`, { method: 'POST' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/Bearer/i);
  });

  it('refuses a wrong token', async () => {
    const server = await start();

    const response = await fetch(`${server.url}${MCP_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${'x'.repeat(AUTH_TOKEN.length)}` },
    });

    expect(response.status).toBe(401);
  });

  it('says nothing about why it refused', async () => {
    // A 401 that distinguishes "no header" from "wrong value" is an oracle.
    const server = await start();

    const [missing, wrong] = await Promise.all([
      fetch(`${server.url}${MCP_PATH}`, { method: 'POST' }).then((r) => r.text()),
      fetch(`${server.url}${MCP_PATH}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer nope' },
      }).then((r) => r.text()),
    ]);

    expect(missing).toBe(wrong);
    expect(missing).not.toContain(AUTH_TOKEN);
  });

  it('refuses before reading the body', async () => {
    // The body here is far over the cap. If the answer is 401 rather than 413,
    // the check ran first — which is what keeps an unauthenticated caller from
    // spending the server's memory.
    const server = await start({ maxBodyBytes: 1024 });

    const response = await fetch(`${server.url}${MCP_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(64 * 1024) }),
    });

    expect(response.status).toBe(401);
  });
});

describe('limits', () => {
  it('refuses a body over the cap', async () => {
    const server = await start({ maxBodyBytes: 1024 });

    const response = await fetch(`${server.url}${MCP_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ pad: 'x'.repeat(64 * 1024) }),
    });

    expect(response.status).toBe(413);
  });

  it('defaults the cap to something a real request fits inside', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });

  it('answers malformed JSON with a parse error rather than a crash', async () => {
    const server = await start();

    const response = await fetch(`${server.url}${MCP_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('-32700');
  });
});

describe('DNS rebinding protection', () => {
  // `fetch` CANNOT be used for these. `Host` is a forbidden header name in the
  // fetch specification, so undici drops it silently and sends the real one —
  // which means a rebinding test written with `fetch` passes without ever having
  // forged anything.
  function rawRequest(
    server: RunningHttpServer,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: DEFAULT_HTTP_HOST,
          port: server.port,
          path,
          method: body === undefined ? 'GET' : 'POST',
          headers,
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (text += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
        },
      );
      request.on('error', reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  it('refuses a forged Host header', async () => {
    const server = await start();

    const response = await rawRequest(
      server,
      MCP_PATH,
      {
        Host: 'evil.example.com',
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('refuses a forged Origin', async () => {
    const server = await start();

    const response = await rawRequest(
      server,
      MCP_PATH,
      {
        Origin: 'https://evil.example.com',
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('accepts the Host an operator allowed', async () => {
    // The reverse-proxy case: the server binds a loopback port, but the Host
    // arriving from the proxy is the public name. Without this the whole
    // deployed configuration answers 421 and looks like a proxy
    // misconfiguration.
    const server = await start({ allowedHosts: ['mcp.example.com'] });

    const response = await rawRequest(server, HEALTH_PATH, { Host: 'mcp.example.com' });

    expect(response.status).toBe(200);
  });
});

describe('MCP over HTTP', () => {
  it('completes an initialize handshake', async () => {
    const server = await start();
    const client = await connectClient(server);

    expect(client.getServerVersion()?.name).toBe('hetzner-mcp');

    await client.close();
  });

  it('lists the same tools the stdio transport would', async () => {
    const server = await start();
    const client = await connectClient(server);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('find_resources');
    expect(names).toContain('search_operations');
    // The destructive gate is a property of the server, not of the transport.
    expect(names).not.toContain('execute_destructive_operation');
    expect(tools.some((tool) => tool.annotations?.destructiveHint === true)).toBe(false);

    await client.close();
  });

  it('publishes additionalProperties: false on every tool schema', async () => {
    // Zod 4 does not emit the keyword for a bare shape, and without it the model
    // is invited to invent parameters — every invented one a wasted round trip.
    const server = await start();
    const client = await connectClient(server);

    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }

    await client.close();
  });

  it('runs a tool', async () => {
    const server = await start();
    const client = await connectClient(server);

    const result = await client.callTool({
      name: 'search_operations',
      arguments: { query: 'server' },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('server');

    await client.close();
  });

  it('isolates concurrent callers', async () => {
    // Stateless means a fresh server per request. Two clients talking at once
    // must not see each other's responses — which is the failure a shared
    // transport would produce.
    const server = await start();
    const [a, b] = await Promise.all([connectClient(server), connectClient(server)]);

    const [first, second] = await Promise.all([
      a.callTool({ name: 'search_operations', arguments: { query: 'volume' } }),
      b.callTool({ name: 'search_operations', arguments: { query: 'firewall' } }),
    ]);

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();

    await Promise.all([a.close(), b.close()]);
  });
});

describe('progress notifications', () => {
  // THE LOAD-BEARING TEST FOR THE STATELESS DECISION.
  //
  // Choosing `sessionIdGenerator: undefined` rests on one claim: that a
  // notification raised while a tool is running still reaches the caller,
  // because MCP ties progress to the token on the originating request and
  // Streamable HTTP carries it on that request's own SSE response. No session
  // required. If that claim is wrong, every awaited Action goes silent over HTTP
  // and the whole session-model argument collapses.
  //
  // It is also one config flag away from being wrong at any time: the SDK guards
  // its SSE write with `if (!this._enableJsonResponse)`, so turning
  // `enableJsonResponse` on drops every notification and returns only the final
  // result — with the tool call still succeeding and every other test in this
  // file still green.
  it('delivers a tool progress notification over the request stream', async () => {
    const realFetch = globalThis.fetch;
    let polls = 0;

    // Only Hetzner is faked. The MCP client and the server under test are both
    // using `fetch` on this same global, and replacing it wholesale would test
    // the mock instead of the transport.
    // Parameters<typeof fetch> rather than `RequestInfo`: that name is a DOM
    // type and this project's tsconfig declares only ES lib plus node.
    type FetchArgs = Parameters<typeof fetch>;
    vi.stubGlobal('fetch', (input: FetchArgs[0], init?: FetchArgs[1]) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes('api.hetzner.cloud')) return realFetch(input, init);

      const path = new URL(url).pathname;
      // `/actions/7` is the poll. The first read is still in flight, so the loop
      // reports progress and sleeps; the second is terminal, so it stops. One
      // round is all this needs.
      const body = path.endsWith('/v1/actions/7')
        ? {
            action: {
              id: 7,
              command: 'reboot_server',
              status: polls++ === 0 ? 'running' : 'success',
              progress: polls === 1 ? 50 : 100,
              started: '2024-01-01T00:00:00Z',
              finished: null,
            },
          }
        : {
            action: {
              id: 7,
              command: 'reboot_server',
              status: 'running',
              progress: 0,
              started: '2024-01-01T00:00:00Z',
              finished: null,
            },
          };

      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const server = await start();
    const client = await connectClient(server);
    const seen: number[] = [];

    const result = await client.callTool(
      {
        name: 'control_resource',
        arguments: {
          connection: 'prod',
          resource_type: 'server',
          action: 'reboot',
          id: 42,
          wait_seconds: 30,
        },
      },
      undefined,
      { onprogress: (progress) => seen.push(progress.progress) },
    );

    expect(result.isError).toBeFalsy();
    expect(seen.length).toBeGreaterThan(0);

    await client.close();
  }, 30_000);
});

describe('logging', () => {
  it('never writes either credential to stderr', async () => {
    const written = captureStderr();

    const server = await start();
    const client = await connectClient(server);
    await client.callTool({ name: 'search_operations', arguments: { query: 'server' } });
    await fetch(`${server.url}${MCP_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    await client.close();

    const log = written.join('');
    expect(log).not.toContain(AUTH_TOKEN);
    expect(log).not.toContain(HETZNER_TOKEN);
  });

  it('records the request line', async () => {
    const written = captureStderr();

    const server = await start();
    await fetch(`${server.url}/nope`);

    expect(written.join('')).toMatch(/GET \/nope 404 \d+ms/);
  });

  it('stays quiet about a health check that succeeded', async () => {
    // A container health check runs every ten to thirty seconds forever. At one
    // line each it buries every request worth reading, and an operator ends up
    // grepping past a day of `GET /healthz 200` to find the one that failed.
    const written = captureStderr();

    const server = await start();
    await fetch(`${server.url}${HEALTH_PATH}`);

    expect(written.join('')).not.toContain(HEALTH_PATH);
  });

  it('records the health check at debug, for when the health check is the problem', async () => {
    const written = captureStderr();

    const server = await start({}, 'debug');
    await fetch(`${server.url}${HEALTH_PATH}`);

    expect(written.join('')).toContain(HEALTH_PATH);
  });
});

describe('shutdown', () => {
  it('closes without hanging on an idle keep-alive connection', async () => {
    // Node's `server.close()` waits for keep-alive sockets, and `fetch` leaves
    // one open. A transport that does not deal with them turns every CI run
    // into a timeout instead of a failure.
    const server = await start();
    await fetch(`${server.url}${HEALTH_PATH}`);

    await expect(server.close()).resolves.toBeUndefined();
    running = undefined;

    await expect(fetch(`${server.url}${HEALTH_PATH}`)).rejects.toThrow();
  });
});
