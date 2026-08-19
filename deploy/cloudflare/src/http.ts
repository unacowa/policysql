import { HttpError } from "./errors.ts";

export const MAX_BODY_BYTES = 1_048_576;

const rejectDuplicateKeys = (text) => {
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
        return JSON.parse(text.slice(start, offset));
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

export const readJsonBody = async (request) => {
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new HttpError(415, "POLICYSQL_UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, "POLICYSQL_REQUEST_TOO_LARGE", "Request body exceeds the size limit.");
  }
  if (!request.body) throw new HttpError(400, "POLICYSQL_INVALID_REQUEST", "Request body is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "POLICYSQL_REQUEST_TOO_LARGE", "Request body exceeds the size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "POLICYSQL_INVALID_REQUEST", "Request body is not valid UTF-8.");
  }
  try {
    rejectDuplicateKeys(text);
    return { value: JSON.parse(text), text };
  } catch {
    throw new HttpError(400, "POLICYSQL_INVALID_REQUEST", "Request body is not valid JSON.");
  }
};
