/**
 * The configuration precedence table, one test per row — plus the security
 * properties that live in this layer rather than in the HTTP client.
 *
 * Three layers, and the rules between them are the part users get wrong:
 *
 *   0. HETZNER_TOKEN / HETZNER_ACCOUNT_TOKEN /
 *      HETZNER_ROBOT_USER + HETZNER_ROBOT_PASSWORD
 *   1. the same variables with a _<NAME> suffix
 *   2. a config file, FIRST HIT WINS WHOLESALE
 *
 * The env var NAME carries the surface. That is the whole reason there are six
 * variables instead of two plus a HETZNER_SURFACE: a surface that can be
 * forgotten is a surface that silently points a token at an API it cannot
 * authenticate against, and the failure arrives as a 401 rather than as a
 * sentence about what is wrong.
 *
 * Two rules carry the rest of the design and both are asserted here rather than
 * inferred:
 *
 *   - File lookup never merges. The first location that has a file IS the
 *     configuration; no other location is read.
 *   - Env replaces file BY WHOLE ENTRY on a name collision, never field by
 *     field, and the shadowed name is recorded so `doctor` can say so.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveRegistry } from '../src/config/resolve.js';
import { ConfigError } from '../src/config/schema.js';
import { toServerConfig } from '../src/config/server-config.js';
import { clearSecrets, getSecrets } from '../src/shaping/redact.js';
import { SURFACE_BASE_URLS, type ConnectionRegistry, type HetznerError } from '../src/types.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ01';
const ROBOT_USER = '#123456+ws';
const ROBOT_PASSWORD = 'sVqPbGx2-robot';

/**
 * The ambient variables a spawned helper genuinely needs (node itself will not
 * start on Windows without SystemRoot). Everything else the tests pass in is
 * explicit, so a HETZNER_* variable in the developer's own shell cannot change
 * an outcome.
 */
const OS_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'COMSPEC']
    .map((key) => [key, process.env[key]])
    .filter(([, value]) => value !== undefined) as Array<[string, string]>,
);

let roots: string[] = [];

interface Tree {
  root: string;
  home: string;
  cwd: string;
}

function tree(): Tree {
  const root = mkdtempSync(path.join(tmpdir(), 'hetzner-mcp-config-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'home', 'work', 'repo');
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function writeJson(file: string, value: unknown): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

/** A minimal valid config file. */
function configFile(
  connections: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): unknown {
  return { version: 1, connections, ...extra };
}

function resolve(t: Tree, env: NodeJS.ProcessEnv): Promise<ConnectionRegistry> {
  // `platform: 'linux'` pins the user-config search to the XDG locations, so the
  // same expectations hold on every CI runner.
  return resolveRegistry(env, t.cwd, t.home, { platform: 'linux' });
}

async function failure(promise: Promise<unknown>): Promise<ConfigError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected resolveRegistry to reject');
}

beforeEach(() => {
  clearSecrets();
});

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

// ---------------------------------------------------------------------------
// Row: env only — the variable name carries the surface
// ---------------------------------------------------------------------------

describe('env only', () => {
  it('layer 0: HETZNER_TOKEN produces one cloud connection named `default`', async () => {
    const t = tree();

    const registry = await resolve(t, { HETZNER_TOKEN: TOKEN });

    expect(registry.source).toBe('env');
    expect([...registry.connections.keys()]).toEqual(['default']);
    expect(registry.connections.get('default')?.surface).toBe('cloud');
    expect(registry.defaultName).toBe('default');
    expect(registry.configPath).toBeUndefined();
    expect(registry.shadowed).toEqual([]);
  });

  it('layer 0: HETZNER_ACCOUNT_TOKEN produces the account-scoped connection', async () => {
    const t = tree();

    const registry = await resolve(t, { HETZNER_ACCOUNT_TOKEN: TOKEN });

    expect([...registry.connections.keys()]).toEqual(['account']);
    expect(registry.connections.get('account')?.surface).toBe('hetzner');
  });

  it('layer 0: the Robot pair produces the `robot` connection', async () => {
    const t = tree();

    const registry = await resolve(t, {
      HETZNER_ROBOT_USER: ROBOT_USER,
      HETZNER_ROBOT_PASSWORD: ROBOT_PASSWORD,
    });

    expect([...registry.connections.keys()]).toEqual(['robot']);
    expect(registry.connections.get('robot')?.surface).toBe('robot');
  });

  it('layer 1: the suffix becomes the connection name, with _ read as -', async () => {
    const t = tree();

    const registry = await resolve(t, {
      HETZNER_TOKEN_PROD: TOKEN,
      HETZNER_ACCOUNT_TOKEN_ACME_OPS: TOKEN,
      HETZNER_ROBOT_USER_METAL: ROBOT_USER,
      HETZNER_ROBOT_PASSWORD_METAL: ROBOT_PASSWORD,
    });

    // Sorted, so error messages and `doctor` output are stable run to run.
    expect([...registry.connections.keys()]).toEqual(['acme-ops', 'metal', 'prod']);
    expect(registry.connections.get('acme-ops')?.surface).toBe('hetzner');
    expect(registry.connections.get('metal')?.surface).toBe('robot');
    expect(registry.connections.get('prod')?.surface).toBe('cloud');
  });

  it('does not read HETZNER_ACCOUNT_TOKEN_X as a cloud token named `account-token-x`', async () => {
    const t = tree();

    const registry = await resolve(t, { HETZNER_ACCOUNT_TOKEN_STORAGE: TOKEN });

    expect([...registry.connections.keys()]).toEqual(['storage']);
    expect(registry.connections.get('storage')?.surface).toBe('hetzner');
  });

  it('derives the base URL from the surface, and never from the user', async () => {
    const t = tree();

    const registry = await resolve(t, {
      HETZNER_TOKEN: TOKEN,
      HETZNER_ACCOUNT_TOKEN: TOKEN,
      HETZNER_ROBOT_USER: ROBOT_USER,
      HETZNER_ROBOT_PASSWORD: ROBOT_PASSWORD,
    });

    expect(registry.connections.get('default')?.baseUrl).toBe(SURFACE_BASE_URLS.cloud);
    expect(registry.connections.get('account')?.baseUrl).toBe(SURFACE_BASE_URLS.hetzner);
    expect(registry.connections.get('robot')?.baseUrl).toBe(SURFACE_BASE_URLS.robot);
  });

  it('treats an empty variable as unset rather than as a connection', async () => {
    // Every client config format lets a user leave `"HETZNER_TOKEN": ""` behind;
    // counting that as configured produces a 401 instead of the "not configured"
    // message that says what to do.
    const t = tree();

    const error = await failure(resolve(t, { HETZNER_TOKEN: '   ' }));

    expect(error.message).toContain('no connections configured');
  });

  it('refuses a suffix that is not a valid connection name', async () => {
    const t = tree();

    const error = await failure(resolve(t, { 'HETZNER_TOKEN_ACME.OPS': TOKEN }));

    expect(error.message).toContain('does not name a valid connection');
  });
});

// ---------------------------------------------------------------------------
// The two failures the env layer alone can produce
// ---------------------------------------------------------------------------

describe('cross-surface name collision', () => {
  it('refuses two variables that claim one name, and names both', async () => {
    // Silently picking one would attach a project-scoped token to the
    // account-scoped API, or the reverse — a 401 with no explanation of why.
    const t = tree();

    const error = await failure(
      resolve(t, { HETZNER_TOKEN_PROD: TOKEN, HETZNER_ACCOUNT_TOKEN_PROD: TOKEN }),
    );

    expect(error.message).toContain('$HETZNER_TOKEN_PROD');
    expect(error.message).toContain('$HETZNER_ACCOUNT_TOKEN_PROD');
    expect(error.message).toContain('"prod"');
    expect(error.message).toContain('api.hetzner.cloud');
    expect(error.message).toContain('api.hetzner.com');
    expect(error.message).toContain('Rename one');
  });

  it('catches a robot variable colliding with a bearer one', async () => {
    const t = tree();

    const error = await failure(
      resolve(t, {
        HETZNER_TOKEN_METAL: TOKEN,
        HETZNER_ROBOT_USER_METAL: ROBOT_USER,
        HETZNER_ROBOT_PASSWORD_METAL: ROBOT_PASSWORD,
      }),
    );

    expect(error.message).toContain('$HETZNER_TOKEN_METAL');
    expect(error.message).toContain('$HETZNER_ROBOT_USER_METAL');
  });

  it('lets the same name exist on one surface across env and file — that is shadowing, not collision', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ prod: { surface: 'hetzner' } }),
    );

    const registry = await resolve(t, { HETZNER_TOKEN_PROD: TOKEN });

    expect(registry.connections.get('prod')?.surface).toBe('cloud');
    expect(registry.shadowed).toEqual(['prod']);
  });
});

describe('half-configured robot connection', () => {
  it('names the missing password variable', async () => {
    const t = tree();

    const error = await failure(resolve(t, { HETZNER_ROBOT_USER_METAL: ROBOT_USER }));

    expect(error.message).toContain('$HETZNER_ROBOT_USER_METAL is set');
    expect(error.message).toContain('$HETZNER_ROBOT_PASSWORD_METAL is not');
    expect(error.message).toContain('HTTP Basic');
  });

  it('names the missing user variable', async () => {
    const t = tree();

    const error = await failure(resolve(t, { HETZNER_ROBOT_PASSWORD_METAL: ROBOT_PASSWORD }));

    expect(error.message).toContain('$HETZNER_ROBOT_PASSWORD_METAL is set');
    expect(error.message).toContain('$HETZNER_ROBOT_USER_METAL is not');
  });

  it('names the bare variable when the bare one was used', async () => {
    const t = tree();

    const error = await failure(resolve(t, { HETZNER_ROBOT_USER: ROBOT_USER }));

    expect(error.message).toContain('$HETZNER_ROBOT_PASSWORD is not');
    expect(error.message).not.toContain('HETZNER_ROBOT_PASSWORD_ROBOT');
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('credential resolution', () => {
  it('reads a cloud token from the variable the connection name implies', async () => {
    const t = tree();
    const registry = await resolve(t, { HETZNER_TOKEN_ACME_OPS: TOKEN });

    const credential = registry.connections.get('acme-ops')?.credential;

    expect(credential?.kind).toBe('bearer');
    await expect(credential?.resolve()).resolves.toEqual({ kind: 'bearer', token: TOKEN });
  });

  it('reads an account token from the account variable, not the cloud one', async () => {
    const t = tree();
    const registry = await resolve(t, { HETZNER_ACCOUNT_TOKEN_STORAGE: TOKEN });

    await expect(registry.connections.get('storage')?.credential.resolve()).resolves.toEqual({
      kind: 'bearer',
      token: TOKEN,
    });
  });

  it('stamps an origin on every connection it builds', async () => {
    // `origin` is optional on the type only so the other agents' tests can build
    // a Connection without asserting provenance. It is never optional HERE:
    // "optional in the type" must not decay into "sometimes missing in
    // practice", or `doctor` learns to tolerate a blank answer.
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ fromfile: {}, shadowed: { label: 'losing entry' } }),
    );

    const registry = await resolve(t, {
      HETZNER_TOKEN_FROMENV: TOKEN,
      HETZNER_TOKEN_SHADOWED: TOKEN,
    });

    for (const connection of registry.connections.values()) {
      expect(connection.origin).toBeDefined();
    }
    expect(registry.connections.get('fromfile')?.origin).toBe('file');
    expect(registry.connections.get('fromenv')?.origin).toBe('env');
    // The env entry replaced the file entry whole, so the env one is what took
    // effect — naming the file here would be a lie in precisely the case a user
    // asks `doctor` about.
    expect(registry.connections.get('shadowed')?.origin).toBe('env');
    expect(registry.shadowed).toEqual(['shadowed']);
  });

  it('resolves a robot credential as a user/password pair, not a token', async () => {
    // The shape difference is the whole reason Credential is a union: Robot
    // speaks HTTP Basic, and a `{ token }` there would produce a header no
    // Hetzner endpoint accepts.
    const t = tree();
    const registry = await resolve(t, {
      HETZNER_ROBOT_USER_METAL: ROBOT_USER,
      HETZNER_ROBOT_PASSWORD_METAL: ROBOT_PASSWORD,
    });

    const credential = registry.connections.get('metal')?.credential;

    expect(credential?.kind).toBe('basic');
    await expect(credential?.resolve()).resolves.toEqual({
      kind: 'basic',
      user: ROBOT_USER,
      password: ROBOT_PASSWORD,
    });
  });

  it('tags every resolved credential with its surface`s own auth style', async () => {
    // The tag comes from SURFACE_AUTH, not from which fields happened to come
    // back. Asserting that the declared `Credential.kind` and the resolved
    // `ResolvedCredential.kind` agree for all three surfaces is what stops the
    // two from ever being derived independently.
    const t = tree();
    const registry = await resolve(t, {
      HETZNER_TOKEN: TOKEN,
      HETZNER_ACCOUNT_TOKEN: TOKEN,
      HETZNER_ROBOT_USER: ROBOT_USER,
      HETZNER_ROBOT_PASSWORD: ROBOT_PASSWORD,
    });

    const tags: Record<string, [string, string]> = {};
    for (const [name, connection] of registry.connections) {
      const resolved = await connection.credential.resolve();
      tags[name] = [connection.credential.kind, resolved.kind];
    }

    expect(tags).toEqual({
      default: ['bearer', 'bearer'],
      account: ['bearer', 'bearer'],
      robot: ['basic', 'basic'],
    });
  });

  it('resolves a file connection`s declared userEnv + passwordEnv', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({
        metal: { surface: 'robot', userEnv: 'RB_USER', passwordEnv: 'RB_PASS' },
      }),
    );

    const registry = await resolve(t, { RB_USER: ROBOT_USER, RB_PASS: ROBOT_PASSWORD });

    await expect(registry.connections.get('metal')?.credential.resolve()).resolves.toEqual({
      kind: 'basic',
      user: ROBOT_USER,
      password: ROBOT_PASSWORD,
    });
  });

  it('is lazy: a missing credential does not stop the server from starting', async () => {
    // One unreachable secret manager must not take the whole server down — the
    // problem has to be reportable through a tool call.
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ prod: { tokenEnv: 'NOWHERE' } }),
    );

    const registry = await resolve(t, {});

    expect(registry.connections.has('prod')).toBe(true);
    await expect(registry.connections.get('prod')?.credential.resolve()).rejects.toThrow(/NOWHERE/);
  });

  it('caches a resolved credential for the process lifetime', async () => {
    const t = tree();
    const env: NodeJS.ProcessEnv = { HETZNER_TOKEN: TOKEN };
    const registry = await resolve(t, env);
    const credential = registry.connections.get('default')?.credential;

    await credential?.resolve();
    // A second `op read` per tool call would be unusable, so the answer must not
    // be re-derived — not even when the source disappears.
    delete env['HETZNER_TOKEN'];

    await expect(credential?.resolve()).resolves.toEqual({ kind: 'bearer', token: TOKEN });
  });

  it('explains a missing token in terms of the variable that would have worked', async () => {
    const t = tree();
    writeJson(path.join(t.home, '.config', 'hetzner-mcp', 'config.json'), configFile({ prod: {} }));

    const registry = await resolve(t, {});

    const error = await registry.connections
      .get('prod')
      ?.credential.resolve()
      .then(
        () => undefined,
        (reason: unknown) => reason as HetznerError,
      );

    expect(error?.kind).toBe('unauthenticated');
    expect(error?.message).toContain('no API token for connection "prod"');
    // The hint is the half the tool layer shows next to the failure, so the
    // variable that would have worked has to be in there.
    expect(error?.hint).toContain('$HETZNER_TOKEN_PROD');
    expect(error?.hint).toContain('Security > API tokens');
  });
});

// ---------------------------------------------------------------------------
// Security properties of the credential layer
// ---------------------------------------------------------------------------

describe('credential commands never reach a shell', () => {
  async function commandRegistry(t: Tree, argv: string[], env: NodeJS.ProcessEnv = {}) {
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ prod: { tokenCommand: argv } }),
    );
    return resolve(t, { ...OS_ENV, ...env });
  }

  it('passes an argument with shell metacharacters through verbatim', async () => {
    // If any shell were involved, `;`, `&&`, `|` and `*` would be interpreted or
    // expanded. Seeing the string come back whole is the proof that execFile was
    // called with an argv array and no `shell` option.
    const t = tree();
    const literal = 'ab;c&&d|e*f$(whoami)`id`';
    const registry = await commandRegistry(t, [
      process.execPath,
      '-e',
      'process.stdout.write(process.argv[1])',
      literal,
    ]);

    await expect(registry.connections.get('prod')?.credential.resolve()).resolves.toEqual({
      kind: 'bearer',
      token: literal,
    });
  });

  it('strips our own credentials from the child environment', async () => {
    // A helper whose job is to fetch a credential has no business receiving the
    // credentials we already hold.
    const t = tree();
    const registry = await commandRegistry(
      t,
      [
        process.execPath,
        '-e',
        "process.stdout.write(Object.keys(process.env).filter((k) => k.startsWith('HETZNER_')).join(',') || 'no-hetzner-vars')",
      ],
      {
        HETZNER_TOKEN: TOKEN,
        HETZNER_TOKEN_OTHER: TOKEN,
        HETZNER_ACCOUNT_TOKEN: TOKEN,
        HETZNER_ROBOT_USER_METAL: ROBOT_USER,
        HETZNER_ROBOT_PASSWORD_METAL: ROBOT_PASSWORD,
      },
    );

    await expect(registry.connections.get('prod')?.credential.resolve()).resolves.toEqual({
      kind: 'bearer',
      token: 'no-hetzner-vars',
    });
  });

  it('explains a command that is not there instead of falling back', async () => {
    const t = tree();
    const registry = await commandRegistry(t, ['definitely-not-on-path-hetzner']);

    await expect(registry.connections.get('prod')?.credential.resolve()).rejects.toThrow(
      /command not found/,
    );
  });

  it('refuses a value that cannot be an Authorization header', async () => {
    // The common "my secret manager returned a whole record" mistake, caught
    // before it becomes an unexplained 401. A value with an embedded newline
    // would otherwise split the header itself.
    const t = tree();
    const registry = await commandRegistry(t, [
      process.execPath,
      '-e',
      'process.stdout.write("id: 13\\ntoken: abcdefgh")',
    ]);

    await expect(registry.connections.get('prod')?.credential.resolve()).rejects.toThrow(
      /whitespace or non-printable/,
    );
  });

  it('accepts the trailing newline every command prints', async () => {
    const t = tree();
    const registry = await commandRegistry(t, [
      process.execPath,
      '-e',
      `process.stdout.write(${JSON.stringify(`${TOKEN}\n`)})`,
    ]);

    await expect(registry.connections.get('prod')?.credential.resolve()).resolves.toEqual({
      kind: 'bearer',
      token: TOKEN,
    });
  });

  it('runs a passwordCommand for the robot surface', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({
        metal: {
          surface: 'robot',
          userEnv: 'RB_USER',
          passwordCommand: [
            process.execPath,
            '-e',
            `process.stdout.write(${JSON.stringify(ROBOT_PASSWORD)})`,
          ],
        },
      }),
    );

    const registry = await resolve(t, { ...OS_ENV, RB_USER: ROBOT_USER });

    await expect(registry.connections.get('metal')?.credential.resolve()).resolves.toEqual({
      kind: 'basic',
      user: ROBOT_USER,
      password: ROBOT_PASSWORD,
    });
  });
});

describe('resolved credentials reach the redaction registry', () => {
  it('registers a bearer token as soon as it resolves', async () => {
    const t = tree();
    const registry = await resolve(t, { HETZNER_TOKEN: TOKEN });

    expect(getSecrets()).not.toContain(TOKEN);
    await registry.connections.get('default')?.credential.resolve();

    expect(getSecrets()).toContain(TOKEN);
  });

  it('registers the password and the Basic header form, but not the bare user', async () => {
    // The wire form is base64(user:password): a logged request header would not
    // contain the password verbatim, so registering only the password would
    // leave the header readable. The user is not a secret and is short enough
    // that blanket-replacing it would eat unrelated text.
    const t = tree();
    const registry = await resolve(t, {
      HETZNER_ROBOT_USER: ROBOT_USER,
      HETZNER_ROBOT_PASSWORD: ROBOT_PASSWORD,
    });

    await registry.connections.get('robot')?.credential.resolve();

    expect(getSecrets()).toContain(ROBOT_PASSWORD);
    expect(getSecrets()).toContain(
      Buffer.from(`${ROBOT_USER}:${ROBOT_PASSWORD}`).toString('base64'),
    );
    expect(getSecrets()).not.toContain(ROBOT_USER);
  });

  it('registers the secret half of an <id>|<secret> token on its own', async () => {
    // A truncated log line can carry the half without the whole.
    const t = tree();
    const secretHalf = 'pRzT4kQm9wLxB2vN6hJ0';
    const registry = await resolve(t, { HETZNER_TOKEN: `13|${secretHalf}` });

    await registry.connections.get('default')?.credential.resolve();

    expect(getSecrets()).toContain(`13|${secretHalf}`);
    expect(getSecrets()).toContain(secretHalf);
  });
});

// ---------------------------------------------------------------------------
// Row: file only
// ---------------------------------------------------------------------------

describe('file only', () => {
  it('reports the file as the source and names the path it used', async () => {
    const t = tree();
    const file = writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ prod: {} }),
    );

    const registry = await resolve(t, {});

    expect(registry.source).toBe('file');
    expect(registry.configPath).toBe(file);
    expect([...registry.connections.keys()]).toEqual(['prod']);
    expect(registry.shadowed).toEqual([]);
  });

  it('carries the per-connection settings the file declared', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({
        prod: { label: 'Production', readOnly: true, timeoutMs: 5_000 },
      }),
    );

    const registry = await resolve(t, {});
    const prod = registry.connections.get('prod');

    expect(prod?.label).toBe('Production');
    expect(prod?.readOnly).toBe(true);
    expect(prod?.timeoutMs).toBe(5_000);
  });

  it('lets two connections share a surface — that is what a second project is', async () => {
    // A Cloud token is created inside one project and cannot see any other, so
    // the same API with a second token is the entire multi-project mechanism.
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ acme: { tokenEnv: 'A' }, 'acme-ops': { tokenEnv: 'B' } }),
    );

    const registry = await resolve(t, {});

    expect(registry.connections.get('acme')?.baseUrl).toBe(
      registry.connections.get('acme-ops')?.baseUrl,
    );
    expect(registry.connections.size).toBe(2);
  });

  it('resolves a single level of extends, replacing whole entries', async () => {
    const t = tree();
    writeJson(path.join(t.root, 'base.json'), configFile({ prod: { label: 'base' }, shared: {} }));
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ prod: { surface: 'hetzner' } }, { extends: path.join(t.root, 'base.json') }),
    );

    const registry = await resolve(t, {});

    expect([...registry.connections.keys()]).toEqual(['prod', 'shared']);
    expect(registry.connections.get('prod')?.surface).toBe('hetzner');
    expect(registry.connections.get('prod')?.label).toBeUndefined();
  });

  it('refuses a chain of extends', async () => {
    const t = tree();
    writeJson(path.join(t.root, 'a.json'), configFile({ a: {} }, { extends: './b.json' }));
    writeJson(path.join(t.root, 'b.json'), configFile({ b: {} }));
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ c: {} }, { extends: path.join(t.root, 'a.json') }),
    );

    const error = await failure(resolve(t, {}));

    expect(error.message).toContain('only one level');
  });
});

// ---------------------------------------------------------------------------
// Row: file lookup order — first hit wins WHOLESALE
// ---------------------------------------------------------------------------

describe('file lookup order', () => {
  it('$HETZNER_MCP_CONFIG beats every other location', async () => {
    const t = tree();
    const explicit = writeJson(path.join(t.root, 'explicit.json'), configFile({ chosen: {} }));
    writeJson(path.join(t.cwd, '.hetzner-mcp.json'), configFile({ project: {} }));
    writeJson(path.join(t.home, '.config', 'hetzner-mcp', 'config.json'), configFile({ user: {} }));

    const registry = await resolve(t, { HETZNER_MCP_CONFIG: explicit });

    expect([...registry.connections.keys()]).toEqual(['chosen']);
    expect(registry.configPath).toBe(explicit);
  });

  it('refuses an explicit pointer that resolves to nothing', async () => {
    // Falling through to a different file the user is not looking at is how a
    // config problem becomes an hour of confusion.
    const t = tree();
    writeJson(path.join(t.home, '.config', 'hetzner-mcp', 'config.json'), configFile({ user: {} }));

    const error = await failure(resolve(t, { HETZNER_MCP_CONFIG: path.join(t.root, 'nope.json') }));

    expect(error.message).toContain('which does not exist');
  });

  it('the nearest .hetzner-mcp.json beats the user config, and nothing is merged', async () => {
    const t = tree();
    writeJson(path.join(t.cwd, '.hetzner-mcp.json'), configFile({ project: {} }));
    writeJson(path.join(t.home, '.config', 'hetzner-mcp', 'config.json'), configFile({ user: {} }));

    const registry = await resolve(t, {});

    expect([...registry.connections.keys()]).toEqual(['project']);
  });

  it('walks up from cwd to find a project config', async () => {
    const t = tree();
    writeJson(path.join(path.dirname(t.cwd), '.hetzner-mcp.json'), configFile({ parent: {} }));

    const registry = await resolve(t, {});

    expect([...registry.connections.keys()]).toEqual(['parent']);
  });

  it('stops the walk at a repository root', async () => {
    // A config above the repo governs an unrelated checkout, which is exactly
    // the surprise the boundary exists to prevent.
    const t = tree();
    writeFileSync(path.join(t.cwd, '.git'), 'gitdir: ../.git/worktrees/x\n', 'utf8');
    writeJson(path.join(path.dirname(t.cwd), '.hetzner-mcp.json'), configFile({ outside: {} }));
    writeJson(path.join(t.home, '.config', 'hetzner-mcp', 'config.json'), configFile({ user: {} }));

    const registry = await resolve(t, {});

    expect([...registry.connections.keys()]).toEqual(['user']);
  });

  it('$XDG_CONFIG_HOME beats ~/.hetzner-mcp', async () => {
    const t = tree();
    const xdg = path.join(t.root, 'xdg');
    writeJson(path.join(xdg, 'hetzner-mcp', 'config.json'), configFile({ xdg: {} }));
    writeJson(path.join(t.home, '.hetzner-mcp', 'config.json'), configFile({ dotdir: {} }));

    const registry = await resolve(t, { XDG_CONFIG_HOME: xdg });

    expect([...registry.connections.keys()]).toEqual(['xdg']);
  });

  it('uses %APPDATA% on win32', async () => {
    const t = tree();
    const appData = path.join(t.root, 'AppData', 'Roaming');
    writeJson(path.join(appData, 'hetzner-mcp', 'config.json'), configFile({ roaming: {} }));

    const registry = await resolveRegistry({ APPDATA: appData }, t.cwd, t.home, {
      platform: 'win32',
    });

    expect([...registry.connections.keys()]).toEqual(['roaming']);
  });
});

// ---------------------------------------------------------------------------
// Row: env + file
// ---------------------------------------------------------------------------

describe('env and file together', () => {
  it('unions disjoint names and reports both sources', async () => {
    const t = tree();
    writeJson(path.join(t.home, '.config', 'hetzner-mcp', 'config.json'), configFile({ acme: {} }));

    const registry = await resolve(t, { HETZNER_TOKEN_PROD: TOKEN });

    expect([...registry.connections.keys()]).toEqual(['acme', 'prod']);
    expect(registry.source).toBe('env+file');
    expect(registry.shadowed).toEqual([]);
  });

  it('env replaces a colliding file entry WHOLE, and records the shadowing', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({
        prod: {
          surface: 'hetzner',
          label: 'From the file',
          readOnly: true,
          timeoutMs: 5_000,
          tokenEnv: 'FILE_TOKEN',
        },
      }),
    );

    const registry = await resolve(t, { HETZNER_TOKEN_PROD: TOKEN });
    const prod = registry.connections.get('prod');

    // Every one of these came from the file entry that lost. Field-level
    // merging would leave a connection nobody can describe from one place.
    expect(prod?.surface).toBe('cloud');
    expect(prod?.baseUrl).toBe(SURFACE_BASE_URLS.cloud);
    expect(prod?.label).toBeUndefined();
    expect(prod?.readOnly).toBe(false);
    expect(prod?.timeoutMs).toBe(30_000);
    await expect(prod?.credential.resolve()).resolves.toEqual({ kind: 'bearer', token: TOKEN });

    expect(registry.shadowed).toEqual(['prod']);
    expect(registry.source).toBe('env+file');
  });

  it('refuses a boolean env var it cannot read rather than defaulting it to false', async () => {
    const t = tree();

    const error = await failure(
      resolve(t, { HETZNER_TOKEN: TOKEN, HETZNER_ALLOW_DESTRUCTIVE: 'ture' }),
    );

    expect(error.message).toContain('HETZNER_ALLOW_DESTRUCTIVE');
  });

  it('refuses a timeout outside the supported bounds', async () => {
    const t = tree();

    const error = await failure(resolve(t, { HETZNER_TOKEN: TOKEN, HETZNER_TIMEOUT_MS: '250' }));

    expect(error.message).toContain('HETZNER_TIMEOUT_MS');
  });
});

// ---------------------------------------------------------------------------
// The capability ceilings
// ---------------------------------------------------------------------------

describe('read-only is a ceiling, not a default', () => {
  it('HETZNER_READ_ONLY tightens a file connection but can never re-open one', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ open: {}, closed: { readOnly: true } }),
    );

    const tightened = await resolve(t, { HETZNER_READ_ONLY: 'true' });
    expect(tightened.connections.get('open')?.readOnly).toBe(true);
    expect(tightened.connections.get('closed')?.readOnly).toBe(true);

    // Read-only is a kill switch: an env var that could clear it would make the
    // switch depend on nobody having set the wrong variable.
    const loosened = await resolve(t, { HETZNER_READ_ONLY: 'false' });
    expect(loosened.connections.get('closed')?.readOnly).toBe(true);
    expect(loosened.connections.get('open')?.readOnly).toBe(false);
  });

  it('allowDestructive: true grants nothing while the global flag is off', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ eager: { allowDestructive: true }, plain: {} }),
    );

    const registry = await resolve(t, {});

    expect(registry.connections.get('eager')?.allowDestructive).toBe(false);
    expect(registry.connections.get('plain')?.allowDestructive).toBe(false);
  });

  it('allowDestructive: false keeps one connection protected while the flag is on', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ guarded: { allowDestructive: false }, plain: {} }),
    );

    const registry = await resolve(t, { HETZNER_ALLOW_DESTRUCTIVE: 'true' });

    expect(registry.connections.get('guarded')?.allowDestructive).toBe(false);
    expect(registry.connections.get('plain')?.allowDestructive).toBe(true);
  });

  it('summarises the connections into ServerConfig without re-reading the env', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ guarded: { allowDestructive: false }, plain: {} }),
    );

    const registry = await resolve(t, { HETZNER_ALLOW_DESTRUCTIVE: 'true' });
    const config = toServerConfig(registry, { HETZNER_LOG_LEVEL: 'debug' }, () => {});

    expect(config.allowDestructive).toBe(true);
    expect(config.readOnly).toBe(false);
    expect(config.logLevel).toBe('debug');
  });

  it('a read-only connection does not count towards the destructive capability', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ only: { readOnly: true, allowDestructive: true } }),
    );

    const registry = await resolve(t, { HETZNER_ALLOW_DESTRUCTIVE: 'true' });
    const warnings: string[] = [];
    const config = toServerConfig(registry, { HETZNER_LOG_LEVEL: 'chatty' }, (m) =>
      warnings.push(m),
    );

    expect(config.readOnly).toBe(true);
    expect(config.allowDestructive).toBe(false);
    // An unreadable log level is not worth refusing to start over, but it is
    // worth saying, or the user watches for output that never arrives.
    expect(config.logLevel).toBe('info');
    expect(warnings[0]).toContain('HETZNER_LOG_LEVEL');
  });
});

// ---------------------------------------------------------------------------
// Row: default selection order
// ---------------------------------------------------------------------------

describe('default connection selection', () => {
  it('a single connection is its own default', async () => {
    const t = tree();

    const registry = await resolve(t, { HETZNER_TOKEN: TOKEN });

    expect(registry.defaultName).toBe('default');
  });

  it('several connections with none designated have NO default', async () => {
    // Guessing which project — or which API — a `delete server` was meant for is
    // the one thing this layer must never do.
    const t = tree();

    const registry = await resolve(t, { HETZNER_TOKEN_PROD: TOKEN, HETZNER_ACCOUNT_TOKEN: TOKEN });

    expect(registry.defaultName).toBeUndefined();
  });

  it('the file`s defaultConnection is used when the env does not choose', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ prod: {}, acme: {} }, { defaultConnection: 'acme' }),
    );

    const registry = await resolve(t, {});

    expect(registry.defaultName).toBe('acme');
  });

  it('HETZNER_CONNECTION outranks the file`s defaultConnection', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ prod: {}, acme: {} }, { defaultConnection: 'acme' }),
    );

    const registry = await resolve(t, { HETZNER_CONNECTION: 'prod' });

    expect(registry.defaultName).toBe('prod');
  });

  it('accepts HETZNER_CONNECTION=ACME_OPS, because the variable is spelled that way', async () => {
    const t = tree();

    const registry = await resolve(t, {
      HETZNER_TOKEN_ACME_OPS: TOKEN,
      HETZNER_TOKEN_PROD: TOKEN,
      HETZNER_CONNECTION: 'ACME_OPS',
    });

    expect(registry.defaultName).toBe('acme-ops');
  });

  it('refuses a HETZNER_CONNECTION that names nothing, and lists what there is', async () => {
    const t = tree();

    const error = await failure(
      resolve(t, { HETZNER_TOKEN_PROD: TOKEN, HETZNER_CONNECTION: 'staging' }),
    );

    expect(error.message).toContain('staging');
    expect(error.message).toContain('prod');
  });

  it('refuses a defaultConnection that names nothing', async () => {
    const t = tree();
    writeJson(
      path.join(t.home, '.config', 'hetzner-mcp', 'config.json'),
      configFile({ prod: {} }, { defaultConnection: 'acme' }),
    );

    const error = await failure(resolve(t, {}));

    expect(error.message).toContain('defaultConnection');
  });
});

// ---------------------------------------------------------------------------
// Nothing configured at all
// ---------------------------------------------------------------------------

describe('nothing configured', () => {
  it('names the variables for every surface and every location it searched', async () => {
    const t = tree();

    const error = await failure(resolve(t, {}));

    expect(error.message).toContain('HETZNER_TOKEN=');
    expect(error.message).toContain('HETZNER_ACCOUNT_TOKEN=');
    expect(error.message).toContain('HETZNER_ROBOT_USER_METAL=');
    expect(error.message).toContain('HETZNER_ROBOT_PASSWORD_METAL=');
    expect(error.message).toContain('.hetzner-mcp.json');
    expect(error.message).toContain(path.join(t.home, '.config', 'hetzner-mcp', 'config.json'));
  });
});
