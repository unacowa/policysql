import { HttpError, binaryLimitExceeded } from "./errors.ts";
import { BinaryLimitError, checkedLimit, decodeBlob, encodeBlob } from "./binary.ts";

const internal = () => new HttpError(500, "POLICYSQL_INTERNAL", "The request could not be completed.");
const mismatch = () => new HttpError(422, "POLICYSQL_SCHEMA_MISMATCH", "The database result does not match the compiled logical contract.");

// `maxBytes` is always the loaded runtime's `max_bytes_per_value`. The adapter holds
// no copy, so a different Rust limit cannot turn valid WASM output into a 500.

// Only LogicalValue::Bytes is emitted as an object by the private WASM ABI.
// JSON parameters have already been validated and serialized to driver TEXT.
const driverValue = (value, maxBytes: number) => {
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) return value;
  if (!value || Array.isArray(value) || Object.keys(value).length !== 2 ||
      value.type !== "blob" || !Object.hasOwn(value, "base64")) throw internal();
  try { return decodeBlob(value.base64, maxBytes); } catch { throw internal(); }
};

export const driverArgs = (statement, maxBytes: number) => {
  checkedLimit(maxBytes);
  if (Object.keys(statement.clientParameters).some(name => Object.hasOwn(statement.serverParameters, name))) throw internal();
  return Object.fromEntries(Object.entries({ ...statement.clientParameters, ...statement.serverParameters })
    .map(([name, value]) => [name, driverValue(value, maxBytes)]));
};

export const rawDriverValue = (value, maxBytes: number) => {
  checkedLimit(maxBytes);
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

export const rowValues = (columns, row) => {
  if (Array.isArray(row)) {
    if (row.length !== columns.length) throw mismatch();
    return columns.map((_column, index) => {
      if (!Object.hasOwn(row, index)) throw mismatch();
      return row[index];
    });
  }
  if (!row || typeof row !== "object") throw mismatch();
  return columns.map((column, index) => {
    if (Object.hasOwn(row, index)) return row[index];
    if (Object.hasOwn(row, column)) return row[column];
    throw mismatch();
  });
};
