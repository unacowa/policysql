//! Test support for the step machine: a fake compiler and a model of the engine that runs
//! effects (ADR 0024 "Effect execution contract") and records a transcript.
#![allow(dead_code, clippy::missing_panics_doc, clippy::too_many_lines)]

use policysql_transaction::machine::{
    Compiled, Compiler, CoreError, DriverStatement, Limits, Operation, RawResult, StatementSummary,
    TriggeredCheck, Validated, step_json,
};
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};

pub const OWNER: &str = "tx_0123456789abcdef0123456789abcdef";
pub const SNAPSHOT: &str = "sqlite-turso-v1:schema_1:policy_1:abi-6";
pub const START: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
pub const T0: u64 = 1_790_000_000_000;

pub const LIMITS: Limits = Limits {
    transaction_ms: 4_000,
    max_transaction_statements: 8,
    max_transaction_result_bytes: 64_000,
    begin_timeout_ms: 1_000,
    max_callback_rows: 100,
    max_statements: 8,
};

#[derive(Clone, Debug)]
struct Plan {
    operation: Operation,
    resource: Option<String>,
    sql: String,
    params: BTreeMap<String, Value>,
    tenant: String,
}

/// Compiles `SELECT`/`INSERT`/`UPDATE`/`DELETE` on one resource. `BAD` SQL is
/// `POLICYSQL_INVALID_SQL`; an envelope `serde_json` rejects (`1e400`) is
/// `POLICYSQL_INVALID_REQUEST`, as the real compile.
#[derive(Clone, Debug, Default)]
pub struct FakeCompiler {
    plans: RefCell<BTreeMap<u64, Plan>>,
    next: Cell<u64>,
    pub snapshot: String,
    /// Resources whose changed rows trigger [`Self::checks`].
    pub triggers: BTreeSet<String>,
    /// The checks a trigger runs (by default `consistency`, as role `auditor`, 1,000 ms).
    pub checks: Vec<TriggeredCheck>,
    pub compiles: Cell<usize>,
}

impl FakeCompiler {
    #[must_use]
    pub fn new() -> Self {
        Self {
            plans: RefCell::default(),
            next: Cell::new(1),
            snapshot: SNAPSHOT.to_owned(),
            // No PR 4 scenario writes `audited`, so their transcripts are unchanged.
            triggers: BTreeSet::from(["audited".to_owned()]),
            checks: vec![TriggeredCheck {
                id: "consistency".to_owned(),
                role: Some("auditor".to_owned()),
                timeout_ms: 1_000,
            }],
            compiles: Cell::new(0),
        }
    }

    #[must_use]
    pub fn live_handles(&self) -> usize {
        self.plans.borrow().len()
    }
}

fn resource_of(sql: &str) -> Option<(Operation, String)> {
    let words: Vec<&str> = sql.split_whitespace().collect();
    let upper: Vec<String> = words.iter().map(|word| word.to_ascii_uppercase()).collect();
    let after = |keyword: &str| {
        upper
            .iter()
            .position(|word| word == keyword)
            .and_then(|index| words.get(index + 1))
            .map(|word| {
                word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                    .to_owned()
            })
    };
    match upper.first().map(String::as_str) {
        Some("SELECT") => after("FROM").map(|resource| (Operation::Select, resource)),
        Some("INSERT") => after("INTO").map(|resource| (Operation::Insert, resource)),
        Some("UPDATE") => after("UPDATE").map(|resource| (Operation::Update, resource)),
        Some("DELETE") => after("FROM").map(|resource| (Operation::Delete, resource)),
        _ => None,
    }
}

impl Compiler for FakeCompiler {
    fn snapshot(&self) -> &str {
        &self.snapshot
    }

    fn compile(&self, auth_json: &str, envelope_json: &str) -> Result<Compiled, CoreError> {
        self.compiles.set(self.compiles.get() + 1);
        let invalid =
            || CoreError::new("POLICYSQL_INVALID_REQUEST", "Request envelope is invalid.");
        let envelope: Value = serde_json::from_str(envelope_json).map_err(|_| invalid())?;
        let auth: Value = serde_json::from_str(auth_json).map_err(|_| invalid())?;
        let statement = envelope["statements"].get(0).ok_or_else(invalid)?;
        let sql = statement["sql"].as_str().ok_or_else(invalid)?;
        let params = statement["params"].as_object().ok_or_else(invalid)?;
        let Some((operation, resource)) = resource_of(sql) else {
            return Err(CoreError {
                code: "POLICYSQL_INVALID_SQL".to_owned(),
                message: "The SQL statement cannot be parsed.".to_owned(),
                path: Some("/statements/0".to_owned()),
            });
        };
        if params.values().any(|value| matches!(value, Value::Number(number) if number.as_i64().is_none() && number.as_f64().is_none_or(|f| !f.is_finite()))) {
            return Err(invalid());
        }
        let mut plans = self.plans.borrow_mut();
        if plans.len() >= 64 {
            return Err(CoreError::new(
                "POLICYSQL_DATABASE_UNAVAILABLE",
                "The database adapter is temporarily unavailable.",
            ));
        }
        let handle = self.next.get();
        self.next.set(handle + 1);
        plans.insert(
            handle,
            Plan {
                operation,
                resource: Some(resource.clone()),
                sql: sql.to_owned(),
                params: params.clone().into_iter().collect(),
                tenant: auth["session"]["tenant_id"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            },
        );
        Ok(Compiled {
            handle,
            statements: vec![StatementSummary {
                operation,
                resource: Some(resource),
            }],
            schema_version: "schema_1".to_owned(),
            policy_version: "policy_1".to_owned(),
        })
    }

    fn statements(&self, handle: u64) -> Result<Vec<DriverStatement>, CoreError> {
        let plans = self.plans.borrow();
        let plan = plans.get(&handle).ok_or_else(|| {
            CoreError::new("POLICYSQL_INTERNAL", "The request could not be completed.")
        })?;
        Ok(vec![DriverStatement {
            sql: format!("{} /* protected */", plan.sql),
            client_parameters: plan.params.clone(),
            server_parameters: BTreeMap::from([(
                "session_tenant_id".to_owned(),
                Value::String(plan.tenant.clone()),
            )]),
            cost_sql: format!("EXPLAIN QUERY PLAN {}", plan.sql),
        }])
    }

    fn validate(&self, handle: u64, index: usize, raw: RawResult) -> Result<Validated, CoreError> {
        let mismatch = || CoreError {
            code: "POLICYSQL_SCHEMA_MISMATCH".to_owned(),
            message: "The database result does not match the compiled logical contract.".to_owned(),
            path: Some(format!("/statements/{index}")),
        };
        if !self.plans.borrow().contains_key(&handle) || index != 0 {
            return Err(mismatch());
        }
        if raw
            .rows
            .iter()
            .any(|row| row.len() != raw.columns.len() || row.iter().any(Value::is_object))
        {
            return Err(mismatch());
        }
        let result_columns = raw
            .columns
            .iter()
            .map(|name| {
                serde_json::value::to_raw_value(&json!({
                    "name": name, "type": "string", "representation": "string", "nullable": false,
                }))
                .map_err(|_| mismatch())
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Validated {
            redactions: raw.rows.iter().map(|row| vec![false; row.len()]).collect(),
            columns: raw.columns,
            rows: raw.rows,
            affected_rows: raw.affected_rows,
            result_columns,
            operation_check: false,
        })
    }

    fn release(&self, handle: u64) {
        self.plans.borrow_mut().remove(&handle);
    }

    fn triggered_checks(&self, resources: &[&str]) -> Vec<TriggeredCheck> {
        if resources
            .iter()
            .any(|resource| self.triggers.contains(*resource))
        {
            self.checks.clone()
        } else {
            Vec::new()
        }
    }
}

pub fn auth(subject: &str) -> Value {
    json!({
        "principal": "https://issuer.test:user", "subject": subject, "role": "member",
        "roles": ["member"], "access": ["execute"], "session": { "tenant_id": "tenant_a" },
    })
}

pub fn binding(snapshot: &str) -> Value {
    json!({ "version": 1, "scope": "tenant", "databaseId": "db_a", "generation": "1", "snapshot": snapshot })
}

pub fn begin(mode: &str) -> Value {
    json!({ "type": "forwarded", "input": {
        "kind": "begin", "transactionId": OWNER, "startFingerprint": START, "mode": mode,
        "auth": auth("user_1"), "databaseBinding": binding(SNAPSHOT), "snapshot": SNAPSHOT,
    }})
}

/// A command event with the exact body `text`.
pub fn command(kind: &str, text: &str) -> Value {
    command_as(kind, text, &auth("user_1"))
}

pub fn command_as(kind: &str, text: &str, auth: &Value) -> Value {
    json!({ "type": "forwarded", "input": {
        "kind": kind, "transactionId": OWNER, "auth": auth, "command": text,
        "databaseBinding": binding(SNAPSHOT), "snapshot": SNAPSHOT,
    }})
}

pub fn statement_text(sequence: u64, sql: &str) -> String {
    json!({ "sequence": sequence, "sql": sql, "params": {} }).to_string()
}

pub fn sequence_text(sequence: u64) -> String {
    format!(r#"{{"sequence":{sequence}}}"#)
}

/// One recorded step: all four inputs and the output text.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct TranscriptLine {
    /// The owner incarnation (a new isolate, with a fresh compiler, after owner loss).
    pub isolate: u32,
    pub durable: Option<String>,
    pub volatile: Option<String>,
    pub event: String,
    pub host: String,
    pub output: String,
}

/// What the engine model saw, for the properties.
#[derive(Clone, Debug, Default)]
pub struct Observed {
    pub commits_emitted: usize,
    pub committed_fed: bool,
    pub not_committed_fed: bool,
    pub persist_committing_emitted: bool,
    /// Phases the store held, in order.
    pub stored_phases: Vec<String>,
    /// Every client reply with the kind of the command it answers (best effort: replies
    /// arrive in order on the client lane).
    pub replies: Vec<(String, Value)>,
    /// Every callback lane reply, in order.
    pub callback_replies: Vec<Value>,
    /// Every `callValidator` effect, in order.
    pub validator_calls: Vec<Value>,
    /// Callback `execute` effects run on the connection.
    pub callback_executes: usize,
}

/// A model of the engine: in-memory state, a store, and the outstanding awaited effect.
#[derive(Debug)]
pub struct Engine {
    pub compiler: FakeCompiler,
    pub limits: Limits,
    pub store: Option<String>,
    pub durable: Option<String>,
    pub volatile: Option<String>,
    pub now: u64,
    pub entropy: u64,
    pub requests: u64,
    pub outstanding: Option<Value>,
    /// The callback lane's outstanding awaited effect.
    pub callback_outstanding: Option<Value>,
    /// `configuredChecks` of the host facts.
    pub configured: Vec<String>,
    /// The durable text a pending `Persist` writes.
    pub persist_text: Option<String>,
    pub transcript: Vec<TranscriptLine>,
    pub observed: Observed,
    /// Client commands awaiting a reply (`kind` or `kind:sequence`), oldest first.
    pub waiting: Vec<String>,
    pub last_effects: Vec<Value>,
    pub isolate: u32,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

pub fn phase_of(text: Option<&str>) -> Option<String> {
    let value: Value = serde_json::from_str(text?).ok()?;
    value["phase"].as_str().map(str::to_owned)
}

impl Engine {
    #[must_use]
    pub fn new() -> Self {
        Self {
            compiler: FakeCompiler::new(),
            limits: LIMITS,
            store: None,
            durable: None,
            volatile: None,
            now: T0,
            entropy: 0,
            requests: 0,
            outstanding: None,
            callback_outstanding: None,
            configured: Vec::new(),
            persist_text: None,
            transcript: Vec::new(),
            observed: Observed::default(),
            waiting: Vec::new(),
            last_effects: Vec::new(),
            isolate: 0,
        }
    }

    fn host(&mut self) -> String {
        self.entropy += 1;
        self.requests += 1;
        json!({
            "nowMs": self.now,
            "entropy": format!("{:064x}", self.entropy.wrapping_mul(0x9e37_79b9_7f4a_7c15)),
            "requestId": format!("req_{}", self.requests),
            "owner": OWNER,
            "configuredChecks": self.configured,
        })
        .to_string()
    }

    /// The id of the callback lane's pending effect in the current volatile state.
    fn callback_pending(&self) -> Option<u64> {
        let volatile: Value = serde_json::from_str(self.volatile.as_deref()?).ok()?;
        volatile["callback"]["pending"]["id"].as_u64()
    }

    /// Feeds one event and runs the immediate effects; an awaited effect stays outstanding.
    pub fn feed(&mut self, event: &Value) -> Value {
        // A callback query, or the outcome of the callback lane's pending effect.
        let callback_lane = event["input"]["kind"] == "callbackQuery"
            || (event["id"].is_u64() && self.callback_pending() == event["id"].as_u64());
        if let Some(kind) = event["input"]["kind"].as_str()
            && kind != "callbackQuery"
        {
            // `kind` or `kind:sequence`, so a reply can be matched to the command it answers.
            let sequence = event["input"]["command"]
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .and_then(|command| command["sequence"].as_u64());
            self.waiting.push(match sequence {
                Some(sequence) => format!("{kind}:{sequence}"),
                None => kind.to_owned(),
            });
        }
        let event_text = event.to_string();
        let host = self.host();
        let output = step_json(
            &self.compiler,
            &self.limits,
            self.durable.as_deref(),
            self.volatile.as_deref(),
            &event_text,
            &host,
        );
        self.transcript.push(TranscriptLine {
            isolate: self.isolate,
            durable: self.durable.clone(),
            volatile: self.volatile.clone(),
            event: event_text,
            host,
            output: output.clone(),
        });
        let parsed: Value = serde_json::from_str(&output).unwrap_or(Value::Null);
        assert!(parsed.get("error").is_none(), "step error: {output}");
        let effects = parsed["effects"].as_array().cloned().unwrap_or_default();
        let awaited = effects.iter().filter(|effect| is_awaited(effect)).count();
        assert!(awaited <= 1, "batch rule: {output}");
        if awaited == 1 {
            assert!(
                effects.last().is_some_and(is_awaited),
                "awaited last: {output}"
            );
        }
        if let Some(text) = parsed["durable"].as_str() {
            assert!(text.len() <= 96 * 1024, "durable bound");
        }
        if let Some(text) = parsed["volatile"].as_str() {
            assert!(text.len() <= 256 * 1024, "volatile bound");
        }
        let reset = effects.iter().any(|effect| effect["type"] == "reset");
        self.durable = parsed["durable"].as_str().map(str::to_owned);
        self.volatile = parsed["volatile"].as_str().map(str::to_owned);
        if callback_lane {
            self.callback_outstanding = None;
        } else {
            self.outstanding = None;
        }
        let callback_pending = self.callback_pending();
        for effect in &effects {
            match effect["type"].as_str() {
                Some("respond") if effect["lane"] == "callback" => {
                    self.observed.callback_replies.push(effect["reply"].clone());
                }
                Some("callValidator") => self.observed.validator_calls.push(effect.clone()),
                Some("execute") if callback_pending == effect["id"].as_u64() => {
                    self.observed.callback_executes += 1;
                }
                Some("respond") => {
                    let kind = if self.waiting.is_empty() {
                        "unknown".to_owned()
                    } else {
                        self.waiting.remove(0)
                    };
                    self.observed.replies.push((kind, effect["reply"].clone()));
                }
                Some("commit") => self.observed.commits_emitted += 1,
                Some("persist") => {
                    if phase_of(self.durable.as_deref()).as_deref() == Some("committing") {
                        self.observed.persist_committing_emitted = true;
                    }
                    self.persist_text.clone_from(&self.durable);
                }
                _ => {}
            }
            if is_awaited(effect) {
                if callback_pending.is_some() && callback_pending == effect["id"].as_u64() {
                    self.callback_outstanding = Some(effect.clone());
                } else {
                    self.outstanding = Some(effect.clone());
                }
            }
        }
        if reset {
            self.durable.clone_from(&self.store);
            self.volatile = None;
            self.outstanding = None;
            self.callback_outstanding = None;
        }
        self.last_effects.clone_from(&effects);
        parsed
    }

    /// Runs the outstanding effect successfully (`ok`) or with a failure, and feeds its outcome.
    /// A validator call succeeds with an allowing decision.
    pub fn resolve(&mut self, ok: bool, class: &str) -> Option<Value> {
        let effect = self.outstanding.take()?;
        self.resolve_effect(&effect, ok, class)
    }

    /// Runs the callback lane's outstanding effect.
    pub fn resolve_callback(&mut self, ok: bool, class: &str) -> Option<Value> {
        let effect = self.callback_outstanding.take()?;
        self.resolve_effect(&effect, ok, class)
    }

    /// Answers the outstanding validator call with `ok` (a 2xx status) and `decision`.
    pub fn decide(&mut self, ok: bool, decision: &Value) -> Option<Value> {
        let effect = self.outstanding.take()?;
        assert_eq!(
            effect["type"], "callValidator",
            "no validator call outstanding"
        );
        let event =
            json!({"type": "validatorReplied", "id": effect["id"], "ok": ok, "decision": decision});
        Some(self.feed(&event))
    }

    /// The capability token of the last validator call.
    #[must_use]
    pub fn token(&self) -> String {
        self.observed
            .validator_calls
            .last()
            .and_then(|call| call["capability"]["token"].as_str())
            .unwrap_or_default()
            .to_owned()
    }

    /// Feeds a callback query with the exact body `text` and `token`.
    pub fn callback(&mut self, token: &str, text: &str) -> Value {
        let validation = format!("cval_{}", &OWNER[3..]);
        self.feed(&json!({"type": "forwarded", "input": {
            "kind": "callbackQuery", "validationId": validation, "capability": token, "command": text,
        }}))
    }

    /// Runs a callback query to completion and returns its reply.
    pub fn run_callback(&mut self, token: &str, text: &str) -> Value {
        let before = self.observed.callback_replies.len();
        self.callback(token, text);
        for _ in 0..8 {
            if self.resolve_callback(true, "unknown").is_none() {
                break;
            }
        }
        self.observed
            .callback_replies
            .get(before)
            .cloned()
            .unwrap_or(Value::Null)
    }

    pub fn resolve_effect(&mut self, effect: &Value, ok: bool, class: &str) -> Option<Value> {
        let id = effect["id"].clone();
        let event = match (effect["type"].as_str(), ok) {
            (Some("open"), true) => json!({"type": "opened", "id": id}),
            (Some("open"), false) => json!({"type": "openFailed", "id": id, "class": class}),
            (Some("checkBinding"), true) => {
                json!({"type": "bindingChecked", "id": id, "allowed": true})
            }
            (Some("checkBinding"), false) => {
                json!({"type": "bindingCheckFailed", "id": id, "class": class})
            }
            (Some("execute"), true) => {
                let sql = effect["statements"][0]["sql"].as_str().unwrap_or("");
                let select = sql.trim_start().to_ascii_uppercase().starts_with("SELECT");
                json!({"type": "executed", "id": id, "results": [{
                    "columns": if select { json!(["id", "name"]) } else { json!([]) },
                    "rows": if select { json!([["p1", "safe"]]) } else { json!([]) },
                    "rowsAffected": i32::from(!select),
                    "usage": {"rowsRead": 1, "rowsWritten": i32::from(!select), "queryDurationMs": 0.5},
                }]})
            }
            (Some("execute"), false) => json!({"type": "executeFailed", "id": id, "class": class}),
            (Some("commit"), true) => {
                self.observed.committed_fed = true;
                json!({"type": "committed", "id": id})
            }
            (Some("commit"), false) => {
                if class == "not_committed" {
                    self.observed.not_committed_fed = true;
                }
                json!({"type": "commitFailed", "id": id, "class": class})
            }
            (Some("rollback"), true) => json!({"type": "rolledBack", "id": id}),
            (Some("rollback"), false) => {
                json!({"type": "rollbackFailed", "id": id, "class": class})
            }
            (Some("setTimer"), true) => json!({"type": "timerSet", "id": id}),
            (Some("setTimer"), false) => json!({"type": "timerFailed", "id": id}),
            (Some("persist"), true) => {
                self.store = self.persist_text.take();
                if let Some(phase) = phase_of(self.store.as_deref()) {
                    self.observed.stored_phases.push(phase);
                }
                json!({"type": "persisted", "id": id})
            }
            (Some("persist"), false) => {
                self.persist_text = None;
                json!({"type": "persistFailed", "id": id})
            }
            (Some("callValidator"), true) => json!({
                "type": "validatorReplied", "id": id, "ok": true,
                "decision": {"version": "1", "allowed": true},
            }),
            (Some("callValidator"), false) => {
                json!({"type": "validatorFailed", "id": id, "class": class})
            }
            _ => return None,
        };
        Some(self.feed(&event))
    }

    /// Resolves every outstanding effect successfully.
    pub fn settle(&mut self) {
        for _ in 0..64 {
            if self.resolve(true, "unknown").is_none()
                && self.resolve_callback(true, "unknown").is_none()
            {
                break;
            }
        }
        assert!(self.outstanding.is_none(), "did not settle");
    }

    /// Owner loss: a successor with the store and a fresh compiler (a new isolate).
    pub fn lose(&mut self) {
        self.durable.clone_from(&self.store);
        self.volatile = None;
        self.outstanding = None;
        self.callback_outstanding = None;
        self.persist_text = None;
        self.compiler = FakeCompiler {
            triggers: self.compiler.triggers.clone(),
            checks: self.compiler.checks.clone(),
            ..FakeCompiler::new()
        };
        self.waiting.clear();
        self.isolate += 1;
    }

    /// The last reply's JSON.
    #[must_use]
    pub fn last_reply(&self) -> Option<&Value> {
        self.observed.replies.last().map(|(_, reply)| reply)
    }

    /// Runs a command to completion and returns its reply.
    pub fn run(&mut self, event: &Value) -> Value {
        let before = self.observed.replies.len();
        self.feed(event);
        self.settle();
        self.observed
            .replies
            .get(before)
            .map_or(Value::Null, |(_, reply)| reply.clone())
    }
}

pub fn is_awaited(effect: &Value) -> bool {
    matches!(
        effect["type"].as_str(),
        Some(
            "open"
                | "checkBinding"
                | "execute"
                | "commit"
                | "rollback"
                | "setTimer"
                | "persist"
                | "callValidator"
        )
    )
}

pub fn code(reply: &Value) -> Option<&str> {
    reply["error"]["code"].as_str()
}

/// Whether a reply is a definite rejection of a commit (the client's `REJECTIONS`), or a
/// value whose status is not `committed`.
pub fn rejects_commit(reply: &Value) -> bool {
    if reply["ok"] == true {
        return reply["value"]["status"] != "committed";
    }
    matches!(
        code(reply),
        Some(
            "POLICYSQL_INVALID_REQUEST"
                | "POLICYSQL_FORBIDDEN_ACCESS"
                | "POLICYSQL_STALE_OPERATION"
                | "POLICYSQL_IDEMPOTENCY_CONFLICT"
                | "POLICYSQL_TRANSACTION_CONFLICT"
                | "POLICYSQL_TRANSACTION_UNAVAILABLE"
                | "POLICYSQL_COMMIT_CHECK_REJECTED"
                | "POLICYSQL_LIMIT_EXCEEDED"
                | "POLICYSQL_TRANSACTION_LIMIT_EXCEEDED"
        )
    )
}
