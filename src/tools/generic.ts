/**
 * The five generic catalog tools — the door to the 221 operations that do not
 * get a dedicated tool of their own.
 *
 * WHY A CATALOG AND NOT 221 TOOLS
 * Every tool schema is tokens spent on EVERY turn, whether the tool is called or
 * not. Two hundred and twenty-one of them would cost more context than the
 * conversation they were meant to serve. Three execute doors plus a searchable
 * catalog buys the whole API for a fixed price, and the price is one extra round
 * trip: search_operations -> describe_operation -> execute_*.
 *
 * THREE EXECUTE DOORS, NOT ONE
 * Anthropic's tool-design review criteria reject a single tool that accepts both
 * GET and DELETE, and documenting "some of these are safe" inside one
 * description does not satisfy the rule. A `method` parameter satisfies it even
 * less — it would make the danger class an argument the model chooses. So the
 * danger class picks the tool, and each tool's annotations are true of
 * everything that tool can run.
 *
 * THE DISPATCH GUARD IS LAYER 2 OF 3
 * Every execute_* handler re-checks that the operation's danger class matches
 * the door it arrived through. That looks redundant — the tool boundary already
 * says which class it serves — but the classification is GENERATED from
 * Hetzner's OpenAPI specs, and a regeneration can misfile a POST that wipes a
 * disk. A security property that holds only because a code generator got it
 * right is not a security property. Layer 1 is `register.ts`, which decides what
 * exists; layer 3 is `http/client.ts`, which computes its own verdict at the
 * socket and takes the stricter of the two, so a catalog that says `safe` for a
 * DELETE unlocks nothing.
 *
 * `execute_destructive_operation` is exported here like the other four. Whether
 * it is REGISTERED is `register.ts`'s decision, and the right answer when
 * destructive operations are off is to leave it out of tools/list entirely
 * rather than list a tool that always refuses: a refusing tool costs schema
 * tokens on every turn, invites a call/refusal/rephrase loop against a wall that
 * only a human with an environment variable can move, and puts a
 * `destructiveHint: true` entry in a server that cannot destroy anything. This
 * module therefore has no "always refuses" mode.
 *
 * THE SURFACE IS A FIRST-CLASS ERROR
 * Hetzner is several APIs on different hosts with different credentials. An
 * operation on the `cloud` surface run against a `hetzner` connection is a
 * mistake the model will make, and the refusal names both surfaces and lists the
 * connections that serve the right one — which turns it into a one-turn fix
 * instead of a guessing game.
 *
 * BODY VALIDATION IS DELIBERATELY PERMISSIVE
 * `body` is a bare record. Path parameters are validated strictly — they are
 * read off the URL template, so the catalog cannot be wrong about them — and
 * query parameter names are checked, but nothing about the body is. Hetzner's
 * own validator is the authority: it returns `error.details.fields` naming each
 * offending field, the transport passes it through verbatim, and a rejected call
 * becomes a one-turn self-correction. Pre-validating against a pruned copy of a
 * spec would instead reject VALID calls with no override.
 */

import { z } from 'zod';

import {
  METADATA,
  getOperation,
  getPricingCategory,
  getSchema,
  listFamilies,
  listSurfaces,
  searchOperations,
} from '../catalog/index.js';
import type { ParamSchema } from '../catalog/index.js';
import { request } from '../http/client.js';
import {
  applySkip,
  firstPage,
  nextPageCursor,
  resumeCursor,
  toQuery,
  type CursorState,
} from '../shaping/cursor.js';
import { HetznerError, SURFACE_LABELS } from '../types.js';
import type {
  CatalogOperation,
  Connection,
  DangerClass,
  HetznerResponse,
  HttpMethod,
  OperationFamily,
  ServerConfig,
  Surface,
  ToolDef,
  ToolExtra,
  ToolResult,
} from '../types.js';
import {
  CONNECTIONS_ARE_OPERATOR_OWNED,
  DESTRUCTIVE_ENABLEMENT,
  assertDanger,
  availableDangerClasses,
  awaitAction,
  connectionProperty,
  noActionHint,
  optionalNumber,
  optionalString,
  readAction,
  readWaitMs,
  renderEnvelope,
  requiredString,
  resolveConnection,
  runTool,
  shapeResponse,
  toRecord,
  unsettledHint,
  waitProperty,
  type EnvelopeMeta,
} from './shared.js';

/**
 * Cited in every description below: Directory review requires a tool that
 * accepts freeform API operations to point at the API's own documentation.
 */
const DOCS_URL = 'https://docs.hetzner.cloud';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const MAX_NEAR_MATCHES = 3;
/** Below this the remaining allowance is worth stating; above it, it is noise on every call. */
const LOW_RATE_LIMIT_REMAINING = 10;

/**
 * Stated wherever a costly operation appears, and phrased as a consequence
 * rather than a warning.
 *
 * Costly operations are NOT gated in this product — the brief keeps everything
 * non-destructive open — so search results and the response are the only places
 * the consequence is ever visible before it reaches an invoice.
 */
const BILLING_NOTE =
  'Operations marked `costly` open a bill: Hetzner charges for what they create from the moment ' +
  'the call succeeds, and this server does not gate them.';

// ---------------------------------------------------------------------------
// Parameter descriptions
//
// Kept together rather than inline so the whole model-facing vocabulary of this
// module can be reviewed on one screen. Every one states what the parameter is
// or what it returns; none tells the model when to call anything, because a
// directive embedded in a tool schema reads as prompt injection.
// ---------------------------------------------------------------------------

const SEARCH_QUERY_DESCRIPTION =
  'Free text matched against operation id, path and summary — e.g. "create server", ' +
  '"dns record", "storage box snapshot", "firewall".';

const SEARCH_LIMIT_DESCRIPTION = `Maximum rows to return. Default ${DEFAULT_SEARCH_LIMIT}, maximum ${MAX_SEARCH_LIMIT}.`;

const DESCRIBE_ID_DESCRIPTION =
  'Catalog operation id, as returned by search_operations — e.g. "create_server", "get_zone_rrset".';

const PATH_PARAMS_DESCRIPTION =
  'Values for the {placeholders} in the operation path, keyed by name — e.g. {"id": 42} for ' +
  '/servers/{id}, or {"id_or_name": "example.com", "rr_name": "www", "rr_type": "A"} for an RRSet. ' +
  'Every placeholder the operation declares must be present. Values are URL-encoded into a single ' +
  'path segment; a value carrying "/", "?", "#" or a "." or ".." segment is refused.';

const QUERY_DESCRIPTION =
  "Query string parameters, keyed by name — Hetzner's filters live here: `label_selector` " +
  '("env=prod"), `sort` ("name:asc"), `status`, `name`. Names are checked against the catalog; ' +
  'values are passed through as single scalars, so a parameter Hetzner allows to repeat takes one ' +
  'value here. Paging parameters are not accepted: `cursor` carries them.';

const BODY_DESCRIPTION =
  'JSON request body, passed to Hetzner unchanged. Hetzner validates it and names each offending ' +
  'field in the error, which comes back verbatim. describe_operation returns the body schema.';

const CURSOR_DESCRIPTION =
  'Opaque pagination token, exactly as returned in meta.next_cursor by a previous call to this ' +
  'operation. It carries the page, the page size and the filters of that call, so `query` is not ' +
  'repeated alongside it. Omitting it starts at the first page.';

// ---------------------------------------------------------------------------
// Enumerated filter values
//
// Derived from the shipped catalog rather than from the `OperationFamily` and
// `Surface` unions in types.ts. Those unions name everything the product will
// ever cover, including the Robot families no spec has been vendored for yet,
// and offering a filter value that resolves to zero rows spends a turn to learn
// nothing.
// ---------------------------------------------------------------------------

const FAMILY_VALUES = listFamilies().map((row) => row.family) as [
  OperationFamily,
  ...OperationFamily[],
];

const SURFACE_VALUES = listSurfaces().map((row) => row.surface) as [Surface, ...Surface[]];

const DANGER_VALUES: [DangerClass, ...DangerClass[]] = ['safe', 'write', 'destructive'];

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

interface Door {
  tool: string;
  danger: DangerClass;
  /**
   * Methods this door will actually dispatch. Checked alongside the danger
   * class because the two are generated independently: a POST arriving
   * classified `safe` would otherwise run through a tool annotated
   * `readOnlyHint: true`, which is a lie told to the host's permission model.
   */
  methods: readonly HttpMethod[];
}

const READ_DOOR: Door = { tool: 'execute_read_operation', danger: 'safe', methods: ['GET'] };

const WRITE_DOOR: Door = {
  tool: 'execute_write_operation',
  danger: 'write',
  methods: ['POST', 'PUT', 'PATCH'],
};

/**
 * POST as well as DELETE. `POST /servers/{id}/actions/rebuild` wipes the disk
 * and answers 201, and `POST /storage_boxes/{id}/actions/rollback_snapshot`
 * overwrites live data — neither is a DELETE and both are irreversible.
 */
const DESTRUCTIVE_DOOR: Door = {
  tool: 'execute_destructive_operation',
  danger: 'destructive',
  methods: ['DELETE', 'POST'],
};

const DOORS: readonly Door[] = [READ_DOOR, WRITE_DOOR, DESTRUCTIVE_DOOR];

function doorFor(danger: DangerClass): Door | undefined {
  return DOORS.find((door) => door.danger === danger);
}

/** How an operation's own class is named in a refusal. */
const DANGER_PHRASE: Record<DangerClass, string> = {
  safe: 'a read-only operation',
  write: 'a write operation',
  destructive: 'a destructive operation',
};

// ---------------------------------------------------------------------------
// What this server can run
// ---------------------------------------------------------------------------

function catalogProvenance(): string {
  const specs = METADATA.specs
    .map((spec) => `${spec.surface} ${spec.version} (${spec.operationCount})`)
    .join(', ');
  return (
    `Catalog: ${METADATA.operationCount} operations from ${specs}, ` +
    `generated ${METADATA.generatedAt.slice(0, 10)}.`
  );
}

function unknownOperation(id: string): HetznerError {
  const near = searchOperations({ query: id, limit: MAX_NEAR_MATCHES }).map((row) => row.id);
  return new HetznerError(
    `No operation with id "${id}" is in this catalog.`,
    'validation',
    near.length > 0
      ? `Closest ids: ${near.join(', ')}. search_operations lists every operation this server can run. ${catalogProvenance()}`
      : `search_operations lists every operation this server can run. ${catalogProvenance()}`,
  );
}

function unavailableClass(cfg: ServerConfig, operation: CatalogOperation): HetznerError {
  if (cfg.readOnly) {
    return new HetznerError(
      `Operation \`${operation.id}\` is ${DANGER_PHRASE[operation.danger]} and this server is running read-only.`,
      'read_only_connection',
      'HETZNER_READ_ONLY closes every write and destructive operation on every connection. A human ' +
        'can clear it and restart the server; the model cannot.',
    );
  }
  return new HetznerError(
    `Operation \`${operation.id}\` is ${DANGER_PHRASE[operation.danger]} and destructive operations are off for this server.`,
    'destructive_blocked',
    `While they are off, execute_destructive_operation is not registered at all. ${DESTRUCTIVE_ENABLEMENT}`,
  );
}

/**
 * The operation id resolved against the catalog, before anything else happens.
 *
 * This is the only way an operation enters this module. There is no parameter
 * anywhere in these five tools that accepts a raw method or path, so every
 * request that leaves here was described by the shipped catalog.
 */
function mustFindOperation(cfg: ServerConfig, id: string): CatalogOperation {
  const operation = getOperation(id);
  if (operation === undefined) throw unknownOperation(id);
  if (!availableDangerClasses(cfg).includes(operation.danger))
    throw unavailableClass(cfg, operation);
  return operation;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Layer 2 of the three-layer gate. See the file header: the door an operation
 * arrived through is evidence of the caller's intent, never proof of the
 * operation's class.
 *
 * The danger half is `assertDanger` from the seam, which re-reads the
 * classification from the catalog and owns the one sentence that names where the
 * operation does live. The METHOD half stays here, because it is a check the
 * seam does not make: the class and the verb are generated independently, so a
 * POST arriving classified `safe` would otherwise run through a tool annotated
 * `readOnlyHint: true` — a lie told to the host's permission model.
 */
function guardDoor(operation: CatalogOperation, door: Door, destructiveEnabled: boolean): void {
  assertDanger(operation.id, [door.danger], door.tool, destructiveEnabled);
  if (door.methods.includes(operation.method)) return;

  // Class matches but the verb does not: the generated catalog contradicts
  // itself. Refusing beats guessing which half is right.
  throw new HetznerError(
    `Operation \`${operation.id}\` is classified ${operation.danger} but uses HTTP ${operation.method}, which ${door.tool} does not run.`,
    'validation',
    'This is an inconsistency in the generated catalog; please report it against hetzner-mcp.',
  );
}

function connectionsOn(cfg: ServerConfig, surface: Surface): string[] {
  return [...cfg.registry.connections.values()]
    .filter((connection) => connection.surface === surface)
    .map((connection) => connection.name);
}

/**
 * The surface gate.
 *
 * Hetzner Cloud tokens are scoped to one project on api.hetzner.cloud; the
 * account API is a different host with a different token; Robot is a different
 * host with HTTP Basic and physical machines. Running a cloud operation against
 * an account connection would send the wrong credential to the wrong host and
 * come back as a 401 or a 404 that blames the resource — so it is refused here,
 * with both surfaces and the usable connections named.
 */
function guardSurface(
  operation: CatalogOperation,
  connection: Connection,
  cfg: ServerConfig,
): void {
  if (operation.surface === connection.surface) return;

  const candidates = connectionsOn(cfg, operation.surface);
  throw new HetznerError(
    `Operation \`${operation.id}\` belongs to the \`${operation.surface}\` surface ` +
      `(${SURFACE_LABELS[operation.surface]}), and connection \`${connection.name}\` is on the ` +
      `\`${connection.surface}\` surface (${SURFACE_LABELS[connection.surface]}).`,
    'surface_mismatch',
    candidates.length > 0
      ? `Connections on \`${operation.surface}\`: ${candidates.join(', ')}.`
      : `No configured connection is on \`${operation.surface}\`. ${CONNECTIONS_ARE_OPERATOR_OWNED}`,
  );
}

// ---------------------------------------------------------------------------
// Path parameters
//
// Substitution is the one place a caller-supplied string reaches the URL, so it
// is treated as the security-sensitive step it is. The transport validates the
// finished path as well (layer 3), but a refusal that names the parameter beats
// a generic "this path contains a fragment" from three layers down.
// ---------------------------------------------------------------------------

/** A query string, a fragment, a path separator, a backslash or whitespace. */
const UNSAFE_PARAM_CHARS = /[/?#\\\s]/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function rejectValue(operation: CatalogOperation, name: string, reason: string): HetznerError {
  return new HetznerError(
    `Path parameter \`${name}\` of \`${operation.id}\` ${reason}.`,
    'validation',
    `Each value fills exactly one segment of ${operation.path} and is URL-encoded into it, so it ` +
      'cannot contain a separator, a query string, a fragment or a relative segment.',
  );
}

/**
 * One path parameter value, checked and encoded.
 *
 * Both the raw value and its decoded form are checked. Checking only the raw
 * form would let `%2e%2e` through to be normalized into `..` by URL parsing;
 * checking only the decoded form would let a value that is already encoded
 * arrive double-encoded and address a different resource than the caller meant.
 * Anything ambiguous is refused rather than repaired.
 */
function encodePathValue(operation: CatalogOperation, name: string, raw: string): string {
  const value = raw.trim();
  if (value === '') throw rejectValue(operation, name, 'is empty');
  if (UNSAFE_PARAM_CHARS.test(value) || hasControlCharacter(value)) {
    throw rejectValue(
      operation,
      name,
      'contains a separator, a query string or a control character',
    );
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw rejectValue(operation, name, 'contains a malformed percent-escape');
  }
  if (UNSAFE_PARAM_CHARS.test(decoded) || hasControlCharacter(decoded)) {
    throw rejectValue(
      operation,
      name,
      'decodes to a value carrying a separator, a query string or a control character',
    );
  }
  if (decoded === '.' || decoded === '..' || value === '.' || value === '..') {
    throw rejectValue(operation, name, 'is a relative path segment');
  }

  return encodeURIComponent(value);
}

/**
 * Substitutes `{placeholders}` in the operation's path template.
 *
 * Driven by `operation.pathParams`, which is read off the URL template itself —
 * so an implementation that assumed a single `{id}` would break the 25 Zone and
 * RRSet routes, which take `{id_or_name}` and, for an RRSet, three parameters.
 */
function buildPath(operation: CatalogOperation, raw: Record<string, unknown> | undefined): string {
  const provided = new Map<string, string>();
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined || value === null) continue;
    provided.set(key, String(value));
  }

  const unexpected = [...provided.keys()].filter((key) => !operation.pathParams.includes(key));
  if (unexpected.length > 0) {
    throw new HetznerError(
      `\`${operation.id}\` has no path parameter ${quoteList(unexpected)}.`,
      'validation',
      `Its path is ${operation.path}, so it takes ${describeNames(operation.pathParams)}.`,
    );
  }

  let path = operation.path;
  for (const name of operation.pathParams) {
    const value = provided.get(name);
    if (value === undefined || value.trim() === '') {
      throw new HetznerError(
        `\`${operation.id}\` needs path parameter \`${name}\`.`,
        'validation',
        `Its path is ${operation.path}; \`path_params\` must carry ${describeNames(operation.pathParams)}.`,
      );
    }
    path = path.split(`{${name}}`).join(encodePathValue(operation, name, value));
  }

  // Tripwire: a leftover placeholder means the template carries a segment the
  // generated `pathParams` list does not name. Sending `{id}` literally would
  // produce an unreadable 404, so refuse and name the real problem.
  if (/[{}]/.test(path)) {
    throw new HetznerError(
      `The path template for \`${operation.id}\` has a placeholder the catalog does not list (${operation.path}).`,
      'validation',
      'This is an inconsistency in the generated catalog; please report it against hetzner-mcp.',
    );
  }
  return path;
}

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

type QueryValue = string | number | boolean;

const PAGING_PARAMS: readonly string[] = ['page', 'per_page'];

/**
 * Names are checked against the catalog; values are not.
 *
 * A wrong name is silently ignored by Hetzner and the caller never learns why
 * the filter did nothing, which is worth a refusal. A wrong VALUE is something
 * Hetzner reports far better than a pruned copy of its spec could.
 */
function buildQuery(
  operation: CatalogOperation,
  raw: Record<string, unknown> | undefined,
): Record<string, QueryValue> {
  const entries = Object.entries(raw ?? {}).filter(
    ([, value]) => value !== undefined && value !== null,
  );
  if (entries.length === 0) return {};

  const paging = entries.map(([key]) => key).filter((key) => PAGING_PARAMS.includes(key));
  if (paging.length > 0 && operation.paginated === true) {
    throw new HetznerError(
      `\`${operation.id}\` is paginated, so ${quoteList(paging)} is not accepted in \`query\`.`,
      'validation',
      'Paging is carried by `cursor`: the first call omits it, and meta.next_cursor of that ' +
        'response is the value that fetches the next page.',
    );
  }

  const unexpected = entries
    .map(([key]) => key)
    .filter((key) => !operation.queryParams.includes(key));
  if (unexpected.length > 0) {
    throw new HetznerError(
      `\`${operation.id}\` has no query parameter ${quoteList(unexpected)}.`,
      'validation',
      `It accepts ${describeNames(visibleQueryParams(operation))}. describe_operation returns each ` +
        'one with its type and its accepted values.',
    );
  }

  const query: Record<string, QueryValue> = {};
  for (const [key, value] of entries) {
    query[key] =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : String(value);
  }
  return query;
}

/** Query parameters a caller may actually pass: paging is the cursor's business. */
function visibleQueryParams(operation: CatalogOperation): string[] {
  return operation.paginated === true
    ? operation.queryParams.filter((name) => !PAGING_PARAMS.includes(name))
    : [...operation.queryParams];
}

// ---------------------------------------------------------------------------
// search_operations
// ---------------------------------------------------------------------------

interface SearchRow {
  id: string;
  surface: Surface;
  method: HttpMethod;
  path: string;
  summary: string;
  family: OperationFamily;
  danger: DangerClass;
  /** Present only when true, so a row costs nothing to say "no". */
  costly?: true;
  returns_action?: true;
  paginated?: true;
}

function toSearchRow(operation: CatalogOperation): SearchRow {
  const row: SearchRow = {
    id: operation.id,
    surface: operation.surface,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    family: operation.family,
    danger: operation.danger,
  };
  if (operation.costly === true) row.costly = true;
  if (operation.returnsAction === true) row.returns_action = true;
  if (operation.paginated === true) row.paginated = true;
  return row;
}

function requestedDanger(args: Record<string, unknown>, cfg: ServerConfig): DangerClass[] {
  const available = availableDangerClasses(cfg);
  const requested = optionalString(args, 'danger');
  if (requested === undefined) return available;
  return available.filter((danger) => danger === requested);
}

function searchHandler(args: Record<string, unknown>, cfg: ServerConfig): ToolResult {
  const limit = optionalNumber(args, 'limit') ?? DEFAULT_SEARCH_LIMIT;
  const danger = requestedDanger(args, cfg);

  const rows =
    danger.length === 0
      ? []
      : searchOperations({
          query: optionalString(args, 'query'),
          surface: optionalString(args, 'surface') as Surface | undefined,
          family: optionalString(args, 'family') as OperationFamily | undefined,
          danger,
          limit,
        }).map(toSearchRow);

  const notes: string[] = [];
  if (rows.length === 0) {
    notes.push(`No operations matched. ${catalogProvenance()}`);
    const requested = optionalString(args, 'danger');
    if (
      requested !== undefined &&
      !availableDangerClasses(cfg).includes(requested as DangerClass)
    ) {
      notes.push(
        cfg.readOnly
          ? 'This server is running read-only, so only `safe` operations have a door.'
          : 'Destructive operations are off for this server, so none are listed.',
      );
    }
  } else {
    notes.push(
      'Each row names its danger class: `safe` runs through execute_read_operation, `write` ' +
        'through execute_write_operation, `destructive` through execute_destructive_operation. ' +
        'describe_operation returns the full parameter and body schema for one id.',
    );
    if (rows.some((row) => row.costly === true)) notes.push(BILLING_NOTE);
    if (rows.length >= limit) {
      notes.push(`The result was cut at limit ${limit}; more operations may match.`);
    }
  }

  return renderEnvelope(
    shapeResponse(
      rows,
      { hint: notes.join(' ') },
      // Under budget pressure the summary is the one column a row can lose and
      // still be actionable — the id is what gets called.
      { prunable: ['summary'] },
    ),
  );
}

// ---------------------------------------------------------------------------
// describe_operation
// ---------------------------------------------------------------------------

interface RenderedParam {
  name: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
}

function renderParams(
  declared: readonly string[],
  schemaParams: readonly ParamSchema[],
  where: 'path' | 'query',
): RenderedParam[] {
  const byName = new Map(
    schemaParams.filter((param) => param.in === where).map((param) => [param.name, param]),
  );
  return declared.map((name) => {
    const param = byName.get(name);
    const rendered: RenderedParam = { name };
    // Path parameters are always required — they are segments of the URL, not
    // options — regardless of what the spec's annotation happens to say.
    if (where === 'path' || param?.required === true) rendered.required = true;
    if (param?.description !== undefined) rendered.description = param.description;
    if (param?.schema !== undefined) rendered.schema = param.schema;
    return rendered;
  });
}

function describeHandler(args: Record<string, unknown>, cfg: ServerConfig): ToolResult {
  const operation = mustFindOperation(cfg, requiredString(args, 'operation_id'));
  const schema = getSchema(operation.id);
  const params = schema?.params ?? [];
  const pricing = getPricingCategory(operation.id);

  const detail = {
    id: operation.id,
    surface: operation.surface,
    surface_label: SURFACE_LABELS[operation.surface],
    method: operation.method,
    path: operation.path,
    family: operation.family,
    summary: operation.summary,
    danger: operation.danger,
    runs_through: doorFor(operation.danger)?.tool ?? null,
    costly: operation.costly === true,
    ...(pricing === undefined ? {} : { pricing_category: pricing }),
    returns_action: operation.returnsAction === true,
    paginated: operation.paginated === true,
    path_params: renderParams(operation.pathParams, params, 'path'),
    query_params: renderParams(visibleQueryParams(operation), params, 'query'),
    request_body: schema?.body ?? null,
  };

  const notes: string[] = [];
  if (operation.returnsAction === true) {
    notes.push(
      'This operation returns an Action: Hetzner accepts the call and finishes the work ' +
        'afterwards. The execute tool polls that Action for up to `wait_seconds` and reports the ' +
        'outcome in meta.action, where `awaited: false` means the work was still running when the ' +
        'call stopped waiting.',
    );
  }
  if (operation.paginated === true) {
    notes.push(
      '`page` and `per_page` are carried by the `cursor` parameter of execute_read_operation ' +
        `rather than by \`query\`, and that tool returns the \`${rowsKey(operation)}\` array as ` +
        'data rather than the response object around it.',
    );
  }
  if (operation.costly === true) {
    notes.push(
      pricing === undefined
        ? BILLING_NOTE
        : `${BILLING_NOTE} The \`${pricing}\` category of GET /pricing quotes the price.`,
    );
  }
  if (operation.hasBody && schema?.body === undefined) {
    notes.push(
      'The operation declares a request body but the spec carries no schema for it; Hetzner names ' +
        'the fields it wants in its own validation error.',
    );
  }

  return renderEnvelope(
    shapeResponse(detail, {
      count: 1,
      ...(notes.length > 0 ? { hint: notes.join(' ') } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// execute_* — shared dispatch
// ---------------------------------------------------------------------------

interface ExecuteShape {
  door: Door;
  /** Paging is a read concern: no mutation in this API returns a page. */
  cursor: boolean;
  body: boolean;
  /** Awaiting an Action only makes sense for a call that starts one. */
  wait: boolean;
}

const READ_SHAPE: ExecuteShape = { door: READ_DOOR, cursor: true, body: false, wait: false };
const WRITE_SHAPE: ExecuteShape = { door: WRITE_DOOR, cursor: false, body: true, wait: true };
/**
 * `body: true` because four destructive operations take one — `rebuild_server`
 * names the image to rebuild from, `set_zone_rrset_records` carries the records
 * that replace what is there.
 */
const DESTRUCTIVE_SHAPE: ExecuteShape = {
  door: DESTRUCTIVE_DOOR,
  cursor: false,
  body: true,
  wait: true,
};

async function executeHandler(
  shape: ExecuteShape,
  args: Record<string, unknown>,
  cfg: ServerConfig,
  extra: ToolExtra,
): Promise<ToolResult> {
  return runTool(async () => {
    // Order matters. The id is validated against the catalog before the
    // connection is even looked at, so an unknown id is never the thing that
    // decides which credential gets resolved.
    const operation = mustFindOperation(cfg, requiredString(args, 'operation_id'));
    guardDoor(operation, shape.door, availableDangerClasses(cfg).includes('destructive'));

    const connection = resolveConnection(args, cfg, { requireExplicit: true });
    guardSurface(operation, connection, cfg);

    const path = buildPath(operation, readRecord(args, 'path_params'));
    const query = buildQuery(operation, readRecord(args, 'query'));
    const body = shape.body ? readRecord(args, 'body') : undefined;

    const cursor = shape.cursor ? readCursor(operation, connection, args, query) : undefined;
    const effectiveQuery =
      cursor === undefined ? query : { ...(cursor.query ?? {}), ...toQuery(cursor) };

    const response = await request({
      connection,
      method: operation.method,
      path,
      query: effectiveQuery,
      body,
      operationId: operation.id,
      signal: extra.signal,
    });

    return shape.wait
      ? await renderMutation(operation, connection, response, args, extra)
      : renderRead(operation, connection, response, cursor);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The cursor state this call runs under, for an operation the catalog marks
 * `paginated`.
 *
 * A cursor already carries the filters of the call that minted it, so passing
 * `query` alongside one is ambiguous — the two could disagree, and silently
 * preferring either would page through a result set the caller did not ask for.
 * It is refused instead.
 */
function readCursor(
  operation: CatalogOperation,
  connection: Connection,
  args: Record<string, unknown>,
  query: Record<string, QueryValue>,
): CursorState | undefined {
  if (operation.paginated !== true) return undefined;

  const raw = optionalString(args, 'cursor');
  if (raw === undefined) {
    return firstPage({ op: operation.id, connection: connection.name, query });
  }
  if (Object.keys(query).length > 0) {
    throw new HetznerError(
      '`query` cannot be combined with `cursor`.',
      'validation',
      'The cursor already carries the filters, the sort and the page size of the call that ' +
        'produced it, so the next page needs nothing but the cursor.',
    );
  }
  return resumeCursor(raw, { op: operation.id, connection: connection.name });
}

/**
 * WHAT COMES BACK, AND WHEN IT IS UNWRAPPED
 *
 * Hetzner never returns a bare payload. A list arrives under the plural key and
 * a single read under the singular one: `{ "servers": [...], "meta": {...} }`,
 * `{ "server": {...} }`, `{ "action": {...} }`. A generic executor cannot
 * hardcode 221 key names, so the rule is stated once and holds everywhere:
 *
 *   - An operation the catalog marks `paginated` returns the ROW ARRAY itself.
 *   - Every other operation returns Hetzner's body VERBATIM, wrapper and all.
 *
 * The decision comes from `operation.paginated`, never from the shape of what
 * came back, so it is the same on every call to the same operation — including
 * a call that returns an empty page. `describe_operation` reports `paginated`
 * and every unwrapped response names the key it unwrapped, so the two shapes are
 * predictable rather than surprising.
 *
 * Unwrapping the paginated case is not cosmetic. The response shaper's cheapest
 * useful degradation drops ROWS and mints a cursor that resumes at the first
 * dropped row, and it can only do that when the payload IS the array. Left
 * wrapped, an oversized page of servers would instead have values inside it
 * replaced by size markers while the cursor advanced past them — quiet data loss
 * in place of an honest short page.
 */
function rowsKey(operation: CatalogOperation): string {
  // The last segment of a collection path IS Hetzner's response key: /servers ->
  // `servers`, /zones/{id_or_name}/rrsets -> `rrsets`, /storage_boxes ->
  // `storage_boxes`. Every one of the catalog's 42 paginated operations ends in
  // a static plural segment, which is what makes this a derivation rather than a
  // guess — `test/catalog.test.ts` territory if that ever stops being true.
  const segments = operation.path.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}

function unwrapRows(
  operation: CatalogOperation,
  data: unknown,
): { key: string; rows: unknown[] } | undefined {
  if (!isRecord(data)) return undefined;
  const key = rowsKey(operation);
  const value = data[key];
  return Array.isArray(value) ? { key, rows: value } : undefined;
}

function renderRead(
  operation: CatalogOperation,
  connection: Connection,
  response: HetznerResponse,
  cursor: CursorState | undefined,
): ToolResult {
  const notes: string[] = [];
  const base: EnvelopeMeta = { connection: connection.name, surface: connection.surface };

  const unwrapped = cursor === undefined ? undefined : unwrapRows(operation, response.data);
  if (cursor !== undefined && unwrapped !== undefined) {
    notes.push(
      `data is the \`${unwrapped.key}\` array of Hetzner's response; the rest of the body is ` +
        'reported in meta.',
    );
    const meta: EnvelopeMeta = {
      ...base,
      cursor,
      total: response.pagination?.totalEntries,
      next_cursor: nextPageCursor(cursor, response.pagination, unwrapped.rows.length),
    };
    return renderEnvelope(
      shapeResponse(applySkip(unwrapped.rows, cursor), {
        ...meta,
        ...composeHint(notes, operation, response),
      }),
    );
  }

  if (cursor !== undefined) {
    // Said out loud rather than absorbed. The shape a paginated operation
    // returns is part of its contract, and a silent fallback would teach the
    // model that the contract is optional.
    notes.push(
      `The response carried no \`${rowsKey(operation)}\` array, so it is returned as Hetzner sent ` +
        'it and no page cursor was minted.',
    );
  }

  return renderEnvelope(
    shapeResponse(response.data, { ...base, ...composeHint(notes, operation, response) }),
  );
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * A mutation's result, including whether its Action finished.
 *
 * 144 of this API's 221 operations return an Action rather than the finished
 * resource, so a generic executor that ignored them would leave most of the API
 * ambiguous: `{ action: { status: "running" } }` says the call was accepted and
 * says nothing about whether the work happened. Awaiting it, and reporting
 * plainly when the wait gave up, is the difference between "it is done" and "it
 * was accepted" — the two answers a caller actually needs to tell apart.
 */
async function renderMutation(
  operation: CatalogOperation,
  connection: Connection,
  response: HetznerResponse,
  args: Record<string, unknown>,
  extra: ToolExtra,
): Promise<ToolResult> {
  const notes: string[] = [];
  const meta: EnvelopeMeta = { connection: connection.name, surface: connection.surface };

  const started = readAction(response.data);
  if (started !== undefined) {
    // Throws when the Action failed: Hetzner reports that in the Action rather
    // than in the HTTP status, so a 201 followed by an asynchronous failure
    // would otherwise read as success.
    const settled = await awaitAction(connection, started, extra, readWaitMs(args));
    meta.action = {
      id: settled.action.id,
      status: settled.action.status,
      awaited: settled.settled,
    };
    if (!settled.settled) notes.push(unsettledHint(settled.action));
  } else if (operation.returnsAction === true) {
    notes.push(noActionHint(operation.id));
  }

  return renderEnvelope(
    shapeResponse(response.data, { ...meta, ...composeHint(notes, operation, response) }),
  );
}

// ---------------------------------------------------------------------------
// Shared response notes
// ---------------------------------------------------------------------------

/** Facts about what came back. Never a directive about what to do next. */
function composeHint(
  notes: string[],
  operation: CatalogOperation,
  response: HetznerResponse,
): { hint?: string } {
  const all = [...notes];
  if (response.data === null) {
    // Otherwise `data: null` reads as a failure when it is an ordinary 204.
    all.push(`Hetzner returned HTTP ${response.status} with an empty body.`);
  }
  if (operation.costly === true) all.push(BILLING_NOTE);

  const rateLimit = response.rateLimit;
  if (rateLimit !== undefined && rateLimit.remaining <= LOW_RATE_LIMIT_REMAINING) {
    all.push(
      `Rate limit: ${rateLimit.remaining} of ${rateLimit.limit} requests left in the current ` +
        'window. The bucket belongs to the token, so every client using it shares this allowance.',
    );
  }
  return all.length > 0 ? { hint: all.join(' ') } : {};
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** The surfaces the shipped catalog actually covers. */
const CATALOG_SURFACES: readonly Surface[] = listSurfaces().map((row) => row.surface);

/** Wraps a synchronous catalog handler so nothing reaches the transport as a throw. */
function guarded(
  run: (args: Record<string, unknown>, cfg: ServerConfig) => ToolResult,
): ToolDef['handler'] {
  return (args, cfg) => runTool(async () => run(args, cfg));
}

export const searchOperationsTool: ToolDef = {
  name: 'search_operations',
  description:
    'Search the catalog of Hetzner API operations by keyword, API surface, resource family or ' +
    'danger class. Returns compact rows — operation id, surface, method, path, summary, family and ' +
    'danger class — for the operations this server can run; classes with no door are omitted. Rows ' +
    'that open a bill are marked `costly`, and rows whose call finishes asynchronously are marked ' +
    "`returns_action`. The catalog is generated from Hetzner's published OpenAPI specs, and the " +
    `endpoints it covers are documented at ${DOCS_URL}.`,
  annotations: {
    title: 'Search Hetzner API operations',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // The catalog is compiled into the package: no network, no external entity,
    // a fixed and fully known domain.
    openWorldHint: false,
  },
  surface: 'read',
  apiSurfaces: CATALOG_SURFACES,
  inputSchema: () => ({
    query: z.string().optional().describe(SEARCH_QUERY_DESCRIPTION),
    surface: z
      .enum(SURFACE_VALUES)
      .optional()
      .describe(
        'Restrict results to one Hetzner API: ' +
          SURFACE_VALUES.map((surface) => `${surface} — ${SURFACE_LABELS[surface]}`).join('; ') +
          '.',
      ),
    family: z.enum(FAMILY_VALUES).optional().describe('Restrict results to one resource family.'),
    danger: z
      .enum(DANGER_VALUES)
      .optional()
      .describe(
        'Restrict results to one danger class: `safe` reads nothing but data, `write` creates or ' +
          'changes, `destructive` removes or overwrites.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_LIMIT)
      .optional()
      .describe(SEARCH_LIMIT_DESCRIPTION),
  }),
  handler: guarded(searchHandler),
};

export const describeOperationTool: ToolDef = {
  name: 'describe_operation',
  description:
    'Return the full calling contract for one Hetzner API operation: its surface, HTTP method and ' +
    'path, every path and query parameter with its type and accepted values, the JSON Schema of ' +
    'its request body, its danger class, which execute_* tool runs it, whether it returns an ' +
    'Action and whether it is paginated. Schemas are returned one operation at a time because ' +
    'returning them for a page of search results would crowd out everything else. Reference ' +
    `documentation: ${DOCS_URL}.`,
  annotations: {
    title: 'Describe a Hetzner API operation',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  surface: 'read',
  apiSurfaces: CATALOG_SURFACES,
  inputSchema: () => ({
    operation_id: z.string().describe(DESCRIBE_ID_DESCRIPTION),
  }),
  handler: guarded(describeHandler),
};

/**
 * The three execute doors differ only in which danger class they admit, what
 * they say about themselves, and which optional fields make sense. Building them
 * from one factory keeps that true: a parameter added to the read door cannot
 * quietly fail to appear on the write door, and the schema cannot drift from the
 * `ExecuteShape` the dispatcher enforces.
 */
interface ExecuteToolSpec {
  shape: ExecuteShape;
  name: string;
  title: string;
  description: string;
  surface: ToolDef['surface'];
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
  /** Example ids, so the id vocabulary is visible without a round trip. */
  idExamples: string;
}

function executeTool(spec: ExecuteToolSpec): ToolDef {
  const { shape } = spec;
  return {
    name: spec.name,
    description: spec.description,
    annotations: {
      title: spec.title,
      readOnlyHint: spec.readOnlyHint,
      destructiveHint: spec.destructiveHint,
      ...(spec.idempotentHint === undefined ? {} : { idempotentHint: spec.idempotentHint }),
      openWorldHint: true,
    },
    surface: spec.surface,
    apiSurfaces: CATALOG_SURFACES,
    inputSchema: (cfg) => ({
      // Required on every door, including the read one: an operation belongs to
      // exactly one surface and a cloud token sees exactly one project, so the
      // target of a generic call is never inferable from the operation alone.
      ...connectionProperty(cfg, { requireExplicit: true }),
      operation_id: z.string().describe(`Catalog operation id — e.g. ${spec.idExamples}.`),
      path_params: z
        .record(z.string(), z.union([z.string(), z.number()]))
        .optional()
        .describe(PATH_PARAMS_DESCRIPTION),
      query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(QUERY_DESCRIPTION),
      ...(shape.body
        ? { body: z.record(z.string(), z.unknown()).optional().describe(BODY_DESCRIPTION) }
        : {}),
      ...(shape.cursor ? { cursor: z.string().optional().describe(CURSOR_DESCRIPTION) } : {}),
      ...(shape.wait ? waitProperty() : {}),
    }),
    handler: (args, cfg, extra) => executeHandler(shape, args, cfg, extra),
  };
}

export const executeReadOperationTool = executeTool({
  shape: READ_SHAPE,
  name: 'execute_read_operation',
  title: 'Run a Hetzner read operation',
  surface: 'read',
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  idExamples: '"list_servers", "get_zone_rrset", "list_storage_boxes"',
  description:
    'Run a read-only Hetzner API operation (GET) from the catalog by id and return the response. ' +
    'Nothing is created, changed or deleted; ids classified as write or destructive are refused ' +
    'here and named with the tool that runs them. Filters go in `query` — `label_selector`, ' +
    '`sort`, `status`, `name`. A paginated operation returns its row array as `data` plus ' +
    'meta.next_cursor, which the next call passes back as `cursor`; every other operation returns ' +
    'Hetzner\'s response body verbatim, wrapper key and all — `{"server": {...}}`. The operation ' +
    'decides which Hetzner API is called, so a connection on another surface is refused. ' +
    `Endpoints are documented at ${DOCS_URL}.`,
});

export const executeWriteOperationTool = executeTool({
  shape: WRITE_SHAPE,
  name: 'execute_write_operation',
  title: 'Run a Hetzner write operation',
  surface: 'write',
  readOnlyHint: false,
  // Creating, updating, attaching and powering on are reversible and lose no
  // data. Deletion, rebuild and snapshot rollback are a different tool.
  destructiveHint: false,
  idExamples: '"create_server", "poweron_server", "update_zone_rrset", "attach_volume"',
  description:
    'Run a Hetzner API operation that creates or changes state (POST, PUT, PATCH) from the catalog ' +
    'by id. Nothing is deleted or overwritten; ids classified as destructive are refused here and ' +
    'run through execute_destructive_operation instead. Operations that provision resources open a ' +
    'bill, and the response says so. Most of these return an Action and complete asynchronously: ' +
    'this tool waits up to `wait_seconds` for it and reports the outcome in meta.action. The ' +
    'request body is passed to Hetzner unchanged and its own per-field validation errors come back ' +
    `verbatim. Operations and their bodies are documented at ${DOCS_URL}.`,
});

export const executeDestructiveOperationTool = executeTool({
  shape: DESTRUCTIVE_SHAPE,
  name: 'execute_destructive_operation',
  title: 'Run a destructive Hetzner operation',
  surface: 'destructive',
  readOnlyHint: false,
  destructiveHint: true,
  idExamples: '"delete_server", "rebuild_server", "delete_zone", "rollback_storage_box_snapshot"',
  description:
    'Run a Hetzner API operation that destroys or overwrites state — deleting a Server, Volume, ' +
    "Network, Zone, RRSet or Storage Box, rebuilding a Server from an image, replacing an RRSet's " +
    'records, or rolling a Storage Box back to a snapshot. These are irreversible: a deleted ' +
    'resource and the data on it cannot be recovered through the API, and a rebuild wipes the disk ' +
    'while answering 201. Only ids classified as destructive are accepted. Most return an Action ' +
    'and complete asynchronously, so meta.action reports whether the work actually finished. ' +
    `Operations and their parameters are documented at ${DOCS_URL}.`,
});

/**
 * Order is fixed: the three-step path reads top to bottom, and the doors follow
 * it in ascending danger. `execute_destructive_operation` is listed here like
 * the rest; whether it is registered is `register.ts`'s decision.
 */
export const genericTools: readonly ToolDef[] = [
  searchOperationsTool,
  describeOperationTool,
  executeReadOperationTool,
  executeWriteOperationTool,
  executeDestructiveOperationTool,
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new HetznerError(`\`${key}\` must be an object.`, 'validation');
  }
  return toRecord(value);
}

function quoteList(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(', ');
}

function describeNames(names: readonly string[]): string {
  return names.length === 0 ? 'none' : quoteList(names);
}
