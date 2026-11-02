// JSON texts that keep integers beyond 2^53 - 1 exact (ADR 0024 pull request 7). The step
// machine returns its effects as JSON; an integer it emits (a bound parameter, a session
// value) must reach the database or the validator with the digits core wrote, not rounded
// through a JavaScript number (#70). Integers outside the safe range are read as BigInt and
// written back as their digits. Everything else is plain JSON.

// An integer literal is unsafe only if it has at least 16 digits (2^53 - 1 has 16); the
// pre-scan is conservative and may run the reviver over a body without one (ADR 0027 pull
// request 7). A `\d{16}` run inside a string costs only the slower path.
const MAY_HOLD_UNSAFE_INTEGER = /\d{16}/u;

// `JSON.rawJSON` is in Node 21+ and workerd but not in every lib this file is compiled against.
type JsonWithRaw = { rawJSON(text: string): unknown };

/** `JSON.parse`, with every integer literal beyond 2^53 - 1 read as a BigInt. Most texts hold
 * no literal that could be unsafe, so they are parsed once without a reviver. */
export const parseExact = (text: string): unknown => MAY_HOLD_UNSAFE_INTEGER.test(text)
  ? JSON.parse(text, (_key, value, context?: { source?: string }) => {
    const source = context?.source;
    return typeof value === "number" && !Number.isSafeInteger(value) && source !== undefined && /^-?\d+$/u.test(source)
      ? BigInt(source)
      : value;
  })
  : JSON.parse(text);

/** `JSON.stringify`, with every BigInt written as its digits. A value without a BigInt is
 * stringified once, without a replacer; the replacer runs only when that throws (ADR 0027
 * pull request 7). */
export const stringifyExact = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? (JSON as unknown as JsonWithRaw).rawJSON(item.toString()) : item);
  }
};
