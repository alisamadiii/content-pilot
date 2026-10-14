import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicRelFor, validatePlacement } from './attachments';

const root = { publicRel: 'public', ext: 'webp' };
const nested = { publicRel: 'site/public', ext: 'jpg' };

test('validatePlacement accepts a well-formed path under public/', () => {
  assert.deepEqual(
    validatePlacement('public/images/projects/ortega-kitchen-remodel.webp', root),
    { dest: 'public/images/projects/ortega-kitchen-remodel.webp' }
  );
});

test('validatePlacement accepts the public URL form and prefixes the folder', () => {
  assert.deepEqual(validatePlacement('/images/projects/ortega.webp', root), {
    dest: 'public/images/projects/ortega.webp',
  });
  assert.deepEqual(validatePlacement('/images/team/ali.jpg', nested), {
    dest: 'site/public/images/team/ali.jpg',
  });
});

test('validatePlacement tolerates a leading slash or ./ before public', () => {
  assert.deepEqual(validatePlacement('/public/images/a-b.webp', root), {
    dest: 'public/images/a-b.webp',
  });
  assert.deepEqual(validatePlacement('./public/images/a-b.webp', root), {
    dest: 'public/images/a-b.webp',
  });
});

test('validatePlacement rejects traversal and absolute escapes', () => {
  assert.match(
    (validatePlacement('public/../.env.webp', root) as { error: string }).error,
    /inside the site|inside `public\/`/
  );
  assert.match(
    (validatePlacement('../public/images/x.webp', root) as { error: string }).error,
    /inside the site/
  );
  // A leading slash means "public URL path", so an absolute-looking path can
  // only ever land inside the public folder.
  assert.deepEqual(validatePlacement('/etc/passwd.webp', root), {
    dest: 'public/etc/passwd.webp',
  });
});

test('validatePlacement rejects paths outside the public folder', () => {
  assert.match(
    (validatePlacement('src/assets/x.webp', root) as { error: string }).error,
    /inside `public\/`/
  );
  assert.match(
    (validatePlacement('public/images/x.webp', nested) as { error: string }).error,
    /inside `site\/public\/`/
  );
});

test('validatePlacement requires a subfolder, kebab-case name and matching extension', () => {
  assert.match(
    (validatePlacement('public/x.webp', root) as { error: string }).error,
    /in a folder under/
  );
  assert.match(
    (validatePlacement('public/images/IMG_2041.webp', root) as { error: string }).error,
    /kebab-case/
  );
  assert.match(
    (validatePlacement('public/images/photo.jpg', root) as { error: string }).error,
    /extension must stay \.webp/
  );
  assert.match(
    (validatePlacement('public/images/photo.exe', root) as { error: string }).error,
    /kebab-case/
  );
});

test('validatePlacement rejects empty and non-string values', () => {
  assert.match((validatePlacement('', root) as { error: string }).error, /no path/);
  assert.match((validatePlacement(null, root) as { error: string }).error, /no path/);
  assert.match((validatePlacement(42, root) as { error: string }).error, /no path/);
});

test('publicRelFor is public for root apps and prefixed for subfolder apps', () => {
  assert.equal(publicRelFor('/w/1', '/w/1'), 'public');
  assert.equal(publicRelFor('/w/1', '/w/1/site'), 'site/public');
  assert.equal(publicRelFor('/w/1', '/w/1/apps/web'), 'apps/web/public');
});
