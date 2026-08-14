/**
 * Credential resolution and the process-wide redaction set.
 *
 * Two rules govern everything here:
 *
 * 1. No shell, ever. `tokenCommand` / `passwordCommand` is an argv array handed
 *    to execFile directly — no `sh -c`, no string splitting, no interpolation.
 *    A registry file that can spawn a shell is a registry file that can run
 *    arbitrary commands from one mistyped character.
 * 2. No native modules, ever. keytar-class dependencies break `npx hetzner-mcp`,
 *    which is the primary install path, so the keychain sources dispatch over
 *    the platform's own CLI instead.
 *
 * Resolved credentials are cached for the process lifetime (an `op read` per
 * tool call is unusable) and never written to disk.
 *
 * Two shapes come out of here, because Hetzner has two authentication schemes:
 * `{ token }` for the bearer surfaces and `{ user, password }` for Robot. The
 * surface decides which — see `Credential.kind` in types.ts.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HetznerError, SURFACE_AUTH, type Credential, type Surface } from '../types.js';
import { registerSecret } from '../shaping/redact.js';
import {
  ACCOUNT_TOKEN_ENV,
  CLOUD_TOKEN_ENV,
  ROBOT_PASSWORD_ENV,
  ROBOT_USER_ENV,
  accountTokenEnvVar,
  bareConnectionName,
  cloudTokenEnvVar,
  credentialSourceRule,
  readEnvValue,
  robotPasswordEnvVar,
  robotUserEnvVar,
} from './schema.js';

const execFileAsync = promisify(execFile);

/**
 * Generous because secret managers prompt: `op read` can wait on Touch ID and
 * macOS `security` can raise a keychain unlock dialog. A tight timeout here
 * shows up as an unexplained auth failure the first time a user is away from
 * the keyboard.
 */
const SECRET_COMMAND_TIMEOUT_MS = 60_000;

/** A Hetzner token is 64 bytes. This bounds a misconfigured command that dumps a file. */
const MAX_SECRET_OUTPUT_BYTES = 64 * 1024;

/** Keep failure diagnostics useful without pasting a whole error page into the log. */
const MAX_STDERR_CHARS = 200;

/**
 * A token is copied verbatim into an Authorization header, and a Robot user and
 * password are base64'd into one, so all three must be printable ASCII with no
 * spaces: that rules out a stray newline splitting the header, and catches the
 * common "my secret manager returned JSON" mistake.
 */
const INVALID_SECRET_CHARS = /[^!-~]/;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Hands a resolved credential to the process-wide redaction set, so it is
 * scrubbed from every log line, error message and tool result. Called at
 * resolution time — before any code path can reach an output stream with it.
 *
 * There is exactly one registry, in `shaping/redact.ts`, and this module does
 * not keep a second: two sets would mean a value that is redactable on one
 * output path and in the clear on another, which is indistinguishable from no
 * redaction at all. The floor for what may be registered lives there too (8
 * characters — long enough not to swallow ordinary words, short enough to still
 * cover a user-chosen Robot password).
 */
function registerCredentialSecret(value: string): void {
  registerSecret(value);

  // Some providers issue `<id>|<secret>` tokens. Hetzner's own are opaque
  // 64-character strings, but a token reaching us through a secret manager can
  // be anything, and the secret half alone is still a live credential that can
  // appear on its own in a truncated log line or a split header.
  const separator = value.indexOf('|');
  if (separator > 0) registerSecret(value.slice(separator + 1));
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

export interface KeychainRef {
  service: string;
  account: string;
}

/** The credential half of a connection — everything needed to answer "where is it". */
export interface CredentialSpec {
  name: string;
  surface: Surface;
  // Bearer surfaces.
  tokenEnv?: string;
  tokenCommand?: readonly string[];
  tokenKeychain?: KeychainRef;
  // Robot.
  userEnv?: string;
  passwordEnv?: string;
  passwordCommand?: readonly string[];
  credentialKeychain?: KeychainRef;
}

export interface CredentialOptions {
  /** Injected for tests; the keychain path is the only platform-dependent branch. */
  platform?: NodeJS.Platform;
}

export type ResolvedCredential = { token: string } | { user: string; password: string };

/**
 * Builds the memoised `Connection.credential`. The cache holds the promise, not
 * the value, so a fan-out across connections does not spawn one `op read` per
 * concurrent call. A failed resolution is evicted: the usual cause is a locked
 * vault, and the user's fix is to unlock it and retry — which must not require
 * restarting the MCP server.
 */
export function createCredential(
  spec: CredentialSpec,
  env: NodeJS.ProcessEnv,
  options: CredentialOptions = {},
): Credential {
  const platform = options.platform ?? process.platform;
  let cached: Promise<ResolvedCredential> | undefined;

  return {
    kind: SURFACE_AUTH[spec.surface],
    resolve: () => {
      if (cached === undefined) {
        cached = resolveCredential(spec, env, platform).catch((error: unknown) => {
          cached = undefined;
          throw error;
        });
      }
      return cached;
    },
  };
}

async function resolveCredential(
  spec: CredentialSpec,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<ResolvedCredential> {
  if (SURFACE_AUTH[spec.surface] === 'basic') {
    const { user, password, source } = await readBasic(spec, env, platform);
    const cleanUser = checkSecret(user, spec, `${source} (user)`, 'user');
    const cleanPassword = checkSecret(password, spec, `${source} (password)`, 'password');

    registerCredentialSecret(cleanPassword);
    // The wire form is `Authorization: Basic base64(user:password)`. Registering
    // it too means a logged request header is redacted even though the password
    // never appears in it verbatim.
    registerCredentialSecret(Buffer.from(`${cleanUser}:${cleanPassword}`).toString('base64'));

    return { user: cleanUser, password: cleanPassword };
  }

  const { value, source } = await readToken(spec, env, platform);
  const token = checkSecret(value, spec, source, 'token');
  registerCredentialSecret(token);
  return { token };
}

function checkSecret(raw: string, spec: CredentialSpec, source: string, what: string): string {
  const value = raw.trim();
  if (value === '') {
    throw authError(`${source} returned an empty ${what} for connection "${spec.name}".`);
  }
  if (INVALID_SECRET_CHARS.test(value)) {
    // Deliberately does not echo the value: it may be a real credential in a
    // shape we did not expect.
    throw authError(
      `${source} did not return a usable ${what} for connection "${spec.name}" ` +
        '(the value contains whitespace or non-printable characters).',
      'If the source returns JSON or a whole record, select the single field that holds the value, ' +
        'e.g. `op read op://Infra/hetzner/credential`.',
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Bearer surfaces — cloud and hetzner
// ---------------------------------------------------------------------------

async function readToken(
  spec: CredentialSpec,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<{ value: string; source: string }> {
  if (spec.tokenEnv !== undefined) {
    return { value: requireEnv(spec, env, spec.tokenEnv, 'tokenEnv'), source: `$${spec.tokenEnv}` };
  }

  if (spec.tokenCommand !== undefined) {
    return {
      value: await runCommand(spec.name, 'tokenCommand', spec.tokenCommand, env),
      source: `tokenCommand (${spec.tokenCommand[0] ?? ''})`,
    };
  }

  if (spec.tokenKeychain !== undefined) {
    return {
      value: await readKeychain(spec.name, 'tokenKeychain', spec.tokenKeychain, env, platform),
      source: 'tokenKeychain',
    };
  }

  // Convention: a connection that declares no source reads its own env var.
  // This is what makes `{"surface": "hetzner"}` a complete connection entry.
  const conventional =
    spec.surface === 'hetzner' ? accountTokenEnvVar(spec.name) : cloudTokenEnvVar(spec.name);
  const byConvention = readEnvValue(env, conventional);
  if (byConvention !== undefined) return { value: byConvention, source: `$${conventional}` };

  // The unnamed single-connection case only. Any other connection falling back
  // to the bare variable would silently point two projects at one token — and a
  // Cloud token is scoped to exactly one project.
  const bare = spec.surface === 'hetzner' ? ACCOUNT_TOKEN_ENV : CLOUD_TOKEN_ENV;
  if (spec.name === bareConnectionName(spec.surface)) {
    const global = readEnvValue(env, bare);
    if (global !== undefined) return { value: global, source: `$${bare}` };
  }

  throw authError(
    `no API token for connection "${spec.name}" (surface "${spec.surface}").`,
    `Set $${conventional}` +
      (spec.name === bareConnectionName(spec.surface) ? ` (or $${bare})` : '') +
      `, or give "${spec.name}" a ${credentialSourceRule(spec.surface)} in your config file. ` +
      (spec.surface === 'cloud'
        ? 'Cloud tokens are created per project under Security > API tokens and cannot see any other project.'
        : 'Account tokens are created in the Hetzner console and cover account-scoped resources such as Storage Boxes.'),
  );
}

// ---------------------------------------------------------------------------
// Robot — HTTP Basic, so two halves
// ---------------------------------------------------------------------------

async function readBasic(
  spec: CredentialSpec,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<{ user: string; password: string; source: string }> {
  if (spec.credentialKeychain !== undefined) {
    // The keychain item's ACCOUNT is the Robot web-service user and its secret
    // is the password. One item holds the whole credential, which is what keeps
    // the user out of the config file — a `#123456+ws` user is half a login.
    const password = await readKeychain(
      spec.name,
      'credentialKeychain',
      spec.credentialKeychain,
      env,
      platform,
    );
    return {
      user: spec.credentialKeychain.account,
      password,
      source: 'credentialKeychain',
    };
  }

  if (spec.userEnv !== undefined) {
    const user = requireEnv(spec, env, spec.userEnv, 'userEnv');
    if (spec.passwordEnv !== undefined) {
      return {
        user,
        password: requireEnv(spec, env, spec.passwordEnv, 'passwordEnv'),
        source: `$${spec.userEnv} + $${spec.passwordEnv}`,
      };
    }
    if (spec.passwordCommand !== undefined) {
      return {
        user,
        password: await runCommand(spec.name, 'passwordCommand', spec.passwordCommand, env),
        source: `$${spec.userEnv} + passwordCommand (${spec.passwordCommand[0] ?? ''})`,
      };
    }
  }

  // Convention, in the same shape the env layer uses: the name is in the
  // variable, and both halves must be present.
  const userVar = robotUserEnvVar(spec.name);
  const passwordVar = robotPasswordEnvVar(spec.name);
  const bare = spec.name === bareConnectionName('robot');

  const user = readEnvValue(env, userVar) ?? (bare ? readEnvValue(env, ROBOT_USER_ENV) : undefined);
  const password =
    readEnvValue(env, passwordVar) ?? (bare ? readEnvValue(env, ROBOT_PASSWORD_ENV) : undefined);

  if (user !== undefined && password !== undefined) {
    return { user, password, source: `$${userVar} + $${passwordVar}` };
  }

  throw authError(
    `no Robot credential for connection "${spec.name}".`,
    `Set $${userVar} and $${passwordVar}` +
      (bare ? ` (or $${ROBOT_USER_ENV} and $${ROBOT_PASSWORD_ENV})` : '') +
      `, or give "${spec.name}" ${credentialSourceRule('robot')} in your config file. ` +
      'The Robot web-service user looks like "#123456+ws" and is created under Robot > Settings > Web service and app settings.',
  );
}

function requireEnv(
  spec: CredentialSpec,
  env: NodeJS.ProcessEnv,
  variable: string,
  field: string,
): string {
  const value = readEnvValue(env, variable);
  if (value === undefined) {
    throw authError(
      `connection "${spec.name}" declares ${field} "${variable}", but $${variable} is unset or empty.`,
      `Export $${variable} in the environment the MCP server starts from — every supported client config has an "env" block for exactly this.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runCommand(
  name: string,
  field: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const [file, ...args] = argv;
  if (file === undefined) {
    throw authError(`connection "${name}" has an empty ${field}.`);
  }

  try {
    const { stdout } = await execFileAsync(file, args, {
      // No `shell` option: execFile without it never invokes a shell, which is
      // the entire security property of this feature.
      env: childEnv(env),
      timeout: SECRET_COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_SECRET_OUTPUT_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error: unknown) {
    throw authError(
      `${field} failed for connection "${name}": ${commandFailure(file, error)}`,
      `Run \`${file}\` yourself in the same environment and confirm it prints the secret and nothing else.`,
    );
  }
}

/**
 * The child gets the ambient environment (it needs PATH, HOME, SSH_AUTH_SOCK,
 * OP_SERVICE_ACCOUNT_TOKEN...) minus our own Hetzner credentials. A helper that
 * fetches a credential has no business receiving the credentials we already
 * hold, and this is a user-configured process we do not otherwise constrain.
 */
const CREDENTIAL_ENV_PREFIXES = [
  CLOUD_TOKEN_ENV,
  ACCOUNT_TOKEN_ENV,
  ROBOT_USER_ENV,
  ROBOT_PASSWORD_ENV,
];

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (CREDENTIAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    copy[key] = value;
  }
  return copy;
}

interface ExecFailure {
  code?: unknown;
  killed?: boolean;
  stderr?: unknown;
  message?: unknown;
}

function commandFailure(file: string, error: unknown): string {
  const failure = (error ?? {}) as ExecFailure;

  if (failure.code === 'ENOENT') {
    return (
      `command not found: ${file}. Use an absolute path, or make sure it is on PATH for the process that ` +
      'starts the MCP server. On Windows it must be a real executable — .cmd and .bat shims cannot be ' +
      'launched without a shell, and hetzner-mcp never uses one.'
    );
  }
  if (failure.killed === true) {
    return `timed out after ${SECRET_COMMAND_TIMEOUT_MS / 1000}s (waiting on an unlock prompt?)`;
  }

  const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
  if (stderr !== '') {
    const firstLine = stderr.split('\n')[0] ?? '';
    return `exit ${String(failure.code ?? 'unknown')}: ${firstLine.slice(0, MAX_STDERR_CHARS)}`;
  }
  return typeof failure.message === 'string'
    ? failure.message
    : `exit ${String(failure.code ?? 'unknown')}`;
}

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

async function readKeychain(
  name: string,
  field: string,
  ref: KeychainRef,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  switch (platform) {
    case 'darwin':
      return runKeychainTool(name, field, 'security', [
        'find-generic-password',
        '-s',
        ref.service,
        '-a',
        ref.account,
        '-w',
      ]);
    case 'linux':
      return runKeychainTool(name, field, 'secret-tool', [
        'lookup',
        'service',
        ref.service,
        'account',
        ref.account,
      ]);
    case 'win32':
      return readWindowsDpapi(name, field, ref, env);
    default:
      throw authError(
        `${field} is not supported on ${platform} (connection "${name}").`,
        'Use a command source instead — it is an argv array, so any command that prints the secret works.',
      );
  }
}

async function runKeychainTool(
  name: string,
  field: string,
  file: string,
  args: string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      timeout: SECRET_COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_SECRET_OUTPUT_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error: unknown) {
    throw authError(
      `${field} lookup failed for connection "${name}": ${commandFailure(file, error)}`,
      file === 'secret-tool'
        ? 'Install libsecret-tools (Debian/Ubuntu: `apt install libsecret-tools`), or switch to a command source.'
        : `Check the item exists: \`${file} find-generic-password -s <service> -a <account>\`.`,
    );
  }
}

/**
 * Windows keychain path — honestly, not a keychain.
 *
 * No first-party Windows CLI returns a generic credential's *secret*: `cmdkey`
 * lists entries but never prints the blob, and reading it means CredRead()
 * through P/Invoke, which is a native dependency this project will not take
 * (it kills the `npx hetzner-mcp` install story).
 *
 * So this is DPAPI-at-rest instead of Credential Manager: ciphertext produced
 * by ConvertFrom-SecureString under the user's DPAPI key, stored at
 * %LOCALAPPDATA%\hetzner-mcp\credentials.dat, decryptable only by the same
 * Windows user on the same machine. That is weaker than Keychain or libsecret
 * — no per-item ACL, no unlock prompt, so any process running as that user can
 * decrypt it — and stronger than a credential sitting in a client config file.
 * The docs must say exactly this and must not imply parity.
 *
 * File format (v1). Written by the CLI, only read here:
 *   { "version": 1, "entries": { "<service>": { "<account>": "<hex ciphertext>" } } }
 */
const CREDENTIAL_STORE_DIR = 'hetzner-mcp';
const CREDENTIAL_STORE_FILE = 'credentials.dat';
const HEX_ONLY = /^[0-9a-fA-F]+$/;

interface CredentialStore {
  version?: unknown;
  entries?: Record<string, Record<string, unknown> | undefined>;
}

async function readWindowsDpapi(
  name: string,
  field: string,
  ref: KeychainRef,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const localAppData = readEnvValue(env, 'LOCALAPPDATA');
  if (localAppData === undefined) {
    throw authError(`cannot resolve ${field} for connection "${name}": %LOCALAPPDATA% is not set.`);
  }
  const storePath = path.join(localAppData, CREDENTIAL_STORE_DIR, CREDENTIAL_STORE_FILE);
  const setupHint =
    `Store it with \`npx hetzner-mcp secrets set --service ${ref.service} --account ${ref.account}\`, ` +
    'or switch the connection to a command source.';

  let contents: string;
  try {
    contents = await fs.readFile(storePath, 'utf8');
  } catch {
    throw authError(`no credential store at ${storePath} for connection "${name}".`, setupHint);
  }

  let store: CredentialStore;
  try {
    store = JSON.parse(contents) as CredentialStore;
  } catch {
    throw authError(`credential store ${storePath} is not valid JSON.`, setupHint);
  }

  const ciphertext = store.entries?.[ref.service]?.[ref.account];
  if (typeof ciphertext !== 'string' || !HEX_ONLY.test(ciphertext)) {
    throw authError(
      `credential store ${storePath} has no usable entry for service "${ref.service}" account "${ref.account}".`,
      setupHint,
    );
  }

  // The hex charset check above is what makes embedding the ciphertext in the
  // script text safe: no character is left that could close the quote. The
  // plaintext comes back over stdout and never touches a command line.
  const script = [
    '$ErrorActionPreference = "Stop";',
    `$secure = ConvertTo-SecureString -String '${ciphertext}';`,
    '$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);',
    'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }',
    'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }',
  ].join(' ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: SECRET_COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_SECRET_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
      },
    );
    return stdout;
  } catch (error: unknown) {
    throw authError(
      `DPAPI decryption failed for connection "${name}": ${commandFailure('powershell.exe', error)}`,
      `${storePath} can only be decrypted by the Windows user that wrote it, on the same machine. If the profile changed, store the credential again.`,
    );
  }
}

// ---------------------------------------------------------------------------

/**
 * Credential resolution failures surface through the same envelope as a
 * rejected request: from the caller's side "no credential" and "bad credential"
 * are the same problem, and HetznerError is what the tool layer already renders
 * with a hint.
 */
function authError(message: string, hint?: string): HetznerError {
  return new HetznerError(message, 'unauthenticated', hint);
}
