import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor } from '../../src/install/doctor.js';

/**
 * Cover for the plaintext-credential scanner, rebuilt around Hetzner's
 * credential model.
 *
 * The Coolify original pinned this scanner to a VALUE: a Laravel Sanctum token
 * is `<id>|<40+ base62>`, a shape that cannot occur by accident, and the
 * regression it guarded was a `{40}` quantifier that silently failed to match
 * the 48-character secrets a live instance issues. Doctor reported configs
 * holding real tokens as clean, and every test stayed green.
 *
 * Hetzner has no such shape. A cloud token is 64 base62 characters and so is a
 * SHA-256 digest, so a scanner keyed on the value would either miss real
 * credentials or scream about content hashes. The confidence therefore comes
 * from the LOCATION — a variable the naming scheme reserves for a credential —
 * and these tests pin that:
 *
 *   - every credential variable in the scheme is scanned, in bare and suffixed
 *     form, because a scheme that is only half-implemented is a silent miss of
 *     exactly the original's kind;
 *   - HETZNER_ROBOT_USER is NOT a credential — flagging an identifier trains
 *     people to ignore the finding;
 *   - a 64-character value that is not at a credential key is not a finding;
 *   - the value never appears in the report.
 */

const created: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hetzner-mcp-doctor-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a Claude Code user config carrying `env` verbatim, and scans it. */
async function scanWithEnv(env: Record<string, string>) {
  const home = sandbox();
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify(
      {
        mcpServers: {
          hetzner: {
            command: 'npx',
            args: ['-y', '-p', '@donedynamics/hetzner-mcp@latest', 'hetzner-mcp-server'],
            env,
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  // An empty cwd keeps project-scope adapters from picking up this repo's own files.
  const report = await runDoctor({ homeDir: home, cwd: sandbox(), env: {} });
  return report.findings.filter((f) => f.severity === 'critical');
}

/** A value that is credential-shaped: 64 base62 characters, as Hetzner issues. */
const TOKEN = 'a1B2c3D4e5'.repeat(7).slice(0, 64);

describe('doctor plaintext-credential scanner', () => {
  it.each([
    ['the bare cloud token variable', 'HETZNER_TOKEN'],
    ['a named cloud token variable', 'HETZNER_TOKEN_PROD'],
    ['the bare account token variable', 'HETZNER_ACCOUNT_TOKEN'],
    ['a named account token variable', 'HETZNER_ACCOUNT_TOKEN_BILLING'],
    ['the bare robot password variable', 'HETZNER_ROBOT_PASSWORD'],
    ['a named robot password variable', 'HETZNER_ROBOT_PASSWORD_DC12'],
  ])('reports a literal in %s', async (_why, variable) => {
    const critical = await scanWithEnv({ [variable]: TOKEN });

    expect(critical.map((f) => f.code)).toContain('plaintext-credential');
  });

  it('reports a robot password that has no token shape at all', async () => {
    // A Robot password is chosen by a human, so requiring a shape here would
    // miss every real one. The variable NAME is the whole basis for the finding.
    const critical = await scanWithEnv({ HETZNER_ROBOT_PASSWORD_DC12: 'hunter2' });

    expect(critical.map((f) => f.code)).toContain('plaintext-credential');
  });

  it('does not report the robot USER, which is an identifier and not a secret', async () => {
    const critical = await scanWithEnv({ HETZNER_ROBOT_USER_DC12: 'ws+ABCDEFGH' });

    expect(critical).toHaveLength(0);
  });

  it('does not report an env-var reference', async () => {
    const critical = await scanWithEnv({ HETZNER_TOKEN: '${HETZNER_TOKEN}' });

    expect(critical).toHaveLength(0);
  });

  it('does not report a documentation placeholder', async () => {
    const critical = await scanWithEnv({ HETZNER_TOKEN: 'YOUR_TOKEN_HERE' });

    expect(critical).toHaveLength(0);
  });

  it('does not report an empty value', async () => {
    const critical = await scanWithEnv({ HETZNER_TOKEN: '' });

    expect(critical).toHaveLength(0);
  });

  it('does not report a connection NAME, which is not a credential', async () => {
    const critical = await scanWithEnv({ HETZNER_CONNECTION: 'prod' });

    expect(critical).toHaveLength(0);
  });

  it('does not fire on a 64-character value that is not a credential variable', async () => {
    // The precision property the Coolify original got for free from the Sanctum
    // shape. A content hash next to an MCP entry is ordinary; a CRITICAL about
    // one would teach the reader to skip the section.
    const critical = await scanWithEnv({ BUNDLE_SHA256: TOKEN });

    expect(critical).toHaveLength(0);
  });

  it('never echoes the credential into the report', async () => {
    const critical = await scanWithEnv({ HETZNER_TOKEN: TOKEN });

    expect(critical.length).toBeGreaterThan(0);
    expect(JSON.stringify(critical)).not.toContain(TOKEN);
  });

  it('names where to revoke the credential for the surface it belongs to', async () => {
    // Three surfaces, three consoles. Sending a Robot user to the Cloud Console
    // is a remediation that cannot be followed.
    const cloud = await scanWithEnv({ HETZNER_TOKEN: TOKEN });
    const account = await scanWithEnv({ HETZNER_ACCOUNT_TOKEN: TOKEN });
    const robot = await scanWithEnv({ HETZNER_ROBOT_PASSWORD: 'hunter2' });

    expect(cloud[0]?.remediation).toContain('Cloud Console');
    expect(account[0]?.remediation).toContain('api.hetzner.com');
    expect(robot[0]?.remediation).toContain('Web service');
  });
});

describe('the raw-text sweep', () => {
  /** A config too broken to parse is where a hand-pasted credential hides. */
  async function scanUnparseable(body: string) {
    const home = sandbox();
    writeFileSync(join(home, '.claude.json'), body, 'utf8');
    const report = await runDoctor({ homeDir: home, cwd: sandbox(), env: {} });
    return report.findings.filter((f) => f.severity === 'critical');
  }

  it('finds a credential in a config that does not parse', async () => {
    const critical = await scanUnparseable(
      `{ "mcpServers": { "hetzner": { "env": { "HETZNER_TOKEN": "${TOKEN}" `,
    );

    expect(critical.map((f) => f.code)).toContain('plaintext-credential');
    expect(critical.some((f) => (f.lines ?? []).length > 0)).toBe(true);
  });

  it('does not report a reference left in an unparseable config', async () => {
    const critical = await scanUnparseable(
      '{ "mcpServers": { "hetzner": { "env": { "HETZNER_TOKEN": "${HETZNER_TOKEN}" ',
    );

    expect(critical).toHaveLength(0);
  });
});
