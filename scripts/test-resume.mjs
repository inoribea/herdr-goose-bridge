#!/usr/bin/env node
/**
 * Unit tests for bin/resume.js. No herdr, no goose, no network.
 *
 *   node --test scripts/test-resume.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resumeArgvFor, resumeArgvOk, pickSession, SESSION_ID } = require('../bin/resume.js');

test('builds the documented resume argv for a valid id', () => {
  assert.deepEqual(resumeArgvFor('goose', '20261124_5'), [
    'goose',
    'session',
    '-r',
    '--session-id',
    '20261124_5',
  ]);
});

test('rejects ids that are not goose session ids', () => {
  for (const bad of ['', '5', '2026_5', '20261124-5', '20261124_5; rm', "20261124_5'", undefined, null, 42]) {
    assert.equal(resumeArgvFor('goose', bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('refuses a binary given as a path (herdr needs a PATH name)', () => {
  assert.equal(resumeArgvFor('C:\\tools\\goose.exe', '20261124_5'), null);
  assert.equal(resumeArgvFor('/usr/bin/goose', '20261124_5'), null);
});

test('argv rules: apostrophe, control char, count and size limits', () => {
  assert.equal(resumeArgvOk(['goose', "it's"]), false);
  assert.equal(resumeArgvOk(['goose', 'a\nb']), false);
  assert.equal(resumeArgvOk(['goose', 'a\u0007b']), false);
  assert.equal(resumeArgvOk(['goose']), true);
  assert.equal(resumeArgvOk([]), false);
  assert.equal(resumeArgvOk(new Array(65).fill('a')), false);
  assert.equal(resumeArgvOk(new Array(64).fill('a')), true);
  assert.equal(resumeArgvOk(['goose', 'x'.repeat(8 * 1024)]), false);
  assert.equal(resumeArgvOk(['goose', 'x'.repeat(8 * 1024 - 5)]), true);
});

test('pickSession: newest session in the same directory', () => {
  const json = JSON.stringify([
    { id: '20261124_3', working_dir: 'D:\\goose', updated_at: '2026-11-24T07:10:55Z' },
    { id: '20261124_5', working_dir: 'D:\\goose', updated_at: '2026-11-24T07:25:28Z' },
    { id: '20261123_1', working_dir: 'D:\\goose', updated_at: '2026-11-23T07:00:06Z' },
  ]);
  assert.equal(pickSession(json, 'D:\\goose'), '20261124_5');
});

test('pickSession: ignores other directories and a trailing slash differs only', () => {
  const json = JSON.stringify([
    { id: '20261124_9', working_dir: 'C:\\Users\\inori', updated_at: '2026-11-24T08:00:00Z' },
    { id: '20261124_5', working_dir: 'D:\\goose\\', updated_at: '2026-11-24T07:25:28Z' },
  ]);
  assert.equal(pickSession(json, 'd:\\goose'), '20261124_5');
  assert.equal(pickSession(json, 'D:\\nowhere'), null);
});

test('pickSession: bad input never throws, returns null', () => {
  assert.equal(pickSession('not json', 'D:\\goose'), null);
  assert.equal(pickSession('{}', 'D:\\goose'), null);
  assert.equal(pickSession('[]', 'D:\\goose'), null);
  assert.equal(pickSession('[]', ''), null);
  assert.equal(pickSession(JSON.stringify([{ id: 'bad', working_dir: 'D:\\goose' }]), 'D:\\goose'), null);
});

test('SESSION_ID matches the documented format only', () => {
  assert.ok(SESSION_ID.test('20261124_5'));
  assert.ok(SESSION_ID.test('20261124_125'));
  assert.ok(!SESSION_ID.test('20261124_5\n'));
});
