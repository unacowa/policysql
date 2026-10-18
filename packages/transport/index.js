export const failureCodes = Object.freeze([
  'POLICYSQL_AUTH_REQUIRED', 'POLICYSQL_AUTH_PREPARATION_FAILED',
  'POLICYSQL_TRANSPORT_TIMEOUT', 'POLICYSQL_REQUEST_CANCELLED', 'POLICYSQL_TRANSPORT_DISCONNECTED',
  'POLICYSQL_TRANSPORT_CLOSED', 'POLICYSQL_TRANSPORT_PROTOCOL_ERROR', 'POLICYSQL_TRANSPORT_ERROR',
]);
export const failure = (code, delivery = 'not-sent') => ({ type: 'failure', code, delivery });

export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
export const validateRole = role => {
  if (role !== undefined && (typeof role !== 'string' || !/^[a-z][a-z0-9_]*$/.test(role))) throw new TypeError('invalid role');
  return role;
};
export const onlyKeys = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
export const positiveDuration = (value, name) => {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new TypeError(`invalid ${name}`);
  return value;
};

export const copyCommand = command => {
  if (!onlyKeys(command, ['commandId', 'target', 'body', 'idempotencyKey']) || !identifier(command.commandId) ||
    !onlyKeys(command.target, ['kind', 'transactionId'])) throw new TypeError('invalid transport command');
  const { kind, transactionId } = command.target;
  const interactive = ['statement', 'commit', 'rollback'].includes(kind);
  if (!interactive && !['execute', 'begin', 'explain', 'catalog', 'capabilities'].includes(kind)) throw new TypeError('invalid command kind');
  if (interactive ? !/^tx_[a-f0-9]{32}$/.test(transactionId) : transactionId !== undefined) throw new TypeError('invalid transaction ID');
  const discovery = kind === 'catalog' || kind === 'capabilities';
  if (discovery ? command.body !== undefined : typeof command.body !== 'string') throw new TypeError('invalid command body');
  if (command.body !== undefined) {
    if (command.body.length > 1_048_576 || new TextEncoder().encode(command.body).byteLength > 1_048_576) throw new TypeError('command body is too large');
    let body;
    try { body = JSON.parse(command.body); } catch { throw new TypeError('invalid command JSON'); }
    if (!record(body)) throw new TypeError('invalid command body');
  }
  if (command.idempotencyKey !== undefined && (kind !== 'execute' || typeof command.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{16,128}$/.test(command.idempotencyKey))) throw new TypeError('invalid idempotency key');
  return Object.freeze({
    commandId: command.commandId,
    target: Object.freeze({ kind, ...(interactive ? { transactionId } : {}) }),
    ...(command.body === undefined ? {} : { body: command.body }),
    ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
  });
};

export const copyOperationOptions = (command, options) => {
  if (!onlyKeys(options, ['serverExpiresAt', 'purpose']) ||
    !['execute', 'confirm-terminal', 'cleanup-rollback'].includes(options.purpose)) throw new TypeError('invalid operation options');
  if (options.serverExpiresAt !== undefined && (typeof options.serverExpiresAt !== 'string' ||
    !Number.isFinite(Date.parse(options.serverExpiresAt)))) throw new TypeError('invalid server deadline');
  if ((options.purpose === 'confirm-terminal' && !['commit', 'rollback'].includes(command.target.kind)) ||
    (options.purpose === 'cleanup-rollback' && command.target.kind !== 'rollback')) throw new TypeError('invalid operation purpose');
  return Object.freeze({ ...options });
};

// Both HTTP and message transports return plain values. Never trust remote Error objects.
export const validReply = reply => record(reply) && (
  reply.type === 'response'
    ? onlyKeys(reply, ['type', 'status', 'body']) && Number.isInteger(reply.status) && reply.status >= 200 && reply.status <= 599 && Object.hasOwn(reply, 'body')
    : reply.type === 'failure' && onlyKeys(reply, ['type', 'code', 'delivery']) && failureCodes.includes(reply.code) && ['not-sent', 'possibly-sent'].includes(reply.delivery)
);

// Error diagnostics are the only server error fields allowed across the worker wire.
export const safeErrorDetails = value => {
  const code = typeof value?.code === 'string' && value.code.length <= 128 && /^POLICYSQL_[A-Z0-9_]+$/.test(value.code)
    ? value.code : 'POLICYSQL_REQUEST_FAILED';
  const safe = { code };
  if (typeof value?.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)) safe.requestId = value.requestId;
  if (value?.path === null) safe.path = null;
  else if (typeof value?.path === 'string' && value.path.length <= 256 && /^[A-Za-z0-9_.$\[\] /:-]+$/.test(value.path)) safe.path = value.path;
  return safe;
};
export const sanitizeReply = reply => {
  if (!validReply(reply)) return failure('POLICYSQL_TRANSPORT_PROTOCOL_ERROR', 'possibly-sent');
  if (reply.type === 'response' && (reply.status >= 300 || record(reply.body?.error))) {
    return { type: 'response', status: reply.status, body: { error: safeErrorDetails(reply.body?.error) } };
  }
  return reply;
};
