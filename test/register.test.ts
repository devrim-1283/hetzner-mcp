/**
 * The registration gate.
 *
 * Layer 1 of three (registration -> dispatch -> transport). The transport tests
 * prove nothing destructive can leave the process; this file proves the weaker
 * but far more visible property that a disabled capability is not even
 * ADVERTISED.
 *
 * That matters because tools/list is what a host's permission model is built
 * on. A destructive-hinted tool in a server that cannot destroy anything makes
 * every consent decision downstream of it wrong — the host asks the user to
 * approve a danger that does not exist, or auto-approves on a hint that no
 * longer describes the server. So the assertion is not merely "the tool
 * refuses"; it is "no registered tool carries destructiveHint: true".
 *
 * The second property under test is the one the sibling product did not need:
 * that `selectTools` and `search_operations` cannot disagree, because both read
 * `availableDangerClasses`. A gate that were stricter than search would show the
 * model an operation and then deny it the door — a loop no rephrasing escapes,
 * since the fix is a human setting an environment variable and restarting.
 */

import { describe, expect, it } from 'vitest';
import { searchOperations } from '../src/catalog/index.js';
import { ALL_TOOLS, selectTools } from '../src/tools/register.js';
import { availableDangerClasses } from '../src/tools/shared.js';
import { SURFACE_BASE_URLS } from '../src/types.js';
import type { Connection, ConnectionRegistry, ServerConfig, Surface } from '../src/types.js';

const READ_TOOLS = [
  'find_resources',
  'get_resource',
  'get_action',
  'get_metrics',
  'get_pricing',
  'search_operations',
  'describe_operation',
  'execute_read_operation',
];

const WRITE_TOOLS = [
  'create_server',
  'control_resource',
  'manage_dns',
  'set_labels',
  'execute_write_operation',
];

const DESTRUCTIVE_TOOL = 'execute_destructive_operation';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
      // Never called: registration is a pure decision over configuration, and a
      // gate that had to resolve a credential to decide would be a gate with a
      // network dependency.
      resolve: () => Promise.reject(new Error('no credential may be resolved during registration')),
    },
  };
}

interface ConfigOptions {
  connections?: Connection[];
  defaultName?: string;
  /** Overrides the derived process-wide flags, to test them disagreeing. */
  readOnly?: boolean;
  allowDestructive?: boolean;
}

/**
 * Mirrors `toServerConfig`: the process-wide flags are a SUMMARY of the
 * resolved connections, never a second parse of the environment. The overrides
 * exist only so the tests can drive the two halves of the gate apart.
 */
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

function namesFor(cfg: ServerConfig): string[] {
  return selectTools(cfg).map((tool) => tool.name);
}

// ---------------------------------------------------------------------------
// The catalogue itself
// ---------------------------------------------------------------------------

describe('the tool surface', () => {
  it('holds 14 tools with unique names', () => {
    const names = ALL_TOOLS.map((tool) => tool.name);

    expect(ALL_TOOLS).toHaveLength(14);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS, DESTRUCTIVE_TOOL].sort());
  });

  it('offers find_resources first and the generic doors last', () => {
    // Hetzner ids are numeric and not guessable, so almost every useful
    // sequence starts at find_resources; the catalog doors are the long tail
    // behind the dedicated tools and belong at the end of the list.
    const names = ALL_TOOLS.map((tool) => tool.name);

    expect(names[0]).toBe('find_resources');
    expect(names.slice(-5)).toEqual([
      'search_operations',
      'describe_operation',
      'execute_read_operation',
      'execute_write_operation',
      DESTRUCTIVE_TOOL,
    ]);
  });

  it('gives every tool the annotations the tool contract requires', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.annotations.title, tool.name).toBeTruthy();
      expect(typeof tool.annotations.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations.destructiveHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations.openWorldHint, tool.name).toBe('boolean');
      // Only the read surface may claim to be read-only, and only the
      // destructive surface may claim to destroy. The annotations are what a
      // host builds its permission prompts on, so they have to agree with the
      // surface the gate sorts by.
      expect(tool.annotations.readOnlyHint, tool.name).toBe(tool.surface === 'read');
      expect(tool.annotations.destructiveHint, tool.name).toBe(tool.surface === 'destructive');
    }
  });

  it('names at least one Hetzner API surface for every tool', () => {
    // A tool with no surface could not resolve a connection at all, and the
    // failure would surface as "no connection named ..." at call time rather
    // than as the wiring mistake it is.
    for (const tool of ALL_TOOLS) {
      expect(tool.apiSurfaces.length, tool.name).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// One predicate, two callers
// ---------------------------------------------------------------------------

describe('registration and search agree', () => {
  const CASES: Array<[string, ServerConfig]> = [
    ['the default configuration', makeConfig()],
    [
      'destructive enabled',
      makeConfig({ connections: [makeConnection({ allowDestructive: true })] }),
    ],
    ['read-only', makeConfig({ connections: [makeConnection({ readOnly: true })] })],
  ];

  it.each(CASES)('offers no operation through a door it did not register: %s', (_why, cfg) => {
    const available = new Set(availableDangerClasses(cfg));
    const registered = new Set(namesFor(cfg));

    // `search_operations` filters the catalog with exactly this set. If the two
    // ever parted, the model would be shown an operation, told which door runs
    // it, and then told that door does not exist.
    expect(registered.has('execute_write_operation')).toBe(available.has('write'));
    expect(registered.has(DESTRUCTIVE_TOOL)).toBe(available.has('destructive'));

    for (const operation of searchOperations({ danger: [...available], limit: 500 })) {
      expect(available.has(operation.danger), operation.id).toBe(true);
    }
  });

  it('always keeps the read door open, because safe is never gated', () => {
    for (const [, cfg] of CASES) {
      expect(availableDangerClasses(cfg)).toContain('safe');
      expect(namesFor(cfg)).toContain('execute_read_operation');
    }
  });
});

// ---------------------------------------------------------------------------
// The destructive gate
// ---------------------------------------------------------------------------

describe('the destructive gate', () => {
  it('registers 13 tools by default and omits execute_destructive_operation entirely', () => {
    const names = namesFor(makeConfig());

    expect(names).toHaveLength(13);
    expect(names).not.toContain(DESTRUCTIVE_TOOL);
    expect([...names].sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
  });

  it('leaves no tool carrying destructiveHint when the flag is off', () => {
    // The whole point of gating at registration rather than at call time: with
    // the door removed, the hint disappears from the list with it, and the
    // host's permission model matches the server's real capability exactly.
    for (const tool of selectTools(makeConfig())) {
      expect(tool.annotations.destructiveHint, tool.name).toBe(false);
    }
  });

  it('registers 14 tools when the flag is on, and only that one is destructive', () => {
    const cfg = makeConfig({ connections: [makeConnection({ allowDestructive: true })] });
    const tools = selectTools(cfg);

    expect(tools).toHaveLength(14);
    expect(tools.map((tool) => tool.name)).toContain(DESTRUCTIVE_TOOL);
    expect(
      tools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name),
    ).toEqual([DESTRUCTIVE_TOOL]);
  });

  it('keeps the door shut when no connection opted in', () => {
    // HETZNER_ALLOW_DESTRUCTIVE=true while every connection opted out: nothing
    // could be destroyed, so advertising the tool would be a lie. The flag is
    // ANDed onto each connection by the config layer, so a connection that says
    // no is the only evidence the gate needs.
    const cfg = makeConfig({
      connections: [makeConnection({ allowDestructive: false })],
      allowDestructive: true,
    });

    expect(namesFor(cfg)).not.toContain(DESTRUCTIVE_TOOL);
  });

  it('keeps the door shut when the summary flag and the connections disagree', () => {
    // `ServerConfig.allowDestructive` is a SUMMARY of the connections, so in a
    // registry built by the config layer the two cannot contradict each other.
    // The gate nonetheless requires BOTH, and that is the point of this test:
    // it pins the direction the gate fails in when a ServerConfig reaches it
    // from anywhere else — a test, an embedder, a refactor that stops deriving
    // the summary. Requiring both makes the invariant local to the gate instead
    // of borrowed from a guarantee made in another file, and the borrowed
    // version is the one that fails open.
    const cfg = makeConfig({
      connections: [makeConnection({ allowDestructive: true })],
      allowDestructive: false,
    });

    expect(namesFor(cfg)).not.toContain(DESTRUCTIVE_TOOL);
  });

  it('keeps the door shut on a read-only server even with the flag on', () => {
    // Read-only is a ceiling: it is checked before anything that could widen it.
    const cfg = makeConfig({
      connections: [makeConnection({ readOnly: true, allowDestructive: true })],
      allowDestructive: true,
    });

    expect(namesFor(cfg)).not.toContain(DESTRUCTIVE_TOOL);
  });

  it('registers the door when one connection of several opted in', () => {
    const cfg = makeConfig({
      connections: [
        makeConnection({ name: 'prod' }),
        makeConnection({ name: 'lab', allowDestructive: true }),
      ],
      defaultName: 'prod',
    });

    expect(namesFor(cfg)).toContain(DESTRUCTIVE_TOOL);
  });
});

// ---------------------------------------------------------------------------
// The read-only gate
// ---------------------------------------------------------------------------

describe('the read-only gate', () => {
  it('registers exactly the 8 read tools', () => {
    const cfg = makeConfig({ connections: [makeConnection({ readOnly: true })] });
    const tools = selectTools(cfg);

    expect(tools).toHaveLength(8);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.surface, tool.name).toBe('read');
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations.destructiveHint, tool.name).toBe(false);
    }
  });

  it('drops the write tools when the process-wide flag is set', () => {
    // HETZNER_READ_ONLY tightens every connection in config/resolve.ts, but the
    // gate must hold on the flag alone: it is a kill switch, and a kill switch
    // that depends on another layer having done its job is not one.
    const cfg = makeConfig({ readOnly: true });
    const names = namesFor(cfg);

    expect(names).toHaveLength(8);
    for (const write of [...WRITE_TOOLS, DESTRUCTIVE_TOOL]) {
      expect(names).not.toContain(write);
    }
  });

  it('keeps the write tools while any connection can still write', () => {
    const cfg = makeConfig({
      connections: [
        makeConnection({ name: 'prod', readOnly: true }),
        makeConnection({ name: 'lab' }),
      ],
      defaultName: 'prod',
    });

    expect(namesFor(cfg)).toHaveLength(13);
  });

  it('drops the write tools when every connection is read-only', () => {
    const cfg = makeConfig({
      connections: [
        makeConnection({ name: 'prod', readOnly: true }),
        makeConnection({ name: 'lab', readOnly: true }),
      ],
      defaultName: 'prod',
    });

    expect(namesFor(cfg)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

describe('the schemas registration publishes', () => {
  it('builds every registered tool schema against every configuration', () => {
    // `inputSchema` is a function of the config, and the one thing that must
    // never happen is a throw during registration: the server would fail to
    // start with a stack trace instead of speaking the protocol.
    const configs = [
      makeConfig(),
      makeConfig({ connections: [makeConnection({ allowDestructive: true })] }),
      makeConfig({ connections: [makeConnection({ readOnly: true })] }),
      makeConfig({
        connections: [
          makeConnection({ name: 'prod' }),
          makeConnection({ name: 'account', surface: 'hetzner' }),
          makeConnection({ name: 'robot', surface: 'robot' }),
        ],
        defaultName: 'prod',
      }),
    ];

    for (const cfg of configs) {
      for (const tool of selectTools(cfg)) {
        expect(() => tool.inputSchema(cfg), tool.name).not.toThrow();
      }
    }
  });

  it('omits the connection parameter from read tools when only one connection exists', () => {
    // An optional parameter with exactly one legal value is a decision the model
    // makes on every call, tokens spent advertising it, and a chance to get it
    // wrong. Write tools still carry it, because a write must never happen
    // through an omitted parameter.
    const cfg = makeConfig();

    expect(Object.keys(cfg.registry.connections)).toBeDefined();
    expect('connection' in { ...tool('get_resource').inputSchema(cfg) }).toBe(false);
    expect('connection' in { ...tool('control_resource').inputSchema(cfg) }).toBe(true);
  });
});

function tool(name: string) {
  const found = ALL_TOOLS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
}
