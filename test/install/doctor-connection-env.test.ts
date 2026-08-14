/**
 * The two ways Hetzner's credential naming scheme goes wrong.
 *
 * Neither exists in coolify-mcp, because neither can: Coolify has one API and
 * one token per connection, so a connection name cannot mean two things and a
 * credential cannot be half-supplied. Hetzner has three API surfaces and one of
 * them authenticates with HTTP Basic, and both consequences are invisible from
 * inside any single variable:
 *
 *   HETZNER_TOKEN_PROD + HETZNER_ACCOUNT_TOKEN_PROD
 *     Two correctly-spelled variables that both claim the connection name
 *     `prod`, on different surfaces, holding different resources. Which one a
 *     tool call reaches is decided by construction order.
 *
 *   HETZNER_ROBOT_USER_DC12 without HETZNER_ROBOT_PASSWORD_DC12
 *     Robot needs both halves. One half is not a weaker credential, it is not a
 *     credential — and the symptom (a connection that is missing, or a 401) does
 *     not name the variable that was forgotten.
 *
 * Both are reported from the environment alone, BEFORE registry resolution, so
 * they still appear on the runs where resolution fails because of them.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor, type DoctorFinding } from '../../src/install/doctor.js';

const created: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hetzner-mcp-connenv-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs doctor against an environment and two empty directories. */
async function findingsFor(env: NodeJS.ProcessEnv): Promise<DoctorFinding[]> {
  const report = await runDoctor({ homeDir: sandbox(), cwd: sandbox(), env });
  return report.findings;
}

const TOKEN = 'a1B2c3D4e5'.repeat(7).slice(0, 64);

function codes(findings: readonly DoctorFinding[]): string[] {
  return findings.map((finding) => finding.code);
}

describe('cross-surface connection name collision', () => {
  it('reports a name claimed by both the cloud and the account surface', async () => {
    const findings = await findingsFor({
      HETZNER_TOKEN_PROD: TOKEN,
      HETZNER_ACCOUNT_TOKEN_PROD: TOKEN,
    });

    expect(codes(findings)).toContain('connection-name-collision');
  });

  it('names both variables and both surfaces, so the fix is unambiguous', async () => {
    const findings = await findingsFor({
      HETZNER_TOKEN_PROD: TOKEN,
      HETZNER_ACCOUNT_TOKEN_PROD: TOKEN,
    });
    const collision = findings.find((f) => f.code === 'connection-name-collision');

    expect(collision?.message).toContain('HETZNER_TOKEN_PROD');
    expect(collision?.message).toContain('HETZNER_ACCOUNT_TOKEN_PROD');
    expect(collision?.message).toContain('cloud');
    expect(collision?.message).toContain('hetzner');
  });

  it('reports a collision between a bearer surface and robot', async () => {
    const findings = await findingsFor({
      HETZNER_TOKEN_DC12: TOKEN,
      HETZNER_ROBOT_USER_DC12: 'ws+ABCDEFGH',
      HETZNER_ROBOT_PASSWORD_DC12: 'hunter2',
    });

    expect(codes(findings)).toContain('connection-name-collision');
  });

  it('does not fire when the same surface defines several distinct names', async () => {
    const findings = await findingsFor({
      HETZNER_TOKEN_PROD: TOKEN,
      HETZNER_TOKEN_STAGING: TOKEN,
    });

    expect(codes(findings)).not.toContain('connection-name-collision');
  });

  it('does not confuse the bare forms, which are three different names', async () => {
    // HETZNER_TOKEN is `default`, HETZNER_ACCOUNT_TOKEN is `account`,
    // HETZNER_ROBOT_* is `robot`. Setting all three is the ordinary full setup.
    const findings = await findingsFor({
      HETZNER_TOKEN: TOKEN,
      HETZNER_ACCOUNT_TOKEN: TOKEN,
      HETZNER_ROBOT_USER: 'ws+ABCDEFGH',
      HETZNER_ROBOT_PASSWORD: 'hunter2',
    });

    expect(codes(findings)).not.toContain('connection-name-collision');
  });

  it('gives the bare account variable the name `account`, which a cloud var can collide with', async () => {
    // Pins the bare-form mapping: HETZNER_ACCOUNT_TOKEN is the connection
    // `account` on the hetzner surface, so HETZNER_TOKEN_ACCOUNT — the cloud
    // connection literally named `account` — is a collision. If the bare form
    // were given any other name this would go quiet, and the collision detector
    // would be blind to every setup that uses the bare variables at all.
    const findings = await findingsFor({
      HETZNER_ACCOUNT_TOKEN: TOKEN,
      HETZNER_TOKEN_ACCOUNT: TOKEN,
    });

    expect(codes(findings)).toContain('connection-name-collision');
  });
});

describe('half-configured robot connection', () => {
  it('reports a user with no password', async () => {
    const findings = await findingsFor({ HETZNER_ROBOT_USER_DC12: 'ws+ABCDEFGH' });
    const incomplete = findings.find((f) => f.code === 'robot-credentials-incomplete');

    expect(incomplete).toBeDefined();
    expect(incomplete?.message).toContain('HETZNER_ROBOT_PASSWORD_DC12');
  });

  it('reports a password with no user', async () => {
    const findings = await findingsFor({ HETZNER_ROBOT_PASSWORD_DC12: 'hunter2' });
    const incomplete = findings.find((f) => f.code === 'robot-credentials-incomplete');

    expect(incomplete).toBeDefined();
    expect(incomplete?.message).toContain('HETZNER_ROBOT_USER_DC12');
  });

  it('reports the bare pair by its bare names', async () => {
    const findings = await findingsFor({ HETZNER_ROBOT_USER: 'ws+ABCDEFGH' });
    const incomplete = findings.find((f) => f.code === 'robot-credentials-incomplete');

    expect(incomplete?.message).toContain('HETZNER_ROBOT_PASSWORD is not');
    // The bare pair has no `_<NAME>` suffix; inventing one would send the user
    // to a variable that does nothing.
    expect(incomplete?.message).not.toContain('HETZNER_ROBOT_PASSWORD_');
  });

  it('stays silent when both halves are present', async () => {
    const findings = await findingsFor({
      HETZNER_ROBOT_USER_DC12: 'ws+ABCDEFGH',
      HETZNER_ROBOT_PASSWORD_DC12: 'hunter2',
    });

    expect(codes(findings)).not.toContain('robot-credentials-incomplete');
  });

  it('treats an empty value as unset rather than as half a credential', async () => {
    // Every client config format lets a user leave `""` behind, and a blank that
    // counts as "set" produces a 401 instead of "not configured".
    const findings = await findingsFor({
      HETZNER_ROBOT_USER_DC12: 'ws+ABCDEFGH',
      HETZNER_ROBOT_PASSWORD_DC12: '   ',
    });

    expect(codes(findings)).toContain('robot-credentials-incomplete');
  });

  it('is reported even though registry resolution fails on the same input', async () => {
    // The whole reason this runs before resolveRegistry: the run where the
    // diagnosis is needed is the run where resolution did not survive.
    const findings = await findingsFor({ HETZNER_ROBOT_USER_DC12: 'ws+ABCDEFGH' });

    expect(codes(findings)).toContain('robot-credentials-incomplete');
  });
});
