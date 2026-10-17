import { Kysely, CamelCasePlugin, type InsertResult, type UpdateResult, type DeleteResult } from 'kysely'
import { PolicySqlClient, PolicySqlError, PolicySqlOutcomeUnknownError, type PolicySqlClientOptions, type PolicyExecuteResult } from '@unacowa/policysql/client'
import { PolicySqlDialect, policyOptions } from '@unacowa/policysql/kysely'
import { createHttpTransport, type TokenProvider } from '@unacowa/policysql/transport/http'
import { createAuthAgentTransport, serveAuthAgentTransport } from '@unacowa/policysql/transport/auth-agent'
import type { PolicySqlTransport, TransportReply } from '@unacowa/policysql/transport'

const transport: PolicySqlTransport = createHttpTransport({ endpoint: 'https://gateway.test', token: 'token' })
const minimal: PolicySqlClientOptions = { transport }
new PolicySqlClient(minimal)
new PolicySqlClient({ ...minimal, role: 'author' })
new PolicySqlClient({ ...minimal, schemaVersion: 's1', policyVersion: 'p1' })
// @ts-expect-error versions must be supplied together
new PolicySqlClient({ ...minimal, schemaVersion: 's1' })
// @ts-expect-error versions must be supplied together
new PolicySqlClient({ ...minimal, policyVersion: 'p1' })
// @ts-expect-error null is not omission
new PolicySqlClient({ ...minimal, role: null })
// @ts-expect-error transport is required
new PolicySqlClient({ token: 'token' })
// @ts-expect-error legacy HTTP client options are not supported
new PolicySqlClient({ endpoint: 'https://gateway.test' })
// @ts-expect-error credentials do not belong to the client
new PolicySqlClient({ transport, token: 'token' })
// @ts-expect-error credential source is required
createHttpTransport({ endpoint: 'https://gateway.test' })
declare const provider: TokenProvider
createHttpTransport({ endpoint: 'https://gateway.test', tokenProvider: provider })
// @ts-expect-error credential sources are mutually exclusive
createHttpTransport({ endpoint: 'https://gateway.test', token: 'token', tokenProvider: provider })
declare const port: MessagePort
const remote: Promise<PolicySqlTransport> = createAuthAgentTransport(port)
serveAuthAgentTransport(port, transport)
const reply: TransportReply = { type: 'failure', code: 'POLICYSQL_REQUEST_CANCELLED', delivery: 'not-sent' }
void [remote, reply]

interface Database { posts: { id: string; title: string; status: 'draft' | 'published' } }
const client = new PolicySqlClient(minimal)
const db = new Kysely<Database>({ dialect: new PolicySqlDialect({ client }), plugins: [new CamelCasePlugin()] })

async function queries() {
  const rows: { id: string; title: string }[] = await db.selectFrom('posts').select(['id', 'title']).execute()
  const insert: InsertResult = await db.insertInto('posts').values({ id: 'id', title: 'Title', status: 'draft' }).executeTakeFirstOrThrow()
  const update: UpdateResult = await db.updateTable('posts').set({ title: 'Updated' }).executeTakeFirstOrThrow()
  const remove: DeleteResult = await db.deleteFrom('posts').executeTakeFirstOrThrow()
  const count: bigint = update.numUpdatedRows
  const row: { id: string } = await db.updateTable('posts').set({ title: 'Updated' }).returning('id')
    .withPlugin(policyOptions({ idempotencyKey: 'explicit-operation-key', expect: { affectedRows: 1 }, onResponse(response) {
      const raw: PolicyExecuteResult = response
      void raw
    } })).executeTakeFirstOrThrow()
  const value: string = await db.transaction().execute(async trx => {
    await trx.updateTable('posts').set({ status: 'published' }).execute()
    return 'done'
  })
  const trx = await db.startTransaction().setAccessMode('read only').execute()
  await trx.selectFrom('posts').select('id').execute()
  await trx.commit().execute()
  // @ts-expect-error no independent PolicySQL execute arguments
  await db.updateTable('posts').set({ title: 'x' }).execute({ idempotencyKey: 'operation-key' })
  // @ts-expect-error no server expectations in standard execute arguments
  await db.updateTable('posts').set({ title: 'x' }).execute({ expect: { affectedRows: 1 } })
  // @ts-expect-error no transaction start keys
  await db.startTransaction().execute({ idempotencyKey: 'start-key' })
  // @ts-expect-error no extra argument to callback transaction
  await db.transaction().execute(async () => {}, { idempotencyKey: 'start-key' })
  // @ts-expect-error low-level starts also have no key argument
  await client.beginTransaction({ idempotencyKey: 'start-key' })
  // @ts-expect-error unsupported constructor flag
  new PolicySqlDialect({ client, autoIdempotencyKey: 'true' })
  void [rows, insert, remove, count, row, value]
  await db.destroy()
}
void queries

new PolicySqlError('Failed', 'POLICYSQL_REQUEST_FAILED', 409)
new PolicySqlOutcomeUnknownError({ phase: 'commit', transactionId: 'tx_123', sequence: 1 })
// @ts-expect-error error codes are required strings
new PolicySqlError('Failed', { cause: new Error() })
// @ts-expect-error phase must be a protocol operation
new PolicySqlOutcomeUnknownError({ phase: 'other' })
