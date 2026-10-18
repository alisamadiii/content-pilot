import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVagueStylingRequest, VAGUE_REPLY } from './vague-guard';

test('isVagueStylingRequest: EmpowerHer #21a and similar wishes are vague', () => {
  for (const message of [
    'Make the mentorship page pop.',
    'make it better',
    'can you make the homepage look more modern',
    'improve this page',
    'make the about page stand out',
  ]) {
    assert.ok(isVagueStylingRequest(message), message);
  }
});

test('isVagueStylingRequest: a target, a quote, a direction, or a long brief is not vague', () => {
  for (const message of [
    'make the heading pop',
    'make the hero background darker',
    'use a bigger font for the title',
    'improve the text to say "Welcome to EmpowerHer"',
    'make the buttons blue',
    'fix mobile',
    'change the third team member title to Program Lead',
    'make it better: ' + 'add more spacing between the cards and align the images to the left, '.repeat(2),
  ]) {
    assert.ok(!isVagueStylingRequest(message), message);
  }
});

test('VAGUE_REPLY asks for specifics and points at the preview', () => {
  assert.match(VAGUE_REPLY, /Tell me what you would like changed/);
  assert.match(VAGUE_REPLY, /click the part of the page/);
});
