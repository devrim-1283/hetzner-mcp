/**
 * `instructions` — the highest-leverage string in the server.
 *
 * It lands in the host's system prompt on every turn, which makes it both the
 * most valuable place to put a fact and the most expensive place to be wrong.
 * Two properties are worth a test each, and both of them are properties nothing
 * else in the suite can catch:
 *
 *  1. IT DESCRIBES THE SURFACE THAT SHIPPED. Every clause is read off
 *     `selectTools`, so a sentence naming a tool that was not registered cannot
 *     survive a configuration change. A test that only checked the default
 *     configuration would keep passing while the read-only text told the model
 *     to call a door that had been removed.
 *
 *  2. IT NEVER STEERS. `instructions` is a description channel. A server that
 *     used it to tell the model how to behave — or to talk past the host's own
 *     system prompt — is what Directory review rejects, and rightly.
 *
 * ASCII is checked for the same reason it is written that way: this string is
 * re-encoded by every host in the chain, and a smart quote is the classic thing
 * to arrive mojibaked in a system prompt where nobody can see where it came
 * from.
 */

import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../src/server.js';
import { selectTools } from '../src/tools/register.js';
import { SURFACE_BASE_URLS } from '../src/types.js';
import type { Connection, ConnectionRegistry, ServerConfig, Surface } from '../src/types.js';

const ALL_TOOL_NAMES = [
  'find_resources',
  'get_resource',
  'get_action',
  'get_metrics',
  'get_pricing',
  'search_operations',
  'describe_operation',
  'execute_read_operation',
  'create_server',
  'control_resource',
  'manage_dns',
  'set_labels',
  'execute_write_operation',
  'execute_destructive_operation',
];

interface ConnectionOptions {
  name?: string;
  surface?: Surface;
  readOnly?: boolean;
  allowDestructive?: boolean;
}

function makeConnection(options: ConnectionOptions = {}): Connection {
  const surface = options.surface ?? 'cloud';
  return {
    name: options.name ?? 'default',
    surface,
    baseUrl: SURFACE_BASE_URLS[surface],
    readOnly: options.readOnly ?? false,
    allowDestructive: options.allowDestructive ?? false,
    timeoutMs: 30_000,
    credential: {
      kind: 'bearer',
      resolve: () => Promise.reject(new Error('no credential may be resolved for instructions')),
    },
  };
}

interface ConfigOptions {
  connections?: Connection[];
  defaultName?: string;
  readOnly?: boolean;
  allowDestructive?: boolean;
}

function makeConfig(options: ConfigOptions = {}): ServerConfig {
  const connections = options.connections ?? [makeConnection()];
  const registry: ConnectionRegistry = {
    connections: new Map(connections.map((connection) => [connection.name, connection])),
    source: 'env',
    shadowed: [],
  };
  if (options.defaultName !== undefined) registry.defaultName = options.defaultName;
  else if (connections.length === 1) registry.defaultName = connections[0]?.name;

  return {
    registry,
    readOnly: options.readOnly ?? connections.every((connection) => connection.readOnly),
    allowDestructive:
      options.allowDestructive ??
      connections.some((connection) => connection.allowDestructive && !connection.readOnly),
    logLevel: 'info',
  };
}

/** The two-connection setup used as the worked example throughout. */
function twoConnections(): ServerConfig {
  return makeConfig({
    connections: [
      makeConnection({ name: 'prod' }),
      makeConnection({ name: 'account', surface: 'hetzner' }),
    ],
    defaultName: 'prod',
  });
}

// ---------------------------------------------------------------------------
// It describes the surface that shipped
// ---------------------------------------------------------------------------

describe('instructions describe the registered surface', () => {
  const CONFIGS: Array<[string, ServerConfig]> = [
    ['the default configuration', makeConfig()],
    [
      'destructive enabled',
      makeConfig({ connections: [makeConnection({ allowDestructive: true })] }),
    ],
    ['read-only', makeConfig({ connections: [makeConnection({ readOnly: true })] })],
    ['two connections', twoConnections()],
  ];

  it.each(CONFIGS)('names no tool it did not register: %s', (_why, cfg) => {
    const registered = new Set(selectTools(cfg).map((tool) => tool.name));
    const text = buildInstructions(cfg);

    for (const name of ALL_TOOL_NAMES) {
      if (registered.has(name)) continue;
      // Word-bounded: a description may legitimately contain a word that is
      // also part of a tool name, and a bare substring check would read that as
      // naming the tool.
      expect(text, name).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it.each(CONFIGS)('stays ASCII: %s', (_why, cfg) => {
    // Re-encoded by every host in the chain. A smart quote or an en dash is the
    // classic thing to arrive mojibaked in a system prompt.
    expect(buildInstructions(cfg)).not.toMatch(/[^\x20-\x7e\n]/);
  });

  it('names the generic doors that exist and only those', () => {
    expect(buildInstructions(makeConfig())).toContain(
      'search_operations -> describe_operation -> execute_read_operation / execute_write_operation.',
    );
    expect(
      buildInstructions(makeConfig({ connections: [makeConnection({ allowDestructive: true })] })),
    ).toContain(
      'execute_read_operation / execute_write_operation / execute_destructive_operation.',
    );
    expect(
      buildInstructions(makeConfig({ connections: [makeConnection({ readOnly: true })] })),
    ).toContain('search_operations -> describe_operation -> execute_read_operation.');
  });
});

// ---------------------------------------------------------------------------
// The facts that only this string can carry
// ---------------------------------------------------------------------------

describe('instructions carry the facts nothing else can', () => {
  it('names all three Hetzner API surfaces and what a server means on each', () => {
    // The server hides which API a connection reaches, and "server" means a
    // virtual machine on one and leased physical hardware on another. The model
    // cannot recover that ambiguity from anything else it is shown.
    const text = buildInstructions(makeConfig());

    expect(text).toContain('api.hetzner.cloud');
    expect(text).toContain('api.hetzner.com');
    expect(text).toContain('robot-ws.your-server.de');
    expect(text).toContain('A cloud server is a virtual machine billed by the hour');
    expect(text).toContain('a robot server is leased physical hardware');
  });

  it('says ids are not guessable and where they come from', () => {
    const text = buildInstructions(makeConfig());

    expect(text).toContain('Resource ids are numeric and not guessable');
    expect(text).toContain('find_resources');
  });

  it('states that costly operations are not gated, wherever writes exist', () => {
    // Unique to this product and the fact a reader is most likely to assume the
    // other way round: the flags gate destruction, and provisioning is neither
    // destruction nor gated.
    const text = buildInstructions(makeConfig());

    expect(text).toContain('Operations that open a bill are not gated');
    expect(text).toContain('costly');
  });

  it('says nothing about billing on a read-only server, where nothing can open one', () => {
    const text = buildInstructions(
      makeConfig({ connections: [makeConnection({ readOnly: true })] }),
    );

    expect(text).not.toContain('open a bill');
  });

  it('states how to enable destructive operations exactly when they are disabled', () => {
    const disabled = buildInstructions(makeConfig());
    const enabled = buildInstructions(
      makeConfig({ connections: [makeConnection({ allowDestructive: true })] }),
    );

    expect(disabled).toContain('HETZNER_ALLOW_DESTRUCTIVE=true');
    expect(enabled).not.toContain('HETZNER_ALLOW_DESTRUCTIVE');
  });

  it('says nothing about enabling destructive operations on a read-only server', () => {
    // Setting HETZNER_ALLOW_DESTRUCTIVE would not enable anything here, so the
    // sentence would be false — and a false sentence in the system prompt costs
    // more than the missing one.
    const text = buildInstructions(
      makeConfig({ connections: [makeConnection({ readOnly: true })] }),
    );

    expect(text).toContain('read-only');
    expect(text).not.toContain('HETZNER_ALLOW_DESTRUCTIVE');
  });
});

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

describe('instructions describe the configured connections', () => {
  it('names the one connection and its surface, and says writes must name it', () => {
    // Read tools omit `connection` entirely with a single connection; write
    // tools require it explicitly, so the name is still the thing the model
    // cannot otherwise learn.
    const text = buildInstructions(makeConfig({ connections: [makeConnection({ name: 'prod' })] }));

    expect(text).toContain('Connected to: prod on Hetzner Cloud (project-scoped).');
    expect(text).toContain('Write tools require connection="prod".');
    expect(text).not.toContain('connection="*"');
  });

  it('names every connection with its surface and the default', () => {
    const text = buildInstructions(twoConnections());

    expect(text).toContain(
      'Connections: prod on Hetzner Cloud (project-scoped), account on Hetzner API (account-scoped).',
    );
    expect(text).toContain('Reads default to prod; write tools require an explicit connection.');
    expect(text).toContain('find_resources accepts connection="*" to search every connection.');
  });

  it('drops the surfaces past six connections but keeps every name', () => {
    // The names are the values the `connection` enum accepts. A model that does
    // not know them cannot call a write tool at all, so they survive the cap
    // even when the surfaces do not.
    const connections = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => makeConnection({ name }));
    const text = buildInstructions(makeConfig({ connections, defaultName: 'a' }));

    expect(text).toContain('Connections: a, b, c, d, e, f, g.');
    expect(text).not.toContain('a on Hetzner Cloud');
  });

  it('says every tool needs an explicit connection when no default was designated', () => {
    const cfg = makeConfig({
      connections: [makeConnection({ name: 'prod' }), makeConnection({ name: 'lab' })],
    });
    const text = buildInstructions(cfg);

    expect(text).toContain('No default connection is configured');
    expect(text).not.toContain('Reads default to');
  });

  it('says so rather than nothing when no connection is configured', () => {
    const text = buildInstructions(makeConfig({ connections: [] }));

    expect(text).toContain('No connection is configured');
  });
});

// ---------------------------------------------------------------------------
// It never steers
// ---------------------------------------------------------------------------

describe('instructions never tell the model what to do', () => {
  it.each([
    ['the default configuration', makeConfig()],
    ['read-only', makeConfig({ connections: [makeConnection({ readOnly: true })] })],
    ['two connections', twoConnections()],
  ])('%s', (_why, cfg) => {
    const text = buildInstructions(cfg).toLowerCase();

    for (const directive of [
      'you must',
      'you should',
      'always call',
      'never call',
      'do not use',
      'make sure to',
      'remember to',
    ]) {
      expect(text, directive).not.toContain(directive);
    }
  });
});
