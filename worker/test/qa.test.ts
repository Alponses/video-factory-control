import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateProbe } from '../src/qa.js';

function probe(duration: number, width = 1080, height = 1920, audio = true) {
  return { format: { duration }, streams: [{ codec_type: 'video', width, height }, ...(audio ? [{ codec_type: 'audio' }] : [])] };
}

for (const [duration, expected] of [[60.9, false], [61.0, true], [75, true]] as const) {
  test(`duration ${duration} boundary`, () => assert.equal(evaluateProbe(probe(duration)).durationPassed, expected));
}

test('1079x1920 fails resolution', () => assert.equal(evaluateProbe(probe(61, 1079, 1920)).resolutionPassed, false));
test('1080x1919 fails resolution', () => assert.equal(evaluateProbe(probe(61, 1080, 1919)).resolutionPassed, false));
test('1080x1920 passes resolution', () => assert.equal(evaluateProbe(probe(61, 1080, 1920)).resolutionPassed, true));
test('no audio fails', () => assert.equal(evaluateProbe(probe(61, 1080, 1920, false)).audioPassed, false));
test('audio passes', () => assert.equal(evaluateProbe(probe(61, 1080, 1920, true)).audioPassed, true));
test('captions remain unknown when not reliably verifiable', () => assert.equal(evaluateProbe(probe(61)).captionsPassed, null));
