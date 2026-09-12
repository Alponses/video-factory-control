import assert from 'node:assert/strict';
import test from 'node:test';
import { formatInstantInTimeZone, isValidIanaTimeZone, localDateTimeToUtc, TimeZoneError } from '../../src/scheduling/timezone.js';

function expectZoneCode(error: unknown, code: string) {
  assert.ok(error instanceof TimeZoneError);
  assert.equal(error.code, code);
  return true;
}

test('America/Mexico_City local time converts to the expected UTC instant and round-trips', () => {
  const instant = localDateTimeToUtc('2026-09-15T20:30:00', 'America/Mexico_City');
  assert.equal(instant.toISOString(), '2026-09-16T02:30:00.000Z');
  assert.equal(formatInstantInTimeZone(instant, 'America/Mexico_City'), '2026-09-15T20:30:00');
});

test('UTC local time remains the same instant', () => {
  assert.equal(localDateTimeToUtc('2026-09-15T20:30:00', 'UTC').toISOString(), '2026-09-15T20:30:00.000Z');
});

test('invalid timezone is rejected instead of falling back', () => {
  assert.equal(isValidIanaTimeZone('random-string'), false);
  assert.equal(isValidIanaTimeZone('GMT-6'), false);
  assert.throws(() => localDateTimeToUtc('2026-09-15T20:30:00', 'random-string'), (error) => expectZoneCode(error, 'INVALID_TIMEZONE'));
});

test('DST spring-forward nonexistent local time is rejected', () => {
  assert.throws(() => localDateTimeToUtc('2026-03-08T02:30:00', 'America/New_York'), (error) => expectZoneCode(error, 'NONEXISTENT_LOCAL_TIME'));
});

test('DST fall-back ambiguous local time is rejected explicitly', () => {
  assert.throws(() => localDateTimeToUtc('2026-11-01T01:30:00', 'America/New_York'), (error) => expectZoneCode(error, 'AMBIGUOUS_LOCAL_TIME'));
});

test('invalid calendar localDateTime is rejected', () => {
  assert.throws(() => localDateTimeToUtc('2026-02-31T20:30:00', 'Europe/Madrid'), (error) => expectZoneCode(error, 'INVALID_LOCAL_DATETIME'));
});
