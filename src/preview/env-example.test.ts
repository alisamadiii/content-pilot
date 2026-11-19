import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnvExample, projectDevEnv } from './env-example';

test('parses the Shopify example with its shared description block', () => {
  const text = [
    '# Shopify Storefront API (public, read-only token — safe to ship to the browser).',
    "# Leave both unset in dev to use Shopify's public demo store.",
    'PUBLIC_SHOPIFY_STORE_DOMAIN=your-store.myshopify.com',
    'PUBLIC_SHOPIFY_STOREFRONT_TOKEN=',
  ].join('\n');
  assert.deepEqual(parseEnvExample(text), [
    {
      key: 'PUBLIC_SHOPIFY_STORE_DOMAIN',
      description:
        "Shopify Storefront API (public, read-only token — safe to ship to the browser). Leave both unset in dev to use Shopify's public demo store.",
      example: 'your-store.myshopify.com',
    },
    { key: 'PUBLIC_SHOPIFY_STOREFRONT_TOKEN', description: '', example: '' },
  ]);
});

test('strips export prefixes, quotes and inline comments', () => {
  const text = [
    'export API_URL="https://api.example.com" # quoted',
    "SINGLE='a # not a comment'",
    'PLAIN=value # trailing comment',
    'HASHED=https://x.dev/#anchor',
    'SPACED = spaced',
  ].join('\n');
  assert.deepEqual(
    parseEnvExample(text).map(({ key, example }) => [key, example]),
    [
      ['API_URL', 'https://api.example.com'],
      ['SINGLE', 'a # not a comment'],
      ['PLAIN', 'value'],
      ['HASHED', 'https://x.dev/#anchor'],
      ['SPACED', 'spaced'],
    ]
  );
});

test('a blank line resets the description; CRLF is fine', () => {
  const text = '# orphan comment\r\n\r\n# Real one\r\nKEY=1\r\nNEXT=2\r\n';
  assert.deepEqual(parseEnvExample(text), [
    { key: 'KEY', description: 'Real one', example: '1' },
    { key: 'NEXT', description: '', example: '2' },
  ]);
});

test('duplicates keep the first; invalid keys are skipped', () => {
  const text = [
    '# first',
    'DUP=one',
    'DUP=two',
    'lower_case=x',
    '1BAD=x',
    'BAD-DASH=x',
    'not an assignment',
    'OK=y',
  ].join('\n');
  assert.deepEqual(parseEnvExample(text), [
    { key: 'DUP', description: 'first', example: 'one' },
    { key: 'OK', description: '', example: 'y' },
  ]);
});

test('empty input yields no variables', () => {
  assert.deepEqual(parseEnvExample(''), []);
});

test('projectDevEnv keeps listed, non-reserved, non-empty values only', () => {
  assert.deepEqual(
    projectDevEnv(
      ['PUBLIC_A', 'NODE_ENV', 'EMPTY'],
      { PUBLIC_A: 'a', NODE_ENV: 'production', EMPTY: '', STALE: 'gone' },
      ['NODE_ENV', 'PATH']
    ),
    { PUBLIC_A: 'a' }
  );
});
