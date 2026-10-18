import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refersToPrevious, withPreviousRequest } from './same-as-before';

test('refersToPrevious: EmpowerHer #170 and common back-references hit', () => {
  for (const message of [
    'do the same for the resources page',
    'Do the same thing on the about page',
    'same for the footer',
    'apply the same change to the contact page',
    'and this one too',
    'also do it on the mentorship page',
    'again for the hero',
    'likewise on the team page',
  ]) {
    assert.ok(refersToPrevious(message), message);
  }
});

test('refersToPrevious: self-contained requests and long messages do not hit', () => {
  for (const message of [
    'change the heading to Welcome',
    'use the same font as the heading for the subtitle',
    'Rename the program from Mentorship to Mentoring everywhere.',
    'thanks',
    'do the same for the resources page ' + 'x'.repeat(200),
  ]) {
    assert.ok(!refersToPrevious(message), message);
  }
});

test('withPreviousRequest: restates the prior request, whitespace collapsed and capped', () => {
  const out = withPreviousRequest('do the same for the resources page', 'Rename the program\n\nfrom Mentorship to Mentoring everywhere.');
  assert.match(out, /^do the same for the resources page\n\n\(By "the same"/);
  assert.match(out, /"Rename the program from Mentorship to Mentoring everywhere\."/);
  assert.match(out, /nothing else\.\)$/);
  const long = withPreviousRequest('same here', 'a'.repeat(1000));
  assert.ok(long.length < 460, String(long.length));
});

test('refersToEarlierItem + withRecentRequests: "the resource I added earlier" carries the recent requests (round 3 #25)', async () => {
  const { refersToEarlierItem, withRecentRequests } = await import('./same-as-before');
  assert.ok(refersToEarlierItem('update the resource I added earlier with a new deadline of March 1, 2026'));
  assert.ok(refersToEarlierItem('remove the story we created'));
  assert.ok(refersToEarlierItem('change the one I added to say Online'));
  assert.ok(!refersToEarlierItem('add a new resource called Test Grant'));
  const out = withRecentRequests('update the resource I added earlier', [
    '/manage-resources add resource. name: Test Grant. location: Online.',
    'Change the About hero heading to Our Story',
  ]);
  assert.match(out, /most recent requests, newest first:\n1\. "\/manage-resources add resource\. name: Test Grant/);
  assert.match(out, /2\. "Change the About hero heading/);
  assert.match(out, /ask which item instead of guessing/);
  assert.equal(withRecentRequests('x', []), 'x');
});
