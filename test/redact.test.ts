import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSecrets,
  findOneTimeSecrets,
  getSecrets,
  isCredentialKey,
  isOneTimeSecretKey,
  logSafe,
  MASK,
  redact,
  redactObject,
  registerSecret,
} from '../src/shaping/redact.js';

/**
 * Shapes taken from the vendored specs rather than invented, so a change to
 * what Hetzner actually returns shows up here as a failing test.
 * `scripts/hetzner-cloud.openapi.json` supplies all of these verbatim.
 */
const CLOUD_TOKEN = 'LRK9DAWQ1ZAEFSrCNEEzLCUwhYX1U3g7wMg4dTlkkDC96fyDuyJ39nVbVjCKSDfj';
const ROOT_PASSWORD = 'YItygq1v3GYjjMomLaKc';
const CONSOLE_PASSWORD = '9MQaTg2VAGI0FIpc10k3UpRXcHj2wQ6x';
const WSS_URL =
  'wss://console.hetzner.cloud/?server_id=42&token=3db32d15-af2f-459c-8bf8-dee1fd05f49c';
const SSH_FINGERPRINT = 'b7:2f:30:a0:2f:6c:58:6c:21:04:58:61:ba:06:3b:2f';
const IMAGE_DIGEST = 'a'.repeat(40) + '0'.repeat(24);

const PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gt',
  'cnNhAAAAAwEAAQAAAYEAvJ8kQ2wPnW0mS7Qk1sVn9pXcRt3LmYb4Zx6uH0aJcD5eFgTi',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

afterEach(() => {
  clearSecrets();
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('secret registry', () => {
  it('scrubs a registered credential from anywhere in a string', () => {
    registerSecret(CLOUD_TOKEN);

    expect(redact(`Authorization failed for ${CLOUD_TOKEN} on retry`)).not.toContain(CLOUD_TOKEN);
  });

  it('registers the secret half of an id|secret credential on its own', () => {
    registerSecret(`77|${'k'.repeat(40)}`);

    // A truncated log line can carry the tail without the id half in front of it.
    expect(redact(`token tail ${'k'.repeat(40)} seen`)).toBe(`token tail ${MASK} seen`);
  });

  it('does not register the id half, which is not a credential', () => {
    registerSecret(`77|${'k'.repeat(40)}`);

    expect(redact('server 77 rebooted')).toBe('server 77 rebooted');
  });

  it('refuses values below the length floor, so a short value cannot eat the response', () => {
    registerSecret('abc');
    registerSecret('');
    registerSecret('   ');

    expect(getSecrets()).toEqual([]);
    expect(redact('abc def abc')).toBe('abc def abc');
  });

  it('masks the longest match first, so a prefix cannot leave a tail in the clear', () => {
    registerSecret('shortsecret');
    registerSecret('shortsecret-with-more');

    expect(redact('value=shortsecret-with-more')).toBe(`value=${MASK}`);
  });

  it('survives a credential containing regex metacharacters', () => {
    registerSecret('a+b(c)[d]*e?f');

    expect(redact('key a+b(c)[d]*e?f end')).toBe(`key ${MASK} end`);
  });
});

// ---------------------------------------------------------------------------
// The pattern backstop
// ---------------------------------------------------------------------------

describe('pattern backstop', () => {
  it('masks a Hetzner Cloud token this process never resolved', () => {
    // The realistic injection route: a user parked a token in a server label,
    // or an attacker put one in a field we echo back.
    const body = JSON.stringify({ labels: { note: `old token ${CLOUD_TOKEN}` } });

    expect(redact(body)).not.toContain(CLOUD_TOKEN);
    expect(redact(body)).toContain(MASK);
  });

  it('masks an Authorization header value whatever echoed it', () => {
    expect(redact(`Authorization: Bearer ${CLOUD_TOKEN}`)).toBe(`Authorization: Bearer ${MASK}`);
    expect(redact('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(
      `Authorization: Basic ${MASK}`,
    );
  });

  it('masks a PEM private key block', () => {
    const out = redact(`key:\n${PRIVATE_KEY}\ndone`);

    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEA');
    expect(out).toContain(MASK);
    expect(out).toContain('done');
  });

  it('strips the console token from a wss_url but keeps the addressable part', () => {
    const out = redact(WSS_URL);

    expect(out).not.toContain('3db32d15-af2f-459c-8bf8-dee1fd05f49c');
    expect(out).toContain('console.hetzner.cloud');
    expect(out).toContain('server_id=42');
  });

  it('leaves an SSH key fingerprint alone', () => {
    expect(redact(SSH_FINGERPRINT)).toBe(SSH_FINGERPRINT);
  });

  it('leaves a 64-character lowercase hex digest alone', () => {
    // Image checksums, Docker ids and git SHAs are all this shape. A backstop
    // that mangled them would be switched off, and then it protects nothing.
    expect(IMAGE_DIGEST).toHaveLength(64);
    expect(redact(IMAGE_DIGEST)).toBe(IMAGE_DIGEST);
  });

  it('leaves generated passwords alone — they are shorter than a token', () => {
    expect(redact(ROOT_PASSWORD)).toBe(ROOT_PASSWORD);
    expect(redact(CONSOLE_PASSWORD)).toBe(CONSOLE_PASSWORD);
  });
});

// ---------------------------------------------------------------------------
// Key classification
// ---------------------------------------------------------------------------

describe('key classification', () => {
  it.each([
    'token',
    'api_token',
    'console_token',
    'secret',
    'client_secret',
    'private_key',
    'api_key',
    'Authorization',
  ])('treats %s as a credential key', (key) => {
    expect(isCredentialKey(key)).toBe(true);
  });

  it.each(['ssh_keys', 'public_key', 'name', 'labels', 'primary_disk_size'])(
    'leaves %s alone',
    (key) => {
      expect(isCredentialKey(key)).toBe(false);
    },
  );

  it.each(['root_password', 'password', 'rescue_password'])(
    'treats %s as a one-time credential',
    (key) => {
      expect(isOneTimeSecretKey(key)).toBe(true);
    },
  );
});

describe('redactObject', () => {
  it('masks credential keys for the model', () => {
    const out = redactObject({ name: 'api', api_token: CLOUD_TOKEN, ssh_keys: [42, 43] });

    expect(out).toEqual({ name: 'api', api_token: MASK, ssh_keys: [42, 43] });
  });

  it('inherits sensitivity into arrays', () => {
    const out = redactObject({ tokens: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'] });

    expect(out).toEqual({ tokens: [MASK, MASK] });
  });

  it('does not mask an empty value, which would assert a credential exists', () => {
    expect(redactObject({ root_password: '', api_token: '' })).toEqual({
      root_password: '',
      api_token: '',
    });
  });

  it('leaves numbers and booleans structurally intact', () => {
    expect(redactObject({ id: 42, locked: false })).toEqual({ id: 42, locked: false });
  });

  it('strips the console token out of a wss_url while keeping the field', () => {
    const out = redactObject({ wss_url: WSS_URL });

    expect(out.wss_url).not.toContain('3db32d15');
    expect(out.wss_url).toContain('console.hetzner.cloud');
  });
});

// ---------------------------------------------------------------------------
// The root_password trade-off
// ---------------------------------------------------------------------------

describe('one-time generated credentials', () => {
  /** The real shape of a `POST /servers` response for a server with no SSH key. */
  const created = {
    server: { id: 42, name: 'db-1', status: 'initializing' },
    action: { id: 1337, command: 'create_server', status: 'running' },
    root_password: ROOT_PASSWORD,
    next_actions: [{ id: 1338, command: 'start_server', status: 'running' }],
  };

  it('passes root_password through to the model — it is the only copy that will exist', () => {
    const out = redactObject(created);

    expect(out.root_password).toBe(ROOT_PASSWORD);
  });

  it('excludes root_password from the log-safe projection', () => {
    const out = logSafe(created);

    expect(out.root_password).toBe(MASK);
    // Everything else still has to survive, or the log stops being a diagnostic.
    expect(out.server).toEqual({ id: 42, name: 'db-1', status: 'initializing' });
  });

  it('passes the VNC console password through but still hides the console token', () => {
    const console_ = { wss_url: WSS_URL, password: CONSOLE_PASSWORD };

    const forModel = redactObject(console_);
    const forLog = logSafe(console_);

    expect(forModel.password).toBe(CONSOLE_PASSWORD);
    expect(forModel.wss_url).not.toContain('3db32d15');
    expect(forLog.password).toBe(MASK);
  });

  it('never passes an API token through, whatever the audience', () => {
    expect(redactObject({ api_token: CLOUD_TOKEN })).toEqual({ api_token: MASK });
    expect(logSafe({ api_token: CLOUD_TOKEN })).toEqual({ api_token: MASK });
  });

  it('never passes an SSH private key through', () => {
    const out = redactObject({ private_key: PRIVATE_KEY });

    expect(out.private_key).toBe(MASK);
  });

  it('reports where the one-time credentials are, so the envelope can flag them', () => {
    expect(findOneTimeSecrets(created)).toEqual(['root_password']);
    expect(findOneTimeSecrets({ a: [{ password: 'x' }, { password: '' }] })).toEqual([
      'a[0].password',
    ]);
    expect(findOneTimeSecrets({ server: { id: 1 } })).toEqual([]);
  });

  it('does not mutate the payload it was given', () => {
    const input = { root_password: ROOT_PASSWORD, api_token: CLOUD_TOKEN };

    logSafe(input);

    expect(input.root_password).toBe(ROOT_PASSWORD);
    expect(input.api_token).toBe(CLOUD_TOKEN);
  });
});
