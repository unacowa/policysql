// Bounded reading of an outbound response body (#53, ADR 0027 "Streamed enforcement").
// Web streams and TextDecoder only (ADR 0019): no platform API, so every outbound adapter
// can use it.
//
// The body is read as a byte stream with a running count of the bytes received, not the
// UTF-16 length of decoded text. The stream is cancelled at the first chunk that takes the
// count over the bound, so no more than one chunk past the bound is ever held. A declared
// `Content-Length` over the bound is rejected unread, unless the caller needs the leading
// bytes of the refused reply (then at most `PREFIX_BYTES` are read); an understated or missing
// one changes nothing. UTF-8 is decoded strictly (`fatal`): malformed bytes are an error, never
// a replacement character. A leading byte order mark is removed, as `Response.text()` does.
//
// On every failure the body is cancelled before the error is thrown. The caller classifies
// the errors; the only response content they carry is the leading bytes a caller asked for to
// recover a leading protocol field (the Hrana baton), and it is never shown to a client.

/** The body exceeded the byte bound (declared or received). */
export class BodyTooLargeError extends Error {
  /**
   * The first bytes received (at most `PREFIX_BYTES`, decoded leniently), so a caller can read a
   * leading field of a reply it refuses (the Hrana baton, #96). Never shown to a client.
   */
  readonly prefix: string;

  constructor(prefix = "") {
    super("Response body exceeds the size limit.");
    this.name = "BodyTooLargeError";
    this.prefix = prefix;
  }
}

const PREFIX_BYTES = 1_024;
/**
 * The first `PREFIX_BYTES` bytes of a body, kept raw until they are needed: a leading field can
 * span two chunks (or every byte), so slicing either chunk alone misses it (#97). At most
 * `PREFIX_BYTES` bytes are copied, whatever the body's size.
 */
class Prefix {
  readonly parts: Uint8Array[] = [];
  length = 0;

  add(chunk: Uint8Array): void {
    if (this.length >= PREFIX_BYTES) return;
    const part = chunk.slice(0, PREFIX_BYTES - this.length);
    this.parts.push(part);
    this.length += part.byteLength;
  }

  /** The prefix decoded leniently: a cut in the middle of a character is not a body failure. */
  text(): string {
    const bytes = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** The body could not be read or was not valid UTF-8. */
export class BodyReadError extends Error {
  constructor() {
    super("Response body could not be read.");
    this.name = "BodyReadError";
  }
}

/**
 * Where a caller receives the leading bytes before any failure, so it can recover a leading
 * protocol field (the Hrana baton) from a reply it refuses or could not finish reading (#96,
 * #97). Filled before every throw of `readBoundedText`; never shown to a client.
 */
export type LeadingBytes = { text: string };

// What an aborted read throws: the signal's reason when it is an error (AbortSignal.timeout
// gives a `TimeoutError` DOMException), otherwise a plain `AbortError`.
const abortError = (signal: AbortSignal): Error => signal.reason instanceof Error
  ? signal.reason
  : new DOMException("The operation was aborted.", "AbortError");

// Release a stream without waiting for it. Cancelling closes the stream at once (a pending
// read resolves as done), but the source's own cancel may never settle; awaiting it would let
// a hostile body hold the caller past its timeout. A rejection is ignored: the failure is
// already terminal.
const release = (target: { cancel(): Promise<void> } | null | undefined) => {
  try { target?.cancel().catch(() => undefined); } catch { /* the failure is already terminal */ }
};

/**
 * Reads `response`'s body as UTF-8 text of at most `maxBytes` bytes. Throws
 * BodyTooLargeError over the bound, BodyReadError for a stream failure or malformed
 * UTF-8, and the signal's abort error when `signal` aborts during the read.
 */
export const readBoundedText = async (
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  // A declared length over the bound is rejected unread, unless the caller needs the leading
  // bytes of the refused reply (`BodyTooLargeError.prefix`): then at most `PREFIX_BYTES` are read.
  prefixOfDeclared = false,
  // Filled with the leading bytes before any failure (over the bound, read error, malformed
  // UTF-8, or abort), for a caller that recovers a leading field from a reply it cannot read.
  leading?: LeadingBytes,
): Promise<string> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("maxBytes must be a non-negative safe integer");
  const body = response.body;
  const declared = Number(response.headers.get("content-length"));
  if (!body) {
    if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
    return "";
  }
  if (Number.isFinite(declared) && declared > maxBytes && !prefixOfDeclared) {
    release(body);
    throw new BodyTooLargeError();
  }
  const reader = body.getReader();
  // A pending read resolves as done when the reader is cancelled, so an abort ends the loop;
  // the abort check after each read turns that into the abort error, not a short body.
  const onAbort = () => { release(reader); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Rejected after the leading bytes, which only supply `prefix`. Reading stops at
    // `PREFIX_BYTES`; a stalled body is ended by the signal, as in the bounded loop below.
    const prefix = new Prefix();
    try {
      while (prefix.length < PREFIX_BYTES) {
        if (signal?.aborted) break;
        const next = await reader.read();
        if (signal?.aborted) break;
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) break;
        prefix.add(next.value);
      }
    } catch { /* the prefix is optional */ }
    release(reader);
    signal?.removeEventListener("abort", onAbort);
    const text = prefix.text();
    if (leading) leading.text = text;
    if (signal?.aborted) throw abortError(signal);
    throw new BodyTooLargeError(text);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const prefix = new Prefix();
  const settle = () => { if (leading) leading.text = prefix.text(); };
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) { settle(); throw abortError(signal); }
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); } catch {
        settle();
        if (signal?.aborted) throw abortError(signal);
        throw new BodyReadError();
      }
      if (signal?.aborted) { settle(); throw abortError(signal); }
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) { settle(); throw new BodyReadError(); }
      prefix.add(chunk);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        const head = prefix.text();
        if (leading) leading.text = head;
        throw new BodyTooLargeError(head);
      }
      try { text += decoder.decode(chunk, { stream: true }); } catch { settle(); throw new BodyReadError(); }
    }
    try { text += decoder.decode(); } catch { settle(); throw new BodyReadError(); }
    return text;
  } catch (error) {
    release(reader);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};
