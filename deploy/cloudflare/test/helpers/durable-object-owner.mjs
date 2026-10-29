// The real Durable Objects adapter over a simulated namespace and object state. Only the
// Cloudflare platform is simulated: `idFromName` / `get` routing, a stub whose `fetch`
// reaches the object, and `DurableObjectState` storage, alarm, and `waitUntil`. The adapter
// code under test (src/adapters/durable-objects.ts) is the production code.
//
// It exposes the same test interface as memory-owner.mjs, so one conformance suite and the
// routing harness run against either adapter.
import {
  durableObjectTransactionOwnerClass, durableObjectTransactionOwners,
} from "../../src/adapters/durable-objects.ts";
import { OwnerLostError } from "./memory-owner.mjs";

/**
 * `dependencies(name)` returns the ports for a new object of `name`; `env` is what the
 * platform hands the object's constructor. `background` receives every `waitUntil` task.
 */
export const createSimulatedDurableObjects = (dependencies, { background = { run() {} }, env = {} } = {}) => {
  const objects = new Map();
  let constructing = null;
  const ObjectClass = durableObjectTransactionOwnerClass(() => dependencies(constructing));

  // One DurableObjectState per incarnation over the object's persistent data, revoked when
  // the platform discards that incarnation.
  const state = (slot) => {
    const life = { live: true };
    const alive = () => { if (!life.live) throw new OwnerLostError("object reset"); };
    return {
      life,
      value: {
        waitUntil(task) { background.run(task); },
        storage: {
          async get(key) { alive(); return structuredClone(slot.data.get(key)); },
          async put(key, value) { alive(); slot.data.set(key, structuredClone(value)); },
          async setAlarm(atMs) { alive(); slot.alarmAt = atMs; },
        },
      },
    };
  };
  const incarnate = (name, slot) => {
    const objectState = state(slot);
    constructing = name;
    try {
      return { life: objectState.life, object: new ObjectClass(objectState.value, env) };
    } finally {
      constructing = null;
    }
  };

  const lookups = { idFromName: 0, get: 0 };
  let nextBodyDelayMs = 0;
  const namespace = {
    idFromName(name) { lookups.idFromName++; return { name }; },
    get(id) {
      lookups.get++;
      return {
        fetch: (input, init) => {
          let slot = objects.get(id.name);
          if (!slot) {
            slot = { data: new Map(), alarmAt: null, owner: null };
            objects.set(id.name, slot);
            slot.owner = incarnate(id.name, slot);
          }
          // The platform may deliver a message's body later than its arrival; a delayed body
          // must not let a later message overtake it.
          const delay = nextBodyDelayMs;
          nextBodyDelayMs = 0;
          if (delay === 0) return slot.owner.object.fetch(new Request(input, init));
          const text = init.body;
          const body = new ReadableStream({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            },
          }, { highWaterMark: 0 });
          return slot.owner.object.fetch(new Request(input, { ...init, body, duplex: "half" }));
        },
      };
    },
  };

  return {
    namespace,
    lookups,
    port: durableObjectTransactionOwners(namespace),
    names: () => [...objects.keys()],
    record: async (name) => structuredClone(objects.get(name)?.data.get("transaction")),
    core: (name) => objects.get(name)?.owner.object.core,
    timerAt: (name) => objects.get(name)?.alarmAt ?? null,
    /** The next message's body reaches the object only after `ms`. */
    delayNextBody(ms) { nextBodyDelayMs = ms; },
    /** The platform resets the object: storage and alarm survive, memory does not. */
    lose(name) {
      const slot = objects.get(name);
      if (!slot) throw new Error(`no object ${name}`);
      slot.owner.life.live = false;
      slot.owner = incarnate(name, slot);
    },
    /** The platform delivers the pending alarm to the live object. */
    async fireTimer(name) {
      const slot = objects.get(name);
      if (!slot || slot.alarmAt === null) return false;
      slot.alarmAt = null;
      await slot.owner.object.alarm();
      return true;
    },
  };
};
