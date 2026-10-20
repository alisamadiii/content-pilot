import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDomainMap } from './domain-map';

test('resolves hosts after start, misses return null', async () => {
  const map = createDomainMap({
    load: async () => new Map([['www.client.com', 42]]),
    refreshMs: 60_000,
  });
  await map.start();
  assert.equal(map.resolve('www.client.com'), 42);
  assert.equal(map.resolve('other.example'), null);
  map.stop();
});

test('refresh swaps the map atomically', async () => {
  let generation = 0;
  const map = createDomainMap({
    load: async () => {
      generation += 1;
      return new Map([[`gen${generation}.example`, generation]]);
    },
  });
  await map.start();
  assert.equal(map.resolve('gen1.example'), 1);
  await map.refresh();
  assert.equal(map.resolve('gen1.example'), null);
  assert.equal(map.resolve('gen2.example'), 2);
  map.stop();
});

test('a failing loader keeps the previous map serving', async () => {
  let fail = false;
  const map = createDomainMap({
    load: async () => {
      if (fail) throw new Error('db down');
      return new Map([['www.client.com', 7]]);
    },
  });
  await map.start();
  fail = true;
  await map.refresh();
  assert.equal(map.resolve('www.client.com'), 7);
  map.stop();
});

test('resolve before start returns null (empty map)', () => {
  const map = createDomainMap({ load: async () => new Map() });
  assert.equal(map.resolve('www.client.com'), null);
});
