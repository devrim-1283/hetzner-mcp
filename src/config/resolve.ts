/**
 * Connection registry resolution — the single entry point that turns an
 * environment plus (optionally) a config file into `ConnectionRegistry`.
 *
 * A connection is (surface, credential). A Hetzner Cloud token is created
 * inside one project and cannot see any other; there is no project parameter in
 * the API. So a second project is a second token, which is a second connection.
 * Adding the surface to the tuple extends the same mechanism to the
 * account-scoped API and to Robot without inventing a second concept.
 *
 * Three layers, in increasing order of ceremony:
 *
 *   0. HETZNER_TOKEN / HETZNER_ACCOUNT_TOKEN /
 *      HETZNER_ROBOT_USER + HETZNER_ROBOT_PASSWORD          (no file at all)
 *   1. the same variables with a _<NAME> suffix              (no file at all)
 *   2. a config file
 *
 * The env var NAME encodes the surface, deliberately. If the surface lived in a
 * separate variable, forgetting it would mean silently talking to the wrong API
 * with a token that cannot work there; with the surface in the name, "the
 * variable exists" and "the surface is known" are the same fact.
 *
 * File lookup is FIRST HIT WINS WHOLESALE: the first location that has a file
 * is the config, and no other location is consulted or merged in. Cross-scope
 * merging is where configuration systems stop being explainable — "which of
 * these four files set readOnly?" has no good answer, so we never create the
 * question.
 *
 * Env and file are unioned, and on a name collision the env entry replaces the
 * file entry WHOLE. No field-level merge: a half-env, half-file connection is
 * not something a user can hold in their head. The shadowed name is recorded so
 * `doctor` can report it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  SURFACE_BASE_URLS,
  type Connection,
  type ConnectionRegistry,
  type Surface,
} from '../types.js';
import {
  ACCOUNT_TOKEN_ENV,
  CLOUD_TOKEN_ENV,
  CONNECTION_NAME_RE,
  CONNECTION_NAME_RULE,
  ConfigError,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  ROBOT_PASSWORD_ENV,
  ROBOT_USER_ENV,
  bareConnectionName,
  cloudTokenEnvVar,
  connectionNameFromEnvSuffix,
  parseConfigFile,
  readEnvValue,
  robotPasswordEnvVar,
  robotUserEnvVar,
  type ConfigFile,
  type ConnectionConfig,
} from './schema.js';
import { createCredential, type CredentialSpec } from './secrets.js';

const CONFIG_PATH_ENV_VAR = 'HETZNER_MCP_CONFIG';
const PROJECT_CONFIG_FILENAME = '.hetzner-mcp.json';
const CONFIG_DIR_NAME = 'hetzner-mcp';
const USER_CONFIG_FILENAME = 'config.json';

const READ_ONLY_ENV = 'HETZNER_READ_ONLY';
const ALLOW_DESTRUCTIVE_ENV = 'HETZNER_ALLOW_DESTRUCTIVE';
const TIMEOUT_ENV = 'HETZNER_TIMEOUT_MS';
const CONNECTION_ENV = 'HETZNER_CONNECTION';

export interface ResolveOptions {
  /** Injected for tests. Decides the Windows %APPDATA% config location and the keychain backend. */
  platform?: NodeJS.Platform;
}

/**
 * Builds the connection registry. Throws {@link ConfigError} when the
 * configuration is unusable — never when a *credential* is merely absent:
 * credential resolution is lazy so that one unreachable secret manager cannot
 * stop the server from starting and reporting the problem through a tool call.
 */
export async function resolveRegistry(
  env: NodeJS.ProcessEnv,
  cwd: string,
  homedir: string,
  options: ResolveOptions = {},
): Promise<ConnectionRegistry> {
  const platform = options.platform ?? process.platform;

  const envSpecs = collectEnvConnections(env);
  const located = await locateConfigFile(env, cwd, homedir, platform);
  const file = located === undefined ? undefined : await loadConfigFile(located, homedir);

  const specs = new Map<string, ConnectionSpec>();
  const shadowed: string[] = [];

  if (file !== undefined) {
    for (const [name, config] of Object.entries(file.config.connections)) {
      specs.set(name, fromFile(name, config, env));
    }
  }
  for (const [name, spec] of envSpecs) {
    if (specs.has(name)) shadowed.push(name);
    specs.set(name, spec);
  }

  if (specs.size === 0) throw new ConfigError(notConfiguredMessage(env, cwd, homedir, platform));

  const connections = new Map<string, Connection>();
  for (const [name, spec] of [...specs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    connections.set(name, toConnection(spec, env, platform));
  }

  const registry: ConnectionRegistry = {
    connections,
    source: envSpecs.size > 0 ? (file === undefined ? 'env' : 'env+file') : 'file',
    shadowed: shadowed.sort(),
  };
  if (file !== undefined) registry.configPath = file.path;

  const defaultName = selectDefault(env, connections, file?.config.defaultConnection);
  if (defaultName !== undefined) registry.defaultName = defaultName;

  return registry;
}

// ---------------------------------------------------------------------------
// Normalised connection spec — file and env entries meet here
// ---------------------------------------------------------------------------

interface ConnectionSpec {
  name: string;
  surface: Surface;
  /**
   * Which layer this entry actually came from. Because env replaces a colliding
   * file entry WHOLE, a shadowed name carries 'env' — the file entry did not
   * survive, and provenance that named the file the user is looking at would be
   * a lie in exactly the case `doctor` exists to explain.
   */
  origin: 'env' | 'file';
  label?: string;
  tokenEnv?: string;
  tokenCommand?: string[];
  tokenKeychain?: { service: string; account: string };
  userEnv?: string;
  passwordEnv?: string;
  passwordCommand?: string[];
  credentialKeychain?: { service: string; account: string };
  readOnly: boolean;
  allowDestructive: boolean;
  timeoutMs: number;
}

function fromFile(name: string, config: ConnectionConfig, env: NodeJS.ProcessEnv): ConnectionSpec {
  const spec: ConnectionSpec = {
    name,
    surface: config.surface,
    origin: 'file',
    // A global env flag may TIGHTEN a file connection, never loosen it.
    // Read-only is a kill switch, so `HETZNER_READ_ONLY=true` has to reach
    // connections the file already described; the reverse would let an env var
    // re-open a connection the file deliberately closed.
    readOnly: config.readOnly || booleanEnv(env, READ_ONLY_ENV, false),
    // Both flags travel in ONE direction, and the direction is encoded here
    // rather than trusted to the caller. The global flag is a ceiling: `true`
    // on a connection grants nothing while $HETZNER_ALLOW_DESTRUCTIVE is off
    // (the destructive tool is not registered at all in that case, so a
    // connection that claimed the capability would be describing a door that
    // does not exist), while `false` keeps one connection protected on a server
    // where the flag is on.
    allowDestructive:
      booleanEnv(env, ALLOW_DESTRUCTIVE_ENV, false) && (config.allowDestructive ?? true),
    timeoutMs: config.timeoutMs,
  };
  if (config.label !== undefined) spec.label = config.label;
  if (config.tokenEnv !== undefined) spec.tokenEnv = config.tokenEnv;
  if (config.tokenCommand !== undefined) spec.tokenCommand = config.tokenCommand;
  if (config.tokenKeychain !== undefined) spec.tokenKeychain = config.tokenKeychain;
  if (config.userEnv !== undefined) spec.userEnv = config.userEnv;
  if (config.passwordEnv !== undefined) spec.passwordEnv = config.passwordEnv;
  if (config.passwordCommand !== undefined) spec.passwordCommand = config.passwordCommand;
  if (config.credentialKeychain !== undefined) spec.credentialKeychain = config.credentialKeychain;
  return spec;
}

function toConnection(
  spec: ConnectionSpec,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Connection {
  const credentialSpec: CredentialSpec = {
    name: spec.name,
    surface: spec.surface,
    ...(spec.tokenEnv !== undefined ? { tokenEnv: spec.tokenEnv } : {}),
    ...(spec.tokenCommand !== undefined ? { tokenCommand: spec.tokenCommand } : {}),
    ...(spec.tokenKeychain !== undefined ? { tokenKeychain: spec.tokenKeychain } : {}),
    ...(spec.userEnv !== undefined ? { userEnv: spec.userEnv } : {}),
    ...(spec.passwordEnv !== undefined ? { passwordEnv: spec.passwordEnv } : {}),
    ...(spec.passwordCommand !== undefined ? { passwordCommand: spec.passwordCommand } : {}),
    ...(spec.credentialKeychain !== undefined
      ? { credentialKeychain: spec.credentialKeychain }
      : {}),
  };

  const connection: Connection = {
    name: spec.name,
    surface: spec.surface,
    // Derived, never configured — the whole reason `baseUrl` is not a field.
    baseUrl: SURFACE_BASE_URLS[spec.surface],
    readOnly: spec.readOnly,
    allowDestructive: spec.allowDestructive,
    timeoutMs: spec.timeoutMs,
    credential: createCredential(credentialSpec, env, { platform }),
    // Optional in the type only so a test may build a Connection without
    // asserting provenance. Every connection this function returns has one.
    origin: spec.origin,
  };
  if (spec.label !== undefined) connection.label = spec.label;
  return connection;
}

// ---------------------------------------------------------------------------
// Layer 0 and 1 — connections defined entirely by environment
// ---------------------------------------------------------------------------

/** Which variable claimed a name, so a collision can name both sides of it. */
interface NameClaim {
  surface: Surface;
  variable: string;
}

/** The two halves of a Robot login, tracked separately so a missing one is nameable. */
interface RobotClaim {
  userVar?: string;
  passwordVar?: string;
}

const BEARER_PREFIXES: ReadonlyArray<{ prefix: string; surface: Surface }> = [
  // Longest first: HETZNER_ACCOUNT_TOKEN_X must not be read as a cloud token.
  { prefix: `${ACCOUNT_TOKEN_ENV}_`, surface: 'hetzner' },
  { prefix: `${CLOUD_TOKEN_ENV}_`, surface: 'cloud' },
];

function collectEnvConnections(env: NodeJS.ProcessEnv): Map<string, ConnectionSpec> {
  const claims = new Map<string, NameClaim>();
  const robots = new Map<string, RobotClaim>();

  const claim = (name: string, surface: Surface, variable: string): void => {
    const existing = claims.get(name);
    if (existing !== undefined && existing.surface !== surface) {
      throw new ConfigError(crossSurfaceCollisionMessage(name, existing, { surface, variable }));
    }
    claims.set(name, { surface, variable });
  };

  const claimRobot = (name: string, variable: string, half: keyof RobotClaim): void => {
    claim(name, 'robot', variable);
    const entry = robots.get(name) ?? {};
    entry[half] = variable;
    robots.set(name, entry);
  };

  // Layer 0 — the bare variables, one connection per surface.
  if (readEnvValue(env, CLOUD_TOKEN_ENV) !== undefined) {
    claim(bareConnectionName('cloud'), 'cloud', CLOUD_TOKEN_ENV);
  }
  if (readEnvValue(env, ACCOUNT_TOKEN_ENV) !== undefined) {
    claim(bareConnectionName('hetzner'), 'hetzner', ACCOUNT_TOKEN_ENV);
  }
  if (readEnvValue(env, ROBOT_USER_ENV) !== undefined) {
    claimRobot(bareConnectionName('robot'), ROBOT_USER_ENV, 'userVar');
  }
  if (readEnvValue(env, ROBOT_PASSWORD_ENV) !== undefined) {
    claimRobot(bareConnectionName('robot'), ROBOT_PASSWORD_ENV, 'passwordVar');
  }

  // Layer 1 — suffixed variables. Sorted so a malformed variable always reports
  // the same one first.
  for (const key of Object.keys(env).sort()) {
    if (readEnvValue(env, key) === undefined) continue;

    if (key.startsWith(`${ROBOT_USER_ENV}_`)) {
      claimRobot(envConnectionName(key, `${ROBOT_USER_ENV}_`), key, 'userVar');
      continue;
    }
    if (key.startsWith(`${ROBOT_PASSWORD_ENV}_`)) {
      claimRobot(envConnectionName(key, `${ROBOT_PASSWORD_ENV}_`), key, 'passwordVar');
      continue;
    }
    const bearer = BEARER_PREFIXES.find((entry) => key.startsWith(entry.prefix));
    if (bearer !== undefined) {
      claim(envConnectionName(key, bearer.prefix), bearer.surface, key);
    }
  }

  // A Robot connection with one half is not a connection: it is a typo that
  // would otherwise surface as a 401 hours later, on the other half's variable.
  for (const [name, robot] of [...robots].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (robot.userVar === undefined || robot.passwordVar === undefined) {
      throw new ConfigError(halfRobotMessage(name, robot));
    }
  }

  const found = new Map<string, ConnectionSpec>();
  for (const [name, { surface }] of claims) {
    found.set(name, envSpec(name, surface, env));
  }
  return found;
}

function envConnectionName(key: string, prefix: string): string {
  const name = connectionNameFromEnvSuffix(key.slice(prefix.length));
  if (!CONNECTION_NAME_RE.test(name)) {
    throw new ConfigError(
      `$${key} does not name a valid connection: "${name}" must be ${CONNECTION_NAME_RULE}.\n` +
        `The variable name after ${prefix} becomes the connection name, lowercased, with _ read as -.`,
    );
  }
  return name;
}

function envSpec(name: string, surface: Surface, env: NodeJS.ProcessEnv): ConnectionSpec {
  // Env-defined connections have no file to state their own settings, so the
  // process-wide knobs are their defaults. File connections are configured by
  // the file (except for the read-only kill switch — see fromFile). The
  // credential is left undeclared: secrets.ts reads the same variables the name
  // was derived from.
  return {
    name,
    surface,
    origin: 'env',
    readOnly: booleanEnv(env, READ_ONLY_ENV, false),
    allowDestructive: booleanEnv(env, ALLOW_DESTRUCTIVE_ENV, false),
    timeoutMs: timeoutEnv(env),
  };
}

const SURFACE_NOUN: Readonly<Record<Surface, string>> = {
  cloud: 'a Cloud project (api.hetzner.cloud)',
  hetzner: 'the account-scoped API (api.hetzner.com)',
  robot: 'Robot, for dedicated servers (robot-ws.your-server.de)',
};

function crossSurfaceCollisionMessage(name: string, first: NameClaim, second: NameClaim): string {
  return [
    `$${first.variable} and $${second.variable} both define the connection "${name}", on different Hetzner APIs.`,
    `  $${first.variable} -> ${SURFACE_NOUN[first.surface]}`,
    `  $${second.variable} -> ${SURFACE_NOUN[second.surface]}`,
    '',
    'A connection is one surface and one credential, so these cannot share a name.',
    'Rename one of them: the text after the prefix becomes the connection name, lowercased, with _ read as -.',
  ].join('\n');
}

function halfRobotMessage(name: string, robot: RobotClaim): string {
  // The missing variable is spelled like the one that IS present: a user who
  // set the bare $HETZNER_ROBOT_USER is told about $HETZNER_ROBOT_PASSWORD, not
  // about a suffixed variable they never typed.
  const present = robot.userVar ?? robot.passwordVar ?? '';
  const missing =
    robot.userVar === undefined
      ? present === ROBOT_PASSWORD_ENV
        ? ROBOT_USER_ENV
        : robotUserEnvVar(name)
      : present === ROBOT_USER_ENV
        ? ROBOT_PASSWORD_ENV
        : robotPasswordEnvVar(name);

  return [
    `$${present} is set but $${missing} is not.`,
    `Robot authenticates with HTTP Basic, so the connection "${name}" needs both halves.`,
    `Set $${missing}, or unset $${present} to drop the connection.`,
  ].join('\n');
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export function booleanEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = readEnvValue(env, key);
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  // Loud rather than lenient: silently reading "HETZNER_ALLOW_DESTRUCTIVE=ture"
  // as false is the kind of thing a user only discovers mid-incident.
  throw new ConfigError(`$${key} must be true or false (got "${raw}").`);
}

function timeoutEnv(env: NodeJS.ProcessEnv): number {
  const raw = readEnvValue(env, TIMEOUT_ENV);
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(
      `$${TIMEOUT_ENV} must be a whole number of milliseconds between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} (got "${raw}").`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Layer 2 — the config file
// ---------------------------------------------------------------------------

interface LocatedConfig {
  path: string;
  config: ConfigFile;
}

async function locateConfigFile(
  env: NodeJS.ProcessEnv,
  cwd: string,
  homedir: string,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const explicit = readEnvValue(env, CONFIG_PATH_ENV_VAR);
  if (explicit !== undefined) {
    const resolved = expandPath(explicit, cwd, homedir);
    // An explicit pointer that resolves to nothing is a mistake, not a reason
    // to quietly fall through to a different file the user is not looking at.
    if (!(await exists(resolved))) {
      throw new ConfigError(`$${CONFIG_PATH_ENV_VAR} points at ${resolved}, which does not exist.`);
    }
    return resolved;
  }

  const project = await findProjectConfig(cwd, homedir);
  if (project !== undefined) return project;

  for (const candidate of userConfigPaths(env, homedir, platform)) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Nearest `.hetzner-mcp.json`, walking up from cwd. The walk stops at a
 * repository root or at $HOME so that a config in a parent project — or worse,
 * one in the user's home directory reached by accident — cannot silently govern
 * an unrelated checkout.
 */
async function findProjectConfig(cwd: string, homedir: string): Promise<string | undefined> {
  const home = path.resolve(homedir);
  let dir = path.resolve(cwd);

  for (;;) {
    const candidate = path.join(dir, PROJECT_CONFIG_FILENAME);
    if (await exists(candidate)) return candidate;

    // Checked after the candidate so a repository root's own config still wins.
    // `.git` may be a file, not a directory, in worktrees and submodules.
    if (await exists(path.join(dir, '.git'))) return undefined;
    if (dir === home) return undefined;

    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function userConfigPaths(
  env: NodeJS.ProcessEnv,
  homedir: string,
  platform: NodeJS.Platform,
): string[] {
  const xdg = readEnvValue(env, 'XDG_CONFIG_HOME');
  const appData = readEnvValue(env, 'APPDATA');
  const configDir =
    xdg ??
    (platform === 'win32' && appData !== undefined ? appData : path.join(homedir, '.config'));

  return [
    path.join(configDir, CONFIG_DIR_NAME, USER_CONFIG_FILENAME),
    path.join(homedir, `.${CONFIG_DIR_NAME}`, USER_CONFIG_FILENAME),
  ];
}

async function loadConfigFile(filePath: string, homedir: string): Promise<LocatedConfig> {
  const config = await readAndParse(filePath);
  if (config.extends === undefined) return { path: filePath, config };

  const basePath = expandPath(config.extends, path.dirname(filePath), homedir);
  const base = await readAndParse(basePath);
  if (base.extends !== undefined) {
    throw new ConfigError(
      `${basePath} also has an "extends" key, and hetzner-mcp resolves only one level.\n` +
        'A chain of config files makes the effective configuration impossible to read off any single file. Inline what you need.',
    );
  }

  // Same rule as env-over-file: a name defined in both replaces the base entry
  // WHOLE, so every connection is described in exactly one place.
  return {
    path: filePath,
    config: {
      ...config,
      connections: { ...base.connections, ...config.connections },
      ...(config.defaultConnection === undefined && base.defaultConnection !== undefined
        ? { defaultConnection: base.defaultConnection }
        : {}),
    },
  };
}

async function readAndParse(filePath: string): Promise<ConfigFile> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    throw new ConfigError(`cannot read config file ${filePath}: ${errorMessage(error)}`);
  }

  let raw: unknown;
  try {
    // Windows editors happily write a BOM, which JSON.parse rejects with a
    // message that says nothing about a BOM.
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error: unknown) {
    throw new ConfigError(
      `${filePath} is not valid JSON: ${errorMessage(error)}\n` +
        'hetzner-mcp reads strict JSON — comments and trailing commas are not allowed.',
    );
  }

  return parseConfigFile(raw, filePath);
}

// ---------------------------------------------------------------------------
// Default selection
// ---------------------------------------------------------------------------

function selectDefault(
  env: NodeJS.ProcessEnv,
  connections: Map<string, Connection>,
  fileDefault: string | undefined,
): string | undefined {
  const requested = readEnvValue(env, CONNECTION_ENV);
  if (requested !== undefined) {
    // Accept HETZNER_CONNECTION=PROD: the matching variable is spelled
    // HETZNER_TOKEN_PROD, so uppercase here is the predictable mistake and
    // failing on it teaches nothing.
    const match = connections.has(requested)
      ? requested
      : connectionNameFromEnvSuffix(requested.toUpperCase());
    if (!connections.has(match)) {
      throw new ConfigError(
        `$${CONNECTION_ENV} selects "${requested}", which is not a configured connection.\n` +
          `Configured: ${[...connections.keys()].join(', ')}.`,
      );
    }
    return match;
  }

  if (fileDefault !== undefined) {
    if (!connections.has(fileDefault)) {
      throw new ConfigError(
        `defaultConnection is "${fileDefault}", which is not one of the configured connections: ${[...connections.keys()].join(', ')}.`,
      );
    }
    return fileDefault;
  }

  // Exactly one connection is its own default; the `connection` parameter is
  // dropped from every tool schema in that case. With several and no
  // designation there is NO default: the tool layer then demands an explicit
  // connection and lists the names, which is better than guessing which project
  // — or which API — a `delete server` was meant for.
  if (connections.size === 1) return [...connections.keys()][0];
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Resolves `~/…` and relative paths. JSON has no shell to expand a tilde. */
function expandPath(value: string, base: string, homedir: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return homedir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(homedir, trimmed.slice(2));
  }
  return path.resolve(base, trimmed);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notConfiguredMessage(
  env: NodeJS.ProcessEnv,
  cwd: string,
  homedir: string,
  platform: NodeJS.Platform,
): string {
  const explicit = readEnvValue(env, CONFIG_PATH_ENV_VAR);
  const searched = [
    `  $${CONFIG_PATH_ENV_VAR}${explicit === undefined ? ' (unset)' : `: ${explicit}`}`,
    `  ${PROJECT_CONFIG_FILENAME} in ${cwd} and its parents`,
    ...userConfigPaths(env, homedir, platform).map((candidate) => `  ${candidate}`),
  ];

  return [
    'hetzner-mcp has no connections configured.',
    '',
    'Set one environment variable:',
    `  ${CLOUD_TOKEN_ENV}=<Cloud Console > project > Security > API tokens>`,
    '',
    'The variable name carries the surface, so nothing else has to:',
    `  ${cloudTokenEnvVar('prod')}=...        a second Cloud project, named "prod"`,
    `  ${ACCOUNT_TOKEN_ENV}=...              the account-scoped API (Storage Boxes, DNS)`,
    `  ${robotUserEnvVar('metal')}=... + ${robotPasswordEnvVar('metal')}=...  dedicated servers`,
    `  ${CONNECTION_ENV}=prod              picks the default`,
    '',
    'A config file works too. Looked for:',
    ...searched,
  ].join('\n');
}

/**
 * The names the installer and `doctor` use when they describe this layer back
 * to the user. Exported from here so there is one spelling of each.
 */
export {
  ALLOW_DESTRUCTIVE_ENV,
  CONFIG_PATH_ENV_VAR,
  CONNECTION_ENV,
  PROJECT_CONFIG_FILENAME,
  READ_ONLY_ENV,
  TIMEOUT_ENV,
  userConfigPaths,
};
