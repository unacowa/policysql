import { EngineError, binaryLimitExceeded } from "./errors.ts";
import { BinaryLimitError, bytesLimit, decodeBlob, encodeBlob } from "./binary.ts";

const internal = () => new EngineError("POLICYSQL_INTERNAL", "The request could not be completed.");
const mismatch = () => new EngineError("POLICYSQL_SCHEMA_MISMATCH", "The database result does not match the compiled logical contract.");

// `maxBytes` is always the loaded runtime's `limits_json` `maxBytesPerValue`. The adapter holds
// no copy, so a different Rust limit cannot turn valid WASM output into a 500.

// Only LogicalValue::Bytes is emitted as an object by the private WASM ABI.
// JSON parameters have already been validated and serialized to driver TEXT.
const driverValue = (value: unknown, maxBytes: number): unknown => {
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) return value;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) throw internal();
  const tagged = value as { type?: unknown; base64?: unknown };
  if (tagged.type !== "blob" || typeof tagged.base64 !== "string" || !Object.hasOwn(tagged, "base64")) throw internal();
  try { return decodeBlob(tagged.base64, maxBytes); } catch { throw internal(); }
};

// An `execute` effect's arguments: core has already merged the client and server namespaces
// and rejected any overlap (ADR 0024 pull request 9 removed the second check here).
export const driverArgs = (args: Record<string, unknown>, maxBytes: number) => {
  bytesLimit(maxBytes);
  return Object.fromEntries(Object.entries(args).map(([name, value]) => [name, driverValue(value, maxBytes)]));
};

export const rawDriverValue = (value: unknown, maxBytes: number): unknown => {
  bytesLimit(maxBytes);
  if (typeof value === "number" && !Number.isFinite(value)) throw mismatch();
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw mismatch();
    return number;
  }
  if (value instanceof Uint8Array) {
    try { return { type: "blob", base64: encodeBlob(value, maxBytes) }; } catch (error) {
      if (error instanceof BinaryLimitError) throw binaryLimitExceeded();
      throw mismatch();
    }
  }
  // Do not permit a plain driver object to impersonate the private BLOB tag.
  if (value !== null && typeof value === "object") throw mismatch();
  if (value === undefined || !["string", "boolean", "number", "object"].includes(typeof value)) throw mismatch();
  return value;
};

export const rowValues = (columns: string[], row: unknown): unknown[] => {
  if (Array.isArray(row)) {
    if (row.length !== columns.length) throw mismatch();
    return columns.map((_column, index) => {
      if (!Object.hasOwn(row as unknown[], index)) throw mismatch();
      return (row as unknown[])[index];
    });
  }
  if (!row || typeof row !== "object") throw mismatch();
  return columns.map((column, index) => {
    if (Object.hasOwn(row, index)) return (row as Record<string, unknown>)[index];
    if (Object.hasOwn(row, column)) return (row as Record<string, unknown>)[column];
    throw mismatch();
  });
};
