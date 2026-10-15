/** Parse a duration string or format a finite millisecond value. */
const UNIT_GROUPS = [
  { milliseconds: 1, aliases: ['millisecond', 'milliseconds', 'msec', 'msecs', 'ms'] },
  { milliseconds: 1_000, aliases: ['second', 'seconds', 'sec', 'secs', 's'] },
  { milliseconds: 60_000, aliases: ['minute', 'minutes', 'min', 'mins', 'm'] },
  { milliseconds: 3_600_000, aliases: ['hour', 'hours', 'hr', 'hrs', 'h'] },
  { milliseconds: 86_400_000, aliases: ['day', 'days', 'd'] },
  { milliseconds: 604_800_000, aliases: ['week', 'weeks', 'w'] },
  { milliseconds: 31_557_600_000, aliases: ['year', 'years', 'yr', 'yrs', 'y'] },
];

const MULTIPLIERS = new Map(
  UNIT_GROUPS.flatMap(({ milliseconds, aliases }) =>
    aliases.map((alias) => [alias, milliseconds])),
);

const FORMAT_UNITS = [
  { milliseconds: 86_400_000, short: 'd', word: 'day' },
  { milliseconds: 3_600_000, short: 'h', word: 'hour' },
  { milliseconds: 60_000, short: 'm', word: 'minute' },
  { milliseconds: 1_000, short: 's', word: 'second' },
];

// Spaces are intentionally ASCII. The numeric token excludes exponents,
// leading plus signs, and decimals without a digit after the point.
const DURATION_TOKENS = /^(-?(?:[0-9]*\.[0-9]+|[0-9]+)) *([a-z]*)$/i;

function parseDuration(text) {
  if (text.length > 100) return undefined;
  const tokens = DURATION_TOKENS.exec(text);
  if (!tokens) return undefined;

  const [, amount, alias] = tokens;
  const multiplier = alias === '' ? 1 : MULTIPLIERS.get(alias.toLowerCase());
  return multiplier === undefined ? undefined : Number(amount) * multiplier;
}

function formatDuration(milliseconds, options) {
  const magnitude = Math.abs(milliseconds);
  const useLongNames = Boolean((options || {}).long);

  for (const unit of FORMAT_UNITS) {
    if (magnitude < unit.milliseconds) continue;
    const quantity = Math.round(milliseconds / unit.milliseconds);
    if (!useLongNames) return `${quantity}${unit.short}`;
    const plural = magnitude >= unit.milliseconds * 1.5 ? 's' : '';
    return `${quantity} ${unit.word}${plural}`;
  }

  return `${milliseconds}${useLongNames ? ' ms' : 'ms'}`;
}

export function duration(value, options) {
  if (typeof value === 'string' && value.length > 0) {
    return parseDuration(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatDuration(value, options);
  }

  throw new Error(
    'val is not a non-empty string or a valid number. val=' + JSON.stringify(value),
  );
}

export default duration;
