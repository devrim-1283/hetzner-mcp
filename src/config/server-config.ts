/**
 * The process-wide server flags, derived once and shared by every transport.
 *
 * This module exists because there is more than one entry point — the stdio
 * binary and `serve --http` — and they must build the same `ServerConfig` from
 * the same connections. A capability gate that quietly differs between
 * transports is the kind of bug that is only ever found in production, on
 * whichever transport the reviewer did not use.
 *
 * It could not simply be imported from the stdio entry point. That file calls
 * `main()` at the top level, so importing any symbol from it attaches a stdio
 * transport as a side effect and hands the importing process's stdout to
 * JSON-RPC. An entry point is not a library, and pulling shared logic out of one
 * is the only safe way to share it.
 */

import { readEnvValue } from './schema.js';
import type { ConnectionRegistry, ServerConfig } from '../types.js';

/** Comma-separated, so one environment variable can carry several names. */
export const ALLOWED_HOSTS_ENV = 'HETZNER_MCP_ALLOWED_HOSTS';

export const LOG_LEVEL_ENV = 'HETZNER_LOG_LEVEL';

/**
 * The Host/Origin allow list for `serve --http`, from the flag and the
 * environment together.
 *
 * The environment form exists because of what happens without it in a
 * container: a flag alone means a compose file has to restate the entire
 * `command:` — node, the script path, the subcommand, the host, the port — in
 * order to append one argument, and each of those then has two spellings that
 * can drift apart from `EXPOSE` and `HEALTHCHECK` without anything failing
 * loudly.
 *
 * Both sources are merged rather than one winning. They answer the same
 * question, an operator who sets both means both, and a silent override is how
 * the defence ends up disabled on the very deployment that took the trouble to
 * configure it.
 */
export function resolveAllowedHosts(
  flagValues: readonly string[],
  env: NodeJS.ProcessEnv,
): string[] {
  const fromEnv = (readEnvValue(env, ALLOWED_HOSTS_ENV) ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  return [...new Set([...flagValues, ...fromEnv])];
}

export type LogLevel = ServerConfig['logLevel'];

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/**
 * Where a non-fatal diagnostic goes.
 *
 * Passed in rather than hardcoded: the stdio entry point prefixes its
 * diagnostics and routes them through `redact()`, and the CLI writes plainly to
 * stderr. Both are correct for their own program, and a shared function that
 * picked one would be wrong in the other half of the codebase.
 */
export type Warn = (message: string) => void;

/**
 * Builds the server configuration from an already-resolved registry.
 *
 * The flags are a SUMMARY of the connections, never a second read of the
 * environment. `config/resolve.ts` has already parsed HETZNER_READ_ONLY and
 * HETZNER_ALLOW_DESTRUCTIVE — including refusing a value it cannot read as a
 * boolean — and stamped the outcome onto every connection, where a config file
 * may also have narrowed them per connection. Parsing the same two variables a
 * second time here would produce a second answer that can disagree with the
 * first, and the gate in the tool layer is not a place to hold two answers.
 *
 * HETZNER_CONNECTION is likewise resolved upstream: it selects
 * `registry.defaultName`, which is a property of the registry rather than of
 * the server.
 */
export function toServerConfig(
  registry: ConnectionRegistry,
  env: NodeJS.ProcessEnv,
  warn: Warn,
): ServerConfig {
  const connections = [...registry.connections.values()];
  return {
    registry,
    readOnly: connections.every((connection) => connection.readOnly),
    // A read-only connection can never destroy anything, so it does not count
    // towards the server having the capability at all.
    allowDestructive: connections.some(
      (connection) => connection.allowDestructive && !connection.readOnly,
    ),
    logLevel: resolveLogLevel(env, warn),
  };
}

export function resolveLogLevel(env: NodeJS.ProcessEnv, warn: Warn): LogLevel {
  const raw = env[LOG_LEVEL_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return DEFAULT_LOG_LEVEL;

  const match = LOG_LEVELS.find((level) => level === raw);
  if (match !== undefined) return match;

  // Not fatal — refusing to start over a log level would be absurd — but not
  // silent either, or the user watches for output that never arrives.
  warn(
    `ignoring ${LOG_LEVEL_ENV}="${raw}"; expected one of ${LOG_LEVELS.join(', ')}. Using ${DEFAULT_LOG_LEVEL}.`,
  );
  return DEFAULT_LOG_LEVEL;
}
