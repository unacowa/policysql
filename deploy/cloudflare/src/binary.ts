// Private server-adapter codec. Public clients use the PolicySQL JSON contract.
// The adapter owns no copy of the per-value limit: every caller injects the value
// advertised by the loaded runtime (policysql_core::bytes::MAX_BYTES_PER_VALUE).

// Well-formed binary value whose decoded size exceeds the per-value limit.
// Transports map it to 413 POLICYSQL_LIMIT_EXCEEDED; malformed values stay TypeError.
export class BinaryLimitError extends RangeError {
  constructor() { super("Binary value exceeds the configured limit"); }
}

// A concrete per-value limit: a positive safe integer from the runtime. An absent,
// infinite or malformed limit is an adapter wiring defect, so every codec and
// driver-value path fails closed; no caller can opt out of the bound.
export const bytesLimit = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError("PolicySQL runtime advertises an invalid per-value binary limit");
  }
  return value as number;
};

// Runtime metadata is validated like any other host input. Package construction
// calls this once, so a malformed runtime is rejected before it serves requests.
export const runtimeBytesLimit = (runtime: { max_bytes_per_value?: unknown } | null | undefined): number =>
  bytesLimit(runtime?.max_bytes_per_value);

export const encodeBlob = (value: Uint8Array, maxBytes: number): string => {
  if (value.byteLength > bytesLimit(maxBytes)) throw new BinaryLimitError();
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

// Validate the alphabet, padding and unused bits before classifying size. No
// decoded-payload allocation occurs until the complete encoded input is checked.
const decodedBlobLength = (value: unknown, maxBytes: number): number => {
  bytesLimit(maxBytes);
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
  if (length > maxBytes) throw new BinaryLimitError();
  return length;
};

export const decodeBlob = (value: unknown, maxBytes: number): Uint8Array => {
  decodedBlobLength(value, maxBytes);
  const binary = atob(value as string);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};
