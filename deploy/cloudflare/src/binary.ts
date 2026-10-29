// Private server-adapter codec. Public clients use the PolicySQL JSON contract.
// Kept in sync with policysql_core::bytes by the real-WASM conformance tests.
export const MAX_BYTES_PER_VALUE = 262_144;

// Well-formed binary value whose decoded size exceeds the per-value limit.
// Transports map it to 413 POLICYSQL_LIMIT_EXCEEDED; malformed values stay TypeError.
export class BinaryLimitError extends RangeError {
  constructor() { super("Binary value exceeds the configured limit"); }
}

export const encodeBlob = (value: Uint8Array): string => {
  if (value.byteLength > MAX_BYTES_PER_VALUE) throw new BinaryLimitError();
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

// Validate the alphabet, padding and unused bits before classifying size. No
// decoded-payload allocation occurs until the complete encoded input is checked.
const decodedBlobLength = (value: unknown): number => {
  if (typeof value !== "string" || value.length % 4 !== 0) throw new TypeError("Invalid binary value");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47)) throw new TypeError("Invalid binary value");
  }
  if (value.length > 0) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = alphabet.indexOf(value[value.length - padding - 1]);
    if (last < 0 || (padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) {
      throw new TypeError("Invalid binary value");
    }
  }
  const length = value.length / 4 * 3 - padding;
  if (length > MAX_BYTES_PER_VALUE) throw new BinaryLimitError();
  return length;
};

export const decodeBlob = (value: unknown): Uint8Array => {
  decodedBlobLength(value);
  const binary = atob(value as string);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};
