import assert from 'node:assert/strict';
import test from 'node:test';
import { deepMerge } from '../../src/legacy/deep-merge.js';

test('deepMerge matches V4.2 precedence and array replacement semantics', () => {
  const base = {
    publishing: {
      tiktok: {
        caption: 'base',
        hashtags: ['#base'],
        preserved: 'yes',
      },
    },
    scenes: [{ text: 'base scene' }],
  };
  const v3 = { publishing: { tiktok: { caption: 'v3' } } };
  const v4 = { publishing: { tiktok: { hashtags: ['#v4'] } }, scenes: [{ text: 'v4 scene' }] };
  const dashboard = { publishing: { tiktok: { caption: 'dashboard' } } };

  assert.deepEqual(deepMerge(base, v3, v4, dashboard), {
    publishing: {
      tiktok: {
        caption: 'dashboard',
        hashtags: ['#v4'],
        preserved: 'yes',
      },
    },
    scenes: [{ text: 'v4 scene' }],
  });
});

test('deepMerge replaces an object member with null exactly like V4.2', () => {
  assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: null }), { a: null });
});
