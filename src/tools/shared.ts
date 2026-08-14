/**
 * The seam every tool module implements against.
 *
 * It exists as its own file rather than living inside whichever tool happened
 * to need a helper first: five tool modules are written independently, and a
 * shared helper hiding inside one of them makes the other four depend on a
 * file that is also being edited for unrelated reasons.
 *
 * Three things live here, and nothing else should:
 *   - reading and validating tool arguments, including connection selection
 *   - the error boundary that turns a thrown HetznerError into a tool result
 *   - awaiting an Action, because 144 of this API's 221 operations return one
 */

import { z } from 'zod';
import { getOperation } from '../catalog/index.js';
import { request } from '../http/client.js';
import {
  attachAction,
  attachBilling,
  billingFromPrices,
  renderEnvelope,
  shapeResponse,
  type EnvelopeMeta,
} from '../shaping/envelope.js';
import { redact } from '../shaping/redact.js';
import { HetznerError, SURFACE_LABELS } from '../types.js';
import type {
  ActionRef,
  ActionStatus,
  CatalogOperation,
  Connection,
  DangerClass,
  ServerConfig,
  Surface,
  ToolExtra,
  ToolResult,
} from '../types.js';

// ---------------------------------------------------------------------------
// Connection selection
// ---------------------------------------------------------------------------

/** The value that means "every connection", for tools that can fan out. */
export const ALL_CONNECTIONS = '*';

export interface ConnectionPropertyOptions {
  /** Accept `"*"`, for read tools that can search the whole fleet. */
  allowAll?: boolean;
  /**
   * Require an explicit choice even when a default exists. Write tools set
   * this: a write must never happen through an omitted parameter.
   */
  requireExplicit?: boolean;
  /** Restrict to connections on these surfaces. */
  surfaces?: readonly Surface[];
}

/**
 * The `connection` parameter — or nothing at all.
 *
 * When exactly one connection can serve the tool, the parameter is ABSENT from
 * the schema rather than optional. An optional parameter with one legal value
 * is a decision the model has to make on every call, tokens spent advertising
 * it, and a chance to get it wrong; removing it is strictly better.
 *
 * The type is an enum over the configured names, never a free string. This is
 * the property that makes a whole class of prompt injection unexpressible:
 * there is no schema position in this server into which "point at this other
 * host" can be written.
 */
export function connectionProperty(
  cfg: ServerConfig,
  opts: ConnectionPropertyOptions = {},
): Record<string, unknown> {
  const names = eligibleNames(cfg, opts.surfaces);
  if (names.length === 0) return {};

  const single = names.length === 1 && !opts.requireExplicit;
  if (single && !opts.allowAll) return {};

  const values = opts.allowAll ? [...names, ALL_CONNECTIONS] : names;
  const described = names.map((name) => `${name} (${surfaceOf(cfg, name)})`).join(', ');

  const base = z
    .enum(values as [string, ...string[]])
    .describe(
      [
        `Which configured connection to use: ${described}.`,
        opts.allowAll ? `"${ALL_CONNECTIONS}" searches every connection.` : '',
        opts.requireExplicit
          ? 'Required — this tool changes something, so the target is never inferred.'
          : defaultHint(cfg),
      ]
        .filter((part) => part !== '')
        .join(' '),
    );

  return { connection: opts.requireExplicit ? base : base.optional() };
}

function defaultHint(cfg: ServerConfig): string {
  const name = cfg.registry.defaultName;
  return name === undefined
    ? 'Required — no default connection is configured.'
    : `Defaults to ${name}.`;
}

function surfaceOf(cfg: ServerConfig, name: string): string {
  const connection = cfg.registry.connections.get(name);
  return connection === undefined ? 'unknown' : SURFACE_LABELS[connection.surface];
}

function eligibleNames(cfg: ServerConfig, surfaces?: readonly Surface[]): string[] {
  return [...cfg.registry.connections.values()]
    .filter((connection) => surfaces === undefined || surfaces.includes(connection.surface))
    .map((connection) => connection.name);
}

/**
 * Resolves the `connection` argument to exactly one connection.
 *
 * Every failure names what the caller can do next, because "connection not
 * found" without the list of names is a round trip spent learning something
 * the server already knew.
 */
export function resolveConnection(
  args: Record<string, unknown>,
  cfg: ServerConfig,
  opts: ConnectionPropertyOptions = {},
): Connection {
  const names = eligibleNames(cfg, opts.surfaces);
  const requested = optionalString(args, 'connection');

  // Nothing serves this tool at all. Reported before every other check,
  // because every message below would otherwise end in "One of: ." — a list of
  // remedies with no remedies in it, which reads as a bug in the server rather
  // than as a thing the reader can go and fix.
  if (names.length === 0) throw noConnectionFor(cfg, opts.surfaces);

  if (requested === ALL_CONNECTIONS) {
    throw new HetznerError(
      `\`connection: "${ALL_CONNECTIONS}"\` is not supported by this tool.`,
      'validation',
      `Name one connection: ${names.join(', ')}.`,
    );
  }

  if (requested === undefined) {
    if (opts.requireExplicit) {
      throw new HetznerError(
        '`connection` is required for this tool.',
        'validation',
        `This tool changes something, so the target is never inferred. One of: ${names.join(', ')}.`,
      );
    }
    if (names.length === 1 && names[0] !== undefined) return get(cfg, names[0]);

    const fallback = cfg.registry.defaultName;
    if (fallback === undefined || !names.includes(fallback)) {
      throw new HetznerError(
        '`connection` is required: no usable default is configured.',
        'validation',
        `One of: ${names.join(', ')}.`,
      );
    }
    return get(cfg, fallback);
  }

  if (!names.includes(requested)) {
    throw new HetznerError(
      `No connection named "${requested}"${surfaceClause(opts.surfaces)}.`,
      'validation',
      `Configured: ${names.join(', ')}. Connections are defined by the person running this server; a tool cannot create one or point at a new host.`,
    );
  }
  return get(cfg, requested);
}

/** Every connection a fan-out tool should visit for `connection: "*"`. */
export function resolveConnectionFanOut(
  args: Record<string, unknown>,
  cfg: ServerConfig,
  opts: ConnectionPropertyOptions = {},
): Connection[] {
  if (optionalString(args, 'connection') === ALL_CONNECTIONS) {
    return eligibleNames(cfg, opts.surfaces).map((name) => get(cfg, name));
  }
  return [resolveConnection(args, cfg, opts)];
}

/**
 * "This tool has nothing to talk to" — said in terms of what the operator would
 * have to add, not in terms of an empty list.
 *
 * The two cases are genuinely different problems. No connections at all means
 * the server started with no credential configured. Connections that exist but
 * none on the required surface means the operator configured a Hetzner Cloud
 * project and then asked for something only the account API can answer, which
 * is a different fix and a different documentation page.
 */
function noConnectionFor(cfg: ServerConfig, surfaces?: readonly Surface[]): HetznerError {
  const configured = [...cfg.registry.connections.values()];
  if (configured.length === 0) {
    return new HetznerError(
      'No connection is configured.',
      'validation',
      'This server needs at least one Hetzner credential. `hetzner-mcp doctor` reports what it found and what it expected.',
    );
  }
  const wanted = (surfaces ?? []).map((surface) => SURFACE_LABELS[surface]).join(' or ');
  const have = configured
    .map((connection) => `${connection.name} (${SURFACE_LABELS[connection.surface]})`)
    .join(', ');
  return new HetznerError(
    `No configured connection is on ${wanted}.`,
    'surface_mismatch',
    `This tool only works against ${wanted}. Configured: ${have}. A credential for one Hetzner API cannot be used against another.`,
  );
}

function surfaceClause(surfaces?: readonly Surface[]): string {
  if (surfaces === undefined || surfaces.length === 0) return '';
  return ` on ${surfaces.map((surface) => SURFACE_LABELS[surface]).join(' or ')}`;
}

function get(cfg: ServerConfig, name: string): Connection {
  const connection = cfg.registry.connections.get(name);
  if (connection === undefined) {
    throw new HetznerError(`Connection "${name}" disappeared from the registry.`, 'unknown');
  }
  return connection;
}

// ---------------------------------------------------------------------------
// Argument readers
//
// Zod has already validated the shape by the time a handler runs. These exist
// for the narrowing, so a handler reads a typed value rather than casting.
// ---------------------------------------------------------------------------

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new HetznerError(`\`${key}\` must be a string.`, 'validation');
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined) {
    throw new HetznerError(`\`${key}\` is required.`, 'validation');
  }
  return value;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HetznerError(`\`${key}\` must be a number.`, 'validation');
  }
  return value;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new HetznerError(`\`${key}\` must be true or false.`, 'validation');
  }
  return value;
}

/**
 * A Hetzner resource id.
 *
 * Ids are numeric, and the model will frequently have one as a string because
 * it read it out of a previous tool result. Accepting both and normalising is
 * the difference between a round trip and none; rejecting the string form
 * would be pedantry paid for by the user.
 */
export function requiredId(args: Record<string, unknown>, key = 'id'): number {
  const raw = args[key];
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw.trim())) return Number(raw.trim());
  throw new HetznerError(
    `\`${key}\` must be a positive integer id.`,
    'validation',
    'find_resources reports the id of everything it lists.',
  );
}

export function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

/**
 * Runs a handler body and renders any failure as a tool RESULT.
 *
 * Errors are returned, never thrown across the transport: a thrown error
 * becomes a protocol-level failure the model cannot read, whereas a result
 * carrying the message and the hint is something it can act on.
 *
 * The text is redacted on the way out. This is the one path a tool can emit a
 * string without passing through `renderEnvelope`, and therefore the last
 * place a resolved credential could otherwise reach the transcript.
 */
export async function runTool(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (error: unknown) {
    return errorResult(error);
  }
}

export function errorResult(error: unknown): ToolResult {
  const parts: string[] = [];
  if (error instanceof HetznerError) {
    // A caller who went away is not a fault. Rendering it as one puts a
    // spurious failure in the transcript for something nobody is waiting on.
    if (error.kind === 'cancelled') {
      return { content: [{ type: 'text', text: 'Cancelled by the caller.' }] };
    }
    parts.push(error.message);
    if (error.hint !== undefined) parts.push(error.hint);
    // Hetzner's error.code is a closed vocabulary — `protected`,
    // `uniqueness_error`, `resource_unavailable` — and it is what a user will
    // search for and what Hetzner's own support will ask about. Dropping it
    // here would mean the one identifier that survives a translation into
    // ordinary prose never reaches the transcript at all.
    if (error.apiCode !== undefined && !parts.some((part) => part.includes(error.apiCode!))) {
      parts.push(`(Hetzner error code: ${error.apiCode})`);
    }
    if (error.validationErrors !== undefined && error.validationErrors.length > 0) {
      parts.push(
        error.validationErrors
          .map((field) => `${field.name}: ${field.messages.join('; ')}`)
          .join(' | '),
      );
    }
  } else if (error instanceof Error) {
    parts.push(error.message);
  } else {
    parts.push('The tool failed with a non-Error value.');
  }
  return { content: [{ type: 'text', text: redact(parts.join(' ')) }], isError: true };
}

/**
 * Re-exported so a tool has ONE import for the whole seam.
 *
 * Four of the five tool modules reported reaching past `shared.ts` into
 * `shaping/envelope.js` for these, which is the seam admitting it was half
 * built: a module boundary that covers the error path but not the success path
 * is not a boundary, it is a habit.
 */
export { renderEnvelope, shapeResponse, attachAction, attachBilling, billingFromPrices };
export type { EnvelopeMeta };

/**
 * Which danger classes this server can actually reach, given its configuration.
 *
 * ONE definition, because two would eventually disagree and the disagreement
 * would be invisible: `register.ts` uses it to decide which tools exist, and
 * `search_operations` uses it to decide which operations to offer. If search
 * were more generous than registration, the model would be shown a door that is
 * not there, call it, and be told it does not exist — a loop no rephrasing can
 * escape, because the fix is a human setting an environment variable.
 *
 * The scan over connections is what keeps it honest in both directions. Reading
 * only the global flag would advertise destructive operations on a server where
 * every connection has opted out, and hide them on one where a single
 * connection opted in.
 *
 * `readOnly` is checked first and nothing below can widen it, because it is a
 * ceiling rather than a default.
 */
export function availableDangerClasses(cfg: ServerConfig): DangerClass[] {
  const connections = [...cfg.registry.connections.values()];
  const writable = !cfg.readOnly && connections.some((connection) => !connection.readOnly);
  if (!writable) return ['safe'];

  // Both terms, deliberately, even though the config layer already ANDs the
  // global flag into every connection. Relying on that alone would make this
  // function correct only because of a guarantee made in a different file: a
  // ServerConfig assembled any other way — a test, a future embedder — would
  // open the destructive door from a connection flag while the summary said
  // closed. Repeating the check costs one `&&` and makes the invariant local.
  const destructive =
    cfg.allowDestructive &&
    connections.some((connection) => !connection.readOnly && connection.allowDestructive);
  return destructive ? ['safe', 'write', 'destructive'] : ['safe', 'write'];
}

/**
 * The catalog said this operation returns an Action and the response carried
 * none.
 *
 * It exists for the same reason `unsettledHint` does: without one sentence
 * owned in one place, five tool modules write five sentences for one fact, and
 * a reader who meets two of them cannot tell whether they describe the same
 * situation.
 */
export function noActionHint(operationId: string): string {
  return `The catalog records ${operationId} as returning an Action and this response carried none, so there was nothing to wait for. The call itself succeeded.`;
}

/**
 * Refuses an operation whose danger class does not belong to this door.
 *
 * Every door needs this check and each one was writing its own. Worse than the
 * duplication is what the duplication does to the message: the refusal is the
 * only place a caller learns WHERE the operation does live, and a version of
 * that sentence per door means the pointer is right in some of them and stale
 * in the rest.
 *
 * The classification is read from the catalog at call time rather than trusted
 * from the caller, so regenerating the catalog after an upstream change closes
 * a door rather than silently leaving it open.
 */
export function assertDanger(
  operationId: string,
  allowed: readonly DangerClass[],
  door: string,
  destructiveEnabled: boolean,
): CatalogOperation {
  const operation = getOperation(operationId);
  if (operation === undefined) {
    throw new HetznerError(
      `No operation named \`${operationId}\`.`,
      'validation',
      'search_operations lists every operation this server knows, with its id.',
    );
  }
  if (allowed.includes(operation.danger)) return operation;

  const where =
    operation.danger === 'destructive'
      ? `\`${operationId}\` runs through execute_destructive_operation${destructiveEnabled ? '' : ', which is registered only while destructive operations are enabled for this server'}.`
      : operation.danger === 'write'
        ? `\`${operationId}\` runs through execute_write_operation.`
        : `\`${operationId}\` runs through execute_read_operation.`;

  throw new HetznerError(
    `Operation \`${operationId}\` is a ${operation.danger} operation and ${door} runs ${allowed.join(' and ')} operations only.`,
    'validation',
    where,
  );
}

/**
 * A Zod failure rendered as a `HetznerError` the model can act on.
 *
 * Zod's own message names its model of the problem ("Invalid input: expected
 * string, received number at records[0].value") rather than the caller's. This
 * keeps the path, because the path is the actionable half, and drops the rest.
 */
export function validationFrom(error: z.ZodError, what: string): HetznerError {
  const issues = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.length === 0 ? what : `${what}.${issue.path.join('.')}`;
    return `${path}: ${issue.message}`;
  });
  const more =
    error.issues.length > issues.length ? ` (${error.issues.length - issues.length} more)` : '';
  return new HetznerError(
    `\`${what}\` is not valid.`,
    'validation',
    `${issues.join(' | ')}${more}`,
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Hetzner's own docs warn that polling too often burns a shared quota. */
const FIRST_POLL_MS = 1_000;
const POLL_BACKOFF = 1.5;
const MAX_POLL_MS = 5_000;

/** Default ceiling on how long a tool will wait before reporting "still running". */
export const DEFAULT_WAIT_MS = 120_000;
export const MAX_WAIT_MS = 600_000;

/**
 * Where an Action is read back from, per surface.
 *
 * There is no single answer, which is the first real cost of the surface
 * abstraction and the reason this is a function rather than a constant: the
 * cloud API has a global `/actions/{id}`, and the account API has no global
 * endpoint at all — its Actions are only readable under the Storage Box that
 * produced them.
 */
export function actionPollPath(surface: Surface, actionId: number): string {
  switch (surface) {
    case 'cloud':
      return `/actions/${actionId}`;
    case 'hetzner':
      return `/storage_boxes/actions/${actionId}`;
    case 'robot':
      throw new HetznerError(
        'Robot has no Action model; its calls complete synchronously.',
        'surface_mismatch',
      );
  }
}

export function readAction(payload: unknown): ActionRef | undefined {
  const body = toRecord(payload);
  const action = body['action'];
  if (action === undefined) return undefined;
  const row = toRecord(action);
  const id = row['id'];
  const status = row['status'];
  if (typeof id !== 'number' || typeof status !== 'string') return undefined;
  return {
    id,
    command: typeof row['command'] === 'string' ? row['command'] : 'unknown',
    status: status as ActionStatus,
    progress: typeof row['progress'] === 'number' ? row['progress'] : 0,
    started: typeof row['started'] === 'string' ? row['started'] : '',
    finished: typeof row['finished'] === 'string' ? row['finished'] : null,
    error:
      row['error'] === null || row['error'] === undefined ? null : readActionError(row['error']),
    resources: Array.isArray(row['resources'])
      ? (row['resources'] as Array<{ id: number; type: string }>)
      : undefined,
  };
}

function readActionError(value: unknown): { code: string; message: string } {
  const row = toRecord(value);
  return {
    code: typeof row['code'] === 'string' ? row['code'] : 'unknown',
    message: typeof row['message'] === 'string' ? row['message'] : 'The action failed.',
  };
}

export interface AwaitActionResult {
  action: ActionRef;
  /** False when the ceiling was reached while the action was still running. */
  settled: boolean;
}

/**
 * Polls an Action to completion, or to a stated give-up.
 *
 * The `settled` flag is the load-bearing half of the return value. A tool that
 * reports a running Action as though the work were done is worse than one that
 * does not wait at all, because the caller has no way to tell. Timing out is
 * therefore a normal outcome that gets said plainly, not an error.
 *
 * A failed Action IS an error: Hetzner reports the reason in the Action rather
 * than in the HTTP status, so a call that returned 201 and then failed
 * asynchronously would otherwise read as success.
 */
export async function awaitAction(
  connection: Connection,
  action: ActionRef,
  extra: ToolExtra,
  waitMs: number = DEFAULT_WAIT_MS,
): Promise<AwaitActionResult> {
  if (action.status !== 'running') {
    throwIfFailed(action);
    return { action, settled: true };
  }

  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), MAX_WAIT_MS);
  let current = action;
  let interval = FIRST_POLL_MS;

  while (current.status === 'running' && Date.now() < deadline) {
    await sleep(Math.min(interval, Math.max(deadline - Date.now(), 0)), extra.signal);
    interval = Math.min(interval * POLL_BACKOFF, MAX_POLL_MS);

    const response = await request({
      connection,
      method: 'GET',
      path: actionPollPath(connection.surface, current.id),
      signal: extra.signal,
    });
    const next = readAction(response.data);
    if (next === undefined) break;
    current = next;

    extra.progress?.(current.progress, 100, `${current.command}: ${current.status}`);
  }

  throwIfFailed(current);
  return { action: current, settled: current.status !== 'running' };
}

function throwIfFailed(action: ActionRef): void {
  if (action.status !== 'error') return;
  throw new HetznerError(
    `The ${action.command} action failed: ${action.error?.message ?? 'no reason given'}.`,
    'action_failed',
    'The HTTP call was accepted; the work failed afterwards. Nothing was retried automatically, because a repeat of a partially applied change is rarely what the caller wants.',
    undefined,
    action.error?.code,
  );
}

/** A statement of fact for `meta.hint` when a wait gave up. */
export function unsettledHint(action: ActionRef): string {
  return `The ${action.command} action (id ${action.id}) was still running when this call stopped waiting; it continues on Hetzner's side. get_action reports its current state.`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new HetznerError('Cancelled by the caller.', 'cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new HetznerError('Cancelled by the caller.', 'cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The `wait_seconds` parameter, shared by every tool that can await an Action. */
export function waitProperty(): Record<string, unknown> {
  return {
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_WAIT_MS / 1000)
      .optional()
      .describe(
        `How long to wait for the resulting Action to finish, in seconds. Default ${DEFAULT_WAIT_MS / 1000}. 0 returns as soon as Hetzner accepts the request, and meta.action.awaited reports whether the work actually completed.`,
      ),
  };
}

export function readWaitMs(args: Record<string, unknown>): number {
  const seconds = optionalNumber(args, 'wait_seconds');
  return seconds === undefined ? DEFAULT_WAIT_MS : seconds * 1000;
}
