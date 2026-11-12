// The transport-independent checks on an operation's body text (ADR 0019). Every transport
// passes the body as text, and these run in the engine, once, for all of them:
//
// - well-formed Unicode: a raw lone surrogate is rejected here (it has no UTF-8 form), before
//   the text crosses the WASM boundary; an escaped lone surrogate, duplicate keys, strict JSON
//   syntax, and nesting depth are rejected by the core's strict check (ADR 0025, ADR 0027);
// - the total body limit (`maxRequestBytes`, from the runtime), in UTF-8 bytes of the text as
//   given (a byte order mark included, so it counts as the 3 bytes it was on the wire). The
//   cheap UTF-16 test rejects a body that cannot fit without encoding it; the core's strict
//   check makes the exact UTF-8 check on the stripped text (see the byte order mark below),
//   so no full encode happens here;
// - the value limit (`maxJsonValues`): JSON values plus object member names, counted by the
//   core's strict check, which stops at the first value over the limit and never builds a
//   tree (ADR 0027);
// - one leading byte order mark (U+FEFF) is removed, as HTTP has always accepted one.
//
// Decoding bytes is the transport's job. The HTTP adapter (src/http/body.ts) decodes the
// request stream with a fatal UTF-8 decoder that keeps a byte order mark (`ignoreBOM`), so
// malformed bytes never become replacement characters and the BOM rule above is the only
// one, and bounds the stream with the limit the engine hands the reader before buffering it.
import { EngineError } from "./errors.ts";

/** The request-side limit the engine reads from the runtime (`limits_json`). */
export type BodyLimits = { readonly maxRequestBytes: number };

/**
 * An operation's body: the text itself, or a reader the engine calls when the operation
 * reaches its body, with the byte limit to enforce while reading. A reader lets a transport
 * stream the body only after the session and the database have been checked; whatever it
 * throws is the operation's error.
 */
export type BodyText = string | ((maxBytes: number) => Promise<string>);

export const invalidBody = (message: string) => new EngineError("POLICYSQL_INVALID_REQUEST", message);
// `detail.limit` names the Capabilities key of the limit (#145 pull request F).
const BODY_LIMIT = Object.freeze({ limit: "maxRequestBytes" });
export const bodyTooLarge = () => new EngineError("POLICYSQL_REQUEST_TOO_LARGE", "Request body exceeds the size limit.", null, BODY_LIMIT);

// With the `u` flag a surrogate pair is one code point outside this class, so only a lone
// surrogate matches.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

const notUtf8 = () => invalidBody("Request body is not valid UTF-8.");

/**
 * Reads (if deferred) a body and applies the checks that need JavaScript's view of the text:
 * required, well-formed Unicode, the cheap size test, and one leading byte order mark. Returns
 * the text core's strict check and the operation consume. Throws the operation's error.
 */
export const readBodyText = async (bodyText: BodyText, limits: BodyLimits): Promise<string> => {
  const { maxRequestBytes } = limits;
  const given = typeof bodyText === "function" ? await bodyText(maxRequestBytes) : bodyText;
  if (typeof given !== "string") throw invalidBody("Request body is required.");
  if (LONE_SURROGATE.test(given)) throw notUtf8();
  // Every UTF-16 unit is at least one UTF-8 byte, so a longer string is over the limit
  // without encoding it. A body at or under this length is measured exactly by the core.
  if (given.length > maxRequestBytes) throw bodyTooLarge();
  const text = given.startsWith("﻿") ? given.slice(1) : given;
  // The core measures the stripped text; the removed mark is 3 bytes, so a body that fits
  // only with the mark removed must still be rejected (it was 3 bytes longer on the wire).
  if (text !== given && text.length <= maxRequestBytes
    && new TextEncoder().encode(given).byteLength > maxRequestBytes) {
    throw bodyTooLarge();
  }
  return text;
};
