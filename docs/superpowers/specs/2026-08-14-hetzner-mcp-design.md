# hetzner-mcp — design

Status: approved, in implementation
Date: 2026-08-14

## Purpose

An MCP server that exposes Hetzner's APIs to a model as a working operator
surface: find infrastructure, inspect it, watch it change, and change it. It is
built as a product for general use, not as an internal script — it is published
to npm, installs itself into eight MCP clients, and is expected to be run by
people who did not write it.

It is the second product in a family whose first member is `coolify-mcp`. The
architecture is deliberately the same, because the problems are the same:
credentials that must not land in config files, a REST surface too large to
expose as one tool per endpoint, and responses too large for a host's context
budget.

## Scope

Hetzner is not one API. Three surfaces are in scope:

| Surface | Host | Auth | Scope of a credential | Spec |
|---|---|---|---|---|
| `cloud` | `api.hetzner.cloud/v1` | Bearer | one **project** | official, OpenAPI 3.1.2, 189 ops |
| `hetzner` | `api.hetzner.com/v1` | Bearer | the **account** | official, OpenAPI 3.1.2, 32 ops |
| `robot` | `robot-ws.your-server.de` | HTTP Basic | the **account** | none published, ~105 ops |

Out of scope: the legacy DNS API at `dns.hetzner.com/api/v1`. Hetzner has moved
DNS into the Cloud API — the cloud spec carries 25 zone and RRSet operations
including zonefile import and export — so supporting the legacy endpoint would
be a second way to do a thing the product already does, with a third credential
type to explain.

### Delivery layers

The product is grown in layers, each of which is a working product:

- **v0.1** — `cloud` and `hetzner` surfaces, both generated from official specs.
  Full operator loop, generic catalog access, installer, CI, npm publish.
- **v0.2** — metrics and pricing depth; DNS ergonomics.
- **v0.3** — `robot` surface, with a hand-written catalog.

`robot` is last because it is the only surface without a machine-readable spec:
its catalog must be written and maintained by hand, and folding that into the
first release would trade a working product for unfinished breadth. The
`Surface` abstraction ships in v0.1 regardless, and is proven by carrying two
real surfaces rather than one — an abstraction with a single implementation is
a guess.

## Architecture

Layers, each depending only on those above it:

```
config/    connection registry — (surface, credential), never a stored secret
http/      one request() — per-surface auth, rate limits, error mapping
catalog/   generated at build time from the vendored specs
shaping/   the single envelope, the degradation ladder, redaction, cursors
tools/     the operator loop, plus the generic three-step door
install/   eight MCP client adapters, plan/diff/apply, doctor
```

`src/types.ts` is the seam between all of them. Every module implements against
it; changing it is a cross-cutting change.

## Connections

A connection is `(surface, credential)`. Nothing else is needed to address
N Hetzner accounts × M projects: a Cloud token is created inside a project and
cannot see any other, so a second project is a second token, which is a second
connection. This is the same conclusion `coolify-mcp` reached for teams, with
the surface added to the tuple so Robot and the account API need no second
mechanism.

### Base URLs are derived, not configured

Coolify is self-hosted, so its base URL is genuine user input. Hetzner runs
exactly one instance of each API, so a user-supplied base URL could only ever be
the value we already know, or a mistake. `SURFACE_BASE_URLS` derives it. A
`baseUrl` key in a config file is rejected as unknown. This removes a class of
misconfiguration instead of validating it.

### Credentials never live in config files

The connection schema is `.strict()` and has no `token` or `password` property,
so a literal credential cannot round-trip through the parser. The rejection is
the feature: the error message names the supported sources and the environment
variable that already works by convention, so the user's next action is legible
from the error alone.

Sources, at most one per connection:

- bearer surfaces: `tokenEnv` | `tokenCommand` | `tokenKeychain`
- `robot`: `userEnv` + `passwordEnv` | `userEnv` + `passwordCommand` |
  `credentialKeychain`

Resolution is lazy and cached for the process lifetime, so an unreachable secret
manager cannot stop the server from starting and reporting the problem through
a tool call.

### The env layer encodes the surface in the variable name

| Env var | Produces |
|---|---|
| `HETZNER_TOKEN` | `default`, surface `cloud` |
| `HETZNER_TOKEN_<NAME>` | `<name>`, surface `cloud` |
| `HETZNER_ACCOUNT_TOKEN[_<NAME>]` | surface `hetzner` |
| `HETZNER_ROBOT_USER_<NAME>` + `HETZNER_ROBOT_PASSWORD_<NAME>` | surface `robot` |

The surface lives in the variable's name rather than in a separate
`HETZNER_SURFACE_<NAME>` variable, because a separate variable can be forgotten,
and a forgotten surface means silently talking to the wrong API. In this scheme
"the variable exists" and "the surface is known" are the same fact.

`cloud` is the default surface for the bare and file forms because it is the
overwhelming majority of use; the minority pays the extra word.

Two failure modes exist here that `coolify-mcp` does not have, and both are
startup errors naming the specific variables involved:

1. **Cross-surface name collision** — `HETZNER_TOKEN_PROD` and
   `HETZNER_ACCOUNT_TOKEN_PROD` both claim `prod`.
2. **Half-configured robot connection** — a user without a password, or the
   reverse.

### File discovery

`HETZNER_MCP_CONFIG` → `./.hetzner-mcp.json` → `~/.config/hetzner-mcp/config.json`
(`%APPDATA%` on win32). **First hit wins wholesale**; no cross-scope merging,
because "which of these four files set `readOnly`?" is a question with no good
answer and the way to avoid it is to never create it. Env and file are unioned;
on a name collision the env entry replaces the file entry whole, and the
shadowed name is reported by `doctor`.

## Catalog

Generated at build time from the two vendored specs into `src/generated/`, and
committed. Every MCP client spawns this process fresh: a 3.4 MB parse per start,
a network dependency for a tool that may run against a locked-down network, and
a non-deterministic tarball are each worse than a file in git. CI re-runs codegen
and diffs the result, so upstream drift breaks the build loudly rather than
shipping a stale surface silently.

Operation counts are **pinned, not measured** — a generator that adapts to
whatever it is fed will happily emit a half-catalog after a bad spec refresh.

### Danger classification

`safe` for GET, `destructive` for DELETE, `write` otherwise — plus a
hand-maintained override list for operations that are irreversible without being
DELETEs. Each override must match exactly one operation or the build fails; a
renamed upstream route must not silently downgrade a destructive operation.

Known overrides: `POST /servers/{id}/actions/rebuild` (wipes the disk),
`POST /zones/{id_or_name}/actions/import_zonefile` (replaces a whole zone),
`POST /storage_boxes/{id}/actions/rollback_snapshot` (overwrites live data).

### Costly classification

Operations that open a bill are flagged `costly` and are **not gated**. This is
a deliberate product decision, taken with the consequence stated: the model can
provision billable infrastructure without a flag being set. What the product
does instead is make the cost visible — `costly` is surfaced in search results
before the call, and `meta.billing` carries the published price after it.

Flagged: `POST /servers`, `/volumes`, `/load_balancers`, `/floating_ips`,
`/primary_ips`, `/certificates`; `create_image` (snapshot storage),
`enable_backup` (+20%), `change_type` (re-rates the server), volume `resize`
(volumes bill by size and cannot shrink); and on the account surface
`POST /storage_boxes` and its `change_type`.

## Asynchrony — the structural difference from Coolify

Nearly every Hetzner mutation returns an `Action`, not the finished resource:
`{ action: { id, command, status: 'running', progress: 0 } }`. The work happens
afterwards. A tool that returns a running action and stops has told the model
nothing about whether anything happened.

`CatalogOperation.returnsAction` is derived from the spec, and the tool layer
either awaits the action or states plainly in `meta.action` that it did not.
Hetzner's own documentation warns against polling too frequently because the
rate limit is shared, so awaiting is bounded, backed off, and reports progress
through the MCP progress channel where the host supports it.

## HTTP

One `request()`. Per-surface auth from `SURFACE_AUTH`. Rate limiting matters
far more than in the self-hosted sibling: Cloud enforces 3600 requests/hour
shared by every client using that token, and Robot enforces per-endpoint limits
as low as 50/hour. `RateLimit-*` headers are parsed and reported; 429 honours
`Retry-After`, then bounded exponential backoff with jitter.

**A POST is never retried on an ambiguous transport failure.** A retried
`POST /servers` provisions and bills a second machine. This is the most
expensive mistake this layer can make and it is called out in the code.

Errors map from Hetzner's `error.code` — a closed vocabulary, and a better
diagnostic than a status code. Unrecognised codes map to `unknown` while
preserving the code verbatim. Two hints carry real diagnostic weight:
`protected` explains that protection must be removed first, and
`unauthenticated` on a cloud connection mentions project scoping, because a
token used against another project's resource presents as a 404 and is otherwise
an hour of chasing the wrong thing.

## Shaping

One envelope for every tool, with a graded degradation ladder — field projection,
then row limiting, then per-value capping — reporting which rung fired. Budget
~130 KB with a meta reserve.

Hetzner-specific pressure: a single cloud server object embeds its full image,
datacenter and server type, and the server type carries a price entry for every
location — 6–10 KB per server, most of it price tables nobody asked for.
Default field projection is correspondingly aggressive. Unlike Coolify, upstream
paginates, so cursors map onto real `page`/`per_page` rather than being invented.

### `root_password` — a deliberate exception to redaction

`POST /servers` returns `root_password` in plaintext when the server is created
without an SSH key. The reflex is to redact it. That would be wrong: it is the
only copy that will ever exist, and without it the machine the user just paid
for is unreachable. Suppressing it does not protect the user, it destroys the
thing they asked for.

So generated passwords pass through to the model, which must relay them, but are
excluded from anything logged, and the envelope flags their presence so the
surrounding copy can say the value is shown once. API tokens, SSH private keys
and console credentials are redacted unconditionally.

## Tool surface

The operator loop, plus a generic three-step door to everything else — the same
shape as the sibling product, so a user of one can read the other.

**Read** — `find_resources` (name, label selector or id, across resource types
and connections, `connection: "*"` fans out), `get_resource`, `get_action`
(with bounded `wait`), `get_metrics`, `get_pricing`.

**Write** — `create_server` (costly, awaits its action, surfaces price and
generated password), `control_resource` (power, rescue, protection, attach and
detach), `manage_dns` (zones and RRSets), `set_labels` (labels are Hetzner's
organizing primitive, and setting them is what makes `find_resources` useful).

**Generic** — `search_operations` → `describe_operation` →
`execute_read_operation` / `execute_write_operation` /
`execute_destructive_operation`. The destructive door is registered only when
`HETZNER_ALLOW_DESTRUCTIVE=true`.

The `connection` parameter is omitted from every schema when only one connection
exists, rather than being present and optional.

`instructions` states facts about the shipped configuration — which connections
exist, which gates are on — read off the registered tool set rather than
re-derived from flags, and never tells the model how to behave.

## Testing

Vitest, explicit imports, 80% floor. Catalog tests assert the pinned counts and
that every override and costly route still resolves. HTTP tests run against a
mocked fetch and cover the retry rules, especially the POST rule. Shaping tests
run against realistic payload sizes, because budget behaviour measured against
toy objects measures nothing. Installer golden fixtures are preserved from the
sibling product: an adapter that writes a subtly malformed entry into a user's
real editor config is the worst failure this product can have.

## Decisions taken, and what was rejected

| Decision | Rejected alternative | Why |
|---|---|---|
| Surface-typed connections | One merged virtual API | A cloud `server` is a VM; a robot `server` is leased hardware. Merging makes "reboot the server" ambiguous in a way that cannot be recovered from. |
| Surface-typed connections | One package per surface | Cross-surface search becomes impossible, and the shared code still has to be shared. |
| Copy-and-adapt the installer | Extract a shared package | Owner's call. Mitigated by keeping the copy structurally identical so it stays diffable and cheap to extract later. |
| Costly operations ungated | A second `ALLOW_COSTLY` flag | Owner's call, taken with the consequence stated. Cost is made visible instead. |
| Legacy DNS API dropped | Supporting it | Zones are in the Cloud API. A second way to do the same thing, with a third credential type. |
| Base URL derived | Configurable | Hetzner has one instance per API. |
