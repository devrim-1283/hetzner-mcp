/**
 * The config file schema — and the two rules it exists to enforce:
 *
 *   1. hetzner-mcp NEVER stores credentials in config files, and that is a
 *      VALIDATION ERROR rather than advice.
 *   2. `baseUrl` is not a setting. It is derived from `surface`, because
 *      Hetzner runs exactly one instance of each API.
 *
 * `connectionSchema` has no `token`, `user`, `password` or `baseUrl` property
 * and is `.strict()`, so none of them can round-trip through the parser at all.
 * The distinction matters: a warning is something a user scrolls past on the way
 * to a working setup, and the file it would have been written into gets
 * committed, synced to a dotfiles repo, and screen-shared. A hard failure with a
 * written remedy is the only version of this rule that holds.
 *
 * The second half of the file is the parity check the published JSON Schema's
 * own `$comment` asks for: `schema/config.v1.json` is a hand-written mirror of
 * `src/config/schema.ts`, and it is what a user's editor validates against. If
 * the two drift, an editor cheerfully autocompletes a property the server then
 * rejects — or worse, stays silent about one it should have flagged.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONFIG_VERSION,
  ConfigError,
  DEFAULT_SURFACE,
  configFileSchema,
  parseConfigFile,
} from '../src/config/schema.js';
import { SURFACES } from '../src/types.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ01';
const PASSWORD = 'hunter2-hunter2';
const SOURCE = '/home/dev/.config/hetzner-mcp/config.json';

function file(connection: Record<string, unknown>, name = 'prod'): unknown {
  return { version: CONFIG_VERSION, connections: { [name]: connection } };
}

function rejection(raw: unknown): ConfigError {
  try {
    parseConfigFile(raw, SOURCE);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected parseConfigFile to reject');
}

// ---------------------------------------------------------------------------
// A literal credential is an ERROR
// ---------------------------------------------------------------------------

describe('a `token` property in a connection', () => {
  it('is a validation error, not a warning', () => {
    // safeParse rather than the throwing wrapper, so this asserts the SCHEMA
    // rejects it — not merely that some caller decided to complain.
    const result = configFileSchema.safeParse(file({ token: TOKEN }));

    expect(result.success).toBe(false);
  });

  it('fails the whole file rather than dropping the key and carrying on', () => {
    const error = rejection(file({ token: TOKEN }));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('"token" is not a valid property');
  });

  it('answers with the sources this surface takes and the conventional variable', () => {
    // The error message IS the enforcement mechanism: it has to leave the user
    // with an obvious next action, or they will go looking for a way to disable
    // the check instead.
    const error = rejection(file({ token: TOKEN }));

    expect(error.message).toContain('hetzner-mcp never stores credentials in config files');
    expect(error.message).toContain('tokenEnv | tokenCommand | tokenKeychain');
    expect(error.message).toContain('$HETZNER_TOKEN_PROD');
    expect(error.message).toContain(SOURCE);
  });

  it('names the connection`s own variable, not a generic one', () => {
    const error = rejection(file({ token: TOKEN }, 'acme-ops'));

    expect(error.message).toContain('$HETZNER_TOKEN_ACME_OPS');
  });

  it('answers an account-scoped connection with the account variable', () => {
    const error = rejection(file({ surface: 'hetzner', token: TOKEN }, 'storage'));

    expect(error.message).toContain('$HETZNER_ACCOUNT_TOKEN_STORAGE');
    expect(error.message).not.toContain('$HETZNER_TOKEN_STORAGE');
  });

  it('answers a robot connection in Robot`s own terms — both halves', () => {
    // Basic auth makes "password in the config file" a far more natural mistake
    // than it was for a bearer-only product, so this message has to be as good
    // as the token one.
    const error = rejection(file({ surface: 'robot', password: PASSWORD }, 'metal'));

    expect(error.message).toContain('never stores credentials in config files');
    expect(error.message).toContain(
      'userEnv + passwordEnv | userEnv + passwordCommand | credentialKeychain',
    );
    expect(error.message).toContain('$HETZNER_ROBOT_USER_METAL + $HETZNER_ROBOT_PASSWORD_METAL');
    expect(error.message).not.toContain(PASSWORD);
  });

  it('never echoes the credential it just refused', () => {
    // The message ends up in terminals, issue reports and screen shares. Quoting
    // the value back would leak the very thing the rule is protecting.
    const error = rejection(file({ token: TOKEN }));

    expect(error.message).not.toContain(TOKEN);
  });

  it.each([
    'token',
    'apiToken',
    'api_token',
    'API-TOKEN',
    'accessToken',
    'authToken',
    'apiKey',
    'key',
    'secret',
    'bearer',
    'authorization',
    // Robot's vocabulary: its credential is a "#123456+ws" user and a
    // "web service password", and a user transcribing it from the Robot UI
    // reaches for exactly these words.
    'user',
    'username',
    'login',
    'pass',
    'password',
    'webServicePassword',
    'web_service_password',
    'robotPassword',
    'credentials',
  ])('treats `%s` the same way', (key) => {
    // Compared with separators stripped and case folded, so a user who guesses
    // a different spelling still gets the explanation rather than a bare
    // "unrecognized key".
    const error = rejection(file({ [key]: TOKEN }));

    expect(error.message).toContain('never stores credentials in config files');
    expect(error.message).not.toContain(TOKEN);
  });

  it('does not mistake the source properties for credentials', () => {
    expect(() =>
      parseConfigFile(
        file({ surface: 'robot', userEnv: 'RB_USER', passwordEnv: 'RB_PASS' }),
        SOURCE,
      ),
    ).not.toThrow();
  });

  it('reports a plain unknown key without the credential lecture', () => {
    const error = rejection(file({ surfase: 'cloud' }));

    expect(error.message).toContain('"surfase" is not a valid property');
    expect(error.message).not.toContain('never stores credentials');
    expect(error.message).toContain('Valid properties:');
  });
});

// ---------------------------------------------------------------------------
// baseUrl is derived, not configured
// ---------------------------------------------------------------------------

describe('a `baseUrl` property in a connection', () => {
  it('is rejected, because the value could only repeat what we know or be wrong', () => {
    const error = rejection(file({ baseUrl: 'https://api.hetzner.cloud/v1' }));

    expect(error.message).toContain('"baseUrl" is not a valid property');
    expect(error.message).toContain('derived from "surface"');
  });

  it('names the address the connection`s surface already implies', () => {
    expect(rejection(file({ baseUrl: 'https://x' })).message).toContain('api.hetzner.cloud/v1');
    expect(rejection(file({ surface: 'robot', baseUrl: 'https://x' })).message).toContain(
      'robot-ws.your-server.de',
    );
  });

  it.each(['url', 'apiUrl', 'endpoint', 'host'])('answers `%s` the same way', (key) => {
    expect(rejection(file({ [key]: 'https://api.hetzner.cloud/v1' })).message).toContain(
      'derived from "surface"',
    );
  });
});

// ---------------------------------------------------------------------------
// Surfaces and their credential sources
// ---------------------------------------------------------------------------

describe('connection validation', () => {
  it('accepts an empty connection and defaults it to cloud', () => {
    // Cloud is the overwhelming majority of use, and the convention
    // ($HETZNER_TOKEN_<NAME>) is what makes this entry complete.
    const parsed = parseConfigFile(file({}), SOURCE);

    expect(parsed.connections['prod']?.surface).toBe('cloud');
    expect(DEFAULT_SURFACE).toBe('cloud');
  });

  it.each(SURFACES)('accepts surface "%s"', (surface) => {
    expect(() => parseConfigFile(file({ surface }), SOURCE)).not.toThrow();
  });

  it('refuses a surface that is not one of the three', () => {
    expect(() => parseConfigFile(file({ surface: 'storagebox' }), SOURCE)).toThrow(ConfigError);
  });

  it.each([
    ['tokenEnv', { tokenEnv: 'HZ_PROD' }],
    ['tokenCommand', { tokenCommand: ['op', 'read', 'op://Infra/hetzner/credential'] }],
    ['tokenKeychain', { tokenKeychain: { service: 'hetzner-mcp', account: 'prod' } }],
  ])('accepts %s as the single source on a bearer surface', (_name, connection) => {
    expect(() => parseConfigFile(file(connection), SOURCE)).not.toThrow();
    expect(() =>
      parseConfigFile(file({ surface: 'hetzner', ...connection }), SOURCE),
    ).not.toThrow();
  });

  it('refuses two token sources at once', () => {
    const error = rejection(file({ tokenEnv: 'HZ_PROD', tokenCommand: ['op', 'read', 'x'] }));

    expect(error.message).toContain('at most one of tokenEnv, tokenCommand, tokenKeychain');
  });

  it.each([
    ['userEnv + passwordEnv', { userEnv: 'RB_USER', passwordEnv: 'RB_PASS' }],
    ['userEnv + passwordCommand', { userEnv: 'RB_USER', passwordCommand: ['op', 'read', 'x'] }],
    ['credentialKeychain', { credentialKeychain: { service: 'hetzner-mcp', account: '#1+ws' } }],
    ['nothing at all', {}],
  ])('accepts %s on the robot surface', (_name, connection) => {
    expect(() => parseConfigFile(file({ surface: 'robot', ...connection }), SOURCE)).not.toThrow();
  });

  it('refuses a bearer source on the robot surface, naming what robot takes', () => {
    const error = rejection(file({ surface: 'robot', tokenEnv: 'HZ_PROD' }));

    expect(error.message).toContain('surface "robot" authenticates with HTTP Basic');
    expect(error.message).toContain('does not accept tokenEnv');
    expect(error.message).toContain(
      'userEnv + passwordEnv | userEnv + passwordCommand | credentialKeychain',
    );
  });

  it.each(['cloud', 'hetzner'])('refuses userEnv on the %s surface', (surface) => {
    const error = rejection(file({ surface, userEnv: 'RB_USER', passwordEnv: 'RB_PASS' }));

    expect(error.message).toContain(`surface "${surface}" authenticates with a bearer token`);
    expect(error.message).toContain('tokenEnv | tokenCommand | tokenKeychain');
  });

  it('refuses half a Basic credential', () => {
    // A user without a password is a login that cannot be made, and it fails at
    // the first API call rather than at startup unless it is caught here.
    const error = rejection(file({ surface: 'robot', userEnv: 'RB_USER' }));

    expect(error.message).toContain('set together or not at all');
    expect(error.message).toContain('found only userEnv');
  });

  it('refuses a password source with no user', () => {
    const error = rejection(file({ surface: 'robot', passwordEnv: 'RB_PASS' }));

    expect(error.message).toContain('set together or not at all');
  });

  it('refuses two password sources at once', () => {
    const error = rejection(
      file({
        surface: 'robot',
        userEnv: 'RB_USER',
        passwordEnv: 'RB_PASS',
        passwordCommand: ['op', 'read', 'x'],
      }),
    );

    expect(error.message).toContain('at most one of passwordEnv, passwordCommand');
  });

  it('refuses credentialKeychain combined with an env half', () => {
    const error = rejection(
      file({
        surface: 'robot',
        credentialKeychain: { service: 'hetzner-mcp', account: '#1+ws' },
        userEnv: 'RB_USER',
      }),
    );

    expect(error.message).toContain('credentialKeychain already carries both halves');
  });

  it('refuses a connection name outside the slug alphabet', () => {
    // Names have to survive a round trip through an env var name
    // (acme-ops <-> HETZNER_TOKEN_ACME_OPS); anything else is ambiguous.
    expect(() => parseConfigFile(file({}, 'Acme Ops'), SOURCE)).toThrow(ConfigError);
  });

  it('refuses a file with no connections at all', () => {
    const error = rejection({ version: CONFIG_VERSION, connections: {} });

    expect(error.message).toContain('define at least one connection');
  });

  it('explains a wrong version in terms of the file, not of Zod', () => {
    const error = rejection({ version: 2, connections: { prod: {} } });

    expect(error.message).toContain('This file is a v1 registry.');
  });

  it('allows $schema so editors can validate the file', () => {
    expect(() =>
      parseConfigFile(
        {
          $schema: 'https://example.com/config.v1.json',
          version: CONFIG_VERSION,
          connections: { prod: {} },
        },
        SOURCE,
      ),
    ).not.toThrow();
  });

  it.each([
    [999, false],
    [1_000, true],
    [120_000, true],
    [120_001, false],
    [1_500.5, false],
  ])('timeoutMs %s is accepted: %s', (timeoutMs, accepted) => {
    expect(configFileSchema.safeParse(file({ timeoutMs })).success).toBe(accepted);
  });

  it('refuses a tokenCommand longer than the bound', () => {
    // A credential source is `op read ...`, not a script.
    expect(configFileSchema.safeParse(file({ tokenCommand: Array(33).fill('x') })).success).toBe(
      false,
    );
    expect(configFileSchema.safeParse(file({ tokenCommand: Array(32).fill('x') })).success).toBe(
      true,
    );
  });

  it('applies the documented defaults', () => {
    const parsed = parseConfigFile(file({}), SOURCE);

    expect(parsed.connections['prod']?.surface).toBe('cloud');
    expect(parsed.connections['prod']?.readOnly).toBe(false);
    expect(parsed.connections['prod']?.timeoutMs).toBe(30_000);
    expect(parsed.connections['prod']?.allowDestructive).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Published JSON Schema parity
// ---------------------------------------------------------------------------

/**
 * The mirror is compared by CONSTRAINT rather than by running a validator: ajv
 * is not a dependency and will not become one for a test — the package's whole
 * install story is "npx, no native modules, few deps". Comparing the property
 * sets, the strictness flags and the numeric/pattern bounds catches every drift
 * a validator would, because those are the only things either schema says.
 */

const SCHEMA_PATH = fileURLToPath(new URL('../schema/config.v1.json', import.meta.url));
const PUBLISHED = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;

function node(...keyPath: string[]): Record<string, unknown> {
  let cursor: unknown = PUBLISHED;
  for (const key of keyPath) {
    cursor = (cursor as Record<string, unknown> | undefined)?.[key];
  }
  if (typeof cursor !== 'object' || cursor === null) {
    throw new Error(`schema/config.v1.json has no ${keyPath.join('.')}`);
  }
  return cursor as Record<string, unknown>;
}

/**
 * Property names the Zod schema accepts, read out of its own error message.
 *
 * Black box on purpose: reaching into `_def` would let the two drift while the
 * test kept passing, which is the exact failure mode this suite exists to stop.
 */
function zodConnectionKeys(): string[] {
  const error = rejection(file({ definitely_not_a_property: 1 }));
  const line = error.message.split('\n').find((text) => text.startsWith('Valid properties:'));
  if (line === undefined) throw new Error('the error message no longer lists the valid properties');
  return line
    .replace('Valid properties:', '')
    .replace(/\.$/, '')
    .split(',')
    .map((key) => key.trim());
}

describe('schema/config.v1.json mirrors src/config/schema.ts', () => {
  it('has no credential and no baseUrl property, and forbids additional ones', () => {
    const properties = Object.keys(node('$defs', 'connection', 'properties'));

    for (const forbidden of ['token', 'user', 'password', 'baseUrl']) {
      expect(properties).not.toContain(forbidden);
    }
    expect(node('$defs', 'connection')['additionalProperties']).toBe(false);
  });

  it('declares exactly the connection properties the parser accepts', () => {
    const declared = Object.keys(node('$defs', 'connection', 'properties')).sort();

    expect(declared).toEqual(zodConnectionKeys().sort());
  });

  it('declares exactly the top-level properties the parser accepts', () => {
    const error = rejection({ version: CONFIG_VERSION, connections: { prod: {} }, nope: 1 });
    expect(error.message).toContain('"nope" is not a valid property');

    expect(Object.keys(node('properties')).sort()).toEqual(
      ['$schema', 'connections', 'defaultConnection', 'extends', 'version'].sort(),
    );
    expect(PUBLISHED['additionalProperties']).toBe(false);
  });

  it('agrees on the version literal', () => {
    expect(node('properties', 'version')['const']).toBe(CONFIG_VERSION);
  });

  it('agrees on the surface enum and its default', () => {
    const surface = node('$defs', 'connection', 'properties', 'surface');

    expect(surface['enum']).toEqual([...SURFACES]);
    expect(surface['default']).toBe(DEFAULT_SURFACE);
  });

  it('agrees on the connection name pattern', () => {
    const pattern = node('$defs', 'connectionName')['pattern'];

    expect(pattern).toBe('^[a-z0-9][a-z0-9-]{0,30}$');
    expect(new RegExp(String(pattern)).test('acme-ops')).toBe(true);
    expect(new RegExp(String(pattern)).test('Acme Ops')).toBe(false);
  });

  it('agrees on the timeout bounds and default', () => {
    const timeout = node('$defs', 'connection', 'properties', 'timeoutMs');

    expect(timeout['minimum']).toBe(1_000);
    expect(timeout['maximum']).toBe(120_000);
    expect(timeout['default']).toBe(30_000);
  });

  it('agrees on the command bounds', () => {
    const command = node('$defs', 'command');

    expect(command['minItems']).toBe(1);
    expect(command['maxItems']).toBe(32);
  });

  it('agrees on the env var name pattern', () => {
    expect(node('$defs', 'envVarName')['pattern']).toBe('^[A-Za-z_][A-Za-z0-9_]*$');
  });

  it('encodes the at-most-one-source rule for both surfaces', () => {
    // Without these an editor would autocomplete a second source the server
    // then refuses.
    const clauses = node('$defs', 'connection')['allOf'] as Array<{
      not?: { required?: string[] };
    }>;
    const pairs = clauses
      .map((clause) => [...(clause.not?.required ?? [])].sort().join('+'))
      .filter((pair) => pair !== '')
      .sort();

    expect(pairs).toEqual(
      [
        'tokenCommand+tokenEnv',
        'tokenEnv+tokenKeychain',
        'tokenCommand+tokenKeychain',
        'passwordCommand+passwordEnv',
        'credentialKeychain+userEnv',
        'credentialKeychain+passwordEnv',
        'credentialKeychain+passwordCommand',
      ]
        .map((pair) => pair.split('+').sort().join('+'))
        .sort(),
    );
  });

  it('encodes the per-surface source gate', () => {
    const clauses = node('$defs', 'connection')['allOf'] as Array<{
      if?: { properties?: { surface?: { const?: string } } };
      then?: { not?: { anyOf?: Array<{ required?: string[] }> } };
      else?: { not?: { anyOf?: Array<{ required?: string[] }> } };
    }>;
    const gate = clauses.find((clause) => clause.if !== undefined);

    expect(gate?.if?.properties?.surface?.const).toBe('robot');
    expect(gate?.then?.not?.anyOf?.flatMap((entry) => entry.required ?? []).sort()).toEqual([
      'tokenCommand',
      'tokenEnv',
      'tokenKeychain',
    ]);
    expect(gate?.else?.not?.anyOf?.flatMap((entry) => entry.required ?? []).sort()).toEqual([
      'credentialKeychain',
      'passwordCommand',
      'passwordEnv',
      'userEnv',
    ]);
  });

  it('requires userEnv alongside either password source', () => {
    expect(node('$defs', 'connection', 'dependentRequired')).toEqual({
      passwordEnv: ['userEnv'],
      passwordCommand: ['userEnv'],
    });
  });

  it('ships an example the parser actually accepts', () => {
    const examples = PUBLISHED['examples'] as unknown[];

    expect(Array.isArray(examples) && examples.length > 0).toBe(true);
    for (const example of examples) {
      expect(() => parseConfigFile(example, SCHEMA_PATH)).not.toThrow();
    }
  });
});
