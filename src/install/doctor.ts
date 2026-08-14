/**
 * `doctor` — read-only inspection of everything between a Hetzner account and
 * an MCP client.
 *
 * This is the strongest single reason the CLI exists. Installing an MCP server
 * is a one-line JSON merge that a determined user will do by hand; finding out
 * *why* it does not work — or that a live API token has been sitting in
 * plaintext in `~/.claude.json` since the day it was pasted there — is not.
 *
 * Three properties hold everywhere in this file:
 *
 *  1. **Nothing is written.** `runDoctor` performs no mutation at all unless
 *     `fix` is set, and even then only through the narrow path described at
 *     {@link planFixes}.
 *  2. **No secret is ever emitted.** Findings record *locations*, never values —
 *     not the value, not a prefix, not a length. Everything that leaves this
 *     module additionally passes through `redact()`, which strips the
 *     credentials this process resolved. A doctor report is the single
 *     most-pasted artefact in any bug report.
 *  3. **We say what we did not check.** Windows ACLs are not inspected, so
 *     Windows gets an honest `acl-not-checked` note rather than a silent pass.
 *
 * WHAT THIS FILE DOES NOT CHECK, AND WHY
 * There is no base-URL check anywhere here. Hetzner runs exactly one instance of
 * each API and `SURFACE_BASE_URLS` derives the host from the surface, so a
 * base URL is never user input and there is no misconfiguration of one to find.
 * Coolify is self-hosted and needed the opposite treatment; carrying that check
 * across would have validated a value nothing can set.
 *
 * `--fix` writes through the same `merge/` writers the installer uses, not
 * through `apply.ts`: a fix is one key in one file, and going via the install
 * plan would drag a whole `ServerEntry` through a code path that is meant to
 * change nothing but a single literal.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import {
  ACCOUNT_TOKEN_ENV,
  CLOUD_TOKEN_ENV,
  ROBOT_PASSWORD_ENV,
  ROBOT_USER_ENV,
  bareConnectionName,
  bareCredentialVars,
  connectionNameFromEnvSuffix,
  conventionalCredentialVars,
  parseConfigFile,
  readEnvValue,
  type ConfigFile,
} from '../config/schema.js';
import { resolveRegistry } from '../config/resolve.js';
import { redact } from '../shaping/redact.js';
import { SURFACE_AUTH } from '../types.js';
import type {
  Connection,
  ConnectionRegistry,
  Detection,
  InstallCtx,
  McpClientAdapter,
  Surface,
  ValidationIssue,
} from '../types.js';
import { ADAPTERS } from './adapters/index.js';
import type { MergeResult } from './merge/json.js';
import { mergeJsonc } from './merge/jsonc.js';
import { mergeYaml } from './merge/yaml.js';

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

/**
 * A Hetzner API token is 64 base62 characters. Nothing else.
 *
 * This is the one place the Coolify original could not be carried across, and
 * the difference matters enough to spell out. A Coolify token is a Laravel
 * Sanctum token — `<numeric id>|<40+ base62>` — a shape that does not occur in a
 * config file by accident, so the original swept every byte of every file for it
 * and reported a hit as CRITICAL with no hedging.
 *
 * Sixty-four base62 characters is NOT such a shape. A SHA-256 digest, a content
 * hash, a Docker image id and half the opaque identifiers in a modern config file
 * all match it. A whole-file sweep on this pattern would produce CRITICAL
 * findings about integrity hashes, and a CRITICAL that is usually wrong is worth
 * less than no CRITICAL at all — people learn to scroll past it, including on
 * the day it is right.
 *
 * So the shape is never load-bearing on its own. It is only ever consulted at a
 * location that is already known to hold a Hetzner credential: a variable named
 * by {@link HETZNER_CREDENTIAL_VAR}, or an `Authorization: Bearer` value. The
 * NAME carries the confidence; the shape only distinguishes "a credential" from
 * "an empty string somebody left behind".
 */
const HETZNER_TOKEN_SHAPE = /^[A-Za-z0-9]{64}$/;

/**
 * The credential variables of the naming scheme, in either the bare or the
 * `_<NAME>` suffixed form.
 *
 * `HETZNER_ROBOT_USER` is deliberately absent: a Robot web-service user name is
 * an identifier, not a secret, and reporting it as a credential at rest would
 * put a CRITICAL on a value that is safe to write down. Its password is the
 * secret, and that one is here.
 */
const HETZNER_CREDENTIAL_VAR = new RegExp(
  `^(?:${CLOUD_TOKEN_ENV}|${ACCOUNT_TOKEN_ENV}|${ROBOT_PASSWORD_ENV})(?:_[A-Z0-9_]+)?$`,
);

/**
 * The same variables, matched inside raw text next to a literal value.
 *
 * This is the replacement for the original's whole-file Sanctum sweep, and it
 * exists for the same case: a config file that does not parse is the likeliest
 * place for a hand-pasted token to be hiding, and refusing to look there because
 * the JSON is broken would abandon the scan exactly where it is most needed.
 * Matching on the variable name rather than on the value's shape is what keeps
 * that sweep from firing on every hash in the file.
 */
const HETZNER_CREDENTIAL_ASSIGNMENT = new RegExp(
  `["']?(${CLOUD_TOKEN_ENV}|${ACCOUNT_TOKEN_ENV}|${ROBOT_PASSWORD_ENV})(?:_[A-Z0-9_]+)?["']?\\s*[:=]\\s*["']([^"'\\n]+)["']`,
  'g',
);

const BEARER_HEADER = /^Bearer\s+(\S+)/i;
const SECRET_KEY_NAME = /TOKEN|KEY|SECRET|PASSWORD/i;

/** `${VAR}`, `${env:VAR}`, `${VAR:-default}` — every reference form our clients accept. */
const ENV_REFERENCE = /\$\{[^}]+\}/;

/**
 * Values that are obviously a template rather than a credential. Kept narrow on
 * purpose: a scanner that guesses at placeholders starts excusing real secrets.
 * `YOUR_..._HERE` is the form our docs and every upstream example use, and
 * `<...>` is the other universal convention.
 */
const PLACEHOLDER = /^(YOUR[_A-Z0-9]*HERE|<[^>]*>)$/i;

/**
 * Keys whose child objects are MCP server entries. Every supported client uses
 * one of these, and the fact that they differ at all is why a single config
 * writer is impossible.
 */
const SERVER_CONTAINER_KEYS = new Set([
  'mcpServers', // Claude Code, Claude Desktop, Cursor, Kimi
  'mcp_servers', // Codex (TOML)
  'context_servers', // Zed
  'mcp', // OpenCode
]);

/** Object keys whose children are environment variables, across the client formats. */
const ENV_CONTAINER_KEYS = new Set(['env', 'environment']);

/**
 * Clients whose expansion of `${VAR}` in a config value is verified against
 * upstream documentation. `--fix` writes a reference only for these: a config
 * that references a variable the client never expands fails at spawn time, in a
 * place the user cannot see, which is strictly worse than the literal it
 * replaced. Kimi and Claude Desktop are pending verification, not excluded.
 */
const EXPANDS_ENV_REFERENCES = new Set(['claude-code', 'cursor']);

/** Guards against a pathological config blowing the stack. Real configs are ~4 deep. */
const MAX_WALK_DEPTH = 64;

/** POSIX permission bits that let someone other than the owner read the file. */
const GROUP_AND_OTHER_BITS = 0o077;

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/**
 * Doctor's own severity ladder, deliberately one rung taller than
 * `ValidationIssue['severity']`.
 *
 * `critical` exists so that a credential at rest can drive exit code 2 and be
 * told apart, fleet-wide and without parsing prose, from "your Codex config has
 * a syntax error". Everything an adapter reports as `error` stays `error`.
 */
export type DoctorSeverity = 'critical' | 'error' | 'warn' | 'info';

export interface DoctorFix {
  applied: boolean;
  detail: string;
}

export interface DoctorFinding {
  /** Machine-readable, kebab-case, stable — CI pipelines will match on it. */
  code: string;
  severity: DoctorSeverity;
  message: string;
  file?: string;
  /** Location inside the file, e.g. `["mcpServers","hetzner","env","HETZNER_TOKEN"]`. */
  keyPath?: string[];
  /** 1-indexed. Used when a match could not be attributed to a key path. */
  lines?: number[];
  /** What to do about it. For credential findings this leads with rotation. */
  remediation: string;
  fix?: DoctorFix;
}

export interface DoctorRuntimeReport {
  node: string;
  packageVersion: string;
  platform: NodeJS.Platform;
  cwd: string;
}

export interface DoctorConnectionReport {
  name: string;
  /**
   * Which Hetzner API this connection speaks to. Reported first because it, not
   * the name, decides what the connection can see: a `cloud` token and a
   * `hetzner` token can carry the same connection name and answer completely
   * different questions.
   */
  surface: Surface;
  /** Derived from the surface. Shown so the report states which host is being talked to. */
  baseUrl: string;
  /**
   * Human description of where the credential comes from. Never the credential.
   *
   * Named `credentialSource` rather than the original's `tokenSource` because on
   * the robot surface it is not a token: it is a user name and a password, from
   * two separate sources that can be configured independently and half-configured
   * by accident.
   */
  credentialSource: string;
  resolved: boolean;
  /** Redacted failure text when `resolved` is false. */
  error?: string;
  /**
   * Whether the resolved value has the expected shape — 64 base62 characters on
   * a bearer surface, merely non-empty on robot, where the password is chosen by
   * the user and has no shape to check. The value itself never leaves here.
   */
  wellFormed?: boolean;
  readOnly: boolean;
  allowDestructive: boolean;
  /** Defined in both the environment and the registry file; the environment won. */
  shadowsFile: boolean;
}

export interface DoctorClientReport {
  adapterId: string;
  client: string;
  scope: 'user' | 'project';
  label: string;
  path: string;
  installed: boolean;
  configExists: boolean;
  parseable: boolean;
  entryPresent: boolean;
  confidence: 'verified' | 'unverified';
  /** e.g. `@donedynamics/hetzner-mcp@1.4.2`, read back out of the installed entry. */
  packageSpec?: string;
  /** Server entries in this file that doctor did not attribute. See `allServers`. */
  unscannedEntries: number;
}

export interface DoctorReport {
  runtime: DoctorRuntimeReport;
  registrySource?: ConnectionRegistry['source'];
  registryPath?: string;
  connections: DoctorConnectionReport[];
  clients: DoctorClientReport[];
  findings: DoctorFinding[];
}

export interface DoctorOptions {
  /** Scan server entries we do not manage, not just ours. */
  allServers?: boolean;
  /** Attempt the conservative rewrites described at {@link planFixes}. */
  fix?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  packageVersion?: string;
  /**
   * The npm package name, which since 0.1.0 is not the same string as the
   * command. Passed in rather than read here so doctor stays a pure function of
   * its options — the CLI owns the manifest, and a test can drive a rename
   * without touching one.
   */
  packageName?: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The literal behind a fixable finding, held here for the duration of one run
 * and never attached to the finding itself — findings get serialised to JSON and
 * printed, and a secret on one would defeat the whole point.
 */
interface FixTarget {
  value: string;
  /** The value is a `Bearer <credential>` header, so the scheme must survive the rewrite. */
  bearer: boolean;
  adapter: McpClientAdapter;
}

type FixTargets = Map<string, FixTarget>;

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const packageVersion = options.packageVersion ?? 'unknown';
  const packageName = options.packageName ?? 'hetzner-mcp';

  const findings: DoctorFinding[] = [];
  const targets: FixTargets = new Map();

  // Connections first, and deliberately so: resolving a token registers it with
  // the redaction set, so the client scan that follows cannot print it even if
  // some future code path tries to.
  const { connections, registry } = await inspectConnections(env, cwd, homeDir, platform, findings);

  const ctx: InstallCtx = {
    homeDir,
    projectRoot: cwd,
    platform,
    packageSpec: `${packageName}@${packageVersion}`,
    transport: 'stdio',
  };
  const scan: ScanOptions = {
    allServers: options.allServers === true,
    targets,
    scannedFiles: new Set<string>(),
  };
  const clients = await inspectClients(ctx, scan, findings);

  reportVersionDrift(clients, packageVersion, findings);
  if (platform === 'win32' && clients.some((client) => client.configExists)) {
    findings.push(aclNotChecked());
  }

  // Deduplicated before `--fix` runs, so a literal reachable through two
  // adapters is repaired once rather than merged into the same file twice.
  const unique = dedupe(findings);
  if (options.fix === true) await applyFixes(unique, targets, env);

  const report: DoctorReport = {
    runtime: { node: process.version, packageVersion, platform, cwd },
    connections,
    clients,
    findings: unique.sort(bySeverityThenCode),
  };
  if (registry !== undefined) {
    report.registrySource = registry.source;
    if (registry.configPath !== undefined) report.registryPath = registry.configPath;
  }
  return report;
}

/** 0 clean · 1 something needs attention · 2 a credential is at rest. */
export function doctorExitCode(report: DoctorReport): number {
  if (report.findings.some((finding) => finding.severity === 'critical')) return 2;
  const actionable = report.findings.some(
    (finding) => finding.severity === 'error' || finding.severity === 'warn',
  );
  return actionable ? 1 : 0;
}

/**
 * Two adapters can describe the same file — Cursor's user and project adapters
 * collide when the working directory is the home directory — and each runs its
 * own `validate()`. Identical findings are collapsed so the report says each
 * thing once. A repeated CRITICAL is how a report loses its reader.
 */
function dedupe(findings: DoctorFinding[]): DoctorFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = [
      finding.code,
      finding.file ?? '',
      (finding.keyPath ?? []).join('.'),
      finding.message,
    ].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SEVERITY_ORDER: Record<DoctorSeverity, number> = { critical: 0, error: 1, warn: 2, info: 3 };

function bySeverityThenCode(a: DoctorFinding, b: DoctorFinding): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface ConnectionsResult {
  connections: DoctorConnectionReport[];
  registry?: ConnectionRegistry;
  /** Problems found while resolving, e.g. `env-var-shadows-file`. */
  findings: DoctorFinding[];
}

/**
 * The connection half of doctor, on its own — this is what `hetzner-mcp
 * connections` prints. Shared rather than reimplemented so the two commands can
 * never disagree about where a credential comes from, which is the single fact
 * both exist to report.
 */
export async function reportConnections(
  options: Pick<DoctorOptions, 'env' | 'cwd' | 'homeDir' | 'platform'> = {},
): Promise<ConnectionsResult> {
  const findings: DoctorFinding[] = [];
  const result = await inspectConnections(
    options.env ?? process.env,
    options.cwd ?? process.cwd(),
    options.homeDir ?? homedir(),
    options.platform ?? process.platform,
    findings,
  );
  return { ...result, findings };
}

async function inspectConnections(
  env: NodeJS.ProcessEnv,
  cwd: string,
  homeDir: string,
  platform: NodeJS.Platform,
  findings: DoctorFinding[],
): Promise<Omit<ConnectionsResult, 'findings'>> {
  // BEFORE resolution, deliberately. Both diagnoses below describe a set of
  // environment variables that resolution itself may choke on — a half
  // configured robot connection is exactly the case where `resolveRegistry`
  // throws — and a diagnosis that only appears when the thing it explains did
  // not happen is no diagnosis at all.
  findings.push(...inspectCredentialEnv(env));

  let registry: ConnectionRegistry;
  try {
    registry = await resolveRegistry(env, cwd, homeDir, { platform });
  } catch (error: unknown) {
    // Not fatal. A user whose connections are unconfigured still needs the
    // client scan — that is where the plaintext credential they are about to be
    // told about is going to be found.
    findings.push({
      code: 'no-connections',
      severity: 'warn',
      message: 'No usable Hetzner connection is configured.',
      remediation: redact(errorText(error)),
    });
    return { connections: [] };
  }

  if (registry.shadowed.length > 0) findings.push(envShadowsFile(registry));

  const fileConfig = await loadRegistryFile(registry.configPath);
  const connections: DoctorConnectionReport[] = [];
  for (const connection of registry.connections.values()) {
    connections.push(await inspectConnection(connection, registry, fileConfig, env));
  }
  return { connections, registry };
}

// ---------------------------------------------------------------------------
// The credential naming scheme
// ---------------------------------------------------------------------------

/**
 * One credential-shaped variable, decoded.
 *
 * `HETZNER_TOKEN_PROD` is not just a variable that happens to be set; it is a
 * claim that a connection called `prod` exists on the `cloud` surface. Decoding
 * the claim is what makes the two diagnoses below possible at all — both are
 * about variables that are individually valid and collectively wrong.
 */
interface CredentialVar {
  variable: string;
  surface: Surface;
  connection: string;
  /** Robot needs two variables; this says which half of the pair this one is. */
  role: 'token' | 'user' | 'password';
}

const CREDENTIAL_PREFIXES: ReadonlyArray<{
  prefix: string;
  surface: Surface;
  role: CredentialVar['role'];
}> = [
  // Longest prefix first. No two of these four are currently prefixes of one
  // another, so the order is defensive rather than load-bearing — but a fifth
  // variable added later most likely would be, and a scan that got the wrong
  // one would invent a connection name rather than fail.
  { prefix: ROBOT_PASSWORD_ENV, surface: 'robot', role: 'password' },
  { prefix: ROBOT_USER_ENV, surface: 'robot', role: 'user' },
  { prefix: ACCOUNT_TOKEN_ENV, surface: 'hetzner', role: 'token' },
  { prefix: CLOUD_TOKEN_ENV, surface: 'cloud', role: 'token' },
];

/**
 * Every credential variable the environment currently sets, decoded.
 *
 * Bare and suffixed forms are decoded the same way: `HETZNER_TOKEN` claims the
 * connection {@link bareConnectionName} gives for its surface, and
 * `HETZNER_TOKEN_PROD` claims `prod`.
 */
export function credentialVars(env: NodeJS.ProcessEnv): CredentialVar[] {
  const found: CredentialVar[] = [];
  for (const variable of Object.keys(env)) {
    if (readEnvValue(env, variable) === undefined) continue;
    const match = CREDENTIAL_PREFIXES.find(
      (candidate) => variable === candidate.prefix || variable.startsWith(`${candidate.prefix}_`),
    );
    if (match === undefined) continue;

    const suffix = variable.slice(match.prefix.length + 1);
    found.push({
      variable,
      surface: match.surface,
      connection:
        suffix === '' ? bareConnectionName(match.surface) : connectionNameFromEnvSuffix(suffix),
      role: match.role,
    });
  }
  return found;
}

/**
 * The two ways this naming scheme goes wrong that nothing else can catch.
 *
 * Neither is a malformed variable — every variable involved is spelled correctly
 * and set to something real. The mistake is in the SET of them, which is why it
 * has to be diagnosed here rather than at the point any one of them is read.
 */
function inspectCredentialEnv(env: NodeJS.ProcessEnv): DoctorFinding[] {
  const declared = credentialVars(env);
  return [...collisionFindings(declared), ...robotPairFindings(declared)];
}

/**
 * The same connection name claimed on two surfaces.
 *
 * `HETZNER_TOKEN_PROD` and `HETZNER_ACCOUNT_TOKEN_PROD` both define a connection
 * called `prod`, on `cloud` and on `hetzner` respectively. Which one a tool call
 * naming `connection: "prod"` reaches is then decided by whatever order the
 * registry happened to build them in — and the two answer different questions
 * about different resources. A user who has done this is not going to see it by
 * reading their own shell profile: the variables look unrelated.
 */
function collisionFindings(declared: readonly CredentialVar[]): DoctorFinding[] {
  const bySurface = new Map<string, Set<Surface>>();
  const byName = new Map<string, Set<string>>();
  for (const item of declared) {
    surfacesOf(bySurface, item.connection).add(item.surface);
    variablesOf(byName, item.connection).add(item.variable);
  }

  const findings: DoctorFinding[] = [];
  for (const [connection, surfaces] of bySurface) {
    if (surfaces.size < 2) continue;
    const variables = [...(byName.get(connection) ?? [])].sort();
    findings.push({
      code: 'connection-name-collision',
      severity: 'error',
      message:
        `${variables.join(' and ')} both define a connection named "${connection}", on the ` +
        `${[...surfaces].sort().join(' and ')} surfaces. A connection name identifies exactly one ` +
        '(surface, credential) pair, so one of these definitions is unreachable — and which one ' +
        'depends on registry construction order rather than on anything you wrote.',
      remediation:
        `Rename one of them, e.g. ${suggestRename(variables)}. The surfaces are different APIs on ` +
        'different hosts holding different resources, so a name that means both is a name that means neither.',
    });
  }
  return findings;
}

function surfacesOf(map: Map<string, Set<Surface>>, key: string): Set<Surface> {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = new Set<Surface>();
  map.set(key, created);
  return created;
}

function variablesOf(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  map.set(key, created);
  return created;
}

/** Names a concrete replacement rather than saying "pick another name". */
function suggestRename(variables: readonly string[]): string {
  const first = variables[0] ?? '';
  return `${first} -> ${first}_1`;
}

/**
 * Half a Robot connection.
 *
 * Robot is the only surface authenticated with HTTP Basic, so its credential is
 * two variables that must both be present. Setting one is the ordinary shape of
 * the mistake — a password added to a secret store and a user name added to a
 * shell profile, and only one of the two ever exported. The connection then
 * either fails to exist or fails to authenticate, and neither symptom names the
 * variable that is missing.
 */
function robotPairFindings(declared: readonly CredentialVar[]): DoctorFinding[] {
  const users = new Map<string, string>();
  const passwords = new Map<string, string>();
  for (const item of declared) {
    if (item.surface !== 'robot') continue;
    if (item.role === 'user') users.set(item.connection, item.variable);
    if (item.role === 'password') passwords.set(item.connection, item.variable);
  }

  const findings: DoctorFinding[] = [];
  for (const [connection, variable] of users) {
    if (passwords.has(connection)) continue;
    findings.push(
      halfRobotConnection(
        connection,
        variable,
        counterpart(variable, ROBOT_USER_ENV, ROBOT_PASSWORD_ENV),
      ),
    );
  }
  for (const [connection, variable] of passwords) {
    if (users.has(connection)) continue;
    findings.push(
      halfRobotConnection(
        connection,
        variable,
        counterpart(variable, ROBOT_PASSWORD_ENV, ROBOT_USER_ENV),
      ),
    );
  }
  return findings;
}

/** `HETZNER_ROBOT_USER_PROD` -> `HETZNER_ROBOT_PASSWORD_PROD`; bare stays bare. */
function counterpart(present: string, presentPrefix: string, missingPrefix: string): string {
  const suffix = present.slice(presentPrefix.length);
  return `${missingPrefix}${suffix}`;
}

function halfRobotConnection(connection: string, present: string, missing: string): DoctorFinding {
  return {
    code: 'robot-credentials-incomplete',
    severity: 'error',
    message:
      `${present} is set but ${missing} is not, so the robot connection "${connection}" is only half ` +
      'configured. Robot authenticates with HTTP Basic: a user without a password is not a credential.',
    remediation:
      `Export ${missing} as well, or unset ${present} if this connection was not meant to exist. ` +
      'The Robot web-service user and its password are set together under Robot > Settings > ' +
      'Web service and app settings — they are NOT your Hetzner account login.',
  };
}

async function inspectConnection(
  connection: Connection,
  registry: ConnectionRegistry,
  fileConfig: ConfigFile | undefined,
  env: NodeJS.ProcessEnv,
): Promise<DoctorConnectionReport> {
  const report: DoctorConnectionReport = {
    name: connection.name,
    surface: connection.surface,
    baseUrl: connection.baseUrl,
    credentialSource: describeCredentialSource(
      connection.name,
      connection.surface,
      fileConfig,
      env,
    ),
    resolved: false,
    readOnly: connection.readOnly,
    allowDestructive: connection.allowDestructive,
    shadowsFile: registry.shadowed.includes(connection.name),
  };

  try {
    // A real resolution, prompts and all: "is the variable set" answers a
    // different question from "does `op read` actually return the credential",
    // and only the second predicts whether the server will work.
    const credential = await connection.credential.resolve();
    report.resolved = true;
    report.wellFormed = isWellFormed(credential);
  } catch (error: unknown) {
    report.error = redact(errorText(error));
  }
  return report;
}

/**
 * Whether a resolved credential looks like one.
 *
 * Only the bearer surfaces have a shape to check. A Robot password is chosen by
 * the user, so the only thing that can be said about it is that it is not empty
 * — and claiming to have validated it would be worse than saying nothing.
 */
function isWellFormed(credential: { token: string } | { user: string; password: string }): boolean {
  if ('token' in credential) return HETZNER_TOKEN_SHAPE.test(credential.token.trim());
  return credential.user.trim() !== '' && credential.password.trim() !== '';
}

/**
 * Describes where a connection's credential comes from, without reading it.
 *
 * `Connection` intentionally exposes only `credential.resolve`, so the source is
 * re-derived from the same two inputs `config/resolve.ts` used. That
 * duplication is the price of the connection object carrying no provenance, and
 * it is worth paying: "which of my source options is this connection actually
 * using" is a question doctor exists to answer.
 *
 * Split on the surface's auth scheme rather than on the connection: `robot` has
 * a pair of sources and the bearer surfaces have one, and a single code path
 * over both would have to describe a user name it may not have.
 */
function describeCredentialSource(
  name: string,
  surface: Surface,
  fileConfig: ConfigFile | undefined,
  env: NodeJS.ProcessEnv,
): string {
  return SURFACE_AUTH[surface] === 'basic'
    ? describeBasicSource(name, fileConfig, env)
    : describeBearerSource(name, surface, fileConfig, env);
}

function describeBearerSource(
  name: string,
  surface: Surface,
  fileConfig: ConfigFile | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const entry = fileConfig?.connections[name];

  if (entry?.tokenCommand !== undefined) return `tokenCommand: ${entry.tokenCommand.join(' ')}`;
  if (entry?.tokenKeychain !== undefined) {
    return `tokenKeychain: service "${entry.tokenKeychain.service}", account "${entry.tokenKeychain.account}"`;
  }
  if (entry?.tokenEnv !== undefined) return envSourceLabel(entry.tokenEnv, env, 'declared');

  const [conventional = ''] = conventionalCredentialVars(surface, name);
  if (readEnvValue(env, conventional) !== undefined) {
    return envSourceLabel(conventional, env, 'by convention');
  }
  // The bare form defines exactly one connection per surface, and only that one
  // — `HETZNER_TOKEN` is the `default` cloud connection, never `prod`.
  const [bare = ''] = bareCredentialVars(surface);
  if (name === bareConnectionName(surface) && readEnvValue(env, bare) !== undefined) {
    return envSourceLabel(bare, env, 'by convention');
  }
  return `$${conventional} (by convention, unset)`;
}

function describeBasicSource(
  name: string,
  fileConfig: ConfigFile | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const entry = fileConfig?.connections[name];

  if (entry?.credentialKeychain !== undefined) {
    return `credentialKeychain: service "${entry.credentialKeychain.service}", account "${entry.credentialKeychain.account}"`;
  }

  const [conventionalUser = '', conventionalPassword = ''] = conventionalCredentialVars(
    'robot',
    name,
  );
  const [bareUser = '', barePassword = ''] = bareCredentialVars('robot');
  const bare = name === bareConnectionName('robot');

  const user =
    entry?.userEnv !== undefined
      ? envSourceLabel(entry.userEnv, env, 'declared')
      : readEnvValue(env, conventionalUser) === undefined && bare
        ? envSourceLabel(bareUser, env, 'by convention')
        : envSourceLabel(conventionalUser, env, 'by convention');

  const password =
    entry?.passwordCommand !== undefined
      ? `passwordCommand: ${entry.passwordCommand.join(' ')}`
      : entry?.passwordEnv !== undefined
        ? envSourceLabel(entry.passwordEnv, env, 'declared')
        : readEnvValue(env, conventionalPassword) === undefined && bare
          ? envSourceLabel(barePassword, env, 'by convention')
          : envSourceLabel(conventionalPassword, env, 'by convention');

  return `user ${user}, password ${password}`;
}

function envSourceLabel(variable: string, env: NodeJS.ProcessEnv, how: string): string {
  const state = readEnvValue(env, variable) === undefined ? 'unset' : 'set';
  return `$${variable} (${how}, ${state})`;
}

async function loadRegistryFile(configPath: string | undefined): Promise<ConfigFile | undefined> {
  if (configPath === undefined) return undefined;
  try {
    const text = await fs.readFile(configPath, 'utf8');
    return parseConfigFile(JSON.parse(stripBom(text)) as unknown, configPath);
  } catch {
    // resolveRegistry already succeeded on this file, so a failure here is a
    // race or a permission change. The credential source degrades to "by
    // convention" rather than taking the whole report down.
    return undefined;
  }
}

function envShadowsFile(registry: ConnectionRegistry): DoctorFinding {
  const many = registry.shadowed.length > 1;
  const finding: DoctorFinding = {
    code: 'env-var-shadows-file',
    severity: 'warn',
    message:
      `Connection${many ? 's' : ''} ${registry.shadowed.join(', ')} ${many ? 'are' : 'is'} defined in both the ` +
      "environment and the registry file. The environment definition replaces the file's one WHOLE — no field is merged, " +
      'so settings such as readOnly written in the file are not in effect.',
    remediation:
      'Delete one of the two definitions. If the file entry is the one you edit, unset the matching ' +
      `${CLOUD_TOKEN_ENV}_<NAME> / ${ACCOUNT_TOKEN_ENV}_<NAME> / ${ROBOT_USER_ENV}_<NAME> in whichever ` +
      'client config or shell profile exports it.',
  };
  if (registry.configPath !== undefined) finding.file = registry.configPath;
  return finding;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

interface ScanOptions {
  allServers: boolean;
  targets: FixTargets;
  /**
   * Files already scanned this run.
   *
   * Two adapters can resolve to the same file — Cursor's user and project
   * adapters both name `.cursor/mcp.json`, and they collide whenever the working
   * directory is the home directory. Without this, that file's credential
   * findings would be reported twice, and a duplicated CRITICAL is how a report
   * loses the reader's trust.
   */
  scannedFiles: Set<string>;
}

async function inspectClients(
  ctx: InstallCtx,
  options: ScanOptions,
  findings: DoctorFinding[],
): Promise<DoctorClientReport[]> {
  const reports: DoctorClientReport[] = [];
  for (const adapter of ADAPTERS) {
    reports.push(await inspectClient(adapter, ctx, options, findings));
  }
  return reports;
}

async function inspectClient(
  adapter: McpClientAdapter,
  ctx: InstallCtx,
  options: ScanOptions,
  findings: DoctorFinding[],
): Promise<DoctorClientReport> {
  const detection = await detectSafely(adapter, ctx);
  const entry = await readEntrySafely(adapter, ctx);
  const spec = extractPackageSpec(entry);

  const report: DoctorClientReport = {
    adapterId: adapter.id,
    client: adapter.client,
    scope: adapter.scope,
    label: adapter.label,
    path: detection.path,
    installed: detection.installed,
    configExists: detection.configExists,
    parseable: detection.parseable,
    entryPresent: entry !== null && entry !== undefined,
    confidence: adapter.confidence,
    unscannedEntries: 0,
  };
  if (spec !== undefined) report.packageSpec = spec;

  if (adapter.confidence === 'unverified' && detection.installed) {
    findings.push(unverifiedAdapter(adapter, detection.path));
  }
  const reported = new Set<string>();
  for (const issue of await validateSafely(adapter, ctx)) {
    reported.add(issue.code);
    findings.push(fromValidationIssue(issue, detection.path));
  }
  if (!detection.configExists || options.scannedFiles.has(detection.path)) return report;
  options.scannedFiles.add(detection.path);

  await checkPermissions(detection.path, ctx.platform, findings);
  report.unscannedEntries = await scanConfigFile(
    adapter,
    detection.path,
    options,
    findings,
    reported,
  );
  return report;
}

/**
 * Whether an adapter already reported that its config does not parse. Adapters
 * word this per client (`codex-config-unparseable`, `claude-code-config-unparseable`),
 * so it is matched on the shape of the code rather than on a list that would go
 * stale the moment an adapter is added.
 */
function alreadyReportedParseFailure(codes: Set<string>): boolean {
  for (const code of codes) if (/unparseable|parse-failed|parse-error/.test(code)) return true;
  return false;
}

/**
 * Adapters do I/O, and a broken one must not take the whole report down: doctor
 * is the tool you reach for *because* something is wrong, so it has to survive
 * more breakage than anything else in this codebase.
 */
async function detectSafely(adapter: McpClientAdapter, ctx: InstallCtx): Promise<Detection> {
  try {
    return await adapter.detect(ctx);
  } catch {
    return {
      installed: false,
      configExists: false,
      parseable: false,
      path: resolvePathSafely(adapter, ctx),
    };
  }
}

function resolvePathSafely(adapter: McpClientAdapter, ctx: InstallCtx): string {
  try {
    return adapter.resolvePath(ctx);
  } catch {
    return `<unresolved: ${adapter.id}>`;
  }
}

async function readEntrySafely(
  adapter: McpClientAdapter,
  ctx: InstallCtx,
): Promise<unknown | null> {
  try {
    return await adapter.readEntry(ctx);
  } catch {
    return null;
  }
}

async function validateSafely(
  adapter: McpClientAdapter,
  ctx: InstallCtx,
): Promise<ValidationIssue[]> {
  try {
    return await adapter.validate(ctx);
  } catch (error: unknown) {
    return [
      {
        severity: 'warn',
        code: 'adapter-validate-failed',
        message: `${adapter.id} could not be validated: ${errorText(error)}`,
      },
    ];
  }
}

function fromValidationIssue(issue: ValidationIssue, file: string): DoctorFinding {
  return {
    code: issue.code,
    severity: issue.severity,
    message: redact(issue.message),
    file,
    remediation: redact(issue.fix ?? `See docs/clients/ for this client's config format.`),
  };
}

function unverifiedAdapter(adapter: McpClientAdapter, file: string): DoctorFinding {
  return {
    code: 'unverified-adapter-present',
    severity: 'warn',
    message: `${adapter.label} is installed, but its MCP config key has not been verified against upstream documentation, so hetzner-mcp will not write to it.`,
    file,
    remediation:
      `Run \`hetzner-mcp install --client ${adapter.client} --print\` and paste the snippet yourself. ` +
      'Writing a guessed key is how an installer corrupts an unrelated part of a user config — this refusal is what prevents that.',
  };
}

// ---------------------------------------------------------------------------
// File permissions
// ---------------------------------------------------------------------------

async function checkPermissions(
  file: string,
  platform: NodeJS.Platform,
  findings: DoctorFinding[],
): Promise<void> {
  // Node reports a synthesised mode on Windows (0o666 / 0o444) that reflects
  // only the read-only attribute, so testing it there would produce a verdict
  // about a permission model Windows does not use. See `aclNotChecked`.
  if (platform === 'win32') return;

  let mode: number;
  try {
    mode = (await fs.stat(file)).mode;
  } catch {
    return;
  }
  if ((mode & GROUP_AND_OTHER_BITS) === 0) return;

  findings.push({
    code: 'world-readable-config',
    severity: 'warn',
    message: `Mode ${(mode & 0o777).toString(8).padStart(3, '0')} — readable by users other than its owner.`,
    file,
    remediation:
      `\`chmod 600 ${file}\`. MCP client configs carry environment blocks, and on a shared box or a ` +
      'CI runner every other account can read whatever ends up in one.',
  });
}

function aclNotChecked(): DoctorFinding {
  return {
    code: 'acl-not-checked',
    severity: 'info',
    message:
      'File permissions were NOT checked. Windows uses ACLs rather than POSIX mode bits and doctor does not read ACLs, so reporting "permissions OK" here would be a claim it has not verified.',
    remediation:
      'Check by hand if this machine is shared: `icacls "%USERPROFILE%\\.claude.json"`. Files under your user profile are normally readable only by you and by Administrators.',
  };
}

// ---------------------------------------------------------------------------
// Credential scanning
// ---------------------------------------------------------------------------

interface StringNode {
  key: string;
  parentKey: string;
  keyPath: string[];
  value: string;
}

interface ParsedConfig {
  text: string;
  value: unknown;
  parseError?: string;
}

/**
 * Scans one client config. Returns the number of server entries that were
 * present but deliberately not attributed, so the caller can tell the user what
 * `--all-servers` would add.
 */
async function scanConfigFile(
  adapter: McpClientAdapter,
  file: string,
  options: ScanOptions,
  findings: DoctorFinding[],
  reported: Set<string>,
): Promise<number> {
  const parsed = await readAndParse(file, adapter.format);
  if (parsed === undefined) return 0;
  if (parsed.parseError !== undefined && !alreadyReportedParseFailure(reported)) {
    findings.push(parseFailure(adapter, file, parsed.parseError));
  }

  const entries = findServerEntries(parsed.value);
  const scanned = options.allServers ? entries : entries.filter((entry) => entry.ours);

  const nodes: StringNode[] = [];
  if (options.allServers) collectStrings(parsed.value, [], nodes, 0);
  else for (const entry of scanned) collectStrings(entry.value, entry.keyPath, nodes, 0);

  const seenTokens = new Set<string>();
  for (const node of nodes) {
    const result = classify(node, file, adapter, seenTokens);
    if (result === undefined) continue;
    findings.push(result.finding);
    if (result.literal !== undefined) {
      options.targets.set(targetKey(file, node.keyPath), { ...result.literal, adapter });
    }
  }

  // Unconditional whole-file sweep for the Sanctum shape, whatever the scan
  // scope is. Scoping the *attributed* scan keeps the report about the user's
  // own installation; staying silent about a live credential we literally read
  // would be indefensible. The leftovers are reported by line number, since by
  // definition they have no key path we walked to.
  const stray = strayTokenLines(parsed.text, seenTokens);
  if (stray.length > 0) {
    findings.push(strayCredential(file, stray, options.allServers, parsed.value !== undefined));
  }

  return entries.length - scanned.length;
}

async function readAndParse(
  file: string,
  format: McpClientAdapter['format'],
): Promise<ParsedConfig | undefined> {
  let text: string;
  try {
    text = stripBom(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }

  try {
    if (format === 'json') return { text, value: JSON.parse(text) as unknown };
    if (format === 'toml') return { text, value: parseToml(text) };
    if (format === 'yaml') return { text, value: parseYaml(text) as unknown };

    const errors: ParseError[] = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
    const first = errors[0];
    if (first === undefined) return { text, value };
    return {
      text,
      value,
      parseError: `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    };
  } catch (error: unknown) {
    // The text is still returned: an unparseable config is precisely the one
    // most likely to have been hand-edited with a token pasted into it.
    return { text, value: undefined, parseError: errorText(error) };
  }
}

function parseFailure(adapter: McpClientAdapter, file: string, detail: string): DoctorFinding {
  const code =
    adapter.client === 'codex'
      ? 'codex-config-unparseable'
      : adapter.format === 'jsonc'
        ? 'jsonc-parse-failed'
        : `${adapter.format}-parse-failed`;

  return {
    code,
    severity: 'error',
    message: `Does not parse as ${adapter.format.toUpperCase()}: ${redact(detail)}`,
    file,
    remediation:
      'Fix the syntax before installing anything. hetzner-mcp refuses to write into a file it cannot parse, ' +
      'because appending to a broken config turns a five-second repair into an archaeology exercise — and this ' +
      'file usually holds every other MCP server on the machine too.',
  };
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

interface ServerEntryNode {
  name: string;
  keyPath: string[];
  value: unknown;
  ours: boolean;
}

/**
 * Locates MCP server entries anywhere in a parsed config.
 *
 * Searched by container key rather than at a fixed depth: Zed nests
 * `context_servers` under a settings root, Codex uses a TOML table, and a
 * project-scoped Claude config puts `mcpServers` under a project path.
 */
function findServerEntries(root: unknown): ServerEntryNode[] {
  const found: ServerEntryNode[] = [];
  walkObjects(root, [], 0, (node, keyPath) => {
    for (const [key, child] of Object.entries(node)) {
      if (!SERVER_CONTAINER_KEYS.has(key) || !isPlainObject(child)) continue;
      for (const [name, entry] of Object.entries(child)) {
        found.push({
          name,
          keyPath: [...keyPath, key, name],
          value: entry,
          ours: isOurs(name, entry),
        });
      }
    }
  });
  return found;
}

function walkObjects(
  value: unknown,
  keyPath: string[],
  depth: number,
  visit: (node: Record<string, unknown>, keyPath: string[]) => void,
): void {
  if (depth > MAX_WALK_DEPTH || !isPlainObject(value)) return;
  visit(value, keyPath);
  for (const [key, child] of Object.entries(value)) {
    walkObjects(child, [...keyPath, key], depth + 1, visit);
  }
}

/**
 * Whether an entry is ours.
 *
 * Matched on the package name inside the entry rather than on a constant shared
 * with the installer, because the entry we most need to find is the one a user
 * added by hand before this CLI existed — and that one was never written by our
 * writer, so it carries none of our bookkeeping.
 */
function isOurs(name: string, entry: unknown): boolean {
  if (/hetzner/i.test(name)) return true;
  try {
    return /hetzner-mcp/i.test(JSON.stringify(entry) ?? '');
  } catch {
    return false;
  }
}

function collectStrings(value: unknown, keyPath: string[], out: StringNode[], depth: number): void {
  if (depth > MAX_WALK_DEPTH) return;

  if (typeof value === 'string') {
    out.push({
      key: keyPath[keyPath.length - 1] ?? '',
      parentKey: keyPath[keyPath.length - 2] ?? '',
      keyPath,
      value,
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectStrings(item, [...keyPath, String(index)], out, depth + 1),
    );
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, [...keyPath, key], out, depth + 1);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Classification — precision order
// ---------------------------------------------------------------------------

interface Classified {
  finding: DoctorFinding;
  /** Present when `--fix` could act on this node. */
  literal?: { value: string; bearer: boolean };
}

/**
 * At most one finding per string node, most precise rule first.
 *
 * The order matters more than the individual rules do. A literal Hetzner token
 * in `headers.Authorization` satisfies all three tests, and reporting it three
 * times would bury the one that says "rotate this now" under two that say
 * "consider using a variable".
 *
 * The first rule is where this diverges from the Coolify original. There, the
 * CRITICAL rung was earned by the VALUE — the Sanctum shape is unmistakable, so
 * a match anywhere was proof. A Hetzner token has no such shape (see
 * {@link HETZNER_TOKEN_SHAPE}), so the CRITICAL rung is earned by the LOCATION:
 * a variable that the naming scheme says holds a credential, set to something
 * that is not a reference and not a placeholder. That is proof of the same
 * thing — a credential at rest — without ever guessing from 64 characters of
 * base62 that happen to be a checksum.
 */
function classify(
  node: StringNode,
  file: string,
  adapter: McpClientAdapter,
  seenTokens: Set<string>,
): Classified | undefined {
  if (isCredentialLiteral(node)) {
    seenTokens.add(node.value.trim());
    return {
      finding: plaintextCredential(file, node, adapter),
      literal: { value: node.value, bearer: false },
    };
  }

  const bearer = BEARER_HEADER.exec(node.value);
  if (bearer !== null && isHeaderNode(node)) {
    const credential = bearer[1] ?? '';
    if (!ENV_REFERENCE.test(node.value) && !PLACEHOLDER.test(credential)) {
      return {
        finding: bearerLiteral(file, node, adapter),
        literal: { value: credential, bearer: true },
      };
    }
  }

  if (
    ENV_CONTAINER_KEYS.has(node.parentKey) &&
    SECRET_KEY_NAME.test(node.key) &&
    node.value !== '' &&
    !ENV_REFERENCE.test(node.value) &&
    !PLACEHOLDER.test(node.value)
  ) {
    return {
      finding: envLiteralSecret(file, node, adapter),
      literal: { value: node.value, bearer: false },
    };
  }
  return undefined;
}

function isHeaderNode(node: StringNode): boolean {
  return node.keyPath.some((segment) => segment.toLowerCase() === 'headers');
}

/**
 * A Hetzner credential written out where a reference belongs.
 *
 * All three conditions carry weight:
 *  - the KEY is one the naming scheme reserves for a credential, which is what
 *    makes this a certainty rather than a guess;
 *  - the value is not a `${VAR}` reference, which is the correct thing to find;
 *  - the value is not a documentation placeholder.
 *
 * The token SHAPE is not required. `HETZNER_TOKEN` set to a 30-character string
 * is a credential someone typed wrong, not a non-credential — refusing to report
 * it because it fails a length check would be the same silent miss the Coolify
 * original's `{40}` quantifier once caused.
 */
function isCredentialLiteral(node: StringNode): boolean {
  if (!ENV_CONTAINER_KEYS.has(node.parentKey)) return false;
  if (!HETZNER_CREDENTIAL_VAR.test(node.key)) return false;
  const value = node.value.trim();
  return value !== '' && !ENV_REFERENCE.test(value) && !PLACEHOLDER.test(value);
}

/**
 * The rotation text.
 *
 * It leads with rotation and does not soften it, because the alternative
 * framing — "move this into an environment variable" — implies the credential is
 * still trustworthy once moved. It is not. It has been readable on disk by every
 * process running as this user, and by every backup, sync client, screen share
 * and support bundle that ever touched the file.
 */
function rotationRemediation(
  adapter: McpClientAdapter,
  keyPath: string[],
  variable: string,
): string {
  const surface = surfaceOfVariable(variable);
  return [
    `ROTATE THIS ${surface === 'robot' ? 'PASSWORD' : 'TOKEN'} NOW. Treat it as compromised.`,
    `  1. ${REVOCATION_LOCATION[surface]}`,
    '  2. Keep the replacement in an environment variable and reference it here instead of pasting it:',
    `       ${keyPath.join('.')} = "${referenceExample(adapter, variable)}"`,
    `     then export ${variable} in the environment this client starts from.`,
    '  3. Re-run `hetzner-mcp doctor` and confirm this finding is gone.',
    'Moving the value without revoking it changes nothing about who already has it.',
  ].join('\n');
}

/**
 * Where each surface's credential is revoked.
 *
 * Three different places, which is why this is a table rather than one sentence:
 * a cloud token lives inside one project and is invisible from the account
 * console, and the Robot password is not a token at all.
 */
const REVOCATION_LOCATION: Readonly<Record<Surface, string>> = {
  cloud:
    'Hetzner Cloud Console > the project this token belongs to > Security > API tokens: revoke it, then issue a replacement. A cloud token is scoped to ONE project, so make sure you are in the right one.',
  hetzner:
    'Hetzner Console > API tokens (account-scoped, api.hetzner.com): revoke this token, then issue a replacement.',
  robot:
    'Robot > Settings > Web service and app settings: change the web-service password. This is the Robot API password, not your Hetzner account login.',
};

/** The surface a credential variable belongs to. Defaults to cloud, the bare form. */
function surfaceOfVariable(variable: string): Surface {
  const match = CREDENTIAL_PREFIXES.find(
    (candidate) => variable === candidate.prefix || variable.startsWith(`${candidate.prefix}_`),
  );
  return match?.surface ?? 'cloud';
}

function plaintextCredential(
  file: string,
  node: StringNode,
  adapter: McpClientAdapter,
): DoctorFinding {
  return {
    code: 'plaintext-credential',
    severity: 'critical',
    // The file is carried in `file` and printed on the heading line; repeating
    // it in the message turns every finding into two lines of absolute path.
    message: `A Hetzner credential is stored in plaintext at ${node.keyPath.join('.')} — ${node.key} holds a literal value rather than a \${VAR} reference.`,
    file,
    keyPath: node.keyPath,
    remediation: rotationRemediation(adapter, node.keyPath, node.key),
  };
}

function bearerLiteral(file: string, node: StringNode, adapter: McpClientAdapter): DoctorFinding {
  return {
    code: 'bearer-literal',
    severity: 'warn',
    message: `${node.keyPath.join('.')} is a literal Bearer credential rather than an environment reference.`,
    file,
    keyPath: node.keyPath,
    remediation:
      `Replace the value with "Bearer ${referenceExample(adapter)}" and export the variable in the environment ` +
      'this client starts from. If the literal is a live credential, rotate it too — it has been at rest in a config file.',
  };
}

function envLiteralSecret(
  file: string,
  node: StringNode,
  adapter: McpClientAdapter,
): DoctorFinding {
  return {
    code: 'env-literal-secret',
    severity: 'warn',
    message: `${node.keyPath.join('.')} sets a credential-shaped variable to a literal value.`,
    file,
    keyPath: node.keyPath,
    remediation:
      `Reference the variable instead: "${node.key}": "${referenceExample(adapter, node.key)}". ` +
      'If the literal is a live credential, rotate it — a config file is not a secret store.',
  };
}

/**
 * The reference syntax this client expands. Cursor is the odd one out with
 * `${env:NAME}`; every other supported client uses `${NAME}`.
 */
function referenceExample(adapter: McpClientAdapter, variable = 'HETZNER_TOKEN'): string {
  return adapter.client === 'cursor' ? `\${env:${variable}}` : `\${${variable}}`;
}

/**
 * The raw-text sweep, matched on the variable NAME rather than the value shape.
 *
 * The Coolify original swept for the Sanctum shape and could therefore find a
 * token in a comment, in a stale block, in a file too broken to parse — anywhere
 * at all. Hetzner tokens have no shape that survives that treatment, so the
 * sweep is anchored to the credential variable names instead. It keeps the case
 * that actually matters (an unparseable config with a pasted credential in it)
 * and gives up the one that never had a name attached, which the original could
 * only report by line number anyway.
 */
function strayTokenLines(text: string, seen: Set<string>): number[] {
  const lines: number[] = [];
  HETZNER_CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  for (
    let match = HETZNER_CREDENTIAL_ASSIGNMENT.exec(text);
    match !== null;
    match = HETZNER_CREDENTIAL_ASSIGNMENT.exec(text)
  ) {
    const value = (match[2] ?? '').trim();
    if (value === '' || ENV_REFERENCE.test(value) || PLACEHOLDER.test(value)) continue;
    if (!seen.has(value)) lines.push(lineOf(text, match.index));
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 0x0a) line += 1;
  return line;
}

function strayCredential(
  file: string,
  lines: number[],
  allServers: boolean,
  parsed: boolean,
): DoctorFinding {
  const many = lines.length > 1;
  return {
    code: 'plaintext-credential',
    severity: 'critical',
    message:
      `${many ? `${lines.length} Hetzner credentials are` : 'A Hetzner credential is'} stored in plaintext at ` +
      `line${many ? 's' : ''} ${lines.join(', ')}.`,
    file,
    lines,
    remediation: [
      `ROTATE EVERY CREDENTIAL AT ${many ? 'THESE LINES' : 'THIS LINE'}. Treat ${many ? 'them' : 'it'} as compromised.`,
      REVOCATION_LOCATION.cloud,
      REVOCATION_LOCATION.hetzner,
      REVOCATION_LOCATION.robot,
      whyByLine(allServers, parsed),
    ].join('\n'),
  };
}

/** Explains why this one came with a line number instead of a key path. */
function whyByLine(allServers: boolean, parsed: boolean): string {
  if (!parsed) {
    return 'Reported by line because the file does not parse, so nothing in it could be attributed to a key. Doctor scans the raw text regardless — an unparseable config is the likeliest place for a hand-pasted credential to be hiding.';
  }
  return allServers
    ? 'Reported by line because the match is not inside a server entry at all — most often a comment left behind after an edit.'
    : 'Re-run with --all-servers to find which server entry each one belongs to, or check the comments.';
}

// ---------------------------------------------------------------------------
// Version pinning
// ---------------------------------------------------------------------------

/**
 * Reads the package spec back out of an installed entry. Both `command` and
 * `args` are searched because the clients disagree on which one carries it: Zed
 * takes a command string, OpenCode takes an argv array.
 */
function extractPackageSpec(entry: unknown): string | undefined {
  if (!isPlainObject(entry)) return undefined;
  const words: string[] = [];

  const command = entry['command'];
  if (typeof command === 'string') words.push(...command.split(/\s+/));
  else if (Array.isArray(command))
    for (const part of command) if (typeof part === 'string') words.push(part);

  const args = entry['args'];
  if (Array.isArray(args)) for (const arg of args) if (typeof arg === 'string') words.push(arg);

  // Matched on the BARE name with an optional npm scope, not on the published
  // package name, and that is the point of the regex rather than an equality
  // check. The entry doctor most needs to read is an old one, written by a
  // different spelling of the same package: an unscoped `hetzner-mcp@…` beside a
  // scoped `@donedynamics/hetzner-mcp@…` is exactly the "clients disagree on
  // which one to run" case this function exists to find. An equality test
  // against the current name would go quiet on the entries that matter most.
  return words.find((word) => PACKAGE_WORD.test(word));
}

/** `hetzner-mcp`, `hetzner-mcp@1.4.2`, `@scope/hetzner-mcp@latest`. */
const PACKAGE_WORD = /^(?:@[\w.-]+\/)?hetzner-mcp(?:@.+)?$/;

function reportVersionDrift(
  clients: DoctorClientReport[],
  packageVersion: string,
  findings: DoctorFinding[],
): void {
  const specs = new Set(
    clients
      .map((client) => client.packageSpec)
      .filter((spec): spec is string => spec !== undefined),
  );
  if (specs.size === 0) return;

  if (specs.size > 1) {
    findings.push({
      code: 'pinned-version-mismatch',
      severity: 'warn',
      message: `Clients disagree on which hetzner-mcp to run: ${[...specs].sort().join(', ')}.`,
      remediation:
        'Reinstall with one spec everywhere — `hetzner-mcp install --all-detected --pin --update` writes the version ' +
        'you are running now into every client config. Two clients on two versions means two different tool surfaces, ' +
        'and a bug report that reproduces in only one of them.',
    });
    return;
  }

  const [only] = [...specs];
  if (only === undefined) return;

  // A bare `hetzner-mcp` is the locally installed binary: its version is whatever
  // the package manager put on disk, which is a pin by another name. Only an
  // explicit `@latest` re-resolves on every spawn.
  if (!only.includes('@')) return;
  const pinned = only.slice(only.indexOf('@') + 1);

  if (pinned === 'latest' || pinned === '') {
    findings.push({
      code: 'unpinned-version',
      severity: 'info',
      message: `Clients resolve hetzner-mcp at spawn time (${only}), so every start may execute code published since the last one.`,
      remediation:
        'Fine for one developer, out of policy at most companies. `hetzner-mcp install --all-detected --pin` writes an ' +
        `exact version (currently ${packageVersion}) into every client config, and you upgrade when you choose to.`,
    });
    return;
  }
  if (pinned !== packageVersion) {
    findings.push({
      code: 'pinned-version-mismatch',
      severity: 'info',
      message: `Clients are pinned to hetzner-mcp@${pinned}, but this CLI is ${packageVersion}.`,
      remediation:
        'Expected right after upgrading the CLI itself. `hetzner-mcp install --all-detected --pin --update` moves the ' +
        'pin; leave it alone if the older version is deliberate.',
    });
  }
}

// ---------------------------------------------------------------------------
// --fix
// ---------------------------------------------------------------------------

/**
 * The conservative fix.
 *
 * A literal is rewritten to `${VAR}` ONLY when `$VAR` is already exported with
 * exactly that value, and only for a client whose expansion of that syntax is
 * verified. Everything else prints instructions and changes nothing.
 *
 * Two things this deliberately does not do:
 *
 *  - It never invents a variable. Setting one durably means editing a shell
 *    profile, a launchd plist or a Windows user environment that this process
 *    cannot see, and a "fixed" config referencing a variable that is unset at
 *    spawn time is worse than the literal it replaced: it now fails inside the
 *    client, where the user has no diagnostics.
 *  - It never prints the value it matched. That would put the secret into shell
 *    history, terminal scrollback and CI logs — three places strictly worse than
 *    the config file being cleaned up.
 *
 * Rotation is recommended either way. A credential that has been at rest in
 * plaintext is burned regardless of what we do to the file now.
 */
type MergeWriter = (source: string, keyPath: readonly string[], value: unknown) => MergeResult;

interface PlannedFix {
  finding: DoctorFinding;
  file: string;
  keyPath: string[];
  /** The `${VAR}` reference that replaces the literal. */
  value: string;
  variable: string;
  write: MergeWriter;
}

async function applyFixes(
  findings: DoctorFinding[],
  targets: FixTargets,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const byFile = new Map<string, PlannedFix[]>();
  for (const fix of planFixes(findings, targets, env)) {
    const bucket = byFile.get(fix.file);
    if (bucket === undefined) byFile.set(fix.file, [fix]);
    else bucket.push(fix);
  }
  // Grouped per file rather than per finding: two literals in one config become
  // one read and one write, so nothing can crash between them.
  for (const [file, fixes] of byFile) await applyFixesToFile(file, fixes);
}

function planFixes(
  findings: DoctorFinding[],
  targets: FixTargets,
  env: NodeJS.ProcessEnv,
): PlannedFix[] {
  const planned: PlannedFix[] = [];
  for (const finding of findings) {
    if (finding.file === undefined || finding.keyPath === undefined) continue;
    const target = targets.get(targetKey(finding.file, finding.keyPath));
    if (target === undefined) continue;

    const fix = buildFix(finding, finding.file, finding.keyPath, target, env);
    if (fix !== undefined) planned.push(fix);
    else finding.fix = { applied: false, detail: NOT_FIXED };
  }
  return planned;
}

const NOT_FIXED =
  'Not fixed, by design. --fix rewrites a literal into ${VAR} only when $VAR is already exported with exactly ' +
  'that value and the client is known to expand the reference. At least one of those is false here, so nothing ' +
  'was changed — follow the remediation above by hand.';

function buildFix(
  finding: DoctorFinding,
  file: string,
  keyPath: string[],
  target: FixTarget,
  env: NodeJS.ProcessEnv,
): PlannedFix | undefined {
  if (!EXPANDS_ENV_REFERENCES.has(target.adapter.client)) return undefined;

  const write = writerFor(target.adapter.format);
  if (write === undefined) return undefined;

  const variable = variableHolding(env, target.value);
  if (variable === undefined) return undefined;

  const reference = referenceExample(target.adapter, variable);
  return {
    finding,
    file,
    keyPath,
    value: target.bearer ? `Bearer ${reference}` : reference,
    variable,
    write,
  };
}

async function applyFixesToFile(file: string, fixes: PlannedFix[]): Promise<void> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error: unknown) {
    for (const fix of fixes) fix.finding.fix = notApplied(errorText(error));
    return;
  }

  const staged: PlannedFix[] = [];
  for (const fix of fixes) {
    const result = fix.write(text, fix.keyPath, fix.value);
    const refusal = result.issues.find((issue) => issue.severity === 'error');
    if (refusal !== undefined) {
      fix.finding.fix = notApplied(refusal.message);
      continue;
    }
    if (!result.changed) {
      fix.finding.fix = notApplied('the writer reported nothing to change');
      continue;
    }
    text = result.text;
    staged.push(fix);
  }
  if (staged.length === 0) return;

  try {
    await writeAtomic(file, text);
  } catch (error: unknown) {
    for (const fix of staged) fix.finding.fix = notApplied(errorText(error));
    return;
  }
  for (const fix of staged) {
    fix.finding.fix = {
      applied: true,
      detail:
        `Rewritten to reference $${fix.variable}, which already held exactly this value. ` +
        "ROTATE THE TOKEN ANYWAY — the literal is in this file's history, in your backups, and in anything that ever synced it.",
    };
  }
}

function notApplied(reason: string): DoctorFix {
  return { applied: false, detail: `Not applied: ${redact(reason)}` };
}

/**
 * Writes through a sibling temp file and a rename.
 *
 * A client config holds every other MCP server on the machine, so a truncated
 * write does not break one integration, it breaks all of them. The original
 * mode is copied onto the temp file first: a tool that reports
 * `world-readable-config` must not be the thing that creates one, and plain
 * `writeFile` would apply the process umask to a file that was 0600.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.hetzner-mcp-${process.pid}.tmp`;
  const mode = await fs
    .stat(file)
    .then((stats) => stats.mode & 0o777)
    .catch(() => undefined);

  await fs.writeFile(temp, text, 'utf8');
  try {
    if (mode !== undefined) await fs.chmod(temp, mode).catch(() => undefined);
    await fs.rename(temp, file);
  } catch (error: unknown) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function variableHolding(env: NodeJS.ProcessEnv, literal: string): string | undefined {
  const needle = literal.trim();
  if (needle === '') return undefined;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() === needle) return key;
  }
  return undefined;
}

/**
 * Plain JSON goes through the JSONC writer too, on purpose.
 *
 * `mergeJson` re-serialises the whole document. That is right for an install,
 * where the file is small and the entry is ours to shape, and wrong here:
 * `~/.claude.json` also carries Claude Code's own project state, so reformatting
 * hundreds of kilobytes of it to change one string is a diff nobody asked for
 * and a change to bytes doctor never inspected. `mergeJsonc` edits text through
 * `modify`/`applyEdits`, so every byte outside the value survives — and JSONC is
 * a superset of JSON, so strict JSON in stays strict JSON out.
 */
function writerFor(format: McpClientAdapter['format']): MergeWriter | undefined {
  if (format === 'json' || format === 'jsonc') return mergeJsonc;
  if (format === 'yaml') return mergeYaml;
  // TOML is written a section at a time, so there is no way to set one key
  // without rewriting the table around it. Refusing beats reformatting
  // config.toml — the one file every Codex MCP server on the machine shares.
  return undefined;
}

function targetKey(file: string, keyPath: string[]): string {
  return [file, ...keyPath].join('\0');
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

const SEVERITY_LABEL: Record<DoctorSeverity, string> = {
  critical: 'CRITICAL',
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
};

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    ...runtimeSection(report),
    '',
    ...connectionSection(report),
    '',
    ...clientSection(report),
    '',
    ...findingSection(report),
  ];
  // One chokepoint. Every string above originated in a file, an environment
  // variable or an error message, and all three can carry a token.
  return redact(lines.join('\n'));
}

function runtimeSection(report: DoctorReport): string[] {
  return [
    'RUNTIME',
    `  node          ${report.runtime.node}`,
    `  hetzner-mcp   ${report.runtime.packageVersion}`,
    `  platform      ${report.runtime.platform}`,
  ];
}

function connectionSection(report: DoctorReport): string[] {
  return formatConnectionReports(report.connections, report.registrySource, report.registryPath);
}

/** Shared by `doctor` and `connections` so the two can never disagree. */
export function formatConnectionReports(
  connections: DoctorConnectionReport[],
  registrySource?: ConnectionRegistry['source'],
  registryPath?: string,
): string[] {
  const where = registryPath === undefined ? '' : `, ${registryPath}`;
  const source = registrySource === undefined ? '' : ` (${registrySource}${where})`;
  const lines = [`CONNECTIONS${source}`];

  if (connections.length === 0) {
    lines.push('  none configured');
    return lines;
  }
  for (const connection of connections) {
    const flags = [
      connection.readOnly ? 'read-only' : undefined,
      connection.allowDestructive ? 'destructive-allowed' : undefined,
      connection.shadowsFile ? 'env shadows file' : undefined,
      connection.resolved && connection.wellFormed === false
        ? 'credential shape unexpected'
        : undefined,
    ].filter((flag): flag is string => flag !== undefined);

    // The surface leads. Two connections can differ in nothing a reader would
    // notice except this, and it decides which API — and which resources — the
    // name reaches.
    lines.push(
      `  ${connection.name}  [${connection.surface}] ${connection.baseUrl}${flags.length > 0 ? `  [${flags.join(', ')}]` : ''}`,
    );
    lines.push(`      cred    ${connection.credentialSource}`);
    lines.push(
      `      status  ${connection.resolved ? 'resolves' : `DOES NOT RESOLVE — ${connection.error ?? 'unknown error'}`}`,
    );
  }
  return lines;
}

function clientSection(report: DoctorReport): string[] {
  const lines = ['CLIENTS'];
  if (report.clients.length === 0) lines.push('  no adapters registered');
  for (const client of report.clients) {
    lines.push(`  ${clientMark(client)}  ${client.adapterId.padEnd(22)} ${client.path}`);
    lines.push(`         ${clientDetail(client)}`);
  }
  return lines;
}

function clientMark(client: DoctorClientReport): string {
  if (!client.configExists) return ' - ';
  if (!client.parseable) return '!!!';
  return client.entryPresent ? ' ok' : '   ';
}

function clientDetail(client: DoctorClientReport): string {
  if (!client.installed && !client.configExists) return 'client not detected';
  if (!client.configExists) return 'installed, no config file yet';
  if (!client.parseable) return 'config file does not parse';

  const parts = [
    client.entryPresent
      ? `hetzner entry present (${client.packageSpec ?? 'spec not recognised'})`
      : 'no hetzner entry',
  ];
  if (client.unscannedEntries > 0) {
    const plural = client.unscannedEntries === 1 ? 'y' : 'ies';
    parts.push(`${client.unscannedEntries} other server entr${plural} not scanned (--all-servers)`);
  }
  if (client.confidence === 'unverified') parts.push('adapter unverified: --print only');
  return parts.join(' · ');
}

function findingSection(report: DoctorReport): string[] {
  if (report.findings.length === 0) {
    return [
      'FINDINGS',
      '  none. No credential at rest, every config parses, every credential source resolves.',
    ];
  }
  const lines = ['FINDINGS'];
  for (const finding of report.findings) {
    const where = finding.file === undefined ? '' : `  ${finding.file}`;
    lines.push(`  [${SEVERITY_LABEL[finding.severity]}] ${finding.code}${where}`);
    lines.push(indent(finding.message, 6));
    lines.push(indent(finding.remediation, 6));
    if (finding.fix !== undefined) {
      const prefix = finding.fix.applied ? '--fix applied: ' : '--fix: ';
      lines.push(indent(`${prefix}${finding.fix.detail}`, 6));
    }
    lines.push('');
  }
  return lines;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n');
}

/** Windows editors write a BOM; JSON.parse and smol-toml both choke on it. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
