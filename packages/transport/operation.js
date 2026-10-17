import { failure, validReply } from './index.js';
import { limitDeadline } from './internal.js';

// One automatic attempt series owns one deadline. Explicit recovery creates a new
// operation for the same immutable command; the client retains its outcome history.
export function createOperation(command, options, { timeoutMs, attempt, onDispose = () => {}, deadline, acceptNotSentConfirmation = false }) {
  let expires = deadline;
  let disposed = false;
  let stopped = false;
  let everSent = options.purpose === 'confirm-terminal';
  let active;
  const serverDeadline = options.serverExpiresAt === undefined ? Infinity : Date.parse(options.serverExpiresAt);
  const mustRespectServerDeadline = () => command.target.kind === 'statement' || !everSent;
  return Object.freeze({
    [limitDeadline](value) {
      if (!Number.isFinite(value)) throw new TypeError('invalid operation deadline');
      expires = Math.min(expires ?? Infinity, value);
    },
    async send({ signal } = {}) {
      if (active) return failure('POLICYSQL_TRANSPORT_PROTOCOL_ERROR');
      if (disposed || stopped) return failure('POLICYSQL_TRANSPORT_CLOSED');
      if (signal?.aborted) return failure('POLICYSQL_REQUEST_CANCELLED');
      expires ??= Date.now() + timeoutMs;
      const remaining = () => Math.max(0, Math.min(expires, mustRespectServerDeadline() ? serverDeadline : Infinity) - Date.now());
      if (remaining() <= 0) return failure('POLICYSQL_TRANSPORT_TIMEOUT');
      const controller = new AbortController();
      let sent = false;
      let timer;
      let interrupted = false;
      let finish;
      const interruption = new Promise(resolve => { finish = resolve; });
      const stop = code => {
        if (interrupted) return;
        interrupted = true;
        controller.abort();
        finish(failure(code, sent ? 'possibly-sent' : 'not-sent'));
      };
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stop('POLICYSQL_TRANSPORT_TIMEOUT'), remaining());
      };
      const onAbort = () => stop('POLICYSQL_REQUEST_CANCELLED');
      active = { stop };
      try {
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        schedule();
        const result = await Promise.race([
          interruption,
          Promise.resolve().then(async () => {
            if (interrupted) return interruption;
            const reply = await attempt({
              command, options, signal: controller.signal,
              remainingMs: () => Math.max(0, expires - Date.now()),
              deadline: expires,
              markSent() {
                if (interrupted || disposed || stopped || remaining() <= 0) return false;
                sent = true;
                everSent = true;
                schedule();
                return true;
              },
            });
            if (!validReply(reply)) return failure('POLICYSQL_TRANSPORT_PROTOCOL_ERROR', sent ? 'possibly-sent' : 'not-sent');
            if (reply.type === 'failure' && sent && !acceptNotSentConfirmation) return { ...reply, delivery: 'possibly-sent' };
            return reply;
          }).catch(() => failure('POLICYSQL_TRANSPORT_ERROR', sent ? 'possibly-sent' : 'not-sent')),
        ]);
        return result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        active = undefined;
      }
    },
    stopUnsent() {
      if (everSent) return;
      stopped = true;
      active?.stop('POLICYSQL_TRANSPORT_CLOSED');
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      active?.stop('POLICYSQL_TRANSPORT_CLOSED');
      onDispose();
    },
  });
}
