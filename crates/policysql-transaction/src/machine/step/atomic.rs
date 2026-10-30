//! Atomic execution (ADR 0024 pull request 6) and the engine-side `request` kind of `execute`.
//!
//! An `execute` reaches the machine in the engine as a `request` event (no owner). The step
//! checks the binding, compiles the verified body text (#70), and computes the idempotency
//! identity of a keyed write. An envelope whose mutations could trigger a commit check is
//! forwarded to the owner `tx_<validation hex>` (`Forward`, relayed on `OwnerReplied`); any
//! other runs here with placement `direct`. Both placements run the same rules:
//!
//! 1. `Open` (the owner first checks the binding again, then persists `active` and sets its
//!    timer; the direct placement persists nothing and sets no timer);
//! 2. for a keyed write, the `policysql_idempotency` lookup in the same database transaction:
//!    more than one row is `POLICYSQL_INTERNAL`, a row with another fingerprint
//!    `POLICYSQL_IDEMPOTENCY_CONFLICT`, a row with this fingerprint is replayed (rolled back,
//!    nothing executes), no row executes;
//! 3. `Execute` of the envelope, every result validated against its plan, the strictest
//!    statement limits applied cumulatively (rows, result bytes, elapsed time);
//! 4. on the owner, the commit checks of the statements that changed rows (`checks.rs`), then
//!    the binding again;
//! 5. for a keyed write, the idempotency row (`INSERT`) in the same database transaction;
//! 6. at most one `Commit`; its outcome alone decides the reply.
//!
//! Any failure before `Commit` rolls back and answers the failure's code. After `Commit`, the
//! reply is the committed response on `Committed`, and a code the client cannot take as a
//! rejection (`POLICYSQL_DATABASE_TIMEOUT`, `POLICYSQL_DATABASE_UNAVAILABLE`, or
//! `POLICYSQL_INTERNAL`) on `CommitFailed`. The owner's record only serializes work: it is
//! never read to answer a request, so a keyed retry always starts from the lookup.

use super::super::MAX_TIME_MS;
use super::super::compiler::{Compiler, Operation, RawResult, StatementLimits, Validated};
use super::super::io::{
    self, Class, Code, DriverCall, DriverResult, Effect, Event, ObserveContext, ObservedStatement,
    core_error_reply, error_reply, value_reply,
};
use super::super::state::{
    AtomicIds, AtomicRun, AtomicStatement, AtomicUsage, Binding, CommitChecks, Connection,
    Counters, Durable, Idempotency, Identity, Kind, Mode, Mutation, Phase, Placement, Record, Task,
    Versions, WorkLane,
};
use super::{Fault, Result, Step, codec_failure, driver_call, exact_object, parse_binding};
use super::{round_ms, shape_statement, to_json};
use crate::canonical::{self, Json};
use crate::identity;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The constant idempotency statements (`turso.ts`); every SQL text the engine sends comes
/// from an effect.
pub(super) const LOOKUP_SQL: &str =
    "SELECT fingerprint, response_json FROM policysql_idempotency WHERE key_hash = :key_hash";
pub(super) const INSERT_SQL: &str = "INSERT INTO policysql_idempotency (key_hash, fingerprint, response_json) VALUES (:key_hash, :fingerprint, :response_json)";

/// What an `execute` request carries (`engine.ts`): the canonical session the engine
/// authorized, the binding it validated, the runtime snapshot, the verified body text, the
/// optional key, and whether the deployment records execution traces.
struct ExecuteRequest<'v> {
    auth: Json,
    binding: Binding,
    binding_value: &'v Value,
    snapshot: &'v str,
    body: &'v str,
    key: Option<&'v Value>,
    trace: bool,
}

impl<'v> ExecuteRequest<'v> {
    fn read(operation: &'v Value) -> std::result::Result<Self, Code> {
        let fields = exact_object(
            operation,
            &["kind", "auth", "databaseBinding", "snapshot", "bodyText"],
            &["idempotencyKey", "trace"],
        )
        .ok_or(Code::Invalid)?;
        let (Some("execute"), Some(body), Some(snapshot)) = (
            fields.get("kind").and_then(Value::as_str),
            fields.get("bodyText").and_then(Value::as_str),
            fields.get("snapshot").and_then(Value::as_str),
        ) else {
            return Err(Code::Invalid);
        };
        let trace = match fields.get("trace") {
            None => false,
            Some(Value::Bool(trace)) => *trace,
            Some(_) => return Err(Code::Invalid),
        };
        let auth = fields
            .get("auth")
            .filter(|auth| auth.is_object())
            .and_then(to_json)
            .ok_or(Code::Internal)?;
        let binding_value = fields.get("databaseBinding").ok_or(Code::Invalid)?;
        let binding = parse_binding(binding_value).ok_or(Code::BindingRejected)?;
        if binding.snapshot != snapshot {
            return Err(Code::Stale);
        }
        Ok(Self {
            auth,
            binding,
            binding_value,
            snapshot,
            body,
            key: fields.get("idempotencyKey"),
            trace,
        })
    }
}

/// The owner's atomic input (`OwnerAtomicInput`): the `request` body is the verified text.
struct AtomicInput<'v> {
    auth: Json,
    binding: Binding,
    snapshot: &'v str,
    body: &'v str,
    idempotency: Option<Idempotency>,
}

impl<'v> AtomicInput<'v> {
    fn read(input: &'v Value, owner: &str) -> std::result::Result<Self, Code> {
        let fields = exact_object(
            input,
            &[
                "kind",
                "validationId",
                "auth",
                "request",
                "databaseBinding",
                "snapshot",
            ],
            &["idempotency"],
        )
        .ok_or(Code::Invalid)?;
        let hex = owner.strip_prefix("tx_").ok_or(Code::Internal)?;
        let routed = fields
            .get("validationId")
            .and_then(Value::as_str)
            .and_then(|id| id.strip_prefix("cval_"))
            == Some(hex);
        let (true, Some(body), Some(snapshot)) = (
            routed,
            fields.get("request").and_then(Value::as_str),
            fields.get("snapshot").and_then(Value::as_str),
        ) else {
            return Err(Code::Invalid);
        };
        let idempotency = match fields.get("idempotency") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let parsed: Idempotency =
                    serde_json::from_value(value.clone()).map_err(|_| Code::Invalid)?;
                // A keyed execution runs on the owner its key names.
                if !super::super::state::hex64(&parsed.key_hash)
                    || !super::super::state::hex64(&parsed.fingerprint)
                    || parsed.key_hash.get(..32) != Some(hex)
                {
                    return Err(Code::Invalid);
                }
                Some(parsed)
            }
        };
        let auth = fields
            .get("auth")
            .filter(|auth| auth.is_object())
            .and_then(to_json)
            .ok_or(Code::Invalid)?;
        let binding_value = fields.get("databaseBinding").ok_or(Code::Invalid)?;
        Ok(Self {
            auth,
            binding: parse_binding(binding_value).ok_or(Code::BindingRejected)?,
            snapshot,
            body,
            idempotency,
        })
    }
}

/// A stored terminal record (`response_json`), read strictly: the shape both paths write,
/// with `status` and `commitChecks` optional only for the rows the TypeScript direct path
/// wrote before the switch-over (they are `committed` and `not_triggered`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored<'a> {
    version: Value,
    #[serde(borrow)]
    transaction_id: &'a RawValue,
    #[serde(borrow)]
    results: &'a RawValue,
    #[serde(borrow)]
    usage: &'a RawValue,
    #[serde(borrow)]
    original_request_id: &'a RawValue,
    #[serde(default)]
    status: Option<Value>,
    #[serde(default)]
    commit_checks: Option<Value>,
}

/// The terminal record written as `response_json` (one shape on both placements).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Terminal<'a> {
    version: u8,
    transaction_id: &'a str,
    status: &'static str,
    results: &'a RawValue,
    usage: &'a AtomicUsage,
    original_request_id: &'a str,
    replayed: bool,
    commit_checks: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AtomicMeta<'a> {
    request_id: &'a str,
    policy_version: &'a str,
    schema_version: &'a str,
    role: &'a str,
    commit_checks: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Debug<'a> {
    execution_trace: &'a RawValue,
}

/// The public `execute` response (`engine.ts`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AtomicReply<'a> {
    transaction_id: &'a str,
    status: &'static str,
    results: &'a RawValue,
    meta: AtomicMeta<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    debug: Option<Debug<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TraceParameter {
    name: String,
    source: &'static str,
    value: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TraceStatement<'a> {
    index: usize,
    operation: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    resource: Option<&'a str>,
    input_sql: String,
    executed_sql: &'a str,
    parameters: Vec<TraceParameter>,
}

/// `turso.ts` `executionTrace`: parameter values are always redacted.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Trace<'a> {
    source: &'static str,
    request_id: &'a str,
    disposition: &'static str,
    attempt: u8,
    statements: Vec<TraceStatement<'a>>,
}

/// The `sql` of each body statement, as the trace's `inputSql`.
#[derive(Deserialize)]
struct BodyStatements {
    #[serde(default)]
    statements: Vec<BTreeMap<String, Box<RawValue>>>,
}

/// An approximation of `String.prototype.localeCompare` for parameter names (the ICU root
/// collation `turso.ts` sorts with): punctuation before digits before letters, letters without
/// case first, then lowercase before uppercase, then the code points.
fn collation_key(name: &str) -> (Vec<(u8, char)>, Vec<bool>, String) {
    let primary = name
        .chars()
        .map(|c| {
            let class = if c.is_ascii_digit() {
                1
            } else if c.is_alphabetic() {
                2
            } else {
                0
            };
            (class, c.to_ascii_lowercase())
        })
        .collect();
    let tertiary = name.chars().map(char::is_uppercase).collect();
    (primary, tertiary, name.to_owned())
}

/// The length of `JSON.stringify(rows)` for rows as objects in column order (`turso.ts`
/// `encodedBytes`); numbers as core's canonical form prints them.
fn rows_bytes(validated: &Validated) -> usize {
    let mut total = 2;
    for (index, values) in validated.rows.iter().enumerate() {
        if index > 0 {
            total += 1;
        }
        total += 2;
        for (position, (column, value)) in validated.columns.iter().zip(values).enumerate() {
            if position > 0 {
                total += 1;
            }
            total += canonical::js_string_len(column) + 1 + canonical::js_value_len(value);
        }
    }
    total
}

/// What a commit failure answers for `execute`: never a rejection, because COMMIT was sent.
const fn commit_failure(class: Class) -> Code {
    match class {
        Class::Timeout => Code::DatabaseTimeout,
        Class::Unavailable => Code::DatabaseUnavailable,
        Class::Rejected | Class::NotCommitted | Class::Unknown | Class::Limit => Code::Internal,
    }
}

/// What a failed atomic `Execute` answers. A limit on the envelope's own results is the
/// client's `POLICYSQL_LIMIT_EXCEEDED`; on the idempotency lookup or insert it is
/// `POLICYSQL_INTERNAL`: the outcome of a keyed request that may have committed could not be
/// read, which is never a rejection.
const fn execute_failure(task: &Task, class: Class) -> Code {
    match (task, class) {
        (Task::AtomicLookup | Task::AtomicInsert, Class::Limit) => Code::Internal,
        _ => Code::for_class(class),
    }
}

fn strictest(statements: &[AtomicStatement], limit: impl Fn(&StatementLimits) -> u64) -> u64 {
    statements
        .iter()
        .map(|statement| limit(&statement.limits))
        .min()
        .unwrap_or(0)
}

impl<C: Compiler> Step<'_, C> {
    fn atomic_run(&self) -> Result<&AtomicRun> {
        self.volatile
            .as_ref()
            .and_then(|volatile| volatile.atomic.as_deref())
            .ok_or(Fault("no_atomic"))
    }

    fn atomic_run_mut(&mut self) -> Result<&mut AtomicRun> {
        self.volatile
            .as_mut()
            .and_then(|volatile| volatile.atomic.as_deref_mut())
            .ok_or(Fault("no_atomic"))
    }

    /// Whether the atomic execution in progress runs on an owner.
    pub(super) fn atomic_on_owner(&self) -> bool {
        self.atomic_run()
            .is_ok_and(|atomic| atomic.placement == Placement::Owner)
    }

    /// Ends work that started no record: release everything and answer.
    fn abort(&mut self, reply: Box<RawValue>) {
        self.release_all();
        if let Some(volatile) = &mut self.volatile {
            volatile.atomic = None;
            volatile.connection = Connection::None;
        }
        self.clear_work();
        self.respond(reply);
    }

    // ---- the request kind -----------------------------------------------------------------

    /// `{"type":"request","operation":{"kind":"execute",...}}` in the engine.
    pub(super) fn request_event(&mut self, operation: &Value) -> Result<()> {
        if self.on_owner() || self.volatile.is_some() {
            // The request kind runs in the engine, one request per state.
            self.respond(error_reply(Code::Internal));
            return Ok(());
        }
        let request = match ExecuteRequest::read(operation) {
            Ok(request) => request,
            Err(code) => {
                self.respond(error_reply(code));
                return Ok(());
            }
        };
        if request.snapshot != self.compiler.snapshot() {
            self.respond(error_reply(Code::Stale));
            return Ok(());
        }
        let binding = request.binding.clone();
        let raw = io::to_raw(operation);
        self.wait(
            WorkLane::Client,
            Some(self.request_id()),
            Task::RequestBinding { operation: raw },
            |id| Effect::CheckBinding {
                id,
                binding,
                deadline_ms: None,
            },
        )
    }

    /// The binding is allowed: compile, identify, and either forward or run here.
    #[allow(clippy::too_many_lines)]
    pub(super) fn request_checked(
        &mut self,
        request_id: Option<String>,
        operation: &RawValue,
    ) -> Result<()> {
        let request_id = request_id.unwrap_or_else(|| self.request_id());
        let operation: Value =
            serde_json::from_str(operation.get()).map_err(|_| Fault("request_operation"))?;
        let request = ExecuteRequest::read(&operation).map_err(|_| Fault("request_operation"))?;
        let auth_text = canonical::to_canonical(&request.auth);
        let compiled = match self.compiler.compile(&auth_text, request.body) {
            Ok(compiled) => compiled,
            Err(error) => {
                self.abort(core_error_reply(&error));
                return Ok(());
            }
        };
        self.allocated.push(compiled.handle);
        self.volatile_mut().handles.push(compiled.handle);
        let write = !compiled.read_only();
        // Idempotency applies to write envelopes only; a read envelope ignores the key.
        let idempotency = if write {
            match Self::request_idempotency(&request) {
                Ok(idempotency) => idempotency,
                Err(reply) => {
                    self.abort(reply);
                    return Ok(());
                }
            }
        } else {
            None
        };
        let mutated: Vec<&str> = compiled
            .statements
            .iter()
            .filter(|statement| statement.operation != Operation::Select)
            .filter_map(|statement| statement.resource.as_deref())
            .collect();
        if write && !self.compiler.triggered_checks(&mutated).is_empty() {
            // A commit check could trigger: the owner of `tx_<validation hex>` runs it.
            self.release(compiled.handle);
            let hex = match &idempotency {
                Some(idempotency) => idempotency.key_hash.get(..32),
                None => self.host.entropy_id(),
            }
            .ok_or(Fault("validation_id"))?
            .to_owned();
            let mut input = json!({
                "kind": "atomic",
                "validationId": format!("cval_{hex}"),
                "auth": serde_json::from_str::<Value>(&auth_text).map_err(|_| Fault("auth"))?,
                "request": request.body,
                "databaseBinding": request.binding_value,
                "snapshot": request.snapshot,
            });
            if let (Some(idempotency), Some(object)) = (&idempotency, input.as_object_mut()) {
                object.insert(
                    "idempotency".to_owned(),
                    json!({"keyHash": idempotency.key_hash, "fingerprint": idempotency.fingerprint}),
                );
            }
            let input = io::to_raw(&input);
            return self.wait(
                WorkLane::Client,
                Some(request_id),
                Task::AtomicForward,
                |id| Effect::Forward {
                    id,
                    owner: format!("tx_{hex}"),
                    lane: "client",
                    input,
                },
            );
        }
        let transaction_id = match &idempotency {
            Some(idempotency) => format!("atomic_{}", &idempotency.key_hash[..24]),
            None => format!("atomic_{request_id}"),
        };
        let debug = request.trace
            && matches!(request.auth.get("access"), Some(Json::Array(access)) if access.contains(&Json::string("debug")));
        let start = AtomicStart {
            placement: Placement::Direct,
            compiled,
            auth: auth_text,
            binding: request.binding.clone(),
            idempotency,
            transaction_id,
            request_id,
            trace: request.trace.then_some(request.body),
            debug,
        };
        self.start_atomic(start)
    }

    /// `identity_json` `request` for `execute`: `None` without a key; a malformed key is the
    /// client's `POLICYSQL_IDEMPOTENCY_KEY_INVALID`.
    fn request_idempotency(
        request: &ExecuteRequest<'_>,
    ) -> std::result::Result<Option<Idempotency>, Box<RawValue>> {
        let Some(binding) = to_json(request.binding_value) else {
            return Err(error_reply(Code::Internal));
        };
        let mut members = vec![
            ("op".to_owned(), Json::string("request")),
            ("endpoint".to_owned(), Json::string("execute")),
            ("auth".to_owned(), request.auth.clone()),
            ("binding".to_owned(), binding),
            ("body".to_owned(), Json::string(request.body)),
        ];
        if let Some(key) = request.key {
            members.push(("key".to_owned(), to_json(key).unwrap_or(Json::Null)));
        }
        let input = canonical::to_canonical(&Json::Object(members));
        match identity::compute(&input) {
            Ok(output) => {
                #[derive(Deserialize)]
                struct Output {
                    idempotency: Option<Idempotency>,
                }
                serde_json::from_str::<Output>(&output)
                    .map(|output| output.idempotency)
                    .map_err(|_| error_reply(Code::Internal))
            }
            Err(identity::IdentityError::KeyInvalid) => Err(error_reply(Code::KeyInvalid)),
            Err(identity::IdentityError::Internal) => Err(error_reply(Code::Internal)),
        }
    }

    /// The owner's reply to a forwarded `execute`, relayed when it has the reply shape.
    pub(super) fn owner_replied(&mut self, reply: &Value) {
        let shaped = match reply.get("ok") {
            Some(Value::Bool(true)) => exact_object(reply, &["ok", "value"], &[])
                .and_then(|fields| fields.get("value"))
                .filter(|value| value.is_object())
                .map(|value| value_reply(&io::to_raw(value))),
            Some(Value::Bool(false)) => exact_object(reply, &["ok", "error"], &[])
                .and_then(|fields| fields.get("error"))
                .and_then(|error| exact_object(error, &["code", "message", "path"], &[]))
                .filter(|error| {
                    error
                        .get("code")
                        .and_then(Value::as_str)
                        .is_some_and(|code| {
                            code.strip_prefix("POLICYSQL_").is_some_and(|rest| {
                                !rest.is_empty()
                                    && rest.bytes().all(|byte| {
                                        byte.is_ascii_uppercase()
                                            || byte.is_ascii_digit()
                                            || byte == b'_'
                                    })
                            })
                        })
                        && error.get("message").is_some_and(Value::is_string)
                        && error
                            .get("path")
                            .is_some_and(|path| path.is_null() || path.is_string())
                })
                .map(|_| io::to_raw(reply)),
            _ => None,
        };
        self.clear_work();
        if let Some(reply) = shaped {
            self.respond(reply);
        } else {
            let rejected = json!({"event": "owner_reply_rejected", "requestId": self.request});
            self.log(&rejected);
            self.respond(error_reply(Code::Internal));
        }
    }

    // ---- the owner's atomic input --------------------------------------------------------

    /// `{"kind":"atomic",...}` on its owner. Whatever the owner's record says, the request
    /// starts a fresh execution (ADR 0024 "Atomic on the owner").
    pub(super) fn atomic_input(&mut self, input: &Value) -> Result<()> {
        let parsed = match AtomicInput::read(input, self.owner) {
            Ok(parsed) => parsed,
            Err(code) => {
                self.respond(error_reply(code));
                return Ok(());
            }
        };
        if parsed.snapshot != self.compiler.snapshot() {
            self.snapshot_skew("atomic");
            return Ok(());
        }
        if parsed.binding.snapshot != parsed.snapshot {
            self.respond(error_reply(Code::Stale));
            return Ok(());
        }
        // One execution at a time; an owner never holds an interactive transaction and an
        // atomic execution under one name (both names are 128-bit), so either is an engine
        // fault.
        let interactive = matches!(&self.durable, Some(Durable::Live(record)) if record.kind == Kind::Interactive);
        if self.busy().is_some() || interactive || self.connection() != Connection::None {
            self.respond(error_reply(Code::Internal));
            return Ok(());
        }
        let binding = parsed.binding.clone();
        let raw = io::to_raw(input);
        self.wait(
            WorkLane::Client,
            Some(self.request_id()),
            Task::AtomicBinding { input: raw },
            |id| Effect::CheckBinding {
                id,
                binding,
                deadline_ms: None,
            },
        )
    }

    pub(super) fn atomic_input_checked(
        &mut self,
        request_id: Option<String>,
        input: &RawValue,
    ) -> Result<()> {
        let request_id = request_id.unwrap_or_else(|| self.request_id());
        let input: Value = serde_json::from_str(input.get()).map_err(|_| Fault("atomic_input"))?;
        let parsed = AtomicInput::read(&input, self.owner).map_err(|_| Fault("atomic_input"))?;
        let auth_text = canonical::to_canonical(&parsed.auth);
        let compiled = match self.compiler.compile(&auth_text, parsed.body) {
            Ok(compiled) => compiled,
            Err(error) => {
                self.abort(core_error_reply(&error));
                return Ok(());
            }
        };
        self.allocated.push(compiled.handle);
        self.volatile_mut().handles.push(compiled.handle);
        // The owner placement runs write envelopes only (`transaction-owner.ts`).
        if compiled.read_only() {
            self.abort(error_reply(Code::Invalid));
            return Ok(());
        }
        let hex = self.owner.trim_start_matches("tx_");
        let transaction_id = match &parsed.idempotency {
            Some(idempotency) => format!("atomic_{}", &idempotency.key_hash[..24]),
            None => format!("atomic_{hex}"),
        };
        let start = AtomicStart {
            placement: Placement::Owner,
            compiled,
            auth: auth_text,
            binding: parsed.binding.clone(),
            idempotency: parsed.idempotency,
            transaction_id,
            request_id,
            trace: None,
            debug: false,
        };
        self.start_atomic(start)
    }

    // ---- the execution -------------------------------------------------------------------

    fn start_atomic(&mut self, start: AtomicStart<'_>) -> Result<()> {
        let AtomicStart {
            placement,
            compiled,
            auth,
            binding,
            idempotency,
            transaction_id,
            request_id,
            trace,
            debug,
        } = start;
        let statements: Vec<AtomicStatement> = compiled
            .statements
            .iter()
            .map(|statement| AtomicStatement {
                operation: statement.operation,
                resource: statement.resource.clone(),
                limits: statement.limits,
                explain_resource: statement.explain_resource,
            })
            .collect();
        if statements.is_empty() {
            return Err(Fault("atomic_statements"));
        }
        let timeout_ms = strictest(&statements, |limits| limits.timeout_ms);
        let now = self.host.now_ms;
        let deadline_ms = match placement {
            Placement::Direct => now.checked_add(timeout_ms),
            Placement::Owner => now.checked_add(self.limits.transaction_ms),
        }
        .filter(|at| *at <= MAX_TIME_MS)
        .ok_or(Fault("deadline"))?;
        let role = canonical::parse(&auth)
            .ok()
            .and_then(|auth| auth.get("role").and_then(Json::as_text).map(str::to_owned))
            .ok_or(Fault("role"))?;
        let trace = match trace {
            Some(body) => Some(self.trace(compiled.handle, &statements, body, &request_id)?),
            None => None,
        };
        let mode = if compiled.read_only() {
            Mode::Read
        } else {
            Mode::Write
        };
        let atomic = AtomicRun {
            placement,
            transaction_id,
            request_id: request_id.clone(),
            auth,
            role,
            binding: binding.clone(),
            handle: compiled.handle,
            statements,
            versions: Versions {
                schema: compiled.schema_version,
                policy: compiled.policy_version,
            },
            idempotency,
            started_at_ms: now,
            debug,
            trace,
            results: None,
            usage: None,
            mutations: Vec::new(),
            checks_passed: false,
            expires_at_ms: (placement == Placement::Owner).then_some(deadline_ms),
        };
        let volatile = self.volatile_mut();
        volatile.atomic = Some(Box::new(atomic));
        volatile.connection = Connection::Opening;
        self.wait(WorkLane::Client, Some(request_id), Task::AtomicOpen, |id| {
            Effect::Open {
                id,
                binding,
                mode,
                timeout_ms,
                deadline_ms,
            }
        })
    }

    /// The execution trace of the envelope (`turso.ts` `executionTrace`).
    fn trace(
        &self,
        handle: u64,
        statements: &[AtomicStatement],
        body: &str,
        request_id: &str,
    ) -> Result<Box<RawValue>> {
        let driver = self
            .compiler
            .statements(handle)
            .map_err(|_| Fault("plan"))?;
        let inputs: Vec<String> = serde_json::from_str::<BodyStatements>(body)
            .map(|body| {
                body.statements
                    .iter()
                    .map(|statement| {
                        statement
                            .get("sql")
                            .and_then(|sql| serde_json::from_str::<String>(sql.get()).ok())
                            .unwrap_or_default()
                    })
                    .collect()
            })
            .unwrap_or_default();
        let traced = driver
            .iter()
            .zip(statements)
            .enumerate()
            .map(|(index, (driver, statement))| {
                let mut parameters: Vec<TraceParameter> = driver
                    .client_parameters
                    .keys()
                    .map(|name| (name, "client"))
                    .chain(driver.server_parameters.keys().map(|name| (name, "server")))
                    .map(|(name, source)| TraceParameter {
                        name: name.clone(),
                        source,
                        value: "[redacted]",
                    })
                    .collect();
                parameters.sort_by_cached_key(|parameter| collation_key(&parameter.name));
                TraceStatement {
                    index,
                    operation: statement.operation.as_str(),
                    resource: statement.resource.as_deref(),
                    input_sql: inputs.get(index).cloned().unwrap_or_default(),
                    executed_sql: &driver.sql,
                    parameters,
                }
            })
            .collect();
        Ok(io::to_raw(&Trace {
            source: "turso-egress",
            request_id,
            disposition: "executed",
            attempt: 1,
            statements: traced,
        }))
    }

    /// The owner's deadline passed, or its timer fired while a database effect ran: nothing
    /// more runs, no COMMIT is sent.
    fn atomic_expired(&self) -> bool {
        self.atomic_on_owner()
            && (self.rollback_requested()
                || self
                    .record()
                    .and_then(|record| record.expires_at_ms)
                    .is_none_or(|at| self.host.now_ms >= at))
    }

    /// `TimerFired` on an atomic owner whose record is `active` and due (`due`): a commit check
    /// in progress is answered now (as for an interactive commit); a database effect in
    /// progress ends the execution when it returns; `Commit` in flight is never expired; a
    /// record no live execution holds (a lost owner's) becomes `expired`.
    pub(super) fn atomic_timer(&mut self, due: bool) -> Result<()> {
        if !due {
            return Ok(());
        }
        let waits_on_validator =
            matches!(self.work().map(|work| &work.task), Some(Task::Validator(_)))
                || self
                    .volatile
                    .as_ref()
                    .is_some_and(|volatile| volatile.deferred.is_some());
        if waits_on_validator {
            return self.expire_validating();
        }
        match self.work().map(|work| &work.task) {
            None => self.close(WorkLane::Background, Phase::Expired, None),
            Some(
                Task::AtomicPersist
                | Task::AtomicTimer
                | Task::AtomicLookup
                | Task::AtomicExecute
                | Task::AtomicCommitBinding
                | Task::AtomicInsert,
            ) => {
                self.volatile_mut().rollback_requested = true;
                Ok(())
            }
            // A new execution that has no record yet (the due record is an earlier one), COMMIT
            // in flight, a replay's rollback, or a close already decided.
            Some(_) => Ok(()),
        }
    }

    fn expire_atomic(&mut self, lane: WorkLane) -> Result<()> {
        // As `transaction-owner.ts` `checkCurrent` answers a deadline that passed.
        self.close(lane, Phase::Expired, Some(error_reply(Code::Unavailable)))
    }

    /// The outcome of an atomic task's awaited effect.
    #[allow(clippy::too_many_lines)]
    pub(super) fn atomic_outcome(
        &mut self,
        lane: WorkLane,
        request_id: Option<String>,
        task: Task,
        event: &Event,
    ) -> Result<()> {
        let request = request_id.clone().unwrap_or_else(|| self.request_id());
        match (task, event) {
            (Task::RequestBinding { operation }, Event::BindingChecked { allowed: true, .. }) => {
                self.request_checked(request_id, &operation)
            }
            (Task::AtomicBinding { input }, Event::BindingChecked { allowed: true, .. }) => {
                self.atomic_input_checked(request_id, &input)
            }
            (
                Task::RequestBinding { .. } | Task::AtomicBinding { .. },
                Event::BindingChecked { allowed: false, .. },
            ) => {
                self.abort(error_reply(Code::BindingRejected));
                Ok(())
            }
            (
                Task::RequestBinding { .. } | Task::AtomicBinding { .. },
                Event::BindingCheckFailed { class, .. },
            ) => {
                self.abort(error_reply(Code::for_class(*class)));
                Ok(())
            }
            (Task::AtomicForward, Event::OwnerReplied { reply, .. }) => {
                self.owner_replied(reply);
                Ok(())
            }
            (Task::AtomicForward, Event::ForwardFailed { .. }) => {
                self.abort(error_reply(Code::Internal));
                Ok(())
            }
            (Task::AtomicOpen, Event::Opened { .. }) => {
                self.set_connection(Connection::Open);
                if !self.atomic_on_owner() {
                    return self.atomic_query(lane, request);
                }
                let record = self.atomic_record()?;
                self.durable = Some(Durable::Live(Box::new(record)));
                self.wait(lane, Some(request), Task::AtomicPersist, |id| {
                    Effect::Persist { id }
                })
            }
            (Task::AtomicOpen, Event::OpenFailed { class, .. }) => {
                // No record of this execution exists yet; the owner's earlier record stays.
                self.abort(error_reply(Code::for_class(*class)));
                Ok(())
            }
            (Task::AtomicPersist, Event::Persisted { .. }) => {
                let at_ms = self
                    .record()
                    .and_then(|record| record.expires_at_ms)
                    .ok_or(Fault("atomic_record"))?;
                self.wait(lane, Some(request), Task::AtomicTimer, |id| {
                    Effect::SetTimer { id, at_ms }
                })
            }
            (Task::AtomicPersist, Event::PersistFailed { .. })
            | (Task::AtomicTimer, Event::TimerFailed { .. }) => {
                self.close(lane, Phase::Failed, Some(error_reply(Code::Internal)))
            }
            (Task::AtomicTimer, Event::TimerSet { .. }) => self.atomic_query(lane, request),
            (Task::AtomicLookup, Event::Executed { results, .. }) => {
                self.lookup_returned(lane, request, results)
            }
            (Task::AtomicExecute, Event::Executed { results, .. }) => {
                self.atomic_executed(lane, request, results)
            }
            (
                task @ (Task::AtomicLookup | Task::AtomicExecute | Task::AtomicInsert),
                Event::ExecuteFailed { class, .. },
            ) => {
                self.set_connection(Connection::Open);
                if self.atomic_expired() {
                    return self.expire_atomic(lane);
                }
                self.close(
                    lane,
                    Phase::Failed,
                    Some(error_reply(execute_failure(&task, *class))),
                )
            }
            (Task::AtomicCommitBinding, Event::BindingChecked { allowed: true, .. }) => {
                let current = self
                    .record()
                    .is_some_and(|record| record.snapshot == self.compiler.snapshot());
                if !current {
                    return self.close(lane, Phase::Failed, Some(error_reply(Code::Unavailable)));
                }
                self.insert_or_commit(lane, request)
            }
            (Task::AtomicCommitBinding, Event::BindingChecked { allowed: false, .. }) => self
                .close(
                    lane,
                    Phase::Failed,
                    Some(error_reply(Code::BindingRejected)),
                ),
            (Task::AtomicCommitBinding, Event::BindingCheckFailed { class, .. }) => self.close(
                lane,
                Phase::Failed,
                Some(error_reply(Code::for_class(*class))),
            ),
            (Task::AtomicInsert, Event::Executed { .. }) => {
                self.set_connection(Connection::Open);
                self.atomic_commit(lane, request)
            }
            (Task::AtomicCommit, Event::Committed { .. }) => self.atomic_committed(lane, request),
            (Task::AtomicCommit, Event::CommitFailed { class, .. }) => {
                // COMMIT was sent: the reply is never a rejection. The connection is rolled
                // back (harmless if COMMIT applied, as `turso.ts` does) and the owner records
                // `failed`, which no request reads.
                self.set_connection(Connection::Open);
                self.close(
                    lane,
                    Phase::Failed,
                    Some(error_reply(commit_failure(*class))),
                )
            }
            (
                Task::AtomicReplay { reply },
                Event::RolledBack { .. } | Event::RollbackFailed { .. },
            ) => {
                let owner = self.atomic_on_owner();
                if !owner {
                    // As `engine.ts` does, a direct replay is observed too.
                    self.observe_atomic()?;
                }
                self.set_connection(Connection::None);
                self.release_all();
                if let Some(volatile) = &mut self.volatile {
                    volatile.atomic = None;
                }
                if !owner {
                    self.respond(reply);
                    self.clear_work();
                    return Ok(());
                }
                self.set_phase(Phase::Committed);
                self.wait(
                    lane,
                    Some(request),
                    Task::Reply {
                        reply: Some(reply),
                        failure: Some(error_reply(Code::Internal)),
                        logs: Vec::new(),
                        failure_logs: Vec::new(),
                        expire_after: false,
                        restore: None,
                    },
                    |id| Effect::Persist { id },
                )
            }
            _ => Err(Fault("unexpected_atomic_outcome")),
        }
    }

    /// The owner's `active` record of this execution.
    fn atomic_record(&self) -> Result<Record> {
        let atomic = self.atomic_run()?;
        let auth = canonical::parse(&atomic.auth).map_err(|_| Fault("auth"))?;
        let binding_value = serde_json::to_value(&atomic.binding).map_err(|_| Fault("binding"))?;
        let binding_json = to_json(&binding_value).ok_or(Fault("binding"))?;
        let auth_fingerprint =
            identity::auth_fingerprint(&auth, &binding_json).map_err(|_| Fault("identity"))?;
        let replay =
            identity::replay_identity(&auth, &binding_json).map_err(|_| Fault("identity"))?;
        let start_fingerprint = atomic.idempotency.as_ref().map_or_else(
            || identity::sha256_hex(atomic.transaction_id.as_bytes()),
            |idempotency| idempotency.fingerprint.clone(),
        );
        Ok(Record {
            owner: self.owner.to_owned(),
            kind: Kind::Atomic,
            phase: Phase::Active,
            identity: Identity {
                auth_fingerprint,
                replay,
                start_fingerprint,
                mode: Mode::Write,
            },
            binding: atomic.binding.clone(),
            snapshot: atomic.binding.snapshot.clone(),
            expires_at_ms: atomic.expires_at_ms,
            next_sequence: 1,
            last: None,
            counters: Counters::default(),
            mutations: Vec::new(),
            versions: None,
            atomic: Some(AtomicIds {
                transaction_id: atomic.transaction_id.clone(),
                key_hash: atomic
                    .idempotency
                    .as_ref()
                    .map(|idempotency| idempotency.key_hash.clone()),
            }),
        })
    }

    /// The idempotency lookup for a keyed write, else the envelope.
    fn atomic_query(&mut self, lane: WorkLane, request: String) -> Result<()> {
        if self.atomic_expired() {
            return self.expire_atomic(lane);
        }
        let atomic = self.atomic_run()?;
        if let Some(idempotency) = &atomic.idempotency {
            let call = DriverCall {
                sql: LOOKUP_SQL.to_owned(),
                args: BTreeMap::from([(
                    "key_hash".to_owned(),
                    Value::String(idempotency.key_hash.clone()),
                )]),
            };
            return self.wait(lane, Some(request), Task::AtomicLookup, |id| {
                Effect::Execute {
                    id,
                    statements: vec![call],
                    trace: None,
                }
            });
        }
        self.atomic_execute(lane, request)
    }

    fn atomic_execute(&mut self, lane: WorkLane, request: String) -> Result<()> {
        let atomic = self.atomic_run()?;
        let trace = atomic.trace.clone();
        let statements = self
            .compiler
            .statements(atomic.handle)
            .map_err(|_| Fault("plan"))?;
        let mut calls = Vec::with_capacity(statements.len());
        for statement in &statements {
            calls.push(driver_call(&statement.sql, statement)?);
        }
        self.wait(lane, Some(request), Task::AtomicExecute, |id| {
            Effect::Execute {
                id,
                statements: calls,
                trace,
            }
        })
    }

    /// The lookup returned: replay, conflict, or execute.
    fn lookup_returned(
        &mut self,
        lane: WorkLane,
        request: String,
        results: &[DriverResult],
    ) -> Result<()> {
        self.set_connection(Connection::Open);
        if self.atomic_expired() {
            return self.expire_atomic(lane);
        }
        let [result] = results else {
            return self.close(lane, Phase::Failed, Some(error_reply(Code::Internal)));
        };
        match result.rows.as_slice() {
            [] => self.atomic_execute(lane, request),
            [row] => {
                let atomic = self.atomic_run()?;
                let fingerprint = atomic
                    .idempotency
                    .as_ref()
                    .map(|idempotency| idempotency.fingerprint.as_str());
                if row.first().and_then(Value::as_str) != fingerprint {
                    return self.close(
                        lane,
                        Phase::Failed,
                        Some(error_reply(Code::IdempotencyConflict)),
                    );
                }
                let Some(reply) = row
                    .get(1)
                    .and_then(Value::as_str)
                    .and_then(|stored| self.replay(stored, &request))
                else {
                    return self.close(lane, Phase::Failed, Some(error_reply(Code::Internal)));
                };
                // The plan is released with the execution, once the rollback returns.
                self.set_connection(Connection::Closing);
                self.wait(lane, Some(request), Task::AtomicReplay { reply }, |id| {
                    Effect::Rollback { id }
                })
            }
            // More than one row for one key hash: the table is not what PolicySQL created.
            _ => self.close(lane, Phase::Failed, Some(error_reply(Code::Internal))),
        }
    }

    /// The reply of a stored terminal record, or `None` when it is not one.
    fn replay(&self, stored: &str, request: &str) -> Option<Box<RawValue>> {
        let atomic = self.atomic_run().ok()?;
        let stored: Stored<'_> = serde_json::from_str(stored).ok()?;
        let transaction_id: String = serde_json::from_str(stored.transaction_id.get()).ok()?;
        let original: String = serde_json::from_str(stored.original_request_id.get()).ok()?;
        let commit_checks = match &stored.commit_checks {
            None => "not_triggered",
            Some(Value::String(checks)) if checks == "passed" => "passed",
            Some(Value::String(checks)) if checks == "not_triggered" => "not_triggered",
            Some(_) => return None,
        };
        let valid = stored.version.as_u64() == Some(1)
            && stored.results.get().starts_with('[')
            && stored.usage.get().starts_with('{')
            && transaction_id.starts_with("atomic_")
            && stored
                .status
                .as_ref()
                .is_none_or(|status| status.as_str() == Some("committed"));
        if !valid {
            return None;
        }
        let trace = atomic.debug.then(|| {
            io::to_raw(&Trace {
                source: "turso-egress",
                request_id: request,
                disposition: "idempotency_replay",
                attempt: 1,
                statements: Vec::new(),
            })
        });
        Some(value_reply(&io::to_raw(&AtomicReply {
            transaction_id: &transaction_id,
            status: "committed",
            results: stored.results,
            meta: AtomicMeta {
                request_id: &original,
                policy_version: &atomic.versions.policy,
                schema_version: &atomic.versions.schema,
                role: &atomic.role,
                commit_checks,
            },
            debug: trace.as_deref().map(|trace| Debug {
                execution_trace: trace,
            }),
        })))
    }

    /// The envelope returned: validate, apply the cumulative limits, then run the commit
    /// checks (owner) or go on to the idempotency row and COMMIT.
    #[allow(clippy::too_many_lines)]
    fn atomic_executed(
        &mut self,
        lane: WorkLane,
        request: String,
        results: &[DriverResult],
    ) -> Result<()> {
        self.set_connection(Connection::Open);
        if self.atomic_expired() {
            return self.expire_atomic(lane);
        }
        let atomic = self.atomic_run()?.clone();
        if results.len() != atomic.statements.len() {
            return self.close(lane, Phase::Failed, Some(error_reply(Code::Internal)));
        }
        let mut validated = Vec::with_capacity(results.len());
        for (index, (result, statement)) in results.iter().zip(&atomic.statements).enumerate() {
            if let Some(code) = codec_failure(result) {
                return self.close(lane, Phase::Failed, Some(error_reply(code)));
            }
            let raw = RawResult {
                columns: result.columns.clone(),
                rows: result.rows.clone(),
                affected_rows: if statement.operation != Operation::Select
                    && !result.columns.is_empty()
                {
                    u64::try_from(result.rows.len()).map_err(|_| Fault("rows"))?
                } else {
                    result.rows_affected
                },
            };
            match self.compiler.validate(atomic.handle, index, raw) {
                Ok(result) => validated.push(result),
                Err(error) => {
                    return self.close(lane, Phase::Failed, Some(core_error_reply(&error)));
                }
            }
        }
        let rows: usize = validated.iter().map(|result| result.rows.len()).sum();
        let bytes: usize = validated.iter().map(rows_bytes).sum();
        let max_rows = strictest(&atomic.statements, |limits| limits.max_rows);
        let max_bytes = strictest(&atomic.statements, |limits| limits.max_result_bytes);
        let max_ms = strictest(&atomic.statements, |limits| limits.timeout_ms);
        if u64::try_from(rows).unwrap_or(u64::MAX) > max_rows
            || u64::try_from(bytes).unwrap_or(u64::MAX) > max_bytes
        {
            return self.close(lane, Phase::Failed, Some(error_reply(Code::LimitExceeded)));
        }
        if self.host.now_ms.saturating_sub(atomic.started_at_ms) > max_ms {
            return self.close(lane, Phase::Failed, Some(error_reply(Code::Timeout)));
        }
        let mut shaped = String::from("[");
        let mut mutations = Vec::new();
        let mut usage = AtomicUsage::default();
        let mut duration = 0.0_f64;
        for (index, ((result, statement), raw)) in validated
            .iter()
            .zip(&atomic.statements)
            .zip(results)
            .enumerate()
        {
            if index > 0 {
                shaped.push(',');
            }
            shaped.push_str(shape_statement(None, statement.operation, result)?.get());
            usage.rows_returned += u64::try_from(result.rows.len()).map_err(|_| Fault("rows"))?;
            if statement.operation != Operation::Select {
                usage.rows_affected = usage.rows_affected.saturating_add(result.affected_rows);
                if result.affected_rows > 0
                    && let Some(resource) = &statement.resource
                {
                    mutations.push(Mutation {
                        index: u32::try_from(index).map_err(|_| Fault("index"))?,
                        operation: statement.operation,
                        resource: resource.clone(),
                    });
                }
            }
            usage.rows_read = usage.rows_read.saturating_add(raw.usage.rows_read);
            usage.rows_written = usage.rows_written.saturating_add(raw.usage.rows_written);
            duration += raw.usage.query_duration_ms;
        }
        shaped.push(']');
        if !duration.is_finite() || duration < 0.0 {
            return self.close(lane, Phase::Failed, Some(error_reply(Code::Internal)));
        }
        usage.query_duration_ms = round_ms(duration);
        let progress = self.atomic_run_mut()?;
        progress.results = Some(io::raw(shaped));
        progress.usage = Some(usage);
        progress.mutations = mutations;
        if progress.placement == Placement::Direct {
            return self.insert_or_commit(lane, request);
        }
        let checks = self.triggered_atomic();
        if checks.is_empty() {
            return self.atomic_commit_binding(lane, request);
        }
        if let Some(missing) = checks
            .iter()
            .find(|check| !self.host.configured_checks.contains(&check.id))
        {
            let unconfigured = json!({
                "event": "commit_check_unconfigured",
                "requestId": request,
                "check": missing.id,
            });
            self.log(&unconfigured);
            return self.close(lane, Phase::Failed, Some(error_reply(Code::CheckRejected)));
        }
        let auth = self.atomic_run()?.auth.clone();
        self.issue(
            lane,
            Some(request),
            CommitChecks {
                sequence: 0,
                digest: String::new(),
                auth,
                checks,
                index: 0,
            },
        )
    }

    /// The checks the executed envelope's changed rows trigger, by ascending id.
    pub(super) fn triggered_atomic(&self) -> Vec<super::super::compiler::TriggeredCheck> {
        let Ok(atomic) = self.atomic_run() else {
            return Vec::new();
        };
        let resources: Vec<&str> = atomic
            .mutations
            .iter()
            .map(|mutation| mutation.resource.as_str())
            .collect();
        self.sorted_checks(&resources)
    }

    /// After the last check allowed (or none triggered), the owner checks the binding again.
    pub(super) fn atomic_commit_binding(&mut self, lane: WorkLane, request: String) -> Result<()> {
        let record = self.record().ok_or(Fault("atomic_record"))?;
        let binding = record.binding.clone();
        let deadline = record.expires_at_ms;
        self.wait(lane, Some(request), Task::AtomicCommitBinding, |id| {
            Effect::CheckBinding {
                id,
                binding,
                deadline_ms: deadline,
            }
        })
    }

    /// The terminal record this execution stores and replays.
    fn terminal_text(&self) -> Result<String> {
        let atomic = self.atomic_run()?;
        let results = atomic.results.as_deref().ok_or(Fault("atomic_results"))?;
        let usage = atomic.usage.as_ref().ok_or(Fault("atomic_usage"))?;
        serde_json::to_string(&Terminal {
            version: 1,
            transaction_id: &atomic.transaction_id,
            status: "committed",
            results,
            usage,
            original_request_id: &atomic.request_id,
            replayed: false,
            commit_checks: if atomic.checks_passed {
                "passed"
            } else {
                "not_triggered"
            },
        })
        .map_err(|_| Fault("terminal"))
    }

    fn insert_or_commit(&mut self, lane: WorkLane, request: String) -> Result<()> {
        if self.atomic_expired() {
            return self.expire_atomic(lane);
        }
        let Some(idempotency) = self.atomic_run()?.idempotency.clone() else {
            return self.atomic_commit(lane, request);
        };
        let call = DriverCall {
            sql: INSERT_SQL.to_owned(),
            args: BTreeMap::from([
                ("key_hash".to_owned(), Value::String(idempotency.key_hash)),
                (
                    "fingerprint".to_owned(),
                    Value::String(idempotency.fingerprint),
                ),
                (
                    "response_json".to_owned(),
                    Value::String(self.terminal_text()?),
                ),
            ]),
        };
        self.wait(lane, Some(request), Task::AtomicInsert, |id| {
            Effect::Execute {
                id,
                statements: vec![call],
                trace: None,
            }
        })
    }

    /// Emits the one `Commit` of this execution, unless the owner's deadline passed.
    fn atomic_commit(&mut self, lane: WorkLane, request: String) -> Result<()> {
        if self.atomic_expired() {
            return self.expire_atomic(lane);
        }
        self.set_connection(Connection::Closing);
        self.wait(lane, Some(request), Task::AtomicCommit, |id| {
            Effect::Commit { id }
        })
    }

    /// The background cost observation of the envelope (`Observe`), while its plan is live.
    fn observe_effect(&self, atomic: &AtomicRun) -> Result<Effect> {
        let driver = self.compiler.statements(atomic.handle).unwrap_or_default();
        let mut calls = Vec::new();
        for (statement, driver) in atomic.statements.iter().zip(&driver) {
            if statement.operation != Operation::Insert {
                calls.push(driver_call(&driver.cost_sql, driver)?);
            }
        }
        Ok(Effect::Observe {
            statements: calls,
            context: ObserveContext {
                request_id: atomic.request_id.clone(),
                binding: atomic.binding.clone(),
                statements: atomic
                    .statements
                    .iter()
                    .map(|statement| ObservedStatement {
                        operation: statement.operation.as_str(),
                        resource: statement.resource.clone(),
                        explain_resource: statement.explain_resource,
                    })
                    .collect(),
            },
        })
    }

    fn observe_atomic(&mut self) -> Result<()> {
        let effect = self.observe_effect(self.atomic_run()?)?;
        self.effects.push(effect);
        Ok(())
    }

    /// COMMIT applied: the reply says so, whatever happens to the owner's record.
    fn atomic_committed(&mut self, lane: WorkLane, request: String) -> Result<()> {
        self.set_connection(Connection::None);
        let atomic = self
            .volatile
            .as_mut()
            .and_then(|volatile| volatile.atomic.take())
            .ok_or(Fault("no_atomic"))?;
        let results = atomic.results.as_deref().ok_or(Fault("atomic_results"))?;
        let reply = value_reply(&io::to_raw(&AtomicReply {
            transaction_id: &atomic.transaction_id,
            status: "committed",
            results,
            meta: AtomicMeta {
                request_id: &atomic.request_id,
                policy_version: &atomic.versions.policy,
                schema_version: &atomic.versions.schema,
                role: &atomic.role,
                commit_checks: if atomic.checks_passed {
                    "passed"
                } else {
                    "not_triggered"
                },
            },
            debug: atomic
                .trace
                .as_deref()
                .filter(|_| atomic.debug)
                .map(|trace| Debug {
                    execution_trace: trace,
                }),
        }));
        // The cost observation of the committed envelope runs after the reply.
        self.effects.push(self.observe_effect(&atomic)?);
        self.release(atomic.handle);
        if atomic.placement == Placement::Direct {
            self.respond(reply);
            self.clear_work();
            return Ok(());
        }
        let unrecorded = json!({
            "event": "transaction_terminal_unrecorded",
            "transactionId": atomic.transaction_id,
            "requestId": request,
        });
        self.set_phase(Phase::Committed);
        self.wait(
            lane,
            Some(request),
            Task::Reply {
                reply: Some(reply.clone()),
                // COMMIT applied: the reply stands when the record is not stored; no request
                // reads that record (a keyed retry resolves through `policysql_idempotency`).
                failure: Some(reply),
                logs: Vec::new(),
                failure_logs: vec![io::to_raw(&unrecorded)],
                expire_after: false,
                restore: None,
            },
            |id| Effect::Persist { id },
        )
    }
}

/// What starts an atomic execution on either placement.
struct AtomicStart<'b> {
    placement: Placement,
    compiled: super::super::Compiled,
    auth: String,
    binding: Binding,
    idempotency: Option<Idempotency>,
    transaction_id: String,
    request_id: String,
    /// The body text, when the deployment records execution traces (direct only).
    trace: Option<&'b str>,
    debug: bool,
}

#[cfg(test)]
mod tests {
    use super::{collation_key, commit_failure};
    use crate::machine::io::{Class, Code};

    #[test]
    fn parameter_names_sort_like_locale_compare() {
        let mut names = vec!["tenant_id", "Name", "name", "a1", "a_b", "ab", "__p0"];
        names.sort_by_cached_key(|name| collation_key(name));
        assert_eq!(
            names,
            ["__p0", "a_b", "a1", "ab", "name", "Name", "tenant_id"]
        );
    }

    #[test]
    fn a_commit_failure_is_never_a_rejection() {
        for class in [
            Class::Timeout,
            Class::Unavailable,
            Class::Rejected,
            Class::NotCommitted,
            Class::Unknown,
            Class::Limit,
        ] {
            assert!(matches!(
                commit_failure(class),
                Code::DatabaseTimeout | Code::DatabaseUnavailable | Code::Internal
            ));
        }
    }
}
