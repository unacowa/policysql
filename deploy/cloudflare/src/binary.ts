// Private server-adapter codec. Public clients use the PolicySQL JSON contract.
// Kept in sync with policysql_core::bytes by the real-WASM conformance tests.
export const MAX_BYTES_PER_VALUE = 262_144;

export const encodeBlob = (value: Uint8Array): string => {
  if (value.byteLength > MAX_BYTES_PER_VALUE) throw new TypeError("Invalid binary value");
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const decodeBlob = (value: unknown): Uint8Array => {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_BYTES_PER_VALUE / 3) * 4 || value.length % 4 !== 0) {
    throw new TypeError("Invalid binary value");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.length / 4 * 3 - padding > MAX_BYTES_PER_VALUE) throw new TypeError("Invalid binary value");
  // atob alone accepts noncanonical padding, unused bits and whitespace.
  const binary = atob(value);
  if (btoa(binary) !== value) throw new TypeError("Invalid binary value");
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};
