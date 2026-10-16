module.exports = function score(value) {
  if (value < 12) return value * 3 + 2;
  return value / 4 - 5;
};
