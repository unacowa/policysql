// Bounded reading of an outbound response body (#53, ADR 0027 "Streamed enforcement").
// Web streams and TextDecoder only (ADR 0019): no platform API, so every outbound adapter
// can use it.
//
// The body is read as a byte stream with a running count of the bytes received, not the
// UTF-16 length of decoded text. The stream is cancelled at the first chunk that takes the
// count over the bound, so no more than one chunk past the bound is ever held. A declared
// `Content-Length` over the bound is rejected unread; an understated or missing one changes
// nothing. UTF-8 is decoded strictly (`fatal`): malformed bytes are an error, never a
// replacement character. A leading byte order mark is removed, as `Response.text()` does.
//
// On every failure the body is cancelled before the error is thrown. The caller classifies
// the errors; none carries response content.

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
const prefixOf = (chunk: Uint8Array | undefined) =>
  (chunk ? new TextDecoder("utf-8").decode(chunk.subarray(0, PREFIX_BYTES)) : "");

/** The body could not be read or was not valid UTF-8. */
export class BodyReadError extends Error {
  constructor() {
    super("Response body could not be read.");
    this.name = "BodyReadError";
  }
}

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
  // bytes of the refused reply (`BodyTooLargeError.prefix`): then the first chunk is read.
  prefixOfDeclared = false,
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
    // Rejected unread, except for the first chunk, which only supplies `prefix`.
    let first: Uint8Array | undefined;
    try {
      const next = await reader.read();
      if (!next.done && next.value instanceof Uint8Array) first = next.value;
    } catch { /* the prefix is optional */ }
    release(reader);
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) throw abortError(signal);
    throw new BodyTooLargeError(prefixOf(first));
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); } catch {
        if (signal?.aborted) throw abortError(signal);
        throw new BodyReadError();
      }
      if (signal?.aborted) throw abortError(signal);
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new BodyReadError();
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new BodyTooLargeError(text.length === 0 ? prefixOf(chunk) : text.slice(0, PREFIX_BYTES));
      try { text += decoder.decode(chunk, { stream: true }); } catch { throw new BodyReadError(); }
    }
    try { text += decoder.decode(); } catch { throw new BodyReadError(); }
    return text;
  } catch (error) {
    release(reader);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};
