/**
 * The single HTTP chokepoint.
 *
 * Every code path in the server — promoted tools, generic catalog operations,
 * and any tool written after this file — reaches Hetzner through `request`.
 * That makes this the only place where a safety property can be stated once and
 * hold for the whole system.
 *
 * The threat model is worth naming, because it is what shapes the file. This
 * process holds a credential that can spend money and destroy data, and it acts
 * on a model whose input includes untrusted text returned by the API itself:
 * server names, labels, DNS record values, error strings written by other
 * people's systems. The adversary is prompt injection, and the containment is
 * here rather than in the tool layer, because a tool written next year can
 * forget a check and this cannot be routed around:
 *
 *   1. Destructive gate. The transport computes its own danger verdict and
 *      takes whichever is stricter — a catalog that misfiles a DELETE as a
 *      write cannot unlock anything.
 *   2. Read-only gate. Refuses every non-GET on a read-only connection, and the
 *      server-wide `readOnly` is a ceiling that a connection cannot widen.
 *   3. Origin pinning. The URL is built by concatenation onto the surface's own
 *      base URL, and redirects are never followed — following one would hand
 *      the credential to whatever host the redirect names.
 *   4. Scrubbing. The resolved credential is stripped from response bodies
 *      before they are parsed, so an echoing endpoint cannot feed the secret
 *      back into the model's context.
 *
 * A refused request never resolves the credential, so a blocked call does not
 * even touch the secret store — no keychain prompt, no vault read.
 *
 * Unlike the sibling Coolify product there is no `insecureTLS` and no
 * user-supplied base URL: base URLs are derived from the surface, so there is no
 * configuration path that can move the origin at all. Neither setting should be
 * added back.
 */

import { HetznerError, SURFACE_AUTH } from '../types.js';
import type {
  CatalogOperation,
  Connection,
  ConnectionRegistry,
  DangerClass,
  HetznerRequest,
  HetznerResponse,
  HttpMethod,
  Pagination,
  ResolvedCredential,
} from '../types.js';
import {
  isDefinitePreSendFailure,
  mapHttpError,
  mapNetworkError,
  mapNonJsonBody,
} from './errors.js';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Kept in step with package.json by `test/http-client.test.ts`, which reads the
 * manifest and fails if these drift. Reading it at runtime instead would mean
 * resolving a path out of a bundle that may be executed from anywhere `npx`
 * unpacked it.
 */
export const PACKAGE_NAME = '@donedynamics/hetzner-mcp';
export const PACKAGE_VERSION = '0.1.0';

/**
 * Descriptive on purpose. Hetzner's abuse team reads user agents when a token
 * starts hammering the API, and "node" tells them nothing about who to contact.
 */
export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION} (+https://github.com/devrim-1283/hetzner-mcp)`;

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Total sends, not retries. Three is deliberately low.
 *
 * Hetzner Cloud's quota is 3600 requests/hour shared by every client using the
 * token, and Robot enforces per-endpoint hourly limits as low as 50. A retry
 * loop that is generous to this process is stingy to every other tool the user
 * is running on the same token, so the bound is set where a transient blip is
 * absorbed and a real outage is handed back to the caller quickly.
 */
export const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
/** Ceiling on the sum of all waits, independent of the per-request timeout. */
export const MAX_RETRY_ELAPSED_MS = 15_000;
/** Left on the clock so a retry has time to actually complete before the deadline. */
const RETRY_HEADROOM_MS = 1_000;

/**
 * Methods that may be re-sent after a failure that leaves the outcome unknown.
 *
 * POST is absent, and this is the single most expensive line in the file. A
 * transport failure after the request left the socket does not tell you whether
 * Hetzner acted on it: the machine may already exist, already be billed, and
 * already be running. A retried `POST /servers` provisions and bills a SECOND
 * one, and no amount of downstream cleverness can undo that.
 *
 * So a POST is re-sent only when the request provably never reached Hetzner's
 * application — see `isDefinitePreSendFailure` — or when Hetzner itself said it
 * refused to process the request: a 429, or a 503 that carries `Retry-After`
 * (which is a load shedder declining work, not a handler that crashed halfway).
 * A bare 500/502/504 on a POST is never retried: the request was received, and
 * "it errored" is not "it did nothing".
 *
 * The rest are safe to repeat. Hetzner's PATCH sets absolute field values and
 * its PUT replaces a resource, so both land on the same state twice; a repeated
 * DELETE answers 404 the second time, which costs nothing.
 */
const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'GET',
  'PUT',
  'PATCH',
  'DELETE',
]);

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/**
 * Equal jitter: half the window fixed, half random.
 *
 * Full jitter can produce a near-zero wait, which on a shared quota is the
 * worst possible behaviour — it turns a 429 into an immediate second 429. The
 * fixed half guarantees the bucket gets some time; the random half stops a
 * fleet fan-out from re-converging on the same instant.
 */
function backoffMs(attempt: number): number {
  const window = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.round(window / 2 + Math.random() * (window / 2));
}

// ---------------------------------------------------------------------------
// Transport context
// ---------------------------------------------------------------------------

export interface TransportContext {
  /**
   * The server-wide read-only flag, as a CEILING.
   *
   * It is OR-ed into every connection's own setting, never consulted instead of
   * it: the global switch can close a connection the config file left open, and
   * can never re-open one the config file closed. A ceiling composes safely; an
   * override does not.
   */
  readOnly?: boolean;
  /**
   * Danger class for a catalog operation id.
   *
   * Escalation only. The transport computes its own verdict first and takes
   * whichever is stricter, so a classifier that returns `safe` for a DELETE —
   * because a regenerated catalog misfiled it, or because something later calls
   * this with a hostile function — cannot unlock anything. That property is why
   * an injectable seam is acceptable inside the security chokepoint at all.
   *
   * Left unset, the generated catalog is loaded lazily and used the same way.
   */
  classifyOperation?: (operationId: string) => DangerClass | undefined;
  /**
   * Used for one thing only: naming a writable sibling connection when a
   * read-only connection refuses a write. It has no effect on any gate.
   */
  registry?: ConnectionRegistry;
}

let context: TransportContext = {};

/** Replaces the transport context wholesale. Called once, at server startup. */
export function configureTransport(next: TransportContext): void {
  context = { ...next };
  generatedIndex = undefined;
}

// ---------------------------------------------------------------------------
// Danger classification
// ---------------------------------------------------------------------------

const DANGER_RANK: Record<DangerClass, number> = { safe: 0, write: 1, destructive: 2 };

interface DestructiveOverride {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: RegExp;
}

/**
 * Hand-maintained, and deliberately duplicated from the catalog generator.
 *
 * Neither of these is a DELETE, so "block the DELETEs" misses both, and both are
 * irreversible: rebuild wipes the server's disk and returns 201, and a snapshot
 * rollback overwrites whatever is live on the Storage Box. They are matched on
 * the operation id *and* on method+path, so a caller cannot dodge the gate by
 * omitting the id or by renaming the operation.
 */
const DESTRUCTIVE_OVERRIDES: readonly DestructiveOverride[] = [
  { id: 'rebuild_server', method: 'POST', path: /^\/servers\/[^/]+\/actions\/rebuild$/ },
  {
    id: 'rollback_snapshot_storage_box',
    method: 'POST',
    path: /^\/storage_boxes\/[^/]+\/actions\/rollback_snapshot$/,
  },
];

function matchesDestructiveOverride(req: HetznerRequest): boolean {
  const path = req.path.replace(/\/+$/, '');
  return DESTRUCTIVE_OVERRIDES.some(
    (override) =>
      override.id === req.operationId ||
      (override.method === req.method && override.path.test(path)),
  );
}

/**
 * What the transport can work out on its own, with no catalog and no tool layer.
 * This is the floor: the classification can be raised from here, never lowered.
 */
function baselineDanger(req: HetznerRequest): DangerClass {
  if (matchesDestructiveOverride(req)) return 'destructive';
  if (req.method === 'DELETE') return 'destructive';
  return req.method === 'GET' ? 'safe' : 'write';
}

function isDangerClass(value: unknown): value is DangerClass {
  return value === 'safe' || value === 'write' || value === 'destructive';
}

let generatedIndex: Promise<ReadonlyMap<string, DangerClass>> | undefined;

/**
 * The generated catalog, loaded lazily and defensively.
 *
 * `src/generated` is produced by codegen and owned elsewhere; it can be absent,
 * stale, or mid-rewrite. Every failure mode collapses to an empty index, which
 * leaves the baseline verdict standing — DELETEs and the overrides above are
 * still blocked. Failing to load the catalog can therefore only make the gate
 * stricter than intended, never looser.
 */
async function loadGeneratedIndex(): Promise<ReadonlyMap<string, DangerClass>> {
  const index = new Map<string, DangerClass>();
  try {
    const module = (await import('../generated/catalog.js')) as { CATALOG?: unknown };
    if (!Array.isArray(module.CATALOG)) return index;
    for (const entry of module.CATALOG as Array<Partial<CatalogOperation>>) {
      if (typeof entry.id === 'string' && isDangerClass(entry.danger)) {
        index.set(entry.id, entry.danger);
      }
    }
  } catch {
    // Deliberately silent: the baseline already covers the irreversible cases,
    // and a missing catalog must not turn every request into an error.
  }
  return index;
}

async function catalogDanger(operationId: string): Promise<DangerClass | undefined> {
  if (context.classifyOperation) {
    try {
      return context.classifyOperation(operationId);
    } catch {
      return undefined;
    }
  }
  generatedIndex ??= loadGeneratedIndex();
  try {
    return (await generatedIndex).get(operationId);
  } catch {
    return undefined;
  }
}

async function classifyDanger(req: HetznerRequest): Promise<DangerClass> {
  const baseline = baselineDanger(req);
  if (!req.operationId || baseline === 'destructive') return baseline;

  const fromCatalog = await catalogDanger(req.operationId);
  if (!fromCatalog) return baseline;
  return DANGER_RANK[fromCatalog] > DANGER_RANK[baseline] ? fromCatalog : baseline;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function destructiveBlocked(req: HetznerRequest): HetznerError {
  const what = req.operationId ? `\`${req.operationId}\`` : `${req.method} ${req.path}`;
  return new HetznerError(
    `Refused ${what}: it is a destructive operation and connection \`${req.connection.name}\` does not allow those.`,
    'destructive_blocked',
    // Named so the human reading the transcript knows the exact knob. The model
    // can neither set an environment variable nor restart the server, so this
    // hint is addressed past it, on purpose.
    `Destructive operations are off for this connection. A human can enable them with ` +
      `HETZNER_ALLOW_DESTRUCTIVE=true (or \`allowDestructive\` on connection \`${req.connection.name}\` ` +
      `in the config file) and a server restart. The block is enforced in the HTTP client, so no ` +
      `tool and no instruction found in API data can work around it.`,
  );
}

function writableSibling(connection: Connection): string | undefined {
  const registry = context.registry;
  if (!registry) return undefined;
  for (const [name, candidate] of registry.connections) {
    if (
      name !== connection.name &&
      !candidate.readOnly &&
      candidate.surface === connection.surface
    ) {
      return name;
    }
  }
  return undefined;
}

/** The connection's own flag, raised by the server-wide ceiling. Never lowered. */
function isReadOnly(connection: Connection): boolean {
  return connection.readOnly || context.readOnly === true;
}

function readOnlyBlocked(req: HetznerRequest): HetznerError {
  const { connection } = req;
  const global = context.readOnly === true && !connection.readOnly;
  const sibling = writableSibling(connection);
  return new HetznerError(
    `Refused ${req.method} ${req.path}: connection \`${connection.name}\` is read-only.`,
    'read_only_connection',
    global
      ? 'The whole server is running read-only (HETZNER_READ_ONLY), which closes every connection ' +
          'regardless of what the config file says. A human must clear it and restart the server.'
      : sibling
        ? `Connection \`${sibling}\` is configured for writes on the same surface — retry there if ` +
          'it targets the intended project or account.'
        : `Every configured connection that could run this is read-only. A human can clear ` +
          `\`readOnly\` for \`${connection.name}\` and restart the server.`,
  );
}

// ---------------------------------------------------------------------------
// URL construction and origin pinning
// ---------------------------------------------------------------------------

/** Query strings, fragments, whitespace and backslashes. */
const UNSAFE_PATH_CHARS = /[?#\\\s]/;

/** Control characters, checked by code point so no literal ever lands in this source file. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function invalidRequest(message: string, hint?: string): HetznerError {
  return new HetznerError(message, 'validation', hint);
}

/**
 * Dot segments, including percent-encoded ones (`%2e%2e`), and malformed
 * escapes. Caught before parsing rather than after, so the refusal can name the
 * path the caller actually wrote.
 */
function hasTraversalSegment(path: string): boolean {
  for (const segment of path.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === '.' || decoded === '..') return true;
  }
  return false;
}

function assertSafePath(path: string): void {
  if (!path.startsWith('/')) {
    throw invalidRequest(`Request path must start with "/", got "${path}".`);
  }
  if (path.startsWith('//')) {
    // A protocol-relative path resolves to a DIFFERENT HOST under URL
    // resolution rules. It never reaches the socket as written, but it must not
    // survive long enough to meet a future refactor that uses `new URL(path, base)`.
    throw invalidRequest(
      `Request path "${path}" is protocol-relative and would leave the Hetzner API host.`,
    );
  }
  if (UNSAFE_PATH_CHARS.test(path) || hasControlCharacter(path)) {
    throw invalidRequest(
      `Request path "${path}" contains a query string, fragment or control character.`,
      'Put query parameters in the `query` object instead of the path, and URL-encode path parameters.',
    );
  }
  if (hasTraversalSegment(path)) {
    throw invalidRequest(
      `Request path "${path}" contains a "." or ".." segment.`,
      'Paths are built from catalog templates with the ids substituted in; a traversal segment ' +
        'means an id arrived carrying one, which is never legitimate.',
    );
  }
}

interface PinnedBase {
  origin: string;
  /** Path prefix, already stripped of trailing slashes. Empty for Robot. */
  pathname: string;
}

/**
 * The connection's base URL, split into the two parts the pinning needs.
 *
 * Not user input: `SURFACE_BASE_URLS` derives it from the surface, and the
 * config layer copies it onto the connection. The validation below therefore
 * guards against a programming error, not against a hostile config.
 */
function pinBase(connection: Connection): PinnedBase {
  let base: URL;
  try {
    base = new URL(connection.baseUrl);
  } catch {
    throw new HetznerError(
      `Connection \`${connection.name}\` has an unparseable base URL.`,
      'unknown',
      'Base URLs are derived from the surface and are never configured, so this is a bug in the ' +
        'config layer rather than something to fix in the config file.',
    );
  }
  if (base.protocol !== 'https:') {
    throw new HetznerError(
      `Connection \`${connection.name}\` would send the credential over ${base.protocol}//.`,
      'unknown',
      'Every Hetzner API is HTTPS-only. Anything else means the base URL was overwritten with a ' +
        'value that would expose the token in transit.',
    );
  }
  return { origin: base.origin, pathname: base.pathname.replace(/\/+$/, '') };
}

function buildUrl(base: PinnedBase, req: HetznerRequest): URL {
  assertSafePath(req.path);

  // Built by CONCATENATION onto the pinned origin, never by resolving the path
  // against a base: `new URL(path, base)` lets an absolute-looking path replace
  // the host outright, which is how a credential leaves the building.
  const url = new URL(`${base.origin}${base.pathname}${req.path}`);

  // Redundant by construction. Kept as a tripwire: if this ever fires, someone
  // changed the line above to URL resolution and reopened the exfiltration path.
  if (url.origin !== base.origin) {
    throw invalidRequest(
      `Refused: the request URL left the Hetzner origin pinned to connection \`${req.connection.name}\`.`,
    );
  }
  // Dot segments normalize during parsing, including percent-encoded ones. This
  // catches anything that climbed above the API prefix despite the checks above.
  if (
    base.pathname &&
    url.pathname !== base.pathname &&
    !url.pathname.startsWith(`${base.pathname}/`)
  ) {
    throw invalidRequest(`Refused: request path "${req.path}" escapes ${base.pathname}.`);
  }

  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface Authorization {
  /** The full `Authorization` header value. Never logged, never returned. */
  header: string;
  /** Every literal that must be scrubbed out of anything the server sends back. */
  secrets: readonly string[];
}

function credentialFailure(connection: Connection, detail: string): HetznerError {
  return new HetznerError(
    `Could not resolve the credential for connection \`${connection.name}\`: ${detail}`,
    'unauthenticated',
    'Check the credential source for this connection. `hetzner-mcp doctor` reports which one is ' +
      'configured and whether it resolves, and is the only place that can safely show what the ' +
      'source said — this error deliberately does not quote it, because that text may contain the ' +
      'secret itself.',
  );
}

/** The error's shape, never its text. See the call site for why. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'the credential source failed';
  const code = (error as { code?: unknown }).code;
  const suffix = typeof code === 'string' ? ` (${code})` : '';
  return `the credential source threw ${error.name}${suffix}`;
}

/**
 * The compile-time floor under `authorize`.
 *
 * Reached only if `ResolvedCredential` gains a variant. The `never` parameter
 * makes that a build error at the switch below rather than a runtime surprise
 * on the one code path that touches the secret: a fourth surface resolving to
 * some third shape must fail to compile where the branch has to be written, not
 * type-check against whichever existing branch happens to accept it.
 */
function unsupportedCredential(resolved: never): never {
  const kind = (resolved as { kind?: unknown }).kind;
  throw new HetznerError(
    `Credential kind \`${String(kind)}\` has no transport support.`,
    'unauthenticated',
    'The credential resolved to a shape this client cannot send. Adding a surface means adding ' +
      'its branch to `authorize` in src/http/client.ts.',
  );
}

/**
 * Builds the `Authorization` header for the connection's surface.
 *
 * The auth style comes from `SURFACE_AUTH`, not from the credential: the surface
 * decides how it is proven to, and a credential that resolved to a different
 * shape is a configuration error rather than a negotiation. That mismatch is
 * checked explicitly below — a `basic` credential silently accepted on a bearer
 * surface would send the wrong scheme to the right host, and Hetzner's answer
 * (401) would blame the token rather than the wiring.
 */
async function authorize(connection: Connection): Promise<Authorization> {
  const style = SURFACE_AUTH[connection.surface];

  let resolved: ResolvedCredential;
  try {
    resolved = await connection.credential.resolve();
  } catch (error) {
    // The helper's own message is deliberately NOT quoted.
    //
    // A credential helper fails while holding the secret, and plenty of them
    // put it in the failure text — `vault read failed for hcloud_...`, a shell
    // wrapper echoing its own argv. We cannot scrub a value we never learned,
    // so the only safe move is to report the shape of the failure and leave the
    // text where it was written. `hetzner-mcp doctor` is the place that can
    // surface it safely, because it knows what the secret is.
    throw credentialFailure(connection, describeFailure(error));
  }

  if (resolved.kind !== style) {
    throw credentialFailure(
      connection,
      `surface \`${connection.surface}\` authenticates with ${style}, and the credential resolved to ${resolved.kind}`,
    );
  }

  switch (resolved.kind) {
    case 'bearer': {
      const token = resolved.token.trim();
      if (!token) {
        throw credentialFailure(
          connection,
          `surface \`${connection.surface}\` authenticates with a bearer token and none was produced`,
        );
      }
      return { header: `Bearer ${token}`, secrets: [token] };
    }
    case 'basic': {
      const { user, password } = resolved;
      if (!user || !password) {
        throw credentialFailure(
          connection,
          'surface `robot` authenticates with HTTP Basic and needs both a webservice user and a password',
        );
      }
      const encoded = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
      return { header: `Basic ${encoded}`, secrets: [encoded, password] };
    }
    default:
      return unsupportedCredential(resolved);
  }
}

/**
 * Removes the credential from anything the server sent back.
 *
 * Not paranoia: an endpoint that echoes request headers puts the `Authorization`
 * value verbatim into the response body. Without this it would flow into the
 * model's context, and from there into every error message and every transcript
 * for the rest of the session.
 */
function scrub(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    // Short values would match innocent substrings and turn a readable body into
    // asterisks; a real Hetzner token is 64 characters.
    if (secret.length < 12) continue;
    if (scrubbed.includes(secret)) scrubbed = scrubbed.replaceAll(secret, '***');
  }
  return scrubbed;
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

interface RequestBody {
  content: string;
  contentType: string;
}

function isEmptyBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (Array.isArray(body)) return body.length === 0;
  return typeof body === 'object' && Object.keys(body).length === 0;
}

/**
 * Robot predates the Cloud API and speaks form encoding, not JSON.
 *
 * It ANSWERS JSON, which is what makes this easy to get wrong: a JSON request
 * body is accepted by the socket and rejected by the handler with an error that
 * reads like a validation problem. Arrays repeat under `key[]`, which is how
 * Robot's own documented examples send multiple authorized keys.
 *
 * UNVERIFIED against the live API: the scalar case is documented (Robot's own
 * examples curl with `-d "type=Hetzner"`), the `key[]=` array spelling is
 * inferred from its `authorized_key` examples. Confirmed by POSTing a rescue
 * activation with two keys and checking both arrive. If the real spelling is a
 * repeated bare `key=`, only multi-value parameters are affected.
 */
function encodeForm(body: unknown): string {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) params.append(`${key}[]`, String(entry));
      continue;
    }
    params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return params.toString();
}

function buildBody(req: HetznerRequest): RequestBody | undefined {
  // fetch throws on a GET with a body.
  if (req.method === 'GET' || isEmptyBody(req.body)) return undefined;

  if (req.connection.surface === 'robot') {
    return { content: encodeForm(req.body), contentType: 'application/x-www-form-urlencoded' };
  }

  let content: string | undefined;
  try {
    content = JSON.stringify(req.body);
  } catch {
    content = undefined;
  }
  if (content === undefined) {
    throw invalidRequest(
      'The request body could not be serialized as JSON.',
      'Pass a plain JSON object; circular references and non-JSON values cannot be sent.',
    );
  }
  return { content, contentType: 'application/json' };
}

// ---------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------

function finiteNumber(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** Anything after this many epoch seconds is a timestamp, not a delta. 2001-09-09. */
const EPOCH_THRESHOLD = 1_000_000_000;

/**
 * `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`.
 *
 * Optional on purpose: Cloud sends all three, and the account API is
 * inconsistent. `limit` and `remaining` are reported together or not at all,
 * because "remaining: 12" without a denominator invites the reader to guess the
 * wrong quota.
 *
 * UNVERIFIED: that Robot sends none of these is an assumption — its docs
 * describe per-endpoint hourly limits without naming any header. Confirmed by
 * reading the response headers off any successful Robot call. Nothing breaks if
 * it does send them; they would simply start being reported.
 *
 * Hetzner documents `RateLimit-Reset` as a unix timestamp, while the IETF draft
 * the header name comes from specifies delta-seconds. Both spellings are
 * accepted and normalized to epoch seconds; the threshold makes them
 * unambiguous, since no plausible delta is thirty years long.
 */
function parseRateLimit(headers: Headers): HetznerResponse['rateLimit'] {
  const limit = finiteNumber(headers.get('ratelimit-limit'));
  const remaining = finiteNumber(headers.get('ratelimit-remaining'));
  if (limit === undefined || remaining === undefined) return undefined;

  const reset = finiteNumber(headers.get('ratelimit-reset'));
  if (reset === undefined) return { limit, remaining };
  const resetAt = reset >= EPOCH_THRESHOLD ? reset : Math.round(Date.now() / 1000 + reset);
  return { limit, remaining, resetAt };
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both are legal. */
function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;

  const seconds = finiteNumber(raw);
  if (seconds !== undefined) return Math.max(0, seconds * 1000);

  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * `meta.pagination` from Cloud and the account API.
 *
 * Reported, never acted on. The shaping layer owns the token budget and drives
 * paging through cursors, so a client that helpfully fetched page 2 would be
 * spending a budget it cannot see — and burning the shared rate limit to do it.
 *
 * `next_page` and `previous_page` are dropped rather than carried: `page` plus
 * `last_page` reconstructs both, and the contract has nowhere to put them.
 */
function extractPagination(data: unknown): Pagination | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const meta = (data as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const raw = (meta as { pagination?: unknown }).pagination;
  if (typeof raw !== 'object' || raw === null) return undefined;

  const source = raw as Record<string, unknown>;
  const page = typeof source['page'] === 'number' ? source['page'] : undefined;
  const perPage = typeof source['per_page'] === 'number' ? source['per_page'] : undefined;
  if (page === undefined || perPage === undefined) return undefined;

  const pagination: Pagination = { page, perPage };
  if (typeof source['total_entries'] === 'number')
    pagination.totalEntries = source['total_entries'];
  if (typeof source['last_page'] === 'number') pagination.lastPage = source['last_page'];
  return pagination;
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

function redirectRefused(location: string | null, url: URL, connection: Connection): HetznerError {
  let target: URL | undefined;
  if (location) {
    try {
      target = new URL(location, url);
    } catch {
      target = undefined;
    }
  }

  const where = target
    ? target.hostname === url.hostname
      ? `to ${target.origin}${target.pathname}`
      : `to ${target.hostname}`
    : 'to an unparseable location';

  return new HetznerError(
    `Refused to follow a redirect from ${url.origin} ${where}.`,
    'network',
    // The credential was sent to the pinned Hetzner origin, which is correct.
    // Following the redirect is what would hand it to the next host, so the
    // transport never does — under any circumstances, same host or not.
    `The credential was NOT sent to the redirect target. Hetzner's APIs do not redirect, so ` +
      `something on the network path answered instead of them — a captive portal or an ` +
      `intercepting proxy in front of connection \`${connection.name}\`.`,
  );
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

interface Attempt {
  status: number;
  headers: Headers;
  /** Already scrubbed of the credential. */
  text: string;
}

interface SendContext {
  req: HetznerRequest;
  url: URL;
  secrets: readonly string[];
  timeoutMs: number;
  timeoutSignal: AbortSignal;
  signal: AbortSignal;
  /** Wall-clock instant past which nothing may be retried. */
  deadline: number;
  waited: number;
  attempts: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Clamps a proposed wait to every budget at once, or refuses it.
 *
 * The per-request `timeoutMs` is a hard boundary that includes the waiting: a
 * retry scheduled past it would be aborted mid-flight, which is a worse outcome
 * than reporting the failure now. A `Retry-After` of an hour lands here and is
 * declined, which is exactly right — that wait belongs to the caller's next
 * turn, not to a socket held open inside this one.
 */
function affordableWait(proposed: number, ctx: SendContext): number | undefined {
  const remainingTotal = MAX_RETRY_ELAPSED_MS - ctx.waited;
  const remainingDeadline = ctx.deadline - Date.now() - RETRY_HEADROOM_MS;
  const budget = Math.min(remainingTotal, remainingDeadline);
  return proposed <= budget && budget > 0 ? proposed : undefined;
}

/** The wait before re-sending after a response, or undefined to stop. */
function retryWaitForResponse(attempt: Attempt, ctx: SendContext): number | undefined {
  if (ctx.attempts >= MAX_ATTEMPTS) return undefined;
  if (!RETRYABLE_STATUSES.has(attempt.status)) return undefined;

  const retryAfter = retryAfterMs(attempt.headers);

  if (!IDEMPOTENT_METHODS.has(ctx.req.method)) {
    // See IDEMPOTENT_METHODS. A POST is re-sent only where Hetzner told us it
    // declined the work, never on a generic 5xx.
    if (attempt.status === 429) return affordableWait(retryAfter ?? backoffMs(ctx.attempts), ctx);
    if (attempt.status === 503 && retryAfter !== undefined) return affordableWait(retryAfter, ctx);
    return undefined;
  }

  return affordableWait(retryAfter ?? backoffMs(ctx.attempts), ctx);
}

/** The wait before re-sending after a transport failure, or undefined to stop. */
function retryWaitForFailure(error: unknown, ctx: SendContext): number | undefined {
  // A deadline or a cancelled tool call is a decision, not a blip.
  if (ctx.signal.aborted) return undefined;
  if (ctx.attempts >= MAX_ATTEMPTS) return undefined;
  if (!IDEMPOTENT_METHODS.has(ctx.req.method) && !isDefinitePreSendFailure(error)) return undefined;
  return affordableWait(backoffMs(ctx.attempts), ctx);
}

async function send(init: RequestInit, ctx: SendContext): Promise<Attempt> {
  ctx.attempts += 1;
  const response = await fetch(ctx.url, init);

  // Always drained, including on 3xx and 4xx, so the socket is released even on
  // the paths that end in a throw.
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text: scrub(text, ctx.secrets),
  };
}

function toTransportError(error: unknown, ctx: SendContext): HetznerError {
  if (error instanceof HetznerError) return error;
  return mapNetworkError(error, {
    connection: ctx.req.connection.name,
    origin: ctx.url.origin,
    timeoutMs: ctx.timeoutMs,
    // Caller cancellation is checked first: when both fired, the caller's intent
    // is the more useful thing to report.
    cancelled: ctx.req.signal?.aborted === true,
    timedOut: ctx.req.signal?.aborted !== true && ctx.timeoutSignal.aborted,
    attempts: ctx.attempts,
  });
}

function parseData<T>(attempt: Attempt, ctx: SendContext): T {
  if (attempt.status === 204 || !attempt.text.trim()) return null as T;

  const contentType = attempt.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw mapNonJsonBody({
      status: attempt.status,
      contentType,
      text: attempt.text,
      origin: ctx.url.origin,
      connection: ctx.req.connection.name,
      surface: ctx.req.connection.surface,
    });
  }
  try {
    return JSON.parse(attempt.text) as T;
  } catch {
    throw mapNonJsonBody({
      status: attempt.status,
      contentType,
      text: attempt.text,
      origin: ctx.url.origin,
      connection: ctx.req.connection.name,
      surface: ctx.req.connection.surface,
    });
  }
}

/** Error bodies go to the mapper as JSON when they parse, as text when they do not. */
function errorBody(attempt: Attempt): unknown {
  try {
    return JSON.parse(attempt.text) as unknown;
  } catch {
    return attempt.text;
  }
}

export async function request<T = unknown>(req: HetznerRequest): Promise<HetznerResponse<T>> {
  const { connection } = req;

  // Gate 1 — destructive. Before anything else, including the URL.
  if ((await classifyDanger(req)) === 'destructive' && !connection.allowDestructive) {
    throw destructiveBlocked(req);
  }

  // Gate 2 — read-only. A refusal here is actionable (another connection may be
  // writable), which is why it lives at call time rather than at registration.
  if (isReadOnly(connection) && req.method !== 'GET') {
    throw readOnlyBlocked(req);
  }

  // Gate 3 — origin pinning.
  const base = pinBase(connection);
  const url = buildUrl(base, req);
  const body = buildBody(req);

  const timeoutMs =
    Number.isFinite(connection.timeoutMs) && connection.timeoutMs > 0
      ? connection.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  // One deadline for the whole call, not one per attempt: `timeoutMs` is what
  // the caller was promised, and retry waits are spent out of it.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;

  // Only now is the secret worth resolving. Every refusal above returns without
  // touching the secret store, so a blocked call cannot trigger a keychain
  // prompt, a vault read, or a credential-helper subprocess.
  const authorization = await authorize(connection);

  const headers: Record<string, string> = {
    authorization: authorization.header,
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
  if (body) headers['content-type'] = body.contentType;

  const init: RequestInit = {
    method: req.method,
    headers,
    // Never `follow`: a redirect would carry the Authorization header to the
    // target host. Every 3xx is inspected and refused instead.
    redirect: 'manual',
    signal,
    ...(body ? { body: body.content } : {}),
  };

  const ctx: SendContext = {
    req,
    url,
    secrets: authorization.secrets,
    timeoutMs,
    timeoutSignal,
    signal,
    deadline: Date.now() + timeoutMs,
    waited: 0,
    attempts: 0,
  };

  let attempt: Attempt;
  for (;;) {
    try {
      attempt = await send(init, ctx);
    } catch (error) {
      const wait = retryWaitForFailure(error, ctx);
      if (wait === undefined) throw toTransportError(error, ctx);
      ctx.waited += wait;
      try {
        await sleep(wait, ctx.signal);
      } catch (interrupted) {
        throw toTransportError(interrupted, ctx);
      }
      continue;
    }

    const wait = retryWaitForResponse(attempt, ctx);
    if (wait === undefined) break;
    ctx.waited += wait;
    try {
      await sleep(wait, ctx.signal);
    } catch (interrupted) {
      throw toTransportError(interrupted, ctx);
    }
  }

  if (attempt.status >= 300 && attempt.status < 400) {
    throw redirectRefused(attempt.headers.get('location'), url, connection);
  }

  const rateLimit = parseRateLimit(attempt.headers);

  if (attempt.status >= 400) {
    throw mapHttpError({
      status: attempt.status,
      body: errorBody(attempt),
      method: req.method,
      path: req.path,
      connection: connection.name,
      surface: connection.surface,
      retryAfterSeconds: retryAfterSecondsOf(attempt),
      rateLimit,
      attempts: ctx.attempts,
    });
  }

  const data = parseData<T>(attempt, ctx);
  const response: HetznerResponse<T> = { status: attempt.status, data };
  if (rateLimit) response.rateLimit = rateLimit;
  const pagination = extractPagination(data);
  if (pagination) response.pagination = pagination;
  return response;
}

function retryAfterSecondsOf(attempt: Attempt): number | undefined {
  const ms = retryAfterMs(attempt.headers);
  return ms === undefined ? undefined : Math.ceil(ms / 1000);
}

/**
 * Named after the product, for call sites that read better with the noun.
 * Same function; there is exactly one entry point.
 */
export { request as hetznerRequest };
