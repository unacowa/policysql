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
  constructor() {
    super("Response body exceeds the size limit.");
    this.name = "BodyTooLargeError";
  }
}

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
): Promise<string> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("maxBytes must be a non-negative safe integer");
  const body = response.body;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    release(body);
    throw new BodyTooLargeError();
  }
  if (!body) return "";
  const reader = body.getReader();
  // A pending read resolves as done when the reader is cancelled, so an abort ends the loop;
  // the abort check after each read turns that into the abort error, not a short body.
  const onAbort = () => { release(reader); };
  signal?.addEventListener("abort", onAbort, { once: true });
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
      if (bytes > maxBytes) throw new BodyTooLargeError();
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
