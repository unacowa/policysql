// The transport-independent checks on an operation's body text (ADR 0019). Every transport
// passes the body as text, and these run in the engine, once, for all of them, so parser
// differentials are handled in one place:
//
// - well-formed Unicode: a lone surrogate is rejected (it has no UTF-8 form), raw in the text
//   or escaped in a JSON string (`"\ud800"` as six ASCII characters), with the same error, so
//   the two forms of the same invalid text behave the same (ADR 0025);
// - the total body limit, counted in UTF-8 bytes of the text as given (a byte order mark
//   included, so it counts as the 3 bytes it was on the wire);
// - one leading byte order mark (U+FEFF) is removed, as HTTP has always accepted one;
// - duplicate JSON object keys, including escaped equivalents, then strict JSON.
//
// Decoding bytes is the transport's job. The HTTP adapter (src/http/body.ts) decodes the
// request stream with a fatal UTF-8 decoder that keeps a byte order mark (`ignoreBOM`), so
// malformed bytes never become replacement characters and the BOM rule above is the only
// one, and bounds the stream with the same limit before buffering it.
import { EngineError } from "./errors.ts";

export const MAX_BODY_BYTES = 1_048_576;

/**
 * An operation's body: the text itself, or a reader the engine calls when the operation
 * reaches its body. A reader lets a transport stream the body only after the session and
 * the database have been checked; whatever it throws is the operation's error.
 */
export type BodyText = string | (() => Promise<string>);

export const invalidBody = (message: string) => new EngineError("POLICYSQL_INVALID_REQUEST", message);
export const bodyTooLarge = () => new EngineError("POLICYSQL_REQUEST_TOO_LARGE", "Request body exceeds the size limit.");

// With the `u` flag a surrogate pair is one code point outside this class, so only a lone
// surrogate matches.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

const notUtf8 = () => invalidBody("Request body is not valid UTF-8.");

/** Thrown by the scan for an escaped lone surrogate; the caller answers `notUtf8`. */
class EscapedLoneSurrogate extends Error {}

const rejectDuplicateKeys = (text: string) => {
  let offset = 0;
  const whitespace = () => {
    while (/\s/.test(text[offset] ?? "")) offset += 1;
  };
  const string = () => {
    const start = offset;
    if (text[offset] !== '"') throw new Error("string expected");
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") offset += 2;
      else if (text[offset] === '"') {
        offset += 1;
        const raw = text.slice(start, offset);
        const decoded = JSON.parse(raw);
        // The text has no raw lone surrogate (checked first), so one in the decoded string
        // came from a `\u` escape. Every key and string value passes here.
        if (raw.includes("\\u") && LONE_SURROGATE.test(decoded)) throw new EscapedLoneSurrogate();
        return decoded;
      } else offset += 1;
    }
    throw new Error("unterminated string");
  };
  const value = (depth = 0) => {
    if (depth > 64) throw new Error("too deep");
    whitespace();
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set();
      if (text[offset] === "}") { offset += 1; return; }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("duplicate key");
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") throw new Error("colon expected");
        offset += 1;
        value(depth + 1);
        whitespace();
        if (text[offset] === "}") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("comma expected");
        offset += 1;
      }
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      while (true) {
        value(depth + 1);
        whitespace();
        if (text[offset] === "]") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("comma expected");
        offset += 1;
      }
    }
    if (text[offset] === '"') { string(); return; }
    const start = offset;
    while (offset < text.length && !/[\s,}\]]/.test(text[offset])) offset += 1;
    JSON.parse(text.slice(start, offset));
  };
  value();
  whitespace();
  if (offset !== text.length) throw new Error("trailing content");
};

/** Reads (if deferred) and checks a body. Returns the parsed value and the exact text. */
export const parseBodyText = async (bodyText: BodyText): Promise<{ value: any; text: string }> => {
  const given = typeof bodyText === "function" ? await bodyText() : bodyText;
  if (typeof given !== "string") throw invalidBody("Request body is required.");
  if (LONE_SURROGATE.test(given)) throw notUtf8();
  // Every UTF-16 unit is at least one UTF-8 byte, so a longer string is over the limit
  // without encoding it.
  if (given.length > MAX_BODY_BYTES || new TextEncoder().encode(given).byteLength > MAX_BODY_BYTES) {
    throw bodyTooLarge();
  }
  const text = given.startsWith("\uFEFF") ? given.slice(1) : given;
  try {
    rejectDuplicateKeys(text);
    return { value: JSON.parse(text), text };
  } catch (error) {
    if (error instanceof EscapedLoneSurrogate) throw notUtf8();
    throw invalidBody("Request body is not valid JSON.");
  }
};
