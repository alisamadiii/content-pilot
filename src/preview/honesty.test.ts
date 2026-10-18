import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimsChange, HONESTY_REPAIR_PROMPT } from './honesty';

test('claimsChange: EmpowerHer #219 "re-added" and other success claims hit', () => {
  for (const reply of [
    "I've re-added the Maria Rosario Lazzati Niada Scholarship for Afghan Women back to your resources list!",
    'I have updated the hero section heading to "Hello".',
    "I've removed the Explore Programs button from the take action section.",
    'I just added the new workshop to the Mentorship page.',
    'The photo has been replaced with the one you uploaded.',
    'The media coverage section is now gone from the homepage.',
    'I set the deadline to March 1st.',
    'Done — I changed the footer phone number.',
  ]) {
    assert.ok(claimsChange(reply), reply);
  }
});

test('claimsChange: honest non-change replies do not hit', () => {
  for (const reply of [
    "I've checked and the Maria Rosario Lazzati Niada Scholarship for Afghan Women is already added to your resources list!",
    'There are 17 resources currently listed on the site!',
    'Hi there! How can I help you with your site today?',
    'Would you like to add a new resource, update an existing one, or remove something from the resources list?',
    'I could not find a "media coverage" section on the About page — which page is it on?',
    'A full page redesign is something your developer handles personally.',
    "I didn't change anything because that section does not exist on the home page.",
  ]) {
    assert.ok(!claimsChange(reply), reply);
  }
});

test('HONESTY_REPAIR_PROMPT forces a real edit or an honest answer, and allows intentional duplicates', () => {
  assert.match(HONESTY_REPAIR_PROMPT, /no file was modified/);
  assert.match(HONESTY_REPAIR_PROMPT, /make the requested change now/);
  assert.match(HONESTY_REPAIR_PROMPT, /already exists, add it anyway/);
  assert.match(HONESTY_REPAIR_PROMPT, /Never claim a change you did not make/);
});
