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
