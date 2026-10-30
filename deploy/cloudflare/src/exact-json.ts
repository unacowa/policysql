// JSON texts that keep integers beyond 2^53 - 1 exact (ADR 0024 pull request 7). The step
// machine returns its effects as JSON; an integer it emits (a bound parameter, a session
// value) must reach the database or the validator with the digits core wrote, not rounded
// through a JavaScript number (#70). Integers outside the safe range are read as BigInt and
// written back as their digits. Everything else is plain JSON.

/** `JSON.parse`, with every integer literal beyond 2^53 - 1 read as a BigInt. */
export const parseExact = (text: string): any => JSON.parse(text, (_key, value, context?: { source?: string }) =>
  typeof value === "number" && !Number.isSafeInteger(value) && /^-?\d+$/u.test(context?.source ?? "")
    ? BigInt(context.source)
    : value);

/** `JSON.stringify`, with every BigInt written as its digits. */
export const stringifyExact = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  typeof item === "bigint" ? (JSON as any).rawJSON(item.toString()) : item);
