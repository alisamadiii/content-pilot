import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeUndo, UNDO_REPLY } from './undo-guard';

test('looksLikeUndo: the EmpowerHer + dad-portfolio phrasings and common variants hit', () => {
  for (const message of [
    "revert everything back the team data to it's original data",
    "revert everything back to it's original data",
    'undo that',
    'Undo the last change please',
    'roll back the hero change',
    'rollback',
    'put the old photo back',
    'put it back how it was',
    'change it back to the previous heading',
    'go back to the original text',
    'restore the team page',
    'bring back the story you deleted',
    'make it how it was before',
    'I want the original version',
  ]) {
    assert.ok(looksLikeUndo(message), message);
  }
});

test('looksLikeUndo: ordinary edits and chat do not hit', () => {
  for (const message of [
    'Use the first image for Mahdi Rahimi.',
    'change the hero heading to Hello',
    'add a back button to the gallery',
    'put the phone number in the footer',
    'what did you change?',
    'the background should be blue',
    'thanks!',
    'add an original photo of the team',
  ]) {
    assert.ok(!looksLikeUndo(message), message);
  }
});

test('UNDO_REPLY points the owner at the header Changes dialog and manual revert', () => {
  assert.match(UNDO_REPLY, /not able to revert/);
  assert.match(UNDO_REPLY, /Changes button in the header/);
  assert.match(UNDO_REPLY, /manually/);
});

test('looksLikeUndo: bare "go back", "take it back", "I liked it before" (EmpowerHer round 3) hit', () => {
  for (const message of ['go back', 'Go back please', 'take it back', 'I liked it before', 'make it like before', 'as it was before']) {
    assert.ok(looksLikeUndo(message), message);
  }
  assert.ok(!looksLikeUndo('add a back button'));
  assert.ok(!looksLikeUndo('the back cover image'));
});

test('looksLikeUndo: a long pasted submission with an incidental undo phrase does not hit (EmpowerHer 2026-10-19)', () => {
  // The author's story said "continuing education was no longer possible like
  // before" — an incidental "like before" buried in a 4k-char content paste.
  // A submission is not an undo request; above the length ceiling it goes to
  // the AI instead of being refused by the guard.
  const submission =
    'Author\nElaha Amiri\nTitle\nThe Girl Who Kept Learning\nStory\n' +
    'A sudden event changed my educational path. Educational centers were ' +
    'closed, and continuing education was no longer possible like before. ' +
    'But I did not want to give up. '.repeat(20) +
    '\nBio\nElaha Amiri is an Afghan student passionate about learning.';
  assert.ok(submission.length > 400);
  assert.ok(!looksLikeUndo(submission));

  // A genuine short undo that happens to say "like before" still hits.
  assert.ok(looksLikeUndo('make it like before'));
});
