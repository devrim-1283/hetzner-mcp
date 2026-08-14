/**
 * The registry file format — and the one place where "hetzner-mcp never stores
 * credentials in config files" is enforced rather than merely recommended.
 *
 * `connectionSchema` has no `token`, `user` or `password` property and is
 * `.strict()`, so a literal credential cannot round-trip through this parser.
 * The rejection is the feature: `formatConfigError` turns it into a message
 * that names the credential sources the connection's own surface accepts and
 * the env var that already works by convention, so the user's next action is
 * obvious from the error alone.
 *
 * There is also no `baseUrl`. Coolify is self-hosted, so its URL is genuine
 * user input; Hetzner runs exactly one instance of each API, so the base URL is
 * derived from `surface` via SURFACE_BASE_URLS. A user-supplied one could only
 * be the value we already know or a mistake, and deleting the field deletes the
 * class of error instead of validating it.
 */
import { z } from 'zod';
import { SURFACES, SURFACE_AUTH, type Surface } from '../types.js';

export const CONFIG_VERSION = 1;

/**
 * The three implicit connections born from bare environment variables. Each
 * name is the surface's plain-language noun, because that is what the user will
 * type into HETZNER_CONNECTION.
 */
export const DEFAULT_CONNECTION_NAME = 'default';
export const ACCOUNT_CONNECTION_NAME = 'account';
export const ROBOT_CONNECTION_NAME = 'robot';

/** `surface` is omitted far more often than it is written — Cloud is the majority case. */
export const DEFAULT_SURFACE: Surface = 'cloud';

/**
 * Connection names are slugs because they must survive a round trip through an
 * env var name: `acme-ops` <-> HETZNER_TOKEN_ACME_OPS. Anything outside this
 * alphabet makes that mapping ambiguous.
 */
export const CONNECTION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const CONNECTION_NAME_RULE =
  'lowercase letters, digits and dashes, starting with a letter or digit, 31 characters max';

export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Longest argv we will hand to execFile — a token command is `op read ...`, not a script. */
export const MAX_TOKEN_COMMAND_ARGS = 32;

/** Config errors are startup failures with a written remedy, not runtime API failures. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------------------
// Name <-> env var mapping
// ---------------------------------------------------------------------------

/** `acme-ops` -> `ACME_OPS`. */
export function envSuffix(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/** `ACME_OPS` -> `acme-ops`. The inverse of {@link envSuffix}. */
export function connectionNameFromEnvSuffix(suffix: string): string {
  return suffix.toLowerCase().replace(/_/g, '-');
}

export const CLOUD_TOKEN_ENV = 'HETZNER_TOKEN';
export const ACCOUNT_TOKEN_ENV = 'HETZNER_ACCOUNT_TOKEN';
export const ROBOT_USER_ENV = 'HETZNER_ROBOT_USER';
export const ROBOT_PASSWORD_ENV = 'HETZNER_ROBOT_PASSWORD';

export function cloudTokenEnvVar(name: string): string {
  return `${CLOUD_TOKEN_ENV}_${envSuffix(name)}`;
}

export function accountTokenEnvVar(name: string): string {
  return `${ACCOUNT_TOKEN_ENV}_${envSuffix(name)}`;
}

export function robotUserEnvVar(name: string): string {
  return `${ROBOT_USER_ENV}_${envSuffix(name)}`;
}

export function robotPasswordEnvVar(name: string): string {
  return `${ROBOT_PASSWORD_ENV}_${envSuffix(name)}`;
}

/**
 * The variables a connection reads when it declares no credential source.
 *
 * The surface is encoded in the variable NAME rather than carried in a separate
 * one, so "the variable exists" and "the surface is known" are the same fact.
 * A surface that could be forgotten is a surface that silently points a token
 * at the wrong API.
 */
export function conventionalCredentialVars(surface: Surface, name: string): string[] {
  switch (surface) {
    case 'cloud':
      return [cloudTokenEnvVar(name)];
    case 'hetzner':
      return [accountTokenEnvVar(name)];
    case 'robot':
      return [robotUserEnvVar(name), robotPasswordEnvVar(name)];
  }
}

/** The bare, unsuffixed variables that define a connection with no file at all. */
export function bareCredentialVars(surface: Surface): string[] {
  switch (surface) {
    case 'cloud':
      return [CLOUD_TOKEN_ENV];
    case 'hetzner':
      return [ACCOUNT_TOKEN_ENV];
    case 'robot':
      return [ROBOT_USER_ENV, ROBOT_PASSWORD_ENV];
  }
}

/** The connection name a bare (unsuffixed) variable pair produces. */
export function bareConnectionName(surface: Surface): string {
  switch (surface) {
    case 'cloud':
      return DEFAULT_CONNECTION_NAME;
    case 'hetzner':
      return ACCOUNT_CONNECTION_NAME;
    case 'robot':
      return ROBOT_CONNECTION_NAME;
  }
}

/**
 * Reads an env var as "set to something", trimmed. Every MCP client config
 * format lets a user leave an empty string behind (`"HETZNER_TOKEN": ""`), and
 * an empty value that counts as "set" produces a 401 instead of the
 * "not configured" message that would have told them what to do.
 */
export function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// Credential sources, per surface
// ---------------------------------------------------------------------------

export const BEARER_SOURCE_KEYS = ['tokenEnv', 'tokenCommand', 'tokenKeychain'] as const;
export const ROBOT_SOURCE_KEYS = [
  'userEnv',
  'passwordEnv',
  'passwordCommand',
  'credentialKeychain',
] as const;

/** How the surface's accepted sources read in prose, for error messages. */
export function credentialSourceRule(surface: Surface): string {
  return SURFACE_AUTH[surface] === 'bearer'
    ? 'tokenEnv | tokenCommand | tokenKeychain'
    : 'userEnv + passwordEnv | userEnv + passwordCommand | credentialKeychain';
}

function authPhrase(surface: Surface): string {
  return SURFACE_AUTH[surface] === 'bearer' ? 'a bearer token' : 'HTTP Basic';
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const connectionNameSchema = z
  .string()
  .regex(CONNECTION_NAME_RE, `connection names must be ${CONNECTION_NAME_RULE}`);

const envVarNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name');

const commandSchema = z.array(z.string().min(1)).min(1).max(MAX_TOKEN_COMMAND_ARGS);

const tokenKeychainSchema = z
  .object({
    service: z.string().trim().min(1),
    account: z.string().trim().min(1),
  })
  .strict();

/**
 * Kept separate from the exported schema so `.shape` survives — the error
 * formatter lists the valid property names, and hardcoding that list twice is
 * exactly how it would drift.
 */
const connectionObject = z
  .object({
    /**
     * Which Hetzner API this connection speaks to. There is no `baseUrl`: it is
     * derived from this field, see the file header.
     */
    surface: z.enum([...SURFACES] as [Surface, ...Surface[]]).default(DEFAULT_SURFACE),
    label: z.string().trim().min(1).max(120).optional(),

    // Credential *sources*. There is no token, user or password — see the header.
    // Bearer surfaces (cloud, hetzner):
    tokenEnv: envVarNameSchema.optional(),
    tokenCommand: commandSchema.optional(),
    tokenKeychain: tokenKeychainSchema.optional(),

    // Robot (HTTP Basic) — a user AND a password, so the sources come in pairs.
    userEnv: envVarNameSchema.optional(),
    passwordEnv: envVarNameSchema.optional(),
    passwordCommand: commandSchema.optional(),
    /** `account` is the Robot web-service user; the stored secret is its password. */
    credentialKeychain: tokenKeychainSchema.optional(),

    readOnly: z.boolean().default(false),
    /**
     * Per-connection override of HETZNER_ALLOW_DESTRUCTIVE, and it can only
     * NARROW: resolve.ts ANDs it with the global flag, so `true` here grants
     * nothing on a server where the flag is off, while `false` keeps one
     * connection protected on a server where it is on.
     */
    allowDestructive: z.boolean().optional(),
    timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  })
  .strict();

const CONNECTION_KEYS = Object.keys(connectionObject.shape);

export const connectionSchema = connectionObject.superRefine((value, ctx) => {
  const surface: Surface = value.surface;
  const declared = (key: string): boolean => (value as Record<string, unknown>)[key] !== undefined;

  const bearer = BEARER_SOURCE_KEYS.filter(declared);
  const robot = ROBOT_SOURCE_KEYS.filter(declared);

  // A source from the wrong surface is not a typo the user can see: `tokenEnv`
  // on a robot connection reads as perfectly sensible right up to the 401.
  const foreign = SURFACE_AUTH[surface] === 'bearer' ? robot : bearer;
  if (foreign.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `surface "${surface}" authenticates with ${authPhrase(surface)} and does not accept ` +
        `${foreign.join(' or ')}. Use ${credentialSourceRule(surface)}.`,
    });
    return;
  }

  if (SURFACE_AUTH[surface] === 'bearer') {
    if (bearer.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `at most one of ${BEARER_SOURCE_KEYS.join(', ')} may be set (found ${bearer.join(' and ')}). ` +
          'Two sources means two answers to "where is the token", and no rule for which wins',
      });
    }
    return;
  }

  if (declared('credentialKeychain')) {
    const others = robot.filter((key) => key !== 'credentialKeychain');
    if (others.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `credentialKeychain already carries both halves of the Basic credential, so it cannot be ` +
          `combined with ${others.join(' or ')}`,
      });
    }
    return;
  }

  if (declared('passwordEnv') && declared('passwordCommand')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'at most one of passwordEnv, passwordCommand may be set. ' +
        'Two sources means two answers to "where is the password", and no rule for which wins',
    });
    return;
  }

  const hasPassword = declared('passwordEnv') || declared('passwordCommand');
  if (declared('userEnv') !== hasPassword) {
    const present = declared('userEnv') ? 'userEnv' : robot.join(' and ');
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `surface "robot" authenticates with HTTP Basic, so userEnv and a password source ` +
        `(passwordEnv or passwordCommand) are set together or not at all (found only ${present}). ` +
        `Omit both and ${conventionalCredentialVars('robot', '<name>')
          .map((variable) => `$${variable}`)
          .join(' + ')} are read by convention.`,
    });
  }
});

const configObject = z
  .object({
    /** Editors resolve schema/config.v1.json from here; it is not a setting. */
    $schema: z.string().optional(),
    version: z.literal(CONFIG_VERSION),
    defaultConnection: connectionNameSchema.optional(),
    /** Single level only — resolved relative to the referring file. */
    extends: z.string().trim().min(1).optional(),
    connections: z.record(connectionNameSchema, connectionSchema),
  })
  .strict();

export const configFileSchema = configObject.superRefine((value, ctx) => {
  if (Object.keys(value.connections).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connections'],
      message: 'define at least one connection',
    });
  }
});

export type ConnectionConfig = z.infer<typeof connectionSchema>;
export type ConfigFile = z.infer<typeof configFileSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const MAX_REPORTED_ISSUES = 10;

/**
 * Property names that mean "a credential is sitting in this file". Compared
 * with separators stripped so `api_token`, `apiToken` and `API-TOKEN` all land
 * on the same explanation. Robot's own vocabulary is in here too: its
 * credential is a `#123456+ws` user and a "web service password", and a user
 * transcribing it from the Robot UI reaches for exactly those words.
 */
const CREDENTIAL_KEYS = new Set([
  'token',
  'apitoken',
  'accesstoken',
  'authtoken',
  'apikey',
  'key',
  'secret',
  'bearer',
  'authorization',
  'user',
  'username',
  'login',
  'pass',
  'password',
  'webservicepassword',
  'robotpassword',
  'credentials',
]);

function looksLikeCredential(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ''));
}

/**
 * Property names that mean "the user tried to tell us where the API lives".
 * Answered with the reason it is not a setting rather than with a bare
 * "unknown property", because the field is present in every comparable tool.
 */
const DERIVED_URL_KEYS = new Set(['baseurl', 'url', 'apiurl', 'endpoint', 'host', 'hostname']);

function looksLikeBaseUrl(key: string): boolean {
  return DERIVED_URL_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ''));
}

/**
 * The type of `ZodIssue['path']`.
 *
 * Zod widened this to `PropertyKey[]` in v4, because a schema can key on a
 * symbol. A registry file is parsed from JSON, which cannot express one, so the
 * symbol case below is unreachable for this codebase — but it is in the type,
 * and rendering `[object Symbol]` into a config error a user has to act on
 * would be worse than one line handling it.
 */
type IssuePath = ReadonlyArray<PropertyKey>;

function formatPath(path: IssuePath): string {
  if (path.length === 0) return '<root>';
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    const name = typeof segment === 'symbol' ? (segment.description ?? '<symbol>') : segment;
    return acc === '' ? name : `${acc}.${name}`;
  }, '');
}

/** The connection name for a path like ['connections', 'prod', ...]. */
function connectionNameAt(path: IssuePath): string | undefined {
  const [head, name] = path;
  return head === 'connections' && typeof name === 'string' ? name : undefined;
}

/**
 * The surface of the connection an issue points at, read back out of the input.
 *
 * The parse failed, so there is no parsed value to consult — but the surface is
 * what decides which credential sources the remedy should name, and a message
 * that lists all three surfaces' sources is a message the user has to filter
 * before they can act on it.
 */
function surfaceAt(raw: unknown, path: IssuePath): Surface {
  const name = connectionNameAt(path);
  if (name === undefined) return DEFAULT_SURFACE;
  const connections = (raw as { connections?: Record<string, unknown> } | undefined)?.connections;
  const candidate = (connections?.[name] as { surface?: unknown } | undefined)?.surface;
  return SURFACES.includes(candidate as Surface) ? (candidate as Surface) : DEFAULT_SURFACE;
}

function credentialKeyBlock(path: IssuePath, key: string, raw: unknown): string {
  const name = connectionNameAt(path);
  const surface = surfaceAt(raw, path);
  const variables = (
    name === undefined ? bareCredentialVars(surface) : conventionalCredentialVars(surface, name)
  ).map((variable) => `$${variable}`);

  return [
    `config error at ${formatPath(path)}: "${key}" is not a valid property.`,
    'hetzner-mcp never stores credentials in config files.',
    `Surface "${surface}" takes ${credentialSourceRule(surface)}, or omit them all and`,
    `${variables.join(' + ')} ${variables.length > 1 ? 'are' : 'is'} read by convention.`,
  ].join('\n');
}

function baseUrlKeyBlock(path: IssuePath, key: string, raw: unknown): string {
  const surface = surfaceAt(raw, path);
  return [
    `config error at ${formatPath(path)}: "${key}" is not a valid property.`,
    'The API address is derived from "surface", never configured: Hetzner runs exactly one',
    'instance of each API, so a value here could only repeat what we already know, or be wrong.',
    `Surface "${surface}" is ${SURFACE_BASE_URL_HINT[surface]}.`,
  ].join('\n');
}

/**
 * Spelled out here rather than imported from SURFACE_BASE_URLS so the message
 * says what the surface IS, not only where it points.
 */
const SURFACE_BASE_URL_HINT: Readonly<Record<Surface, string>> = {
  cloud: 'api.hetzner.cloud/v1 (one Cloud project)',
  hetzner: 'api.hetzner.com/v1 (account-scoped)',
  robot: 'robot-ws.your-server.de (dedicated servers)',
};

function unknownKeyBlock(path: IssuePath, key: string): string {
  const valid = connectionNameAt(path) === undefined ? undefined : CONNECTION_KEYS.join(', ');
  const lines = [`config error at ${formatPath(path)}: "${key}" is not a valid property.`];
  if (valid) lines.push(`Valid properties: ${valid}.`);
  return lines.join('\n');
}

function describeIssue(issue: z.ZodIssue, raw: unknown): string[] {
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return issue.keys.map((key) => {
      if (looksLikeCredential(key)) return credentialKeyBlock(issue.path, key, raw);
      if (looksLikeBaseUrl(key)) return baseUrlKeyBlock(issue.path, key, raw);
      return unknownKeyBlock(issue.path, key);
    });
  }
  // `invalid_value` rather than v3's `invalid_literal`: Zod 4 merged literal and
  // enum mismatches into one code. The path guard is what keeps this branch
  // aimed at the version field alone.
  //
  // Without it the user is told "Invalid input: expected 1", which names Zod's
  // model of the problem rather than theirs.
  if (issue.code === z.ZodIssueCode.invalid_value && issue.path.join('.') === 'version') {
    return [`config error at version: must be ${CONFIG_VERSION}. This file is a v1 registry.`];
  }
  return [`config error at ${formatPath(issue.path)}: ${issue.message}`];
}

export function formatConfigError(error: z.ZodError, sourcePath: string, raw?: unknown): string {
  const blocks = error.issues.flatMap((issue) => describeIssue(issue, raw));
  const shown = blocks.slice(0, MAX_REPORTED_ISSUES);
  if (blocks.length > shown.length) {
    shown.push(`(${blocks.length - shown.length} further problems not shown)`);
  }
  return [`invalid hetzner-mcp config: ${sourcePath}`, ...shown].join('\n\n');
}

/** Parses and validates one registry file. Throws {@link ConfigError} on any problem. */
export function parseConfigFile(raw: unknown, sourcePath: string): ConfigFile {
  const result = configFileSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(formatConfigError(result.error, sourcePath, raw));
  return result.data;
}
