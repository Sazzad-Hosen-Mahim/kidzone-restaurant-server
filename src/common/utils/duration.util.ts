const UNITS: Record<string, number> = {
  ms: 1 / 1000,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/**
 * Parses a human duration such as `15m`, `7d` or `900` into whole seconds.
 *
 * Used for the JWT lifetimes so the env value is validated and converted once,
 * in our own code, rather than handed to the signing library as an opaque
 * string whose format we cannot check at startup.
 */
export function parseDurationToSeconds(value: string): number {
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i.exec(trimmed);
  if (!match) {
    throw new Error(`"${value}" is not a valid duration. Use a number of seconds or a form like 15m, 24h, 7d.`);
  }

  const [, amount, unit] = match;
  return Math.round(Number(amount) * UNITS[unit.toLowerCase()]);
}
