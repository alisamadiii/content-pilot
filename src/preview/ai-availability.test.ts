import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  aiUnavailableReason,
  checkAiAvailability,
  checkClaude,
  checkGemini,
} from './ai-availability';

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

const mockFetch = (handler: (url: string) => Response | Promise<Response>) => {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url);
  }) as typeof fetch;
};
afterEach(() => {
  globalThis.fetch = realFetch;
});
const logs = () => {
  const out: string[] = [];
  return { out, log: (m: string) => out.push(m) };
};

test('claude: missing key disables chat with the "not configured" reason (no network call)', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  mockFetch(() => new Response('', { status: 200 }));
  const l = logs();
  await checkClaude(l.log);
  assert.equal(aiUnavailableReason('claude'), 'AI editing is not configured on this server (no API key).');
  assert.equal(calls.length, 0);
  assert.match(l.out[0], /ANTHROPIC_API_KEY not set/);
});

test('claude: a 401 marks the key invalid; the probe carries the key + version headers', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  mockFetch(() => new Response('', { status: 401 }));
  const l = logs();
  await checkClaude(l.log);
  assert.equal(aiUnavailableReason('claude'), 'AI editing is misconfigured on this server (invalid API key).');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=1');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  assert.match(l.out[0], /invalid \(401\)/);
});

test('claude: 200 clears a previous failure; non-401 errors and network failures keep chat enabled', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  mockFetch(() => new Response('', { status: 200 }));
  await checkClaude(() => {});
  assert.equal(aiUnavailableReason('claude'), null);
  mockFetch(() => new Response('', { status: 500 }));
  await checkClaude(() => {});
  assert.equal(aiUnavailableReason('claude'), null);
  mockFetch(() => {
    throw new Error('ENOTFOUND');
  });
  const l = logs();
  await checkClaude(l.log);
  assert.equal(aiUnavailableReason('claude'), null);
  assert.match(l.out[0], /preflight skipped \(network\): ENOTFOUND/);
});

test('gemini: missing key → not configured; the key is sent URL-encoded with pageSize=1', async () => {
  delete process.env.GEMINI_API_KEY;
  mockFetch(() => new Response('', { status: 200 }));
  await checkGemini(() => {});
  assert.equal(aiUnavailableReason('gemini'), 'AI editing is not configured on this server (no API key).');
  assert.equal(calls.length, 0);
  process.env.GEMINI_API_KEY = 'a b&c';
  await checkGemini(() => {});
  assert.equal(aiUnavailableReason('gemini'), null);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models?key=a%20b%26c&pageSize=1');
});

test('gemini: 400, 401 and 403 all mean an invalid key; 429/500 do not', async () => {
  process.env.GEMINI_API_KEY = 'g';
  for (const status of [400, 401, 403]) {
    mockFetch(() => new Response('', { status }));
    const l = logs();
    await checkGemini(l.log);
    assert.equal(aiUnavailableReason('gemini'), 'AI editing is misconfigured on this server (invalid API key).', String(status));
    assert.match(l.out[0], new RegExp(`invalid \\(${status}\\)`));
  }
  for (const status of [429, 500]) {
    mockFetch(() => new Response('', { status }));
    await checkGemini(() => {});
    assert.equal(aiUnavailableReason('gemini'), null, String(status));
  }
});

test('providers are independent: a bad claude key never disables gemini', async () => {
  process.env.ANTHROPIC_API_KEY = 'bad';
  process.env.GEMINI_API_KEY = 'good';
  mockFetch((url) => new Response('', { status: url.includes('anthropic') ? 401 : 200 }));
  await checkAiAvailability(() => {});
  assert.equal(aiUnavailableReason('claude'), 'AI editing is misconfigured on this server (invalid API key).');
  assert.equal(aiUnavailableReason('gemini'), null);
  assert.equal(calls.length, 2);
});
