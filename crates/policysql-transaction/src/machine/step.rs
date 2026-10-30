//! The transitions (ADR 0024, "Fail-closed rules", "Effect execution contract").
//!
//! Every handler reads the current durable and volatile state, decides, and leaves the next
//! state plus a batch of effects: immediate effects first, at most one awaited effect last.
//! Anything the handlers did not foresee (an invariant violation, an outcome that is not
//! pending, invalid volatile state) goes through [`Step::fail_closed`], which never turns
//! `committing` into a definite rejection.

use super::compiler::{Compiler, CoreError, Operation, RawResult, Validated};
use super::io::{
    self, Class, Code, DriverCall, DriverResult, Effect, Event, HostFacts, ObserveContext,
    error_reply, value_reply,
};
use super::state::{
    Binding, Connection, Counters, Durable, Identity, MAX_DURABLE_BYTES, MAX_VOLATILE_BYTES, Mode,
    Mutation, Pending, Phase, Record, Replay, TX_STATE_VERSION, Task, Unreadable, Usage, Versions,
    Volatile, Work, WorkLane, awaited_by, hex64,
};
use super::{Limits, MAX_SAFE_INTEGER, Output};
use crate::canonical::{self, Json};
use crate::identity;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// An invariant the transition relies on did not hold.
#[derive(Debug)]
pub(super) struct Fault(&'static str);

type Result<T> = std::result::Result<T, Fault>;

/// The durable state as read: absent, unreadable, or a record.
enum Stored {
    Absent,
    Unreadable(Unreadable),
    Readable(Durable),
}

pub(super) fn run<C: Compiler>(
    compiler: &C,
    limits: &Limits,
    durable: Option<&str>,
    volatile: Option<&str>,
    event: &str,
    host: &str,
) -> Option<Output> {
    let host: HostFacts = serde_json::from_str(host).ok()?;
    if !host.is_valid() {
        return None;
    }
    let owner = host.owner.clone()?;
    if event.len() > limits.max_event_bytes() {
        return None;
    }
    let event: Event = serde_json::from_str(event).ok()?;
    let stored = match durable {
        None => Stored::Absent,
        Some(text) => match Durable::parse(text, &owner) {
            Ok(durable) => Stored::Readable(durable),
            Err(reason) => Stored::Unreadable(reason),
        },
    };
    let volatile_state = volatile.map(|text| Volatile::parse(text, &owner));
    let mut machine = Step {
        compiler,
        limits,
        host: &host,
        owner: &owner,
        durable: None,
        volatile: None,
        effects: Vec::new(),
        reset: false,
        request: None,
        allocated: Vec::new(),
        abandoned: false,
    };
    match (stored, volatile_state) {
        (Stored::Unreadable(reason), volatile) => {
            machine.volatile = volatile.flatten();
            machine.discard(reason, &event);
        }
        (stored, Some(None)) => {
            // Invalid volatile state is an engine fault: Abandon applied to the durable state.
            // Its handles are released when they can still be read.
            for handle in readable_handles(volatile.unwrap_or_default(), &owner) {
                compiler.release(handle);
            }
            machine.durable = match stored {
                Stored::Readable(durable) => Some(durable),
                Stored::Absent | Stored::Unreadable(_) => None,
            };
            machine.fail_closed("volatile_invalid", &event, true);
        }
        (stored, volatile) => {
            machine.durable = match stored {
                Stored::Readable(durable) => Some(durable),
                Stored::Absent | Stored::Unreadable(_) => None,
            };
            machine.volatile = volatile.flatten();
            let before = (machine.durable.clone(), machine.volatile.clone());
            let outcome = machine
                .dispatch(&event)
                .and_then(|()| machine.check_output());
            if let Err(Fault(reason)) = outcome {
                // Plans compiled by this step are released; the state is the one it started from.
                for handle in std::mem::take(&mut machine.allocated) {
                    compiler.release(handle);
                }
                (machine.durable, machine.volatile) = before;
                machine.reset = false;
                machine.fail_closed(reason, &event, false);
            }
        }
    }
    Some(machine.finish_output())
}

struct Step<'a, C> {
    compiler: &'a C,
    limits: &'a Limits,
    host: &'a HostFacts,
    owner: &'a str,
    durable: Option<Durable>,
    volatile: Option<Volatile>,
    effects: Vec<Effect>,
    reset: bool,
    /// The client request the work being decided answers.
    request: Option<String>,
    /// Handles compiled during this step.
    allocated: Vec<u64>,
    /// This step is `Abandon`.
    abandoned: bool,
}

/// A parsed client command (`statement`, `commit`, or `rollback`).
struct Command<'a> {
    kind: &'static str,
    auth: Json,
    binding: Option<Binding>,
    binding_json: Json,
    snapshot: &'a str,
    /// The exact verified body text (#70: compile and digest use this, never a re-serialization).
    text: &'a str,
    members: BTreeMap<String, Box<RawValue>>,
    sequence: Option<u64>,
}

#[derive(Serialize)]
struct EnvelopeStatement<'a> {
    sql: &'a RawValue,
    params: &'a RawValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    expect: Option<&'a RawValue>,
}

#[derive(Serialize)]
struct Envelope<'a> {
    statements: [EnvelopeStatement<'a>; 1],
}

impl<C: Compiler> Step<'_, C> {
    // ---- plumbing -------------------------------------------------------------------------

    fn finish_output(mut self) -> Output {
        if self.reset {
            self.release_all();
            self.effects.push(Effect::Reset);
            return Output {
                durable: None,
                volatile: None,
                effects: self.effects,
            };
        }
        if let Some(volatile) = &self.volatile
            && volatile.work.is_none()
            && volatile.pending.is_none()
            && volatile.connection == Connection::None
            && volatile.handles.is_empty()
        {
            self.volatile = None;
        }
        Output {
            durable: self.durable.as_ref().map(Durable::to_json),
            volatile: self.volatile.as_ref().map(Volatile::to_json),
            effects: self.effects,
        }
    }

    /// Bounds and the batch rule of the state this step leaves.
    fn check_output(&self) -> Result<()> {
        if self.reset {
            return Ok(());
        }
        if self
            .durable
            .as_ref()
            .is_some_and(|durable| durable.to_json().len() > MAX_DURABLE_BYTES)
        {
            return Err(Fault("durable_bound"));
        }
        if let Some(volatile) = &self.volatile {
            if volatile.to_json().len() > MAX_VOLATILE_BYTES || !volatile.is_consistent() {
                return Err(Fault("volatile_bound"));
            }
        }
        let awaited = self
            .effects
            .iter()
            .filter(|effect| effect.is_awaited())
            .count();
        let last_awaited = self.effects.last().is_some_and(Effect::is_awaited);
        if awaited > 1 || (awaited == 1 && !last_awaited) {
            return Err(Fault("batch_rule"));
        }
        // The awaited effect of this batch is the one recorded as pending.
        let pending = self.volatile.as_ref().and_then(|volatile| volatile.pending);
        // `Abandon`'s Persist is run by the engine as it discards the state; no outcome follows.
        if let Some(effect) = self.effects.iter().find(|effect| effect.is_awaited())
            && !(self.abandoned && self.volatile.is_none())
            && pending.map(|pending| pending.id) != effect.id()
        {
            return Err(Fault("pending_mismatch"));
        }
        if let Some(Durable::Live(record)) = &self.durable
            && !record.is_consistent()
        {
            return Err(Fault("durable_inconsistent"));
        }
        Ok(())
    }

    fn record(&self) -> Option<&Record> {
        match &self.durable {
            Some(Durable::Live(record)) => Some(record),
            _ => None,
        }
    }

    fn record_mut(&mut self) -> Result<&mut Record> {
        match &mut self.durable {
            Some(Durable::Live(record)) => Ok(record),
            _ => Err(Fault("no_record")),
        }
    }

    fn volatile_mut(&mut self) -> &mut Volatile {
        let seed = self.seed_id();
        self.volatile.get_or_insert_with(|| Volatile {
            v: TX_STATE_VERSION,
            owner: self.owner.to_owned(),
            next_effect_id: seed,
            connection: Connection::None,
            handles: Vec::new(),
            pending: None,
            work: None,
            rollback_requested: false,
        })
    }

    /// A fresh volatile part numbers its effects from entropy, so an outcome addressed to an
    /// earlier incarnation's effect cannot match a new one.
    fn seed_id(&self) -> u64 {
        (self.host.entropy_u64(0) & 0x0000_ffff_ffff_ffff).max(1)
    }

    fn connection(&self) -> Connection {
        self.volatile
            .as_ref()
            .map_or(Connection::None, |volatile| volatile.connection)
    }

    fn set_connection(&mut self, connection: Connection) {
        self.volatile_mut().connection = connection;
    }

    fn work(&self) -> Option<&Work> {
        self.volatile
            .as_ref()
            .and_then(|volatile| volatile.work.as_ref())
    }

    fn rollback_requested(&self) -> bool {
        self.volatile
            .as_ref()
            .is_some_and(|volatile| volatile.rollback_requested)
    }

    /// Emits the awaited effect of `task` (built from its id) and records it as pending.
    fn wait(
        &mut self,
        lane: WorkLane,
        request_id: Option<String>,
        task: Task,
        effect: impl FnOnce(u64) -> Effect,
    ) -> Result<()> {
        let volatile = self.volatile_mut();
        let id = volatile.next_effect_id;
        if id >= MAX_SAFE_INTEGER {
            return Err(Fault("effect_ids"));
        }
        volatile.next_effect_id = id + 1;
        volatile.pending = Some(Pending {
            id,
            effect: awaited_by(&task),
        });
        volatile.work = Some(Work {
            lane,
            request_id,
            task,
        });
        self.effects.push(effect(id));
        Ok(())
    }

    fn respond(&mut self, reply: Box<RawValue>) {
        self.effects.push(Effect::Respond {
            lane: "client",
            reply,
        });
    }

    fn log(&mut self, record: &Value) {
        self.effects.push(Effect::Log {
            record: io::to_raw(record),
        });
    }

    fn release_all(&mut self) {
        if let Some(volatile) = &mut self.volatile {
            for handle in volatile.handles.drain(..) {
                self.compiler.release(handle);
            }
        }
    }

    fn release(&mut self, handle: u64) {
        self.compiler.release(handle);
        if let Some(volatile) = &mut self.volatile {
            volatile.handles.retain(|live| *live != handle);
        }
    }

    fn request_id(&self) -> String {
        self.host.request_id.clone()
    }

    // ---- dispatch -------------------------------------------------------------------------

    fn dispatch(&mut self, event: &Event) -> Result<()> {
        match event {
            Event::Abandon => {
                self.abandon();
                Ok(())
            }
            Event::Forwarded { input } => self.forwarded(input),
            Event::TimerFired => self.timer(),
            outcome => self.outcome(outcome),
        }
    }

    /// `Abandon`: release every handle, drop pending effects, and persist the phase change
    /// (`active`/`validating` with a connection → `failed`, `committing` → `commit_unknown`).
    fn abandon(&mut self) {
        self.abandoned = true;
        let connection = self.connection();
        self.release_all();
        let id = self
            .volatile
            .as_ref()
            .map_or_else(|| self.seed_id(), |volatile| volatile.next_effect_id);
        self.volatile = None;
        let next = match self.durable.as_ref().map(Durable::phase) {
            Some(Phase::Active | Phase::Validating) if connection != Connection::None => {
                Some(Phase::Failed)
            }
            Some(Phase::Committing) => Some(Phase::CommitUnknown),
            _ => None,
        };
        if let Some(phase) = next {
            self.set_phase(phase);
            self.effects.push(Effect::Persist { id });
        }
    }

    /// The fail-closed rule for anything unforeseen: release handles; `active`/`validating`
    /// → `failed`, `committing` → `commit_unknown`, persisted; answer every waiting client
    /// with `POLICYSQL_INTERNAL`, or `POLICYSQL_COMMIT_OUTCOME_UNKNOWN` for a commit that may
    /// have been sent; then reset, so the engine closes the connection and reloads.
    fn fail_closed(&mut self, reason: &'static str, event: &Event, volatile_unknown: bool) {
        self.effects.clear();
        let had_volatile = volatile_unknown || self.volatile.is_some();
        let phase = self.durable.as_ref().map(Durable::phase);
        let unsure_commit = matches!(phase, Some(Phase::Committing | Phase::CommitUnknown));
        self.log(&json!({
            "event": "tx_fail_closed",
            "transactionId": self.owner,
            "reason": reason,
        }));
        let waiting = self
            .work()
            .filter(|work| work.lane == WorkLane::Client)
            .map(|work| {
                matches!(
                    work.task,
                    Task::CommitPersist { .. } | Task::CommitSend { .. } | Task::Reply { .. }
                )
            });
        if let Some(commit) = waiting {
            self.respond(error_reply(if unsure_commit && commit {
                Code::OutcomeUnknown
            } else {
                Code::Internal
            }));
        }
        if let Event::Forwarded { input } = event {
            let commit = input.get("kind").and_then(Value::as_str) == Some("commit");
            self.respond(error_reply(if unsure_commit && commit {
                Code::OutcomeUnknown
            } else {
                Code::Internal
            }));
        }
        self.release_all();
        self.volatile = None;
        let next = match phase {
            Some(Phase::Active | Phase::Validating) if had_volatile => Some(Phase::Failed),
            Some(Phase::Committing) => Some(Phase::CommitUnknown),
            _ => None,
        };
        match next {
            Some(phase) => {
                self.set_phase(phase);
                // The new volatile part awaits only this Persist, then resets.
                if self
                    .wait(WorkLane::Background, None, Task::ResetAfterPersist, |id| {
                        Effect::Persist { id }
                    })
                    .is_err()
                {
                    self.reset = true;
                }
            }
            None => self.reset = true,
        }
    }

    /// An unreadable record (ADR 0024 "Fail-closed rules"): log, roll back an open
    /// connection, replace the record with a tombstone, and answer as the tombstone is
    /// answered.
    fn discard(&mut self, reason: Unreadable, event: &Event) {
        self.log(&json!({
            "event": "tx_state_discarded",
            "transactionId": self.owner,
            "reason": reason.as_str(),
        }));
        if let Some(work) = self.work()
            && work.lane == WorkLane::Client
        {
            let commit = matches!(
                work.task,
                Task::CommitBinding { .. }
                    | Task::CommitPersist { .. }
                    | Task::CommitSend { .. }
                    | Task::Reply { .. }
            );
            self.respond(error_reply(if commit {
                Code::OutcomeUnknown
            } else {
                Code::Internal
            }));
        }
        if let Event::Forwarded { input } = event {
            let reply = match input.get("kind").and_then(Value::as_str) {
                Some("commit") => Code::OutcomeUnknown,
                Some("atomic") => Code::Internal,
                _ => Code::Unavailable,
            };
            self.respond(error_reply(reply));
        }
        let idle_open = self.volatile.as_ref().is_some_and(|volatile| {
            volatile.connection == Connection::Open && volatile.pending.is_none()
        });
        self.release_all();
        self.durable = Some(Durable::Tombstone {
            owner: self.owner.to_owned(),
        });
        let result = if idle_open {
            if let Some(volatile) = &mut self.volatile {
                volatile.work = None;
                volatile.connection = Connection::Closing;
            }
            self.wait(
                WorkLane::Background,
                None,
                Task::CloseRollback {
                    phase: Phase::Discarded,
                    reply: None,
                },
                |id| Effect::Rollback { id },
            )
        } else {
            let pending_on_connection = self.connection() != Connection::None;
            self.volatile = None;
            if pending_on_connection {
                // The connection is busy or unknown: the engine closes it on reset.
                self.wait(WorkLane::Background, None, Task::ResetAfterPersist, |id| {
                    Effect::Persist { id }
                })
            } else {
                self.wait(
                    WorkLane::Background,
                    None,
                    Task::Reply {
                        reply: None,
                        failure: None,
                        logs: Vec::new(),
                        failure_logs: Vec::new(),
                        expire_after: false,
                    },
                    |id| Effect::Persist { id },
                )
            }
        };
        if result.is_err() {
            self.reset = true;
        }
    }

    /// Moves the record to `phase` (the tombstone for `discarded`); a phase without a deadline
    /// drops `expiresAtMs`.
    fn set_phase(&mut self, phase: Phase) {
        if phase == Phase::Discarded {
            self.durable = Some(Durable::Tombstone {
                owner: self.owner.to_owned(),
            });
            return;
        }
        if let Some(Durable::Live(record)) = &mut self.durable {
            record.phase = phase;
            if !phase.has_deadline() {
                record.expires_at_ms = None;
            }
        }
    }

    /// Ends client or background work with `phase`: roll back an open idle connection, then
    /// persist the phase, then answer `reply` (client work). A failed persist answers
    /// `POLICYSQL_INTERNAL` and resets.
    fn close(&mut self, lane: WorkLane, phase: Phase, reply: Option<Box<RawValue>>) -> Result<()> {
        self.release_all();
        let request_id = match lane {
            WorkLane::Client => Some(self.request.clone().unwrap_or_else(|| self.request_id())),
            WorkLane::Background => None,
        };
        if self.connection() == Connection::Open {
            self.set_connection(Connection::Closing);
            return self.wait(
                lane,
                request_id,
                Task::CloseRollback { phase, reply },
                |id| Effect::Rollback { id },
            );
        }
        self.set_connection(Connection::None);
        self.persist_phase(lane, request_id, phase, reply)
    }

    fn persist_phase(
        &mut self,
        lane: WorkLane,
        request_id: Option<String>,
        phase: Phase,
        reply: Option<Box<RawValue>>,
    ) -> Result<()> {
        if self.durable.is_none() {
            if let Some(reply) = reply {
                self.respond(reply);
            }
            self.clear_work();
            return Ok(());
        }
        self.set_phase(phase);
        let failure = reply.as_ref().map(|_| error_reply(Code::Internal));
        self.wait(
            lane,
            request_id,
            Task::Reply {
                reply,
                failure,
                logs: Vec::new(),
                failure_logs: Vec::new(),
                expire_after: false,
            },
            |id| Effect::Persist { id },
        )
    }

    fn clear_work(&mut self) {
        if let Some(volatile) = &mut self.volatile {
            volatile.work = None;
            volatile.pending = None;
        }
    }

    // ---- outcomes -------------------------------------------------------------------------

    fn outcome(&mut self, event: &Event) -> Result<()> {
        let id = event.outcome_id().ok_or(Fault("not_outcome"))?;
        let expected = event.answers().ok_or(Fault("not_outcome"))?;
        let pending = self.volatile.as_ref().and_then(|volatile| volatile.pending);
        if !pending.is_some_and(|pending| pending.id == id && pending.effect == expected) {
            return self.stale(event);
        }
        let volatile = self.volatile.as_mut().ok_or(Fault("no_volatile"))?;
        volatile.pending = None;
        let work = volatile.work.take().ok_or(Fault("no_work"))?;
        let lane = work.lane;
        let request_id = work.request_id;
        self.request.clone_from(&request_id);
        let result = self.consume(lane, request_id, work.task, event);
        // A task that did not wait again leaves no work behind.
        if let Some(volatile) = &mut self.volatile
            && volatile.pending.is_none()
        {
            volatile.work = None;
        }
        result
    }

    /// An outcome for an id that is not pending: ignored once the transaction is terminal (a
    /// late answer after expiry or `Abandon`), otherwise the transaction fails closed.
    fn stale(&mut self, event: &Event) -> Result<()> {
        let idle = self
            .volatile
            .as_ref()
            .is_none_or(|volatile| volatile.pending.is_none());
        let terminal = self
            .durable
            .as_ref()
            .map_or(idle, |durable| durable.phase().is_terminal());
        if terminal {
            self.log(&json!({
                "event": "tx_outcome_ignored",
                "transactionId": self.owner,
                "id": event.outcome_id(),
            }));
            return Ok(());
        }
        Err(Fault("outcome_not_pending"))
    }

    #[allow(clippy::too_many_lines)]
    fn consume(
        &mut self,
        lane: WorkLane,
        request_id: Option<String>,
        task: Task,
        event: &Event,
    ) -> Result<()> {
        match (task, event) {
            // -- begin --
            (
                Task::BeginBinding {
                    identity,
                    binding,
                    snapshot,
                },
                Event::BindingChecked { allowed: true, .. },
            ) => self.begin_checked(request_id, identity, binding, snapshot),
            (Task::BeginBinding { .. }, Event::BindingChecked { allowed: false, .. }) => {
                self.respond(error_reply(Code::BindingRejected));
                Ok(())
            }
            (Task::BeginBinding { .. }, Event::BindingCheckFailed { class, .. }) => {
                self.respond(error_reply(Code::for_class(*class)));
                Ok(())
            }
            (
                Task::BeginOpen {
                    identity,
                    binding,
                    snapshot,
                    expires_at_ms,
                },
                Event::Opened { .. },
            ) => {
                self.set_connection(Connection::Open);
                self.durable = Some(Durable::Live(Box::new(Record {
                    owner: self.owner.to_owned(),
                    kind: super::state::Kind::Interactive,
                    phase: Phase::Active,
                    identity,
                    binding,
                    snapshot,
                    expires_at_ms: Some(expires_at_ms),
                    next_sequence: 1,
                    last: None,
                    counters: Counters::default(),
                    mutations: Vec::new(),
                    versions: None,
                })));
                self.wait(lane, request_id, Task::BeginPersist, |id| Effect::Persist {
                    id,
                })
            }
            (Task::BeginOpen { .. }, Event::OpenFailed { class, .. }) => {
                self.set_connection(Connection::None);
                self.respond(error_reply(Code::for_class(*class)));
                Ok(())
            }
            (Task::BeginPersist, Event::Persisted { .. }) => {
                let at_ms = self
                    .record()
                    .and_then(|record| record.expires_at_ms)
                    .ok_or(Fault("begin_record"))?;
                self.wait(lane, request_id, Task::BeginTimer, |id| Effect::SetTimer {
                    id,
                    at_ms,
                })
            }
            (Task::BeginPersist, Event::PersistFailed { .. })
            | (Task::BeginTimer, Event::TimerFailed { .. }) => {
                self.close(lane, Phase::Failed, Some(error_reply(Code::Internal)))
            }
            (Task::BeginTimer, Event::TimerSet { .. }) => {
                if self.rollback_requested() {
                    return self.expire_client(lane);
                }
                let request = request_id.unwrap_or_else(|| self.request_id());
                let record = self.record().ok_or(Fault("begin_record"))?;
                let started = json!({
                    "event": "transaction_started",
                    "transactionId": self.owner,
                    "mode": record.identity.mode.as_str(),
                    "requestId": request,
                });
                let state = public_state(record, &request);
                self.log(&started);
                self.respond(value_reply(&state));
                Ok(())
            }

            // -- statement --
            (
                Task::StatementBinding {
                    sequence,
                    digest,
                    handle,
                    operation,
                    resource,
                    versions,
                },
                Event::BindingChecked { allowed: true, .. },
            ) => {
                if let Some(expired) = self.recheck(lane)? {
                    return expired;
                }
                let statements = self
                    .compiler
                    .statements(handle)
                    .map_err(|_| Fault("plan"))?;
                let mut calls = Vec::with_capacity(statements.len());
                for statement in &statements {
                    calls.push(driver_call(&statement.sql, statement)?);
                }
                self.wait(
                    lane,
                    request_id,
                    Task::StatementExecute {
                        sequence,
                        digest,
                        handle,
                        operation,
                        resource,
                        versions,
                        started_at_ms: self.host.now_ms,
                    },
                    |id| Effect::Execute {
                        id,
                        statements: calls,
                        trace: None,
                    },
                )
            }
            (
                Task::StatementBinding { .. }
                | Task::CommitBinding { .. }
                | Task::RollbackBinding { .. },
                Event::BindingChecked { allowed: false, .. },
            ) => self.close(
                lane,
                Phase::Failed,
                Some(error_reply(Code::BindingRejected)),
            ),
            (
                Task::StatementBinding { .. }
                | Task::CommitBinding { .. }
                | Task::RollbackBinding { .. },
                Event::BindingCheckFailed { class, .. },
            ) => self.close(
                lane,
                Phase::Failed,
                Some(error_reply(Code::for_class(*class))),
            ),
            (task @ Task::StatementExecute { .. }, Event::Executed { results, .. }) => {
                self.executed(lane, request_id, task, results)
            }
            (Task::StatementExecute { handle, .. }, Event::ExecuteFailed { class, .. }) => {
                self.set_connection(Connection::Open);
                self.release(handle);
                if self.rollback_requested() {
                    // The expiry that arrived meanwhile decides, not the failure it caused.
                    return self.expire_client(lane);
                }
                self.close(
                    lane,
                    Phase::Failed,
                    Some(error_reply(Code::for_class(*class))),
                )
            }

            // -- commit --
            (
                Task::CommitBinding { sequence, digest },
                Event::BindingChecked { allowed: true, .. },
            ) => {
                if let Some(expired) = self.recheck(lane)? {
                    return expired;
                }
                self.set_phase(Phase::Committing);
                self.wait(
                    lane,
                    request_id,
                    Task::CommitPersist { sequence, digest },
                    |id| Effect::Persist { id },
                )
            }
            (Task::CommitPersist { sequence, digest }, Event::Persisted { .. }) => {
                let expires = self
                    .record()
                    .and_then(|record| record.expires_at_ms)
                    .ok_or(Fault("committing_record"))?;
                // The one deadline check of `committing`: after it, nothing expires the
                // transaction; COMMIT's outcome alone decides.
                if self.host.now_ms >= expires || self.rollback_requested() {
                    return self.close(lane, Phase::Expired, Some(error_reply(Code::Unavailable)));
                }
                self.set_connection(Connection::Closing);
                self.wait(
                    lane,
                    request_id,
                    Task::CommitSend { sequence, digest },
                    |id| Effect::Commit { id },
                )
            }
            (Task::CommitPersist { .. }, Event::PersistFailed { .. }) => {
                // COMMIT was never sent; the store holds `committing` or the earlier phase.
                self.close(lane, Phase::Failed, Some(error_reply(Code::Internal)))
            }
            (Task::CommitSend { digest, .. }, Event::Committed { .. }) => {
                self.set_connection(Connection::None);
                let request = request_id.unwrap_or_else(|| self.request_id());
                let response = terminal_response(self.owner, "committed", &request);
                let usage = self.record().ok_or(Fault("commit_record"))?.counters.usage;
                self.complete(Phase::Committed, digest, &response)?;
                let terminal = self.terminal_log("committed", &request, usage);
                let unrecorded = json!({
                    "event": "transaction_terminal_unrecorded",
                    "transactionId": self.owner,
                    "requestId": request,
                });
                let reply = value_reply(&response);
                self.wait(
                    lane,
                    Some(request),
                    Task::Reply {
                        reply: Some(reply.clone()),
                        // COMMIT applied: the reply says so even when the record is not
                        // stored; a retry then finds `committing` (outcome unknown).
                        failure: Some(reply),
                        logs: vec![io::to_raw(&terminal)],
                        failure_logs: vec![io::to_raw(&unrecorded), io::to_raw(&terminal)],
                        expire_after: false,
                    },
                    |id| Effect::Persist { id },
                )
            }
            (Task::CommitSend { digest, .. }, Event::CommitFailed { class, .. }) => {
                self.set_connection(Connection::None);
                let request = request_id.unwrap_or_else(|| self.request_id());
                if *class == Class::NotCommitted {
                    // The adapter proved COMMIT did not apply.
                    let response = terminal_response(self.owner, "failed", &request);
                    self.complete(Phase::Failed, digest, &response)?;
                    return self.wait(
                        lane,
                        Some(request),
                        Task::Reply {
                            reply: Some(value_reply(&response)),
                            failure: Some(error_reply(Code::Internal)),
                            logs: Vec::new(),
                            failure_logs: Vec::new(),
                            expire_after: false,
                        },
                        |id| Effect::Persist { id },
                    );
                }
                let unknown = json!({
                    "event": "transaction_commit_outcome_unknown",
                    "transactionId": self.owner,
                    "requestId": request,
                });
                self.log(&unknown);
                self.set_phase(Phase::CommitUnknown);
                self.wait(
                    lane,
                    Some(request),
                    Task::Reply {
                        reply: Some(error_reply(Code::OutcomeUnknown)),
                        failure: Some(error_reply(Code::OutcomeUnknown)),
                        logs: Vec::new(),
                        failure_logs: Vec::new(),
                        expire_after: false,
                    },
                    |id| Effect::Persist { id },
                )
            }

            // -- rollback --
            (
                Task::RollbackBinding { sequence, digest },
                Event::BindingChecked { allowed: true, .. },
            ) => {
                if let Some(expired) = self.recheck(lane)? {
                    return expired;
                }
                self.set_connection(Connection::Closing);
                self.wait(
                    lane,
                    request_id,
                    Task::RollbackSend { sequence, digest },
                    |id| Effect::Rollback { id },
                )
            }
            (
                Task::RollbackSend { digest, .. },
                Event::RolledBack { .. } | Event::RollbackFailed { .. },
            ) => {
                // A failed ROLLBACK leaves the decided phase: the database deadline ends the
                // server transaction, and no COMMIT is ever sent.
                self.set_connection(Connection::None);
                let request = request_id.unwrap_or_else(|| self.request_id());
                let response = terminal_response(self.owner, "rolled_back", &request);
                let usage = self
                    .record()
                    .ok_or(Fault("rollback_record"))?
                    .counters
                    .usage;
                self.complete(Phase::RolledBack, digest, &response)?;
                let terminal = self.terminal_log("rolled_back", &request, usage);
                self.wait(
                    lane,
                    Some(request),
                    Task::Reply {
                        reply: Some(value_reply(&response)),
                        failure: Some(error_reply(Code::Internal)),
                        logs: vec![io::to_raw(&terminal)],
                        failure_logs: Vec::new(),
                        expire_after: false,
                    },
                    |id| Effect::Persist { id },
                )
            }

            // -- closing and replies --
            (
                Task::CloseRollback { phase, reply },
                Event::RolledBack { .. } | Event::RollbackFailed { .. },
            ) => {
                self.set_connection(Connection::None);
                self.persist_phase(lane, request_id, phase, reply)
            }
            (
                Task::Reply {
                    reply,
                    logs,
                    expire_after,
                    ..
                },
                Event::Persisted { .. },
            ) => {
                for record in logs {
                    self.effects.push(Effect::Log { record });
                }
                if let Some(reply) = reply {
                    self.respond(reply);
                }
                if expire_after && self.rollback_requested() {
                    // An expiry arrived while the statement's completion was being recorded:
                    // its reply stands, then the transaction rolls back.
                    self.clear_work();
                    self.log_unavailable("expired");
                    return self.close(WorkLane::Background, Phase::Expired, None);
                }
                Ok(())
            }
            (
                Task::Reply {
                    failure,
                    failure_logs,
                    expire_after,
                    ..
                },
                Event::PersistFailed { .. },
            ) => {
                for record in failure_logs {
                    self.effects.push(Effect::Log { record });
                }
                if expire_after {
                    // A statement's completion could not be stored: roll back and record
                    // `failed` before answering (ADR 0024 failure table).
                    return self.close(lane, Phase::Failed, failure);
                }
                if let Some(failure) = failure {
                    self.respond(failure);
                }
                self.reset = true;
                Ok(())
            }
            (Task::ResetAfterPersist, Event::Persisted { .. } | Event::PersistFailed { .. }) => {
                self.reset = true;
                Ok(())
            }
            _ => Err(Fault("unexpected_outcome")),
        }
    }

    /// The checks repeated when a binding check returns: expiry (by the clock or a timer that
    /// arrived meanwhile) and the runtime snapshot. `Some` when the work ended.
    fn recheck(&mut self, lane: WorkLane) -> Result<Option<Result<()>>> {
        let record = self.record().ok_or(Fault("recheck_record"))?;
        let expired = record.expires_at_ms.is_none_or(|at| self.host.now_ms >= at)
            || self.rollback_requested();
        if expired {
            return Ok(Some(self.expire_client(lane)));
        }
        if record.snapshot != self.compiler.snapshot() {
            return Ok(Some(self.close(
                lane,
                Phase::Failed,
                Some(error_reply(Code::Unavailable)),
            )));
        }
        Ok(None)
    }

    fn expire_client(&mut self, lane: WorkLane) -> Result<()> {
        self.log_unavailable("expired");
        self.close(lane, Phase::Expired, Some(error_reply(Code::Unavailable)))
    }

    fn log_unavailable(&mut self, reason: &str) {
        let record = json!({
            "event": "transaction_owner_unavailable",
            "transactionId": self.owner,
            "reason": reason,
        });
        self.log(&record);
    }

    fn terminal_log(&self, status: &str, request: &str, usage: Usage) -> Value {
        json!({
            "event": "transaction_terminal",
            "transactionId": self.owner,
            "status": status,
            "requestId": request,
            "usage": usage_json(usage),
        })
    }

    /// Records a completed terminal command as `last` and advances the sequence.
    fn complete(&mut self, phase: Phase, digest: String, response: &RawValue) -> Result<()> {
        let record = self.record_mut()?;
        record.next_sequence = record
            .next_sequence
            .checked_add(1)
            .filter(|next| *next <= MAX_SAFE_INTEGER)
            .ok_or(Fault("sequence"))?;
        record.last = Some(Replay {
            digest,
            response: io::raw(response.get().to_owned()),
        });
        self.set_phase(phase);
        Ok(())
    }

    #[allow(clippy::too_many_lines)]
    fn executed(
        &mut self,
        lane: WorkLane,
        request_id: Option<String>,
        task: Task,
        results: &[DriverResult],
    ) -> Result<()> {
        let Task::StatementExecute {
            sequence,
            digest,
            handle,
            operation,
            resource,
            versions,
            ..
        } = task
        else {
            return Err(Fault("executed_task"));
        };
        self.set_connection(Connection::Open);
        if self.rollback_requested() {
            self.release(handle);
            return self.expire_client(lane);
        }
        let [result] = results else {
            self.release(handle);
            return self.close(lane, Phase::Failed, Some(error_reply(Code::Internal)));
        };
        if let Some(code) = codec_failure(result) {
            self.release(handle);
            return self.close(lane, Phase::Failed, Some(error_reply(code)));
        }
        let raw = RawResult {
            columns: result.columns.clone(),
            rows: result.rows.clone(),
            // The RETURNING row count for a mutation with result columns, else the driver's.
            affected_rows: if operation != Operation::Select && !result.columns.is_empty() {
                u64::try_from(result.rows.len()).map_err(|_| Fault("rows"))?
            } else {
                result.rows_affected
            },
        };
        let validated = match self.compiler.validate(handle, 0, raw) {
            Ok(validated) => validated,
            Err(error) => {
                self.release(handle);
                return self.close(lane, Phase::Failed, Some(io::core_error_reply(&error)));
            }
        };
        let observed = self.compiler.statements(handle).unwrap_or_default();
        self.release(handle);
        if operation != Operation::Insert
            && let Some(statement) = observed.first()
        {
            let call = driver_call(&statement.cost_sql, statement)?;
            self.effects.push(Effect::Observe {
                statements: vec![call],
                context: ObserveContext {
                    operation: operation.as_str(),
                    resource: resource.clone(),
                },
            });
        }
        let request = request_id.unwrap_or_else(|| self.request_id());
        let shaped = shape_result(sequence, operation, &validated)?;
        let record = self.record().ok_or(Fault("statement_record"))?;
        let result_bytes = record
            .counters
            .result_bytes
            .saturating_add(u64::try_from(shaped.get().len()).map_err(|_| Fault("bytes"))?);
        if result_bytes > self.limits.max_transaction_result_bytes {
            return self.close(
                lane,
                Phase::Failed,
                Some(error_reply(Code::TransactionLimit)),
            );
        }
        let usage = Usage {
            rows_read: record
                .counters
                .usage
                .rows_read
                .saturating_add(result.usage.rows_read),
            rows_written: record
                .counters
                .usage
                .rows_written
                .saturating_add(result.usage.rows_written),
            query_duration_ms: round_ms(
                record.counters.usage.query_duration_ms + result.usage.query_duration_ms,
            ),
        };
        if !usage.is_valid() || !result.usage.query_duration_ms.is_finite() {
            return self.close(lane, Phase::Failed, Some(error_reply(Code::Internal)));
        }
        let response = statement_response(self.owner, sequence, &shaped, &request);
        let mut next = record.clone();
        next.next_sequence = sequence + 1;
        next.last = Some(Replay {
            digest,
            response: io::raw(response.get().to_owned()),
        });
        let index = next.counters.statements;
        next.counters = Counters {
            statements: index + 1,
            result_bytes,
            usage,
        };
        if operation != Operation::Select
            && validated.affected_rows > 0
            && let Some(resource) = resource
        {
            next.mutations.push(Mutation {
                index,
                operation,
                resource,
            });
        }
        next.versions = Some(versions);
        let next = Durable::Live(Box::new(next));
        if next.to_json().len() > MAX_DURABLE_BYTES {
            return self.close(
                lane,
                Phase::Failed,
                Some(error_reply(Code::TransactionLimit)),
            );
        }
        self.durable = Some(next);
        let usage_log = json!({
            "event": "transaction_usage",
            "transactionId": self.owner,
            "requestId": request,
            "usage": usage_json(usage),
        });
        self.log(&usage_log);
        self.wait(
            lane,
            Some(request),
            Task::Reply {
                reply: Some(value_reply(&response)),
                failure: Some(error_reply(Code::Internal)),
                logs: Vec::new(),
                failure_logs: Vec::new(),
                expire_after: true,
            },
            |id| Effect::Persist { id },
        )
    }

    // ---- timer ----------------------------------------------------------------------------

    fn timer(&mut self) -> Result<()> {
        let Some(record) = self.record() else {
            return Ok(());
        };
        let phase = record.phase;
        let due = record
            .expires_at_ms
            .is_some_and(|at| self.host.now_ms >= at);
        // `committing`: before COMMIT the step consuming `Persisted` decides; after it,
        // nothing expires the transaction.
        if !due || !matches!(phase, Phase::Active | Phase::Validating) {
            return Ok(());
        }
        if let Some(work) = self.work() {
            let defer = work.lane == WorkLane::Client
                && matches!(
                    work.task,
                    Task::BeginBinding { .. }
                        | Task::BeginOpen { .. }
                        | Task::BeginPersist
                        | Task::BeginTimer
                        | Task::StatementBinding { .. }
                        | Task::StatementExecute { .. }
                        | Task::CommitBinding { .. }
                        | Task::RollbackBinding { .. }
                        | Task::Reply {
                            expire_after: true,
                            ..
                        }
                );
            if defer {
                self.volatile_mut().rollback_requested = true;
            }
            return Ok(());
        }
        self.close(WorkLane::Background, Phase::Expired, None)
    }

    // ---- client input ---------------------------------------------------------------------

    fn forwarded(&mut self, input: &Value) -> Result<()> {
        let kind = input.get("kind").and_then(Value::as_str);
        match kind {
            Some("begin") => self.begin(input),
            Some(kind @ ("statement" | "commit" | "rollback")) => {
                let kind = match kind {
                    "statement" => "statement",
                    "commit" => "commit",
                    _ => "rollback",
                };
                self.command(kind, input)
            }
            // A callback query needs a validation session (pull request 5).
            Some("callbackQuery") => {
                self.respond(error_reply(Code::Unavailable));
                Ok(())
            }
            // Atomic execution runs in the machine from pull request 6.
            Some("atomic") => {
                self.respond(error_reply(Code::Internal));
                Ok(())
            }
            _ => {
                self.respond(error_reply(Code::Invalid));
                Ok(())
            }
        }
    }

    /// What a client event gets while other work is in progress: an engine fault on the
    /// client lane (the lane is serialized), or an expiry, discard, or fail-closed in progress.
    fn busy(&self) -> Option<Code> {
        self.work().map(|work| match work.lane {
            WorkLane::Client => Code::Internal,
            WorkLane::Background => Code::Unavailable,
        })
    }

    fn begin(&mut self, input: &Value) -> Result<()> {
        let Some(fields) = exact_object(
            input,
            &[
                "kind",
                "transactionId",
                "startFingerprint",
                "mode",
                "auth",
                "databaseBinding",
                "snapshot",
            ],
            &["expected"],
        ) else {
            self.respond(error_reply(Code::Invalid));
            return Ok(());
        };
        let mode = match fields.get("mode").and_then(|value| value.as_str()) {
            Some("read") => Some(Mode::Read),
            Some("write") => Some(Mode::Write),
            _ => None,
        };
        let start = fields
            .get("startFingerprint")
            .and_then(|value| value.as_str())
            .filter(|value| hex64(value));
        let snapshot = fields.get("snapshot").and_then(|value| value.as_str());
        let (Some(mode), Some(start), Some(snapshot), true, true) = (
            mode,
            start,
            snapshot,
            fields.get("transactionId").and_then(|value| value.as_str()) == Some(self.owner),
            fields.get("auth").is_some_and(Value::is_object),
        ) else {
            self.respond(error_reply(Code::Invalid));
            return Ok(());
        };
        if snapshot != self.compiler.snapshot() {
            self.respond(error_reply(Code::Conflict));
            return Ok(());
        }
        let binding_value = fields
            .get("databaseBinding")
            .cloned()
            .unwrap_or(Value::Null);
        let Some(binding) = parse_binding(&binding_value) else {
            self.respond(error_reply(Code::BindingRejected));
            return Ok(());
        };
        if binding.snapshot != snapshot {
            self.respond(error_reply(Code::Stale));
            return Ok(());
        }
        let (Some(auth), Some(binding_json)) = (
            fields.get("auth").and_then(to_json),
            to_json(&binding_value),
        ) else {
            self.respond(error_reply(Code::Internal));
            return Ok(());
        };
        let (Ok(auth_fingerprint), Ok(replay)) = (
            identity::auth_fingerprint(&auth, &binding_json),
            identity::replay_identity(&auth, &binding_json),
        ) else {
            self.respond(error_reply(Code::Internal));
            return Ok(());
        };
        if let Some(code) = self.busy() {
            self.respond(error_reply(code));
            return Ok(());
        }
        let identity = Identity {
            auth_fingerprint,
            replay,
            start_fingerprint: start.to_owned(),
            mode,
        };
        let check = binding.clone();
        self.wait(
            WorkLane::Client,
            Some(self.request_id()),
            Task::BeginBinding {
                identity,
                binding,
                snapshot: snapshot.to_owned(),
            },
            |id| Effect::CheckBinding {
                id,
                binding: check,
                deadline_ms: None,
            },
        )
    }

    fn begin_checked(
        &mut self,
        request_id: Option<String>,
        identity: Identity,
        binding: Binding,
        snapshot: String,
    ) -> Result<()> {
        let request = request_id.unwrap_or_else(|| self.request_id());
        match &self.durable {
            Some(Durable::Tombstone { .. }) => {
                self.respond(error_reply(Code::Unavailable));
                Ok(())
            }
            Some(Durable::Live(record)) => {
                if record.identity.start_fingerprint != identity.start_fingerprint
                    || record.identity.auth_fingerprint != identity.auth_fingerprint
                    || record.snapshot != snapshot
                    || record.binding != binding
                {
                    self.respond(error_reply(Code::Conflict));
                    return Ok(());
                }
                match record.phase {
                    // COMMIT may be in flight or its outcome unrecorded; only the commit
                    // command answers.
                    Phase::Committing | Phase::CommitUnknown | Phase::Discarded => {
                        self.respond(error_reply(Code::Unavailable));
                        Ok(())
                    }
                    Phase::Active if self.connection() != Connection::Open => {
                        self.set_phase(Phase::Failed);
                        self.persist_reply(
                            Some(request),
                            error_reply(Code::Unavailable),
                            error_reply(Code::Internal),
                        )
                    }
                    _ => {
                        let state = public_state(record, &request);
                        self.respond(value_reply(&state));
                        Ok(())
                    }
                }
            }
            None => {
                let expires_at_ms = self
                    .host
                    .now_ms
                    .checked_add(self.limits.transaction_ms)
                    .filter(|at| *at <= super::MAX_TIME_MS)
                    .ok_or(Fault("deadline"))?;
                let mode = identity.mode;
                let timeout_ms = self.limits.begin_timeout_ms;
                let pinned = binding.clone();
                self.set_connection(Connection::Opening);
                self.wait(
                    WorkLane::Client,
                    Some(request),
                    Task::BeginOpen {
                        identity,
                        binding,
                        snapshot,
                        expires_at_ms,
                    },
                    |id| Effect::Open {
                        id,
                        binding: pinned,
                        mode,
                        timeout_ms,
                        deadline_ms: expires_at_ms,
                    },
                )
            }
        }
    }

    /// Persists the current record, then answers `reply` (`failure` and reset when the write
    /// fails).
    fn persist_reply(
        &mut self,
        request_id: Option<String>,
        reply: Box<RawValue>,
        failure: Box<RawValue>,
    ) -> Result<()> {
        self.wait(
            WorkLane::Client,
            request_id,
            Task::Reply {
                reply: Some(reply),
                failure: Some(failure),
                logs: Vec::new(),
                failure_logs: Vec::new(),
                expire_after: false,
            },
            |id| Effect::Persist { id },
        )
    }

    fn parse_command<'v>(kind: &'static str, input: &'v Value) -> Option<Command<'v>> {
        let fields = exact_object(
            input,
            &[
                "kind",
                "transactionId",
                "auth",
                "command",
                "databaseBinding",
                "snapshot",
            ],
            &[],
        )?;
        let text = fields.get("command")?.as_str()?;
        let snapshot = fields.get("snapshot")?.as_str()?;
        fields.get("transactionId")?.as_str()?;
        let auth = fields
            .get("auth")
            .filter(|auth| auth.is_object())
            .and_then(to_json)?;
        let binding_value = fields.get("databaseBinding")?;
        let members: BTreeMap<String, Box<RawValue>> = serde_json::from_str(text).ok()?;
        let allowed: &[&str] = if kind == "statement" {
            &["sequence", "sql", "params", "expect"]
        } else {
            &["sequence"]
        };
        let required: &[&str] = if kind == "statement" {
            &["sequence", "sql", "params"]
        } else {
            &["sequence"]
        };
        if !members.keys().all(|key| allowed.contains(&key.as_str()))
            || !required.iter().all(|key| members.contains_key(*key))
        {
            return None;
        }
        if kind == "statement" {
            let sql_is_string = members
                .get("sql")
                .is_some_and(|sql| sql.get().starts_with('"'));
            let params_is_object = members
                .get("params")
                .is_some_and(|params| params.get().starts_with('{'));
            if !sql_is_string || !params_is_object {
                return None;
            }
        }
        let sequence = members
            .get("sequence")
            .and_then(|raw| sequence_value(raw.get()));
        Some(Command {
            kind,
            auth,
            binding: parse_binding(binding_value),
            binding_json: to_json(binding_value).unwrap_or(Json::Null),
            snapshot,
            text,
            members,
            sequence,
        })
    }

    #[allow(clippy::too_many_lines)]
    fn command(&mut self, kind: &'static str, input: &Value) -> Result<()> {
        let Some(command) = Self::parse_command(kind, input) else {
            self.respond(error_reply(Code::Invalid));
            return Ok(());
        };
        let request = self.request_id();
        self.request = Some(request.clone());
        let owned = input.get("transactionId").and_then(Value::as_str) == Some(self.owner);
        let record = match &self.durable {
            Some(Durable::Live(record)) if owned => record.clone(),
            Some(Durable::Tombstone { .. }) if owned => {
                // Nothing in a discarded record proves COMMIT was not sent.
                self.respond(error_reply(if kind == "commit" {
                    Code::OutcomeUnknown
                } else {
                    Code::Unavailable
                }));
                return Ok(());
            }
            _ => {
                self.respond(error_reply(Code::Unavailable));
                return Ok(());
            }
        };
        // The caller must be the record's principal, subject, role, and session on its
        // database (the replay identity, which has no snapshot).
        let Some(binding) = command.binding.clone() else {
            self.respond(error_reply(Code::Unavailable));
            return Ok(());
        };
        let replay = identity::replay_identity(&command.auth, &command.binding_json);
        if replay.as_deref().ok() != Some(record.identity.replay.as_str()) {
            self.respond(error_reply(Code::Unavailable));
            return Ok(());
        }
        let same_snapshot = identity::auth_fingerprint(&command.auth, &command.binding_json)
            .is_ok_and(|fingerprint| fingerprint == record.identity.auth_fingerprint)
            && binding == record.binding
            && command.snapshot == record.snapshot;

        // An exact retry of the last completed command replays it, before any snapshot or
        // liveness check (ADR 0024 "Replay identity").
        if let (Some(sequence), Some(last)) = (command.sequence, &record.last)
            && sequence + 1 == record.next_sequence
            && (kind != "statement" || self.may_repeat(&command))
        {
            let Some(digest) = digest_of(&command) else {
                self.respond(error_reply(Code::Internal));
                return Ok(());
            };
            if digest == last.digest {
                self.respond(value_reply(&last.response));
                return Ok(());
            }
        }

        // COMMIT may have been sent: a commit of that sequence is answered as unknown, never
        // rejected; nothing else runs.
        if matches!(record.phase, Phase::Committing | Phase::CommitUnknown) {
            if self
                .work()
                .is_some_and(|work| work.lane == WorkLane::Client)
            {
                self.respond(error_reply(Code::Internal));
                return Ok(());
            }
            let answer = if kind == "commit" && command.sequence == Some(record.next_sequence) {
                Code::OutcomeUnknown
            } else {
                Code::Unavailable
            };
            if record.phase == Phase::Committing {
                // Successor rule (or the same owner after `Reset`): the outcome is unknown.
                self.release_all();
                self.volatile = None;
                self.set_phase(Phase::CommitUnknown);
                return self.persist_reply(Some(request), error_reply(answer), error_reply(answer));
            }
            self.respond(error_reply(answer));
            return Ok(());
        }
        if let Some(code) = self.busy() {
            self.respond(error_reply(code));
            return Ok(());
        }
        if !same_snapshot {
            self.respond(error_reply(Code::Unavailable));
            return Ok(());
        }
        let active = record.phase == Phase::Active;
        if record.snapshot != self.compiler.snapshot() {
            if !active {
                self.respond(error_reply(Code::Unavailable));
                return Ok(());
            }
            return self.close(
                WorkLane::Client,
                Phase::Failed,
                Some(error_reply(Code::Unavailable)),
            );
        }
        let expired = record.expires_at_ms.is_none_or(|at| self.host.now_ms >= at);
        if active && (expired || self.connection() != Connection::Open) {
            let (reason, phase) = if expired {
                ("expired", Phase::Expired)
            } else {
                ("owner_lost", Phase::Failed)
            };
            self.log_unavailable(reason);
            return self.close(
                WorkLane::Client,
                phase,
                Some(error_reply(Code::Unavailable)),
            );
        }
        let Some(sequence) = command.sequence else {
            self.respond(error_reply(Code::Invalid));
            return Ok(());
        };
        if !active {
            self.respond(error_reply(Code::Unavailable));
            return Ok(());
        }
        if sequence != record.next_sequence {
            return self.close(
                WorkLane::Client,
                Phase::Failed,
                Some(error_reply(Code::Conflict)),
            );
        }
        let deadline = record.expires_at_ms;
        let check = record.binding.clone();
        match kind {
            "statement" => self.statement(&command, &record, sequence, deadline, check),
            "commit" => {
                let resources: Vec<&str> = record
                    .mutations
                    .iter()
                    .map(|mutation| mutation.resource.as_str())
                    .collect();
                let checks = self.compiler.triggered_checks(&resources);
                if !checks.is_empty() {
                    // Commit checks run in the machine from pull request 5. Until then a
                    // triggered check cannot pass, so the commit is rejected before COMMIT.
                    let unavailable = json!({
                        "event": "commit_check_unavailable",
                        "transactionId": self.owner,
                        "requestId": request,
                        "checks": checks,
                    });
                    self.log(&unavailable);
                    return self.close(
                        WorkLane::Client,
                        Phase::Failed,
                        Some(error_reply(Code::CheckRejected)),
                    );
                }
                let digest = digest_of(&command).ok_or(Fault("commit_digest"))?;
                self.wait(
                    WorkLane::Client,
                    Some(request),
                    Task::CommitBinding { sequence, digest },
                    |id| Effect::CheckBinding {
                        id,
                        binding: check,
                        deadline_ms: deadline,
                    },
                )
            }
            _ => {
                let digest = digest_of(&command).ok_or(Fault("rollback_digest"))?;
                self.wait(
                    WorkLane::Client,
                    Some(request),
                    Task::RollbackBinding { sequence, digest },
                    |id| Effect::CheckBinding {
                        id,
                        binding: check,
                        deadline_ms: deadline,
                    },
                )
            }
        }
    }

    fn statement(
        &mut self,
        command: &Command<'_>,
        record: &Record,
        sequence: u64,
        deadline: Option<u64>,
        check: Binding,
    ) -> Result<()> {
        let request = self.request_id();
        if u64::from(record.counters.statements) >= self.limits.max_transaction_statements {
            return self.close(
                WorkLane::Client,
                Phase::Failed,
                Some(error_reply(Code::TransactionLimit)),
            );
        }
        let compiled = match self.compile(command) {
            Ok(compiled) => compiled,
            Err(error) => {
                return self.close(
                    WorkLane::Client,
                    Phase::Failed,
                    Some(io::core_error_reply(&error)),
                );
            }
        };
        let handle = compiled.handle;
        self.allocated.push(handle);
        self.volatile_mut().handles.push(handle);
        if record.identity.mode == Mode::Read && !compiled.read_only() {
            return self.close(
                WorkLane::Client,
                Phase::Failed,
                Some(error_reply(Code::ModeViolation)),
            );
        }
        let [summary] = compiled.statements.as_slice() else {
            return self.close(
                WorkLane::Client,
                Phase::Failed,
                Some(error_reply(Code::Internal)),
            );
        };
        // The digest this statement records, from its verified text, before any database work.
        let Some(digest) = digest_of(command) else {
            self.release(handle);
            self.respond(error_reply(Code::Internal));
            return Ok(());
        };
        let task = Task::StatementBinding {
            sequence,
            digest,
            handle,
            operation: summary.operation,
            resource: summary.resource.clone(),
            versions: Versions {
                schema: compiled.schema_version.clone(),
                policy: compiled.policy_version.clone(),
            },
        };
        self.wait(WorkLane::Client, Some(request), task, |id| {
            Effect::CheckBinding {
                id,
                binding: check,
                deadline_ms: deadline,
            }
        })
    }

    /// Compiles a statement command's envelope, built from the raw members of its verified
    /// text, so every number keeps its exact spelling (#70).
    fn compile(&self, command: &Command<'_>) -> std::result::Result<super::Compiled, CoreError> {
        let internal =
            || CoreError::new("POLICYSQL_INTERNAL", "The request could not be completed.");
        let (Some(sql), Some(params)) = (command.members.get("sql"), command.members.get("params"))
        else {
            return Err(internal());
        };
        let envelope = serde_json::to_string(&Envelope {
            statements: [EnvelopeStatement {
                sql,
                params,
                expect: command.members.get("expect").map(AsRef::as_ref),
            }],
        })
        .map_err(|_| internal())?;
        self.compiler
            .compile(&canonical::to_canonical(&command.auth), &envelope)
    }

    /// Whether a statement may repeat `last`, judged by compiling it (released at once): a
    /// compile that rejects it for a reason of its own proves it is not `last` without hashing
    /// it; a state-dependent failure is inconclusive.
    fn may_repeat(&self, command: &Command<'_>) -> bool {
        match self.compile(command) {
            Ok(compiled) => {
                self.compiler.release(compiled.handle);
                true
            }
            Err(error) => matches!(
                error.code.as_str(),
                "POLICYSQL_DATABASE_UNAVAILABLE" | "POLICYSQL_INTERNAL"
            ),
        }
    }
}

// ---- pure helpers ---------------------------------------------------------------------------

/// The `handles` of a volatile text that is otherwise invalid, when it is still JSON of this
/// owner: what `Abandon` would release.
fn readable_handles(text: &str, owner: &str) -> Vec<u64> {
    if text.len() > MAX_VOLATILE_BYTES {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    if value.get("owner").and_then(Value::as_str) != Some(owner) {
        return Vec::new();
    }
    value
        .get("handles")
        .and_then(Value::as_array)
        .map(|handles| handles.iter().filter_map(Value::as_u64).take(64).collect())
        .unwrap_or_default()
}

/// The members of an object with exactly the `required` keys plus any of `optional`.
fn exact_object<'v>(
    value: &'v Value,
    required: &[&str],
    optional: &[&str],
) -> Option<&'v serde_json::Map<String, Value>> {
    let object = value.as_object()?;
    let allowed = |key: &str| required.contains(&key) || optional.contains(&key);
    (object.keys().all(|key| allowed(key)) && required.iter().all(|key| object.contains_key(*key)))
        .then_some(object)
}

fn parse_binding(value: &Value) -> Option<Binding> {
    let binding: Binding = serde_json::from_value(value.clone()).ok()?;
    binding.is_valid().then_some(binding)
}

/// A `serde_json` value as core's canonical JSON value.
fn to_json(value: &Value) -> Option<Json> {
    canonical::parse(&serde_json::to_string(value).ok()?).ok()
}

/// A sequence: an integer value from 1 to 2^53 − 1, whatever its spelling (`1`, `1.0`).
fn sequence_value(text: &str) -> Option<u64> {
    let Json::Number(number) = canonical::parse(text).ok()? else {
        return None;
    };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let value = number.as_u64().or_else(|| {
        number
            .as_f64()
            .filter(|value| {
                value.fract() == 0.0 && *value >= 1.0 && *value <= 9_007_199_254_740_991.0
            })
            .map(|value| value as u64)
    })?;
    (1..=MAX_SAFE_INTEGER).contains(&value).then_some(value)
}

/// The digest of a command from its verified text.
fn digest_of(command: &Command<'_>) -> Option<String> {
    let parsed = canonical::parse(command.text).ok()?;
    Some(identity::command_digest(command.kind, parsed))
}

/// `{ sql, args }` with the client and server parameter namespaces merged; a collision is an
/// invariant violation.
fn driver_call(sql: &str, statement: &super::DriverStatement) -> Result<DriverCall> {
    let mut args = statement.client_parameters.clone();
    for (name, value) in &statement.server_parameters {
        if args.insert(name.clone(), value.clone()).is_some() {
            return Err(Fault("parameter_namespace"));
        }
    }
    Ok(DriverCall {
        sql: sql.to_owned(),
        args,
    })
}

/// A codec marker in the raw rows: the engine could not represent a driver value.
fn codec_failure(result: &DriverResult) -> Option<Code> {
    let mut code = None;
    for value in result.rows.iter().flatten() {
        if let Some(object) = value.as_object() {
            match object.get("type").and_then(Value::as_str) {
                Some("blob") => {}
                Some("invalid") if object.get("limit") == Some(&Value::Bool(true)) => {
                    return Some(Code::LimitExceeded);
                }
                _ => code = Some(Code::SchemaMismatch),
            }
        }
    }
    code
}

fn round_ms(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn usage_json(usage: Usage) -> Value {
    json!({
        "rowsRead": usage.rows_read,
        "rowsWritten": usage.rows_written,
        "queryDurationMs": usage.query_duration_ms,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicState<'a> {
    transaction_id: &'a str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    meta: RequestMeta<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestMeta<'a> {
    request_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalMeta<'a> {
    request_id: &'a str,
    commit_checks: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResponse<'a> {
    transaction_id: &'a str,
    status: &'a str,
    meta: TerminalMeta<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatementResponse<'a> {
    transaction_id: &'a str,
    status: &'static str,
    next_sequence: u64,
    result: &'a RawValue,
    meta: RequestMeta<'a>,
}

/// The begin reply (`publicState`): status, and the next sequence and expiry while active.
fn public_state(record: &Record, request_id: &str) -> Box<RawValue> {
    let active = record.phase == Phase::Active;
    io::to_raw(&PublicState {
        transaction_id: &record.owner,
        status: record.phase.as_str(),
        next_sequence: active.then_some(record.next_sequence),
        expires_at: record
            .expires_at_ms
            .filter(|_| active)
            .map(super::time::iso_from_ms),
        meta: RequestMeta { request_id },
    })
}

fn terminal_response(transaction_id: &str, status: &str, request_id: &str) -> Box<RawValue> {
    io::to_raw(&TerminalResponse {
        transaction_id,
        status,
        meta: TerminalMeta {
            request_id,
            commit_checks: "not_triggered",
        },
    })
}

fn statement_response(
    transaction_id: &str,
    sequence: u64,
    result: &RawValue,
    request_id: &str,
) -> Box<RawValue> {
    io::to_raw(&StatementResponse {
        transaction_id,
        status: "active",
        next_sequence: sequence + 1,
        result,
        meta: RequestMeta { request_id },
    })
}

/// One result row as an object in column order.
struct Row<'a> {
    columns: &'a [String],
    values: &'a [Value],
}

impl Serialize for Row<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.columns.len()))?;
        for (column, value) in self.columns.iter().zip(self.values) {
            map.serialize_entry(column, value)?;
        }
        map.end()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MutationMeta {
    affected_rows: u64,
    returning: bool,
    operation_check: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Redaction<'a> {
    row: usize,
    column: &'a str,
    code: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultShape<'a> {
    columns: &'a [Box<RawValue>],
    redactions: Vec<Redaction<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultMeta<'a> {
    operation: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    mutation: Option<MutationMeta>,
    result: ResultShape<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatementResult<'a> {
    sequence: u64,
    columns: &'a [String],
    rows: Vec<Row<'a>>,
    row_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    affected_rows: Option<u64>,
    meta: ResultMeta<'a>,
}

/// The public result of one statement (`turso.ts` `validateDriverResults`), with its sequence.
fn shape_result(
    sequence: u64,
    operation: Operation,
    validated: &Validated,
) -> Result<Box<RawValue>> {
    let columns = validated.columns.as_slice();
    let rows = validated
        .rows
        .iter()
        .map(|values| Row { columns, values })
        .collect();
    let mut redactions = Vec::new();
    for (row, flags) in validated.redactions.iter().enumerate() {
        for (index, redacted) in flags.iter().enumerate() {
            if *redacted {
                let column = columns.get(index).ok_or(Fault("redaction_column"))?;
                redactions.push(Redaction {
                    row,
                    column,
                    code: "POLICY_REDACTED",
                });
            }
        }
    }
    let mutation = (operation != Operation::Select).then_some(MutationMeta {
        affected_rows: validated.affected_rows,
        returning: !validated.result_columns.is_empty(),
        operation_check: if validated.operation_check {
            "passed"
        } else {
            "not_configured"
        },
    });
    let text = serde_json::to_string(&StatementResult {
        sequence,
        columns,
        rows,
        row_count: validated.rows.len(),
        affected_rows: (operation != Operation::Select).then_some(validated.affected_rows),
        meta: ResultMeta {
            operation: operation.as_str(),
            mutation,
            result: ResultShape {
                columns: &validated.result_columns,
                redactions,
            },
        },
    })
    .map_err(|_| Fault("result_shape"))?;
    RawValue::from_string(text).map_err(|_| Fault("result_shape"))
}
