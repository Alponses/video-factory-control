export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(instant: Date | string): Clock {
  const value = instant instanceof Date ? new Date(instant.getTime()) : new Date(instant);
  if (Number.isNaN(value.getTime())) throw new Error('Fixed clock requires a valid instant');
  return { now: () => new Date(value.getTime()) };
}
