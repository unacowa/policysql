// In-memory TransactionOwner adapter (ADR 0022). TEST ONLY, NOT FOR PRODUCTION.
//
// It keeps one owner per name in one JavaScript process. That is exactly the port's
// guarantee within a single process, and exactly what it cannot give on a platform that runs
// several isolates or servers: each would hold its own map, and two owners could serve one
// transaction id. It is therefore not shipped with the library.
//
// Faithful to the port contract:
// - inputs and replies cross a JSON boundary, as they do between a Worker and a Durable
//   Object, so the owner never shares an object with its caller;
// - `lose(name)` replaces the live owner with a successor that sees the same store and
//   timer but none of the lost owner's memory; the lost owner's facilities are revoked;
// - `fireTimer(name)` delivers the owner's single pending timer, as an alarm would.
import { TransactionOwnerCore } from "../../src/transaction-owner.ts";
import { OWNER_NAME } from "../../src/transaction-owner-port.ts";

const wire = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export class OwnerLostError extends Error {}

/**
 * `dependencies(name)` returns the ports for a new owner of `name` (the same shape
 * `TransactionOwnerCore` takes). `background` receives every task an owner defers.
 */
export const createMemoryTransactionOwners = (dependencies, { background = { run() {} } } = {}) => {
  const slots = new Map();

  const incarnate = (name, slot) => {
    const life = { live: true };
    const alive = () => { if (!life.live) throw new OwnerLostError("owner lost"); };
    const facilities = {
      store: {
        async get(key) { alive(); return structuredClone(slot.data.get(key)); },
        async put(key, value) { alive(); slot.data.set(key, structuredClone(value)); },
      },
      timer: { async schedule(atMs) { alive(); slot.timerAt = atMs; } },
      background: { run(task) { background.run(task); } },
    };
    return { life, core: new TransactionOwnerCore(facilities, dependencies(name)) };
  };

  // The live owner for `name`, created on its first command.
  const live = (name) => {
    let slot = slots.get(name);
    if (!slot) {
      slot = { data: new Map(), timerAt: null, owner: null };
      slots.set(name, slot);
      slot.owner = incarnate(name, slot);
    }
    return slot.owner.core;
  };

  const port = {
    route(name) {
      if (typeof name !== "string" || !OWNER_NAME.test(name)) throw new TypeError("owner name");
      return {
        begin: async (input, requestId) => wire(await live(name).begin(wire(input), requestId)),
        atomic: async (input, requestId) => wire(await live(name).atomic(wire(input), requestId)),
        command: async (kind, input, requestId) => wire(await live(name).command(kind, wire(input), requestId)),
        callbackQuery: async (input, requestId) => wire(await live(name).callbackQuery(wire(input), requestId)),
      };
    },
  };

  return {
    port,
    names: () => [...slots.keys()],
    record: async (name) => structuredClone(slots.get(name)?.data.get("transaction")),
    core: (name) => slots.get(name)?.owner.core,
    timerAt: (name) => slots.get(name)?.timerAt ?? null,
    /** Owner loss: the successor keeps the store and timer, not the open transaction. */
    lose(name) {
      const slot = slots.get(name);
      if (!slot) throw new Error(`no owner ${name}`);
      slot.owner.life.live = false;
      slot.owner = incarnate(name, slot);
    },
    /** Delivers the pending timer, if any, to the live owner. */
    async fireTimer(name) {
      const slot = slots.get(name);
      if (!slot || slot.timerAt === null) return false;
      slot.timerAt = null;
      await slot.owner.core.onTimer();
      return true;
    },
  };
};
