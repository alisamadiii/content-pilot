import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractCandidates, findAmbiguity, requestedKind } from './ambiguity';

// EmpowerHer get-involved/SplitScreen.astro, trimmed: two <a> buttons.
const splitScreen = `
<section>
  <h2 class="text-3xl">Partner with us</h2>
  <p>EmpowerHer would love to partner with organizations.</p>
  <a href="/get-involved/partner-with-us" class="group/btn mt-8 inline-flex rounded-full bg-white">
    Become a Partner
    <span class="flex size-6"><svg></svg></span>
  </a>
  <h2 class="text-3xl">Volunteer</h2>
  <a href="/get-involved/volunteer-with-us" class="group/btn mt-8 inline-flex rounded-full border">
    Start Volunteering
    <span class="flex size-6"><svg></svg></span>
  </a>
  <a href="/privacy" class="text-xs underline">Privacy</a>
  <img src="/images/team/mahdi.webp" alt="Mahdi Rahimi" />
  <img src="/images/hero.webp" alt="" />
  <button data-hero-dot aria-label="Image 1" class="h-[3px]"></button>
</section>`;

const files = [{ path: 'src/components/marketing/get-involved/SplitScreen.astro', content: splitScreen }];

test('extractCandidates: buttons = <button> with text + anchors styled as buttons, not plain links or icon-only dots', () => {
  assert.deepEqual(extractCandidates('button', splitScreen), ['Become a Partner', 'Start Volunteering']);
});

test('extractCandidates: headings, images (alt or filename), links', () => {
  assert.deepEqual(extractCandidates('heading', splitScreen), ['Partner with us', 'Volunteer']);
  assert.deepEqual(extractCandidates('image', splitScreen), ['Mahdi Rahimi', 'hero.webp']);
  assert.deepEqual(extractCandidates('link', splitScreen), ['Become a Partner', 'Start Volunteering', 'Privacy']);
});

test('extractCandidates: component buttons (<Button>, <LinkButton label=…>) and {expr} labels are skipped', () => {
  const src = `<Button href="/x">Donate now</Button>\n<LinkButton label="Apply" href="/a" />\n<Button>{t('cta')}</Button>`;
  assert.deepEqual(extractCandidates('button', src), ['Donate now', 'Apply']);
});

test('requestedKind: most specific word wins; "button text" is a button, not text', () => {
  assert.equal(requestedKind('Change the button text to Get Involved'), 'button');
  assert.equal(requestedKind('swap the photo'), 'image');
  assert.equal(requestedKind('update the heading'), 'heading');
  assert.equal(requestedKind('fix the link'), 'link');
  assert.equal(requestedKind('make the paragraph shorter'), null);
});

test('findAmbiguity: EmpowerHer case — "the button" with two buttons → asks, lists both', () => {
  const q = findAmbiguity('Change the button text to Get Involved', files);
  assert.ok(q);
  assert.match(q, /I found 2 buttons on this page: “Become a Partner”, “Start Volunteering”/);
  assert.match(q, /Which one do you mean\?/);
  assert.match(q, /exact current text/);
});

test('findAmbiguity: naming the button (or quoting it) is unambiguous', () => {
  assert.equal(findAmbiguity('Change the Become a Partner button to Get Involved', files), null);
  assert.equal(findAmbiguity('change the "Start Volunteering" button text to Get Involved', files), null);
});

test('findAmbiguity: plural / all / positional / section scope → let the model handle it', () => {
  assert.equal(findAmbiguity('change both buttons to Get Involved', files), null);
  assert.equal(findAmbiguity('change all the buttons to Get Involved', files), null);
  assert.equal(findAmbiguity('change the second button to Get Involved', files), null);
  assert.equal(findAmbiguity('change the button in the volunteer section', files), null);
  assert.equal(findAmbiguity('change the hero button text', files), null);
});

test('findAmbiguity: a single candidate, no element word, or chat → null', () => {
  const one = [{ path: 'a.astro', content: '<a class="btn" href="/d">Donate</a>' }];
  assert.equal(findAmbiguity('change the button text to Give', one), null);
  assert.equal(findAmbiguity('make it shorter', files), null);
  assert.equal(findAmbiguity('what does the button say?', files), null);
  assert.equal(findAmbiguity('change the button text', []), null);
});

test('findAmbiguity: image with two candidates asks by name/filename', () => {
  const q = findAmbiguity('replace the image with the uploaded one', files);
  assert.ok(q);
  assert.match(q, /2 images on this page: “Mahdi Rahimi”, “hero.webp”/);
  assert.match(q, /click it in the preview/);
});

test('findAmbiguity: long lists are capped at 8 with a count', () => {
  const many = Array.from({ length: 11 }, (_, i) => `<a class="btn">Button ${i + 1}</a>`).join('\n');
  const q = findAmbiguity('change the button text to X', [{ path: 'p.astro', content: many }]);
  assert.ok(q);
  assert.match(q, /11 buttons/);
  assert.match(q, /“Button 8” and 3 more\./);
  assert.doesNotMatch(q, /Button 9/);
});

test('extractCandidates: utility-CSS buttons without a btn class (dad-portfolio "Hire me" / "Email me")', () => {
  const home = `
<a href="#contact"
  class="bg-brand text-brand-foreground hover:bg-brand/90 inline-flex h-10 items-center justify-center rounded-lg px-4 text-base font-medium transition-all md:px-6"
>
  Hire me
</a>
<a href="/about" class="text-sm font-semibold tracking-tight">About</a>
<a href="/work" class="group mt-12 block">See all work</a>
<a href="mailto:x@y.z"
  class="bg-primary text-primary-foreground inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-base font-medium transition-all md:px-6"
>
  Email me
  <svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" /></svg>
</a>`;
  assert.deepEqual(extractCandidates('button', home), ['Hire me', 'Email me']);
  const q = findAmbiguity('Change the button text to Get Involved', [{ path: 'src/pages/index.astro', content: home }]);
  assert.ok(q);
  assert.match(q, /2 buttons on this page: “Hire me”, “Email me”/);
});

test('findAmbiguity: naming a button that does not exist still asks (no silent nearest-match)', () => {
  const home = `<a class="btn">Hire me</a><a class="btn">Email me</a>`;
  const q = findAmbiguity('Change the Get a quote button text to Get Involved', [{ path: 'p.astro', content: home }]);
  assert.ok(q);
  assert.match(q, /“Hire me”, “Email me”/);
});
