// HTTP request body framing (inbound adapter, ADR 0019): `Content-Type`, `Content-Length`,
// a streamed size bound, and strict UTF-8 decoding. The engine then applies the
// transport-independent checks (src/request-body.ts) to the decoded text.
import { bodyTooLarge, invalidBody } from "../request-body.ts";
import { EngineError } from "../errors.ts";

/**
 * Decodes the request body as UTF-8 text without buffering more than `maxBytes`, the body
 * limit the engine reads from the runtime. Malformed UTF-8 is an error, never a replacement
 * character.
 */
export const readBodyText = async (request: Request, maxBytes: number): Promise<string> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be a positive safe integer");
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new EngineError("POLICYSQL_UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw bodyTooLarge();
  if (!request.body) throw invalidBody("Request body is required.");
  const reader = request.body.getReader();
  // The BOM is kept so the engine applies its one BOM rule to every transport alike.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw bodyTooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw invalidBody("Request body is not valid UTF-8.");
  }
  return text;
};
