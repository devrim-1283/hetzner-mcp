# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

First release.

### Added

**Connections.** A connection is one API surface and one credential. A Hetzner
Cloud token is created inside a project and cannot see another, so N projects
across M accounts are N connections and nothing else is needed. Configuration is
either bare environment variables — `HETZNER_TOKEN` is a working setup on its
own — or a registry file for per-connection settings, with the first file found
winning wholesale and no cross-scope merging.

Credentials cannot be written into that file: the schema has no `token`,
`password` or `user` property and rejects unknown keys, so a credential in a
config file is a startup error naming the three places it can live instead.
Credentials come from an environment variable, an argv handed to `execFile`
without a shell, or the OS keychain, and are resolved lazily so an unreachable
secret manager cannot stop the server from starting and reporting the problem.

**Two API surfaces**, both generated from Hetzner's official OpenAPI
specifications: Hetzner Cloud (189 operations, project-scoped) and the
account-scoped Hetzner API (32 operations, Storage Boxes). The specs are
vendored and the catalog is committed; CI regenerates and diffs it, so an
upstream change breaks the build rather than shipping a stale tool surface.

**Thirteen tools.** `find_resources` searches by name, by label selector, or by
listing a type, across one connection or all of them. `get_resource`,
`get_action`, `get_metrics` and `get_pricing` read; `create_server`,
`control_resource`, `manage_dns` and `set_labels` write; and
`search_operations` → `describe_operation` → `execute_read_operation` /
`execute_write_operation` reach every one of the 221 operations, which would
otherwise have cost 221 tool schemas on every turn.

**Action awaiting.** 144 of the 221 operations return an Action rather than a
result, so waiting is the default and `meta.action.awaited` reports honestly
when a wait gave up. A failed Action is an error, because Hetzner reports
asynchronous failure inside the Action and a call that returned 201 and then
failed would otherwise read as success.

**Cost visibility.** Operations that open a bill are marked `costly` in search
results, and a call that created something reports Hetzner's published price in
`meta.billing`. The price comes from `GET /pricing` rather than the price table
embedded in the response, because the embedded table carries no currency and
Hetzner invoices some accounts in USD.

**An installer** for eight MCP clients — Claude Code, Claude Desktop, Codex,
Cursor, Zed, opencode, Kimi and MiniMax — that shows a diff before writing,
refuses to merge into a config it cannot parse, and writes a pointer rather than
a credential. Plus `doctor`, which reports what is configured, where each
connection came from, and what is wrong — including a credential pasted into a
client config.

### Security

- Tool schemas contain no `baseUrl`, `url`, `host` or credential parameter.
  `connection` is an enum over the configured names, so an instruction to point
  at another host has no schema position to land in.
- The HTTP client builds URLs by concatenation onto the surface's own origin,
  refuses every redirect, rejects paths carrying a query, fragment or traversal
  segment, and scrubs the credential out of response bodies before parsing.
- A POST is never retried on an ambiguous transport failure, because a retried
  `POST /servers` provisions and bills a second machine.
- `readOnly` refuses every non-GET at the transport before the socket opens, and
  is a ceiling that a connection cannot opt out of.
- The destructive gate is three layers deep, and
  `execute_destructive_operation` is not registered at all when destructive
  operations are disabled — so no tool carries `destructiveHint: true` on a
  server that cannot destroy anything.
- Credentials are registered for redaction on resolution, and a pattern backstop
  catches ones this process never resolved. The backstop is anchored at exactly
  64 mixed-case characters so it cannot eat the lowercase hex digests and
  colon-separated fingerprints that fill these payloads.
- A generated `root_password` is a deliberate exception: it passes through to
  the model and is masked only on the log path, because it is the only copy that
  will ever exist and a machine nobody can log into is not a machine. The
  envelope names it in `meta.one_time_secrets`.

### Known limitations

- The Robot surface (dedicated servers) is not implemented. It has no published
  OpenAPI specification, so its catalog must be written by hand; it is planned
  for 0.3.0.
- Operations that open a bill are **not** gated behind a flag. See
  [SECURITY.md](SECURITY.md#residual-risk--stated-plainly).
- `manage_dns` lists at most one page of record sets; a zone with more needs
  `execute_read_operation`.
- The generic executor cannot express a repeated query parameter, so multi-value
  filters such as `sort` and `status` are single-valued through that path.
