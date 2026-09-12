export type TimeZoneErrorCode = 'INVALID_LOCAL_DATETIME' | 'INVALID_TIMEZONE' | 'NONEXISTENT_LOCAL_TIME' | 'AMBIGUOUS_LOCAL_TIME';

export class TimeZoneError extends Error {
  constructor(public readonly code: TimeZoneErrorCode, message: string) {
    super(message);
  }
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const UTC_ZONE = 'UTC';
const SUPPORTED_IANA_TIME_ZONES = new Set<string>(Intl.supportedValuesOf('timeZone'));

function parseLocal(value: string): LocalParts {
  const match = LOCAL_PATTERN.exec(value);
  if (!match) throw new TimeZoneError('INVALID_LOCAL_DATETIME', 'localDateTime must use YYYY-MM-DDTHH:mm[:ss] without an offset');
  const parts: LocalParts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? '0'),
  };
  const naive = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  const same = naive.getUTCFullYear() === parts.year && naive.getUTCMonth() + 1 === parts.month && naive.getUTCDate() === parts.day
    && naive.getUTCHours() === parts.hour && naive.getUTCMinutes() === parts.minute && naive.getUTCSeconds() === parts.second;
  if (!same) throw new TimeZoneError('INVALID_LOCAL_DATETIME', 'localDateTime is not a valid calendar date/time');
  return parts;
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  if (timeZone === UTC_ZONE) return true;
  return SUPPORTED_IANA_TIME_ZONES.has(timeZone);
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

function localPartsAt(instant: Date, timeZone: string): LocalParts {
  const entries = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    year: Number(entries.year), month: Number(entries.month), day: Number(entries.day),
    hour: Number(entries.hour), minute: Number(entries.minute), second: Number(entries.second),
  };
}

function sameParts(a: LocalParts, b: LocalParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const value = parts.find((part) => part.type === 'timeZoneName')?.value;
  if (!value || value === 'GMT' || value === 'UTC') return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new TimeZoneError('INVALID_TIMEZONE', `Unable to resolve UTC offset for ${timeZone}`);
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export function localDateTimeToUtc(localDateTime: string, timeZone: string): Date {
  if (!isValidIanaTimeZone(timeZone)) throw new TimeZoneError('INVALID_TIMEZONE', 'timezone must be a supported IANA time zone or UTC');
  const local = parseLocal(localDateTime);
  const naiveMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);

  // ECMA-402/ICU supplies the actual IANA offsets. Probe both sides of a nearby
  // transition, then round-trip candidate instants. This rejects DST gaps and
  // overlaps instead of guessing an offset or silently choosing one occurrence.
  const offsets = new Set<number>();
  for (const hours of [-48, -36, -24, -12, 0, 12, 24, 36, 48]) {
    offsets.add(offsetMinutesAt(new Date(naiveMs + hours * 3_600_000), timeZone));
  }
  const matches: Date[] = [];
  for (const offsetMinutes of offsets) {
    const candidate = new Date(naiveMs - offsetMinutes * 60_000);
    if (sameParts(localPartsAt(candidate, timeZone), local)) matches.push(candidate);
  }
  const unique = [...new Map(matches.map((value) => [value.getTime(), value])).values()].sort((a, b) => a.getTime() - b.getTime());
  if (unique.length === 0) throw new TimeZoneError('NONEXISTENT_LOCAL_TIME', 'The requested local time does not exist in this time zone because of a clock transition');
  if (unique.length > 1) throw new TimeZoneError('AMBIGUOUS_LOCAL_TIME', 'The requested local time occurs more than once in this time zone; choose a different local time');
  return unique[0]!;
}

export function formatInstantInTimeZone(instant: Date, timeZone: string): string {
  if (!isValidIanaTimeZone(timeZone)) throw new TimeZoneError('INVALID_TIMEZONE', 'timezone must be a supported IANA time zone or UTC');
  const parts = localPartsAt(instant, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}
