/**
 * The MCP server: identity, the registered tool surface, and `instructions`.
 *
 * Transport-agnostic on purpose. `index.ts` attaches stdio and `http/serve.ts`
 * attaches Streamable HTTP. Nothing here touches process state, so the server
 * can be built repeatedly in a test — and is, once per POST in HTTP mode.
 */

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, selectTools } from './tools/register.js';
import { SURFACE_LABELS } from './types.js';
import type { Connection, ServerConfig } from './types.js';

export const SERVER_NAME = 'hetzner-mcp';

const API_REFERENCE = 'https://docs.hetzner.cloud';

/** Reported only when package.json cannot be read, which should not happen. */
const UNKNOWN_VERSION = '0.0.0';

/**
 * Above this, naming every connection's surface costs more context than it
 * returns. The NAMES are still listed past it — they are the values the
 * `connection` enum accepts, and a model that does not know them cannot call a
 * write tool at all.
 */
const MAX_DESCRIBED_CONNECTIONS = 6;

/**
 * The version reported in the MCP `initialize` handshake.
 *
 * Read from package.json at runtime rather than duplicated as a constant: a
 * hardcoded string drifts silently at the next release and the number the
 * client displays becomes a lie. `dist/` sits one level under the package root
 * in the published layout and `src/` does in the source tree, so the same
 * relative path serves both.
 */
function packageVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

export function buildServer(cfg: ServerConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Hetzner', version: packageVersion() },
    { instructions: buildInstructions(cfg) },
  );
  registerTools(server, cfg);
  return server;
}

/**
 * The `instructions` string, assembled from the configuration that actually
 * shipped.
 *
 * This lands in the host's system prompt on every turn, which makes it both the
 * highest-leverage string in the server and the most expensive place to be
 * wrong: a sentence naming a tool that was not registered sends the model
 * looking for a door that does not exist, and a sentence describing a gate that
 * is not there is worse than saying nothing. So every clause is read off the
 * REGISTERED SET rather than re-derived from the flags — and the set is taken
 * from `selectTools`, the same gate `registerTools` runs, with no parameter by
 * which a caller could describe a surface that did not ship.
 *
 * Two rules hold for every sentence:
 *   - it states a FACT about this server's configuration or capability surface;
 *   - it never tells the model how to behave. `instructions` is a description
 *     channel, not a prompt. A server that used it to steer the model or to
 *     talk past the host's own system prompt is what Directory review rejects,
 *     and rightly.
 *
 * ASCII throughout. This string is re-encoded by every host in the chain, and a
 * smart quote is the classic thing to arrive mojibaked in a system prompt.
 */
export function buildInstructions(cfg: ServerConfig): string {
  const tools = selectTools(cfg);
  const registered = new Set(tools.map((tool) => tool.name));
  const writable = tools.some((tool) => tool.surface !== 'read');
  const destructive = tools.some((tool) => tool.surface === 'destructive');

  const lines = [coreParagraph(registered, writable)];

  if (!writable) {
    lines.push('This server is running read-only. No write tools are registered.');
  } else if (!destructive) {
    // Recovers, in about 30 tokens, the one fact that registration-time gating
    // would otherwise have thrown away. Suppressed under read-only above,
    // because there the sentence would be false: setting
    // HETZNER_ALLOW_DESTRUCTIVE alone would not enable anything.
    lines.push(
      'Destructive operations (deleting a resource, rebuilding a server, rolling a Storage Box ' +
        'back to a snapshot) are disabled on this server. They can be enabled by setting ' +
        'HETZNER_ALLOW_DESTRUCTIVE=true and restarting it.',
    );
  }

  if (writable) {
    // The fact that separates this product from its sibling, and the one a
    // reader is most likely to assume the other way round. Nothing here gates
    // spending: the flags gate destruction, and provisioning is neither.
    lines.push(
      'Operations that open a bill are not gated. Provisioning a Server, Volume, Load Balancer ' +
        'or Floating IP starts charging immediately and is reachable wherever writes are; ' +
        'search_operations marks those operations costly, and the response of a call that ' +
        "created something reports Hetzner's published price for it.",
    );
  }

  lines.push(connectionParagraph(cfg, writable));

  return lines.filter((line) => line !== '').join('\n');
}

function coreParagraph(registered: ReadonlySet<string>, writable: boolean): string {
  const loop = writable
    ? 'Dedicated tools cover the common operator loop: find resources, read one in full, follow an Action to completion, read server metrics, read prices, create a server, power and lifecycle control, DNS zones and records, and labels.'
    : 'Dedicated tools cover the read side of the common operator loop: find resources, read one in full, follow an Action to completion, read server metrics, read prices.';

  const doors = [
    'execute_read_operation',
    'execute_write_operation',
    'execute_destructive_operation',
  ]
    .filter((name) => registered.has(name))
    .join(' / ');

  return [
    // Naming the three APIs is not padding. The server hides which one a
    // connection reaches, and the word "server" means a virtual machine on one
    // of them and a leased physical machine on another — an ambiguity nothing
    // downstream can recover from once a call has been made.
    `hetzner-mcp exposes Hetzner's REST APIs across three surfaces: ${SURFACE_LABELS.cloud} at api.hetzner.cloud, ${SURFACE_LABELS.hetzner} at api.hetzner.com, and ${SURFACE_LABELS.robot} at robot-ws.your-server.de.`,
    'A cloud server is a virtual machine billed by the hour; a robot server is leased physical hardware on a monthly contract with a cancellation period. Every connection below names the surface it reaches.',
    'Resource ids are numeric and not guessable; find_resources locates servers, volumes, networks, firewalls, load balancers, zones and the rest by name or label selector, and returns the id, resource_type, surface and connection that the other tools take.',
    loop,
    `Everything else in these APIs is reachable via search_operations -> describe_operation -> ${doors}.`,
    'Most cloud mutations are asynchronous: the call returns an Action, the tools wait for it, and meta.action reports whether the work actually finished.',
    `API reference: ${API_REFERENCE}`,
  ].join(' ');
}

/**
 * What the model would otherwise have to call a `list_connections` tool to
 * learn.
 *
 * Stating it here saves a tool slot and a round trip, and it is the only place
 * the model can find out which names the `connection` enum will accept before
 * it has called anything — which matters more here than in a single-API server,
 * because a name also decides WHICH Hetzner API is reached and a credential for
 * one cannot be used against another.
 */
function connectionParagraph(cfg: ServerConfig, writable: boolean): string {
  const connections = [...cfg.registry.connections.values()];
  if (connections.length === 0) {
    // Not a hypothetical: the stdio entry point refuses to start with no
    // credential, but a config file may define a set this server can resolve
    // and still leave nothing usable behind. Silence would read as "there is
    // one and it was not worth naming".
    return 'No connection is configured, so every tool will refuse until one is.';
  }

  const [only] = connections;
  if (connections.length === 1 && only !== undefined) {
    // Read tools omit `connection` entirely with one connection; write tools
    // still require it by name, so the name is still worth stating.
    const selection = writable ? ` Write tools require connection="${only.name}".` : '';
    return `Connected to: ${describe(only)}.${selection}`;
  }

  const listed =
    connections.length <= MAX_DESCRIBED_CONNECTIONS
      ? connections.map(describe)
      : connections.map((connection) => connection.name);

  const defaultName = cfg.registry.defaultName;
  const selection =
    defaultName === undefined
      ? 'No default connection is configured; every tool requires an explicit connection.'
      : writable
        ? `Reads default to ${defaultName}; write tools require an explicit connection.`
        : `Reads default to ${defaultName}.`;

  return [
    `Connections: ${listed.join(', ')}.`,
    selection,
    'find_resources accepts connection="*" to search every connection.',
  ].join(' ');
}

function describe(connection: Connection): string {
  return `${connection.name} on ${SURFACE_LABELS[connection.surface]}`;
}
