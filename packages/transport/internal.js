// In-process hooks used by the bundled bridge. Never serialized onto the wire.
export const contextKey = Symbol('transport context');
export const timeout = Symbol('transport timeout');
export const limitDeadline = Symbol('operation deadline');
