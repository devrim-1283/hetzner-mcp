/**
 * The stdio entry point.
 *
 * STDOUT IS THE JSON-RPC CHANNEL. Nothing may be written to it that is not a
 * protocol message: one stray line of diagnostics desynchronises the framing
 * and the client drops the connection with an error naming neither the line nor
 * this process. Every human-readable byte therefore goes to stderr, which every
 * MCP client captures as the server's log.
 *
 * No shebang here — tsup prepends one, and a second `#!` on line 2 of the
 * bundle is a syntax error rather than a comment.
 */

import { homedir } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveRegistry } from './config/resolve.js';
import { ConfigError } from './config/schema.js';
import { toServerConfig } from './config/server-config.js';
import { configureTransport } from './http/client.js';
import { buildServer } from './server.js';
import { redact } from './shaping/redact.js';

/** Prefixes diagnostics, so a client log holding several servers stays legible. */
const PROGRAM = 'hetzner-mcp';

/** The server is not configured. A human has to change something. */
const EXIT_CONFIG = 1;

/**
 * Startup failed for a reason that is not the user's configuration. Split from
 * EXIT_CONFIG so the packaging smoke test can tell "nobody set the variables"
 * apart from "the build is broken" without parsing stderr.
 */
const EXIT_INTERNAL = 2;

async function main(): Promise<void> {
  const registry = await resolveRegistry(process.env, process.cwd(), homedir());
  const cfg = toServerConfig(registry, process.env, note);

  // Layer 3 of the destructive gate, armed once, here. `http/client.ts` holds
  // this as process state rather than reading the config itself, precisely so
  // that it cannot be reconfigured from inside a tool call — which also means
  // an entry point that forgot to arm it would leave the transport enforcing
  // only what each connection carries, with the server-wide ceiling silent.
  // The registry is passed for one thing: naming a writable sibling connection
  // when a read-only one refuses a write.
  configureTransport({ readOnly: cfg.readOnly, registry });

  const server = buildServer(cfg);
  await server.connect(new StdioServerTransport());
}

/**
 * Writes one diagnostic line to stderr — never stdout, which carries JSON-RPC.
 *
 * The prefix is skipped when the message already opens with the program name:
 * the most-seen error in the product is "hetzner-mcp has no connections
 * configured", and "hetzner-mcp: hetzner-mcp has no..." is the kind of stutter
 * that makes a first run feel unfinished.
 */
function note(message: string): void {
  const line = message.startsWith(PROGRAM) ? message : `${PROGRAM}: ${message}`;
  process.stderr.write(`${line}\n`);
}

/**
 * Reports a startup failure on stderr and exits non-zero.
 *
 * A configuration problem must be loud and must carry its remedy: the
 * alternative is a process that starts, answers `initialize`, and then fails
 * every tool call for a reason nobody can see from the client side.
 *
 * Everything is passed through `redact()`. At this point no credential has
 * usually been resolved, so the registered-secret pass has nothing to do — but
 * the shape-based backstop inside `redact` catches the case that actually
 * happens: a token pasted into the wrong variable and quoted straight back in
 * the message that refuses it. Client logs get shared in bug reports.
 */
function fail(error: unknown): never {
  if (error instanceof ConfigError) {
    // These messages are written for a human at a terminal: they name the
    // variables to set and every path that was searched. Printed verbatim.
    note(redact(error.message));
    process.exit(EXIT_CONFIG);
  }

  const detail = error instanceof Error ? error.message : String(error);
  note(`failed to start: ${redact(detail)}`);
  process.exit(EXIT_INTERNAL);
}

main().catch(fail);
