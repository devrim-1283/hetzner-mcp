/**
 * Redaction — and the one place in this server where "redact everything that
 * looks like a credential" is the WRONG answer.
 *
 * Three separate jobs, easy to confuse:
 *
 *  - {@link redact} removes OUR credentials from a finished string: the bearer
 *    tokens and Basic passwords this process resolved, plus anything matching a
 *    credential shape we never resolved. Never optional, applied to every byte
 *    that leaves the server.
 *  - {@link redactObject} masks HETZNER'S secrets by key name, recursively,
 *    before shaping. Masked by default.
 *  - {@link logSafe} is {@link redactObject} for a different audience: the log
 *    file. It masks strictly more, and the difference between the two is the
 *    subject of the long comment below.
 *
 * The secret registry lives here rather than in the config layer because
 * redaction is the consumer and a registry with no consumer is a registry
 * nobody notices has stopped being populated. The config layer calls
 * {@link registerSecret} at token-resolution time.
 */

export const MASK = '***';

/**
 * Values shorter than this are never registered as secrets.
 *
 * Two failure modes bound this number from opposite sides. Too low and the set
 * eats the response: one empty or near-empty string — a token command that
 * returned nothing, a `basic` credential whose password half was blank — would
 * splice `***` between every character of every payload. Too high and a short
 * Robot web-service password, which the user chooses and Hetzner does not
 * constrain to any useful length, silently stops being redacted at all.
 *
 * Eight is where those meet. A Hetzner Cloud token is 64 characters and a
 * generated Robot password is ~15, so no real credential sits near the floor;
 * what sits near it is a user-chosen Robot password, and for those the error we
 * want is over-masking. A payload where the word "resource" came out as `***`
 * is a confusing tool result the user can ask about. A payload where a live
 * password came out in the clear is not recoverable.
 */
const MIN_SECRET_LENGTH = 8;

// ---------------------------------------------------------------------------
// The one-time credential problem
// ---------------------------------------------------------------------------

/**
 * Keys whose value PASSES THROUGH to the model, and is masked only for logs.
 *
 * READ THIS BEFORE "FIXING" IT INTO A BLANKET REDACTION.
 *
 * `POST /servers` returns `root_password` in plaintext when the server was
 * created without an SSH key. Hetzner generates it, shows it in that one
 * response, and never returns it again — there is no endpoint that reads it
 * back. The same is true of the VNC password from `request_console`, of Robot's
 * rescue-system and reset passwords, and of generated Storage Box passwords.
 *
 * Redacting it is the reflex, and it is wrong. Redaction protects a user from a
 * credential they already hold leaking somewhere they did not expect. This is
 * the opposite situation: the user does not hold this credential yet, the model
 * is the only channel by which they can ever receive it, and the resource they
 * just paid for is unreachable without it. Masking it does not protect the
 * user — it destroys the thing they asked for and bills them for the wreckage.
 * "Create a server" would return a server nobody can log into, and the only
 * remedy left would be to delete it and try again.
 *
 * So the trade-off is resolved by audience rather than by value:
 *
 *   to the model   pass through, because relaying it to the user is the entire
 *                  reason the value exists. The envelope flags its presence so
 *                  the surrounding copy can say it is shown once.
 *   to a log,
 *   a diagnostic,
 *   an error dump  masked, because those outlive the conversation and are
 *                  shared without being reread.
 *
 * That is the whole point: a chat transcript is a channel the user is watching
 * right now; a log file is a channel nobody is watching until it is too late.
 * Anything that narrows this set should be able to answer "and how does the
 * user get into the server they just created?".
 */
const ONE_TIME_SECRET_KEYS: ReadonlySet<string> = new Set([
  'root_password',
  'password',
  'rescue_password',
]);

/**
 * Keys masked for every audience, including the model.
 *
 * These fail the test the one-time set passes: every one of them is either a
 * credential the user already has by another route (an API token they created,
 * an SSH key they generated) or a credential that grants access without the
 * user ever needing to read it (a console token embedded in a URL). Relaying
 * them to the model buys nothing and puts a live credential in a transcript.
 *
 * `_key$` deliberately does not appear: Hetzner's `ssh_keys` on a server is an
 * array of numeric ids, and `public_key` is public by definition. Masking
 * either would destroy structure to protect nothing.
 */
const CREDENTIAL_KEY =
  /(?:^|_)(?:token|secret|passphrase|credential)s?$|(?:^|_)(?:private|api|access)_key$|^authorization$/i;

// ---------------------------------------------------------------------------
// Shape-based patterns, for credentials this process never resolved
// ---------------------------------------------------------------------------

/**
 * A Hetzner Cloud API token: exactly 64 alphanumerics, containing at least one
 * lowercase letter, one uppercase letter and one digit.
 *
 * The shape is taken from the spec's own example
 * (`scripts/hetzner-cloud.openapi.json`, `info.description`), which is the only
 * 64-character alphanumeric run anywhere in either vendored spec.
 *
 * The three character-class requirements are what keep this off legitimate
 * data, and they were chosen after checking what long strings Hetzner actually
 * returns:
 *
 *   SSH key and image fingerprints  colon-separated hex pairs
 *                                   (`b7:2f:30:a0:...`) — the colons break the
 *                                   run, so they can never match.
 *   any lowercase hex digest        an ISO or image checksum, a Docker id, a
 *                                   git SHA a user parked in a label. All are
 *                                   64 characters and all are lowercase-plus-
 *                                   digits, so the uppercase requirement
 *                                   excludes every one of them.
 *   generated passwords             `root_password` and the VNC console
 *                                   password are 20 and 32 characters in the
 *                                   spec's examples. The exact-64 anchor means
 *                                   the backstop cannot eat the one credential
 *                                   this module deliberately passes through.
 *
 * A backstop that mangled every fingerprint would get switched off, and a
 * backstop that is switched off protects nothing — so the conservative pattern
 * is the useful one.
 */
const HETZNER_TOKEN =
  /\b(?=[A-Za-z0-9]{64}\b)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{64}\b/g;

/** `Authorization: Bearer <...>` / `Basic <...>`, wherever it was echoed from. */
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * A PEM private key block. Matched non-greedily so two keys in one payload are
 * two matches rather than one match spanning the text between them.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;

/** OpenSSH's own single-line private key form, which the PEM pattern above misses. */
const OPENSSH_PRIVATE_KEY = /\bb3BlbnNzaC1rZXktdjEA[A-Za-z0-9+/=]+/g;

/**
 * A credential carried as a query parameter.
 *
 * `request_console` returns
 * `wss://console.hetzner.cloud/?server_id=42&token=<uuid>`, and that token is a
 * live grant of console access to the machine. The host and the server id are
 * useful context and survive; the token does not.
 */
const URL_CREDENTIAL_PARAM = /([?&](?:token|access_token|auth|key|signature|sig)=)[^&\s"'\\]+/gi;

// ---------------------------------------------------------------------------
// Secret registry
// ---------------------------------------------------------------------------

const secrets = new Set<string>();

/**
 * Registers a value that must be scrubbed from every log line, error message
 * and tool result. Called at credential-resolution time so a token is
 * redactable before any code path can reach an output stream with it.
 */
export function registerSecret(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  secrets.add(trimmed);

  // Composite credentials are registered as their whole and as their secret
  // half. A value of the form `<id>|<secret>` can reach an output path already
  // split — a truncated log line, a header that got wrapped, an error message
  // that quoted only the tail — and the half that is left is still live. Only
  // the tail is registered: the id half is not a credential, and registering it
  // would mask a bare number wherever it appeared.
  const separator = trimmed.indexOf('|');
  if (separator > 0) {
    const tail = trimmed.slice(separator + 1);
    if (tail.length >= MIN_SECRET_LENGTH) secrets.add(tail);
  }
}

/**
 * Every registered secret, longest first. The order is load-bearing: masking a
 * short secret that is a prefix of a longer one would leave the remainder of
 * the longer one sitting in the clear next to a `***`.
 */
export function getSecrets(): string[] {
  return [...secrets].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** Test hook. Production never unregisters — a resolved token stays redactable. */
export function clearSecrets(): void {
  secrets.clear();
}

// ---------------------------------------------------------------------------
// String redaction
// ---------------------------------------------------------------------------

/**
 * Replace every registered secret, and everything matching a credential shape,
 * with `***`.
 *
 * Shape matching is a backstop rather than the primary mechanism: a token this
 * process never resolved can still arrive in a response body, because a Hetzner
 * label value or a cloud-init user_data blob holding another system's
 * credential is an entirely ordinary thing to find.
 */
export function redact(text: string, registered: Iterable<string> = getSecrets()): string {
  let out = text;
  for (const secret of sortSecrets(registered)) {
    // split/join rather than a regex: no escaping, so a credential containing
    // regex metacharacters cannot silently fail to match.
    out = out.split(secret).join(MASK);
  }
  return out
    .replace(PRIVATE_KEY_BLOCK, MASK)
    .replace(OPENSSH_PRIVATE_KEY, MASK)
    .replace(AUTH_HEADER, (_match, scheme: string) => `${scheme} ${MASK}`)
    .replace(URL_CREDENTIAL_PARAM, `$1${MASK}`)
    .replace(HETZNER_TOKEN, MASK);
}

// ---------------------------------------------------------------------------
// Object redaction
// ---------------------------------------------------------------------------

/**
 * Who is going to read this.
 *
 * `'model'` is the chat transcript: the user is present and watching.
 * `'log'` is anything durable — a log file, a crash dump, a bug report
 * attachment — where nobody is watching and everybody eventually looks.
 */
export type Audience = 'model' | 'log';

export interface RedactOptions {
  audience?: Audience;
  /** Override the registered secret set. Present for tests; production reads the registry. */
  secrets?: Iterable<string>;
}

/**
 * Mask credential-shaped keys recursively, then run {@link redact} over every
 * surviving string.
 *
 * The default audience is `'model'`, because the overwhelming majority of calls
 * are shaping a tool result. A caller writing to a log has to say so — and
 * {@link logSafe} exists so that saying so is one word.
 */
export function redactObject<T>(value: T, opts: RedactOptions = {}): T {
  const registered = sortSecrets(opts.secrets ?? getSecrets());
  const audience: Audience = opts.audience ?? 'model';
  // Masking maps strings to strings and preserves every key, so the shape —
  // and therefore T — survives the walk.
  return walk(value, registered, audience, 'plain') as T;
}

/**
 * The projection for anything durable: everything {@link redactObject} masks,
 * plus the one-time credentials the model is allowed to see.
 *
 * Every logger, diagnostic dump and `doctor` report goes through here. A
 * `root_password` reaching a log file would sit there long after the
 * conversation that justified showing it has ended.
 */
export function logSafe<T>(value: T, opts: Omit<RedactOptions, 'audience'> = {}): T {
  return redactObject(value, { ...opts, audience: 'log' });
}

/**
 * The key paths of one-time credentials present in a payload.
 *
 * The envelope uses this to flag the response: a value that exists exactly once
 * has to be labelled as such where the user can see it, or it reads like any
 * other field and gets scrolled past.
 */
export function findOneTimeSecrets(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const here = path === '' ? key : `${path}.${key}`;
      if (
        ONE_TIME_SECRET_KEYS.has(key.toLowerCase()) &&
        typeof child === 'string' &&
        child !== ''
      ) {
        found.push(here);
        continue;
      }
      visit(child, here);
    }
  };
  visit(value, '');
  return found;
}

/** True when a key name holds a credential that is masked for every audience. */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key);
}

/** True when a key name holds a credential Hetzner will never return again. */
export function isOneTimeSecretKey(key: string): boolean {
  return ONE_TIME_SECRET_KEYS.has(key.toLowerCase());
}

/** How the parent key classified this node. */
type Classification = 'plain' | 'credential' | 'one-time';

function walk(
  node: unknown,
  registered: readonly string[],
  audience: Audience,
  classification: Classification,
): unknown {
  if (typeof node === 'string') {
    // An empty string is never masked: `"root_password": ""` rendered as `***`
    // asserts that a password exists, which is a different and wrong claim.
    if (node === '') return node;
    if (classification === 'credential') return MASK;
    if (classification === 'one-time') return audience === 'log' ? MASK : node;
    // Every other string still goes through the shape backstop, which is what
    // strips the console token out of a `wss_url` without needing a key rule
    // for every field that might carry a credential in its query string.
    return redact(node, registered);
  }
  if (Array.isArray(node)) {
    // Classification is inherited: `"tokens": ["...", "..."]` is a list of tokens.
    return node.map((item) => walk(item, registered, audience, classification));
  }
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = walk(child, registered, audience, classify(key));
    }
    return out;
  }
  // Numbers and booleans carry no credential, and masking them destroys
  // structure for nothing.
  return node;
}

function classify(key: string): Classification {
  // One-time wins over the credential rule deliberately: `root_password` would
  // otherwise be caught by any broadening of CREDENTIAL_KEY and quietly lost.
  if (isOneTimeSecretKey(key)) return 'one-time';
  if (CREDENTIAL_KEY.test(key)) return 'credential';
  return 'plain';
}

function sortSecrets(values: Iterable<string>): string[] {
  return [...values]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
