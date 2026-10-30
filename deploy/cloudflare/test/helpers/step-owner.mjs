// The step machine's owner with the machine's own atomic owner path (ADR 0024 pull request 6),
// for the atomic differential harness (test/step-atomic-differential.test.mjs) until pull
// request 8 switches atomic execution in production.
//
// Since pull request 7 the executor is production code: `StepTransactionOwner` in
// src/transaction-owner.ts, which `TransactionOwnerCore` extends for interactive transactions.
// This helper only adds the owner name and the input shapes the harnesses use (`bodyText`
// for a command's or callback's verified text) and records transcripts.
import { StepTransactionOwner } from "../../src/transaction-owner.ts";

export { failureClass } from "../../src/step-effects.ts";

export class StepOwnerCore extends StepTransactionOwner {
  /** `name` is the owner name the adapter routes to; `dependencies` as for `TransactionOwnerCore`. */
  constructor(facilities, dependencies, name) {
    super({ ...facilities, name }, dependencies);
    /** Every step: the four inputs and the output text (a transcript, ADR 0024). */
    this.transcript = [];
  }

  begin(input, requestId) {
    const { authFingerprint: _computedByCore, ...fields } = input;
    return super.begin(fields, requestId);
  }

  /** `input` is the owner command plus the session (`auth`) and verified text (`bodyText`). */
  command(kind, input, requestId) {
    return super.command(kind, {
      transactionId: input.transactionId, auth: input.auth, command: input.bodyText ?? input.command,
      databaseBinding: input.databaseBinding, snapshot: input.snapshot,
    }, requestId);
  }

  /** `input` is `{ validationId, capability, bodyText }`: the verified callback text (#70). */
  callbackQuery(input, requestId) {
    return super.callbackQuery({
      validationId: input.validationId, capability: input.capability, command: input.bodyText ?? input.command,
    }, requestId);
  }
}
