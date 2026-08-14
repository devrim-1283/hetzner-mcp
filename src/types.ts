/**
 * Shared contracts for hetzner-mcp.
 *
 * Every module implements against these types. They are the seam between the
 * catalog, the HTTP client, the tool layer and the installer, so changing one
 * is a cross-cutting change — prefer adding over editing.
 */

// ---------------------------------------------------------------------------
// Surfaces — the one concept coolify-mcp did not need
// ---------------------------------------------------------------------------

/**
 * Hetzner is not one API. It is several, on different hosts, with different
 * authentication and different notions of what a "server" is.
 *
 *   cloud   api.hetzner.cloud/v1     bearer, scoped to ONE PROJECT
 *   hetzner api.hetzner.com/v1       bearer, scoped to the ACCOUNT
 *   robot   robot-ws.your-server.de  HTTP Basic, physical machines
 *
 * The surface is never inferred and never hidden. A cloud `server` is a virtual
 * machine billed by the hour; a robot `server` is leased physical hardware with
 * a monthly contract and a cancellation notice period. Collapsing those two
 * into one namespace would make "reboot the server" ambiguous in a way that
 * cannot be recovered from after the fact, so the surface travels with every
 * connection, every catalog operation and every tool argument.
 */
export type Surface = 'cloud' | 'hetzner' | 'robot';

export const SURFACES: readonly Surface[] = ['cloud', 'hetzner', 'robot'] as const;

/**
 * Base URLs are derived from the surface, never configured.
 *
 * Coolify is self-hosted, so its base URL is a genuine user input. Hetzner runs
 * exactly one instance of each API, which means a user-supplied base URL could
 * only ever be (a) the value we already know or (b) a mistake. Deriving it
 * deletes a whole class of configuration error instead of validating it.
 */
export const SURFACE_BASE_URLS: Readonly<Record<Surface, string>> = {
  cloud: 'https://api.hetzner.cloud/v1',
  hetzner: 'https://api.hetzner.com/v1',
  robot: 'https://robot-ws.your-server.de',
};

/** How a surface proves who it is. Decided by the surface, not by the user. */
export const SURFACE_AUTH: Readonly<Record<Surface, 'bearer' | 'basic'>> = {
  cloud: 'bearer',
  hetzner: 'bearer',
  robot: 'basic',
};

export const SURFACE_LABELS: Readonly<Record<Surface, string>> = {
  cloud: 'Hetzner Cloud (project-scoped)',
  hetzner: 'Hetzner API (account-scoped)',
  robot: 'Hetzner Robot (dedicated servers)',
};

// ---------------------------------------------------------------------------
// Catalog (generated at build time from Hetzner's OpenAPI specs)
// ---------------------------------------------------------------------------

/**
 * Danger class decides which generic door an operation is reachable through,
 * and whether the transport layer will let it out of the process at all.
 *
 * Computed at build time. `destructive` is NOT simply `method === 'DELETE'`:
 * POST /servers/{id}/actions/rebuild wipes the disk and returns 201, and
 * POST /storage_boxes/{id}/actions/rollback_snapshot overwrites live data.
 * Both are irreversible; neither is a DELETE.
 */
export type DangerClass = 'safe' | 'write' | 'destructive';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type OperationFamily =
  | 'servers'
  | 'server-types'
  | 'images'
  | 'ssh-keys'
  | 'volumes'
  | 'networks'
  | 'firewalls'
  | 'load-balancers'
  | 'floating-ips'
  | 'primary-ips'
  | 'certificates'
  | 'placement-groups'
  | 'zones'
  | 'actions'
  | 'datacenters'
  | 'locations'
  | 'isos'
  | 'pricing'
  | 'storage-boxes'
  | 'robot-servers'
  | 'robot-ips'
  | 'robot-boot'
  | 'robot-storage-boxes'
  | 'robot-ordering'
  | 'other';

export interface CatalogOperation {
  /** Stable id from the spec's operationId, e.g. "delete_server". */
  id: string;
  surface: Surface;
  method: HttpMethod;
  /** Path template with `{placeholders}`, e.g. "/servers/{id}". */
  path: string;
  family: OperationFamily;
  summary: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
  danger: DangerClass;
  /**
   * Opens a bill. Provisioning a server, a volume or a Load Balancer starts
   * charging immediately; ordering dedicated hardware commits to a contract.
   *
   * NOT gated — the brief keeps everything non-destructive open — but surfaced
   * in search results and in the response so the consequence is visible before
   * and after the call rather than only on the invoice.
   */
  costly?: boolean;
  /**
   * Returns an Action rather than the finished resource. Hetzner mutations are
   * asynchronous: the call returns `{ action: { id, status: 'running' } }` and
   * the work completes later. Tools use this to decide whether a result needs
   * to be awaited before it means anything.
   */
  returnsAction?: boolean;
  /** Supports `page`/`per_page`. 38 of the cloud API's 82 GETs do. */
  paginated?: boolean;
}

export interface CatalogMeta {
  /** Per-surface provenance, so one stale spec cannot hide behind another. */
  specs: Array<{
    surface: Surface;
    /** The spec's own info.version. */
    version: string;
    sha256: string;
    operationCount: number;
  }>;
  operationCount: number;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Connections — a connection is (surface, credential)
// ---------------------------------------------------------------------------

/**
 * A Hetzner Cloud token is created inside a project and cannot see any other
 * project; there is no project parameter in the API. So a second project is a
 * second token, which is a second connection — the same shape coolify-mcp
 * arrived at for teams. N connections covers N accounts x M projects with no
 * extra concept, and adding the surface to the tuple extends it to Robot and
 * the account-scoped API without a second mechanism.
 */
export interface Credential {
  kind: 'bearer' | 'basic';
  /** Resolved lazily, cached for the process lifetime, never written to disk. */
  resolve: () => Promise<{ token: string } | { user: string; password: string }>;
}

export interface Connection {
  /** Slug: ^[a-z0-9][a-z0-9-]{0,30}$ — must survive a round trip through an env var name. */
  name: string;
  surface: Surface;
  /** Derived from `surface`. Present so the HTTP layer never re-derives it. */
  baseUrl: string;
  label?: string;
  /** Refuse every write and destructive operation regardless of token scope. */
  readOnly: boolean;
  /** Per-connection override of the global HETZNER_ALLOW_DESTRUCTIVE flag. */
  allowDestructive: boolean;
  timeoutMs: number;
  credential: Credential;
  /**
   * Where this connection was defined. `doctor` exists to answer "why is it
   * behaving like that", and with a layered configuration the answer is usually
   * "not from the file you are looking at" — the aggregate `source` on the
   * registry cannot say which connection came from where.
   *
   * Optional so that a test may build a Connection without asserting provenance
   * it does not care about.
   */
  origin?: 'env' | 'file';
}

export interface ConnectionRegistry {
  connections: Map<string, Connection>;
  /** Undefined when several connections exist and none was designated. */
  defaultName?: string;
  /** Where the config came from, for `doctor` and error messages. */
  source: 'env' | 'file' | 'env+file';
  configPath?: string;
  /** Names defined in both env and file; env won. */
  shadowed: string[];
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface HetznerRequest {
  connection: Connection;
  method: HttpMethod;
  /** Concrete path with params already substituted, e.g. "/servers/42". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Catalog operation id, when the call came from the generic path. */
  operationId?: string;
  signal?: AbortSignal;
}

/**
 * Hetzner paginates properly, unlike Coolify. `meta.pagination` carries
 * page/per_page/total_entries, which maps onto our cursor without invention.
 */
export interface Pagination {
  page: number;
  perPage: number;
  totalEntries?: number;
  lastPage?: number;
}

export interface HetznerResponse<T = unknown> {
  status: number;
  data: T;
  /**
   * From RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset. Unlike a
   * self-hosted Coolify, these are real and shared across the whole project:
   * 3600/hour by default, and a polling loop can exhaust them for every other
   * client using the same token.
   */
  rateLimit?: { limit: number; remaining: number; resetAt?: number };
  pagination?: Pagination;
}

/** Every failure the tool layer can render. Never thrown across the transport. */
export class HetznerError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'destructive_blocked'
      | 'read_only_connection'
      | 'surface_mismatch'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'validation'
      | 'conflict'
      | 'locked'
      | 'protected'
      | 'resource_limit'
      | 'resource_unavailable'
      | 'rate_limited'
      | 'maintenance'
      | 'action_failed'
      | 'network'
      | 'unknown',
    /** Actionable next step shown to the model. */
    readonly hint?: string,
    readonly status?: number,
    /**
     * Hetzner's own `error.code`, passed through verbatim. It is a closed
     * vocabulary (`uniqueness_error`, `protected`, `resource_unavailable`, ...)
     * and a better diagnostic than anything we would synthesize from the
     * status code alone.
     */
    readonly apiCode?: string,
    /** Hetzner's `error.details.fields` for invalid_input. */
    readonly validationErrors?: Array<{ name: string; messages: string[] }>,
  ) {
    super(message);
    this.name = 'HetznerError';
  }
}

// ---------------------------------------------------------------------------
// Actions — Hetzner's asynchronous mutation model
// ---------------------------------------------------------------------------

export type ActionStatus = 'running' | 'success' | 'error';

/**
 * Nearly every cloud mutation returns one of these instead of the finished
 * resource. A tool that returns `{ action: { status: 'running' } }` and stops
 * has told the model nothing about whether the work happened, so the tool layer
 * either awaits the action or states plainly that it did not.
 */
export interface ActionRef {
  id: number;
  command: string;
  status: ActionStatus;
  /** 0-100. */
  progress: number;
  started: string;
  finished?: string | null;
  error?: { code: string; message: string } | null;
  resources?: Array<{ id: number; type: string }>;
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

export type TruncationKind = 'field_prune' | 'row_limit' | 'field_value' | null;

export interface ResponseMeta {
  count: number;
  total?: number;
  next_cursor?: string;
  truncated: number;
  truncation: TruncationKind;
  /** Factual statement of available next steps. Never a directive about model behaviour. */
  hint?: string;
  /** Partial failures from a `connection: "*"` fan-out. */
  errors?: Array<{ connection: string; message: string }>;
  /**
   * Present when the call opened a bill. States the price Hetzner published for
   * what was just created, so the cost appears next to the act rather than on
   * the invoice.
   */
  billing?: { monthly?: string; hourly?: string; currency: string };
  /** Present when the call returned an Action. */
  action?: { id: number; status: ActionStatus; awaited: boolean };
}

/** Identical envelope across every tool. */
export interface ToolEnvelope<T = unknown> {
  connection?: string;
  surface?: Surface;
  data: T;
  meta: ResponseMeta;
}

export interface ShapeOptions {
  /** Fields kept, in order. An allowlist — a denylist rots when Hetzner adds fields. */
  fields?: readonly string[];
  /** Fields dropped first when over budget, in order. */
  prunable?: readonly string[];
  maxBytes?: number;
}

// ---------------------------------------------------------------------------
// Tool modules
// ---------------------------------------------------------------------------

/**
 * Annotations are mandatory per Anthropic's tool-design review criteria:
 * every tool must carry title, readOnlyHint and destructiveHint.
 */
export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

/**
 * A tool module. `build` receives the resolved config so a tool can shape its
 * schema around it — most importantly, the `connection` parameter is omitted
 * entirely when only one connection exists, rather than being optional.
 */
export interface ToolDef {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  /** Which surface this belongs to; register.ts uses it to apply the gates. */
  surface: 'read' | 'write' | 'destructive';
  /** Which Hetzner API surfaces this tool can operate on. */
  apiSurfaces: readonly Surface[];
  /** Zod raw shape. Built per-config so `connection` can be conditional. */
  inputSchema: (cfg: ServerConfig) => Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    cfg: ServerConfig,
    extra: ToolExtra,
  ) => Promise<ToolResult>;
}

export interface ToolExtra {
  signal?: AbortSignal;
  /** Present when the host supports progress notifications. */
  progress?: (progress: number, total?: number, message?: string) => void;
}

/** MCP tool result. Errors are returned, never thrown across the transport. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

export interface ServerConfig {
  registry: ConnectionRegistry;
  /** Global default; a connection may override. */
  allowDestructive: boolean;
  readOnly: boolean;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

/** The MCP server entry an adapter writes into a client's config. */
export interface ServerEntry {
  /** Key under mcpServers / context_servers / mcp. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface InstallCtx {
  homeDir: string;
  projectRoot: string;
  platform: NodeJS.Platform;
  /** Bake HETZNER_CONNECTION into the env block. */
  connection?: string;
  /** "@donedynamics/hetzner-mcp@1.4.2" vs "@donedynamics/hetzner-mcp@latest". */
  packageSpec: string;
  transport: 'stdio' | 'http';
}

/** Inert data. Built purely so --dry-run is a true preview, then applied. */
export type Operation =
  | { kind: 'json-merge'; path: string; keyPath: string[]; value: unknown }
  | { kind: 'jsonc-merge'; path: string; keyPath: string[]; value: unknown }
  | { kind: 'toml-append'; path: string; section: string; text: string }
  | { kind: 'toml-replace'; path: string; section: string; text: string }
  | { kind: 'yaml-merge'; path: string; keyPath: string[]; value: unknown }
  | { kind: 'json-remove'; path: string; keyPath: string[] }
  | { kind: 'jsonc-remove'; path: string; keyPath: string[] }
  | { kind: 'toml-remove'; path: string; section: string }
  | { kind: 'yaml-remove'; path: string; keyPath: string[] }
  | { kind: 'exec'; argv: string[]; cwd?: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'note'; level: 'info' | 'warn'; message: string };

export interface ValidationIssue {
  severity: 'error' | 'warn' | 'info';
  /** Machine-readable, kebab-case, e.g. "codex-config-unparseable". */
  code: string;
  message: string;
  /** What the user should do about it. */
  fix?: string;
}

export interface Detection {
  installed: boolean;
  configExists: boolean;
  parseable: boolean;
  path: string;
}

export interface McpClientAdapter {
  /** e.g. "codex-user" */
  id: string;
  /** e.g. "codex" */
  client: string;
  scope: 'user' | 'project';
  label: string;
  format: 'json' | 'jsonc' | 'toml' | 'yaml';
  /**
   * 'unverified' makes apply() refuse to write and downgrade to --print.
   * Promotion requires a link to upstream docs or a reproducible probe.
   */
  confidence: 'verified' | 'unverified';
  transports: Array<'stdio' | 'http'>;
  supports(target: string): boolean;
  resolvePath(ctx: InstallCtx): string;
  detect(ctx: InstallCtx): Promise<Detection>;
  nativeCli?: { bin: string; buildArgv(entry: ServerEntry, ctx: InstallCtx): string[] };
  /** PURE — no I/O. */
  planWrite(entry: ServerEntry, ctx: InstallCtx): Operation[];
  /** PURE — no I/O. */
  planRemove(ctx: InstallCtx): Operation[];
  readEntry(ctx: InstallCtx): Promise<unknown | null>;
  validate(ctx: InstallCtx): Promise<ValidationIssue[]>;
}

export interface InstallRecord {
  adapterId: string;
  path: string;
  serverName: string;
  managedKeyPath: string[];
  method: 'file' | 'native-cli';
  packageSpec: string;
  writtenAt: string;
  entryHash: string;
}

export interface InstallState {
  schema: 'hetzner-mcp.install.v1';
  installs: InstallRecord[];
}
