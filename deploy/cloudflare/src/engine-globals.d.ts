// What the engine may use from the host, stated explicitly (issue #59).
//
// The engine is compiled with `types: []` and `lib: ["ES2022"]` (tsconfig.engine.json), so
// nothing from the Workers or DOM type packages is visible. This file puts back exactly the
// host surface the engine legitimately reads — time, entropy, hashing, text encoding, URLs,
// and logging — and nothing else. In particular `fetch`, `Request`, `Response`, and `Headers`
// are absent on purpose: an engine module that reaches for HTTP does not compile, rather
// than depending on a lint rule to notice it (ADR 0019).
//
// Adding a name here is a decision about the engine's host surface. `test/boundary.test.mjs`
// pins the HTTP types' absence.

declare const console: {
  log(...data: unknown[]): void;
};

declare const crypto: {
  randomUUID(): string;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  subtle: {
    importKey(
      format: "raw",
      keyData: ArrayBufferView | ArrayBuffer,
      algorithm: { name: string; hash: string },
      extractable: boolean,
      keyUsages: string[],
    ): Promise<unknown>;
    sign(algorithm: "HMAC", key: unknown, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
  };
};

/** The URL object, as both a value and the type of one. */
declare class URL {
  constructor(url: string | { toString(): string }, base?: string | { toString(): string });
  readonly protocol: string;
  readonly host: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly href: string;
  toString(): string;
}

declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(timeout: unknown): void;
declare function structuredClone<T>(value: T): T;
declare function btoa(data: string): string;
declare function atob(data: string): string;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}

declare class DOMException extends Error {}
