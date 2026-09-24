import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRemoteEvidence } from './client.ts';

test('evidence sentences are sent to the platform as objects, per its live 422 on bare strings', () => {
  assert.deepEqual(toRemoteEvidence(['a', 'b']), [{ note: 'a' }, { note: 'b' }]);
  assert.deepEqual(toRemoteEvidence([]), []);
});
