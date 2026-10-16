/** Preserve signed zero when persisting finite numeric arguments and IR data. */
export function stringifySynthesis(value, space = 2) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Encode nonfinite synthesis values with explicit type tags.');
      if (Object.is(item, -0)) return JSON.rawJSON('-0');
    }
    return item;
  }, space);
}
