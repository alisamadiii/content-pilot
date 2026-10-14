import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseImageDir, publicRelFor, slugify } from './image-dirs';

test('slugify makes a short kebab-case stem and drops filler words', () => {
  assert.equal(slugify('Photo of Ali Samadi, the founder'), 'ali-samadi-founder');
  assert.equal(slugify('IMG_2041.webp'), '2041');
  assert.equal(slugify('Café façade — façade!'), 'cafe-facade-facade');
});

test('slugify never returns empty and caps length', () => {
  assert.equal(slugify(''), 'image');
  assert.equal(slugify('the a of'), 'image');
  assert.equal(slugify('x', 'fallback'), 'x');
  assert.ok(slugify('word '.repeat(40)).length <= 60);
});

const hints = [
  { dir: 'public/images/projects', count: 14 },
  { dir: 'public/images/team', count: 6 },
  { dir: 'public/images', count: 3 },
  { dir: 'src/assets/icons', count: 40 },
];

test('chooseImageDir picks the existing folder that matches the description', () => {
  assert.equal(chooseImageDir('New team member headshot', hints, 'public'), 'public/images/team');
  assert.equal(chooseImageDir('kitchen project after photo', hints, 'public'), 'public/images/projects');
});

test('chooseImageDir falls back to images/uploads and never picks src/ or bare images/', () => {
  assert.equal(chooseImageDir('a nice sunset', hints, 'public'), 'public/images/uploads');
  assert.equal(chooseImageDir('icons for the nav', hints, 'public'), 'public/images/uploads');
  assert.equal(chooseImageDir('anything', [], 'site/public'), 'site/public/images/uploads');
});

test('chooseImageDir respects the app subfolder prefix', () => {
  const nested = [{ dir: 'site/public/images/team', count: 2 }, { dir: 'public/images/team', count: 9 }];
  assert.equal(chooseImageDir('team photo', nested, 'site/public'), 'site/public/images/team');
});

test('publicRelFor is public for root apps and prefixed for subfolder apps', () => {
  assert.equal(publicRelFor('/w/1', '/w/1'), 'public');
  assert.equal(publicRelFor('/w/1', '/w/1/site'), 'site/public');
  assert.equal(publicRelFor('/w/1', '/w/1/apps/web'), 'apps/web/public');
});
