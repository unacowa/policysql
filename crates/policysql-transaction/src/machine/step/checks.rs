//! Commit checks and validator callbacks (ADR 0007; ADR 0024 pull request 5).
//!
//! A commit whose recorded mutations trigger checks checks the binding, persists
//! `validating`, and then, for each check by ascending id, issues a fresh callback capability
//! and emits `CallValidator`. While a validator is awaited, its callback queries run on the
//! callback lane against the same open transaction under the callback session. The verdict
//! revokes the capability; a deny, a malformed decision, or a failed call rejects the commit
//! with `POLICYSQL_COMMIT_CHECK_REJECTED` before any COMMIT. After the last allow, the binding
//! is checked again and the commit continues to `committing`. A callback failure ends the
//! open transaction; an expiry answers the waiting commit at once. Nothing here can emit
//! `Commit`: only the commit path after `CommitBinding { passed: true }` does.

use super::super::compiler::{Compiler, Operation, RawResult, TriggeredCheck, Validated};
use super::super::io::{
    self, CapabilityGrant, Code, Effect, Event, core_error_reply, error_reply, value_reply,
};
use super::super::state::{
    CallbackTask, CallbackWork, Capability, CommitChecks, Connection, Durable, Kind, Pending,
    Phase, Record, Replay, Task, Versions, Volatile, Work, WorkLane,
};
use super::super::{Compiled, MAX_SAFE_INTEGER};
use super::{
    FailureDetail, Fault, Result, ResultShape, Row, Step, codec_failure, driver_call, exact_object,
};
use super::{redactions_of, sequence_value};
use crate::canonical::{self, Json};
use crate::identity;
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Whether a validator's JSON body is exactly a decision (`commit-checks.ts` `exactDecision`)
/// that allows the commit: only `version`, `allowed`, and `error`; `version` is `"1"`;
/// `allowed` is a boolean; `error`, when present, is an object with exactly a string `code`.
pub(super) fn allowed_decision(decision: &Value) -> bool {
    let Some(object) = decision.as_object() else {
        return false;
    };
    if !object
        .keys()
        .all(|key| matches!(key.as_str(), "version" | "allowed" | "error"))
    {
        return false;
    }
    if object.get("version").and_then(Value::as_str) != Some("1") {
        return false;
    }
    if let Some(error) = object.get("error") {
        let exact = error.as_object().is_some_and(|error| {
            error.len() == 1 && error.get("code").is_some_and(Value::is_string)
        });
        if !exact {
            return false;
        }
    }
    object.get("allowed") == Some(&Value::Bool(true))
}

/// base64url without padding (RFC 4648 section 5).
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = chunk.iter().enumerate().fold(0_u32, |acc, (index, byte)| {
            acc | (u32::from(*byte) << (16 - 8 * index))
        });
        for index in 0..=chunk.len() {
            let sextet = (triple >> (18 - 6 * index)) & 0x3f;
            out.push(char::from(ALPHABET[sextet as usize]));
        }
    }
    out
}

/// A presented capability is the 43-character base64url form of 32 bytes.
fn token_syntax(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Constant-time equality of two hashes of equal length.
fn same_hash(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

/// The callback session (`commit-checks.ts`): the commit's session with the check's role,
/// that role appended to `roles` once, and `access: ["execute"]`.
fn callback_session(auth: &Json, role: &str) -> Option<Json> {
    let Json::Object(members) = auth else {
        return None;
    };
    let mut roles: Vec<Json> = match auth.get("roles") {
        Some(Json::Array(roles)) => roles.clone(),
        None => Vec::new(),
        Some(_) => return None,
    };
    let role_value = Json::string(role);
    if !roles.contains(&role_value) {
        roles.push(role_value.clone());
    }
    let mut session: Vec<(String, Json)> = members
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "role" | "roles" | "access"))
        .cloned()
        .collect();
    session.push(("role".to_owned(), role_value));
    session.push(("roles".to_owned(), Json::Array(roles)));
    session.push((
        "access".to_owned(),
        Json::Array(vec![Json::string("execute")]),
    ));
    Some(Json::Object(session))
}

#[derive(Serialize)]
struct HookStatement<'a> {
    index: usize,
    #[serde(rename = "type")]
    operation: &'static str,
    resource: &'a str,
}

/// The hook body without `query` (`commit-checks.ts` `runCommitChecks`), in its wire order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HookPayload<'a> {
    version: &'static str,
    validation_id: &'a str,
    check: &'a str,
    request_id: &'a str,
    policy_version: &'a str,
    schema_version: &'a str,
    role: &'a str,
    session: &'a RawValue,
    statements: Vec<HookStatement<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CallbackMeta<'a> {
    operation: &'static str,
    result: ResultShape<'a>,
    request_id: &'a str,
    policy_version: &'a str,
    schema_version: &'a str,
    role: &'a str,
}

/// A callback query's reply (`transaction-owner.ts` `validationQuery`): the statement result
/// with its sequence, and the request id, versions, and callback role in `meta`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CallbackResponse<'a> {
    sequence: u64,
    columns: &'a [String],
    rows: Vec<Row<'a>>,
    row_count: usize,
    meta: CallbackMeta<'a>,
}

fn callback_response(
    sequence: u64,
    validated: &Validated,
    request_id: &str,
    versions: &Versions,
    role: &str,
) -> Result<Box<RawValue>> {
    let columns = validated.columns.as_slice();
    let text = serde_json::to_string(&CallbackResponse {
        sequence,
        columns,
        rows: validated
            .rows
            .iter()
            .map(|values| Row { columns, values })
            .collect(),
        row_count: validated.rows.len(),
        meta: CallbackMeta {
            operation: Operation::Select.as_str(),
            result: ResultShape {
                columns: &validated.result_columns,
                redactions: redactions_of(validated)?,
            },
            request_id,
            policy_version: &versions.policy,
            schema_version: &versions.schema,
            role,
        },
    })
    .map_err(|_| Fault("callback_shape"))?;
    RawValue::from_string(text).map_err(|_| Fault("callback_shape"))
}

/// What a callback query's `Execute` carried.
struct Executed<'a> {
    request: &'a str,
    sequence: u64,
    digest: String,
    handle: u64,
    versions: &'a Versions,
}

impl<C: Compiler> Step<'_, C> {
    /// The checks the record's mutations trigger, from the runtime's policy.
    pub(super) fn triggered(&self, record: &Record) -> Vec<TriggeredCheck> {
        let resources: Vec<&str> = record
            .mutations
            .iter()
            .map(|mutation| mutation.resource.as_str())
            .collect();
        self.sorted_checks(&resources)
    }

    /// The checks changed rows in `resources` trigger, by ascending id, each once.
    pub(super) fn sorted_checks(&self, resources: &[&str]) -> Vec<TriggeredCheck> {
        if resources.is_empty() {
            return Vec::new();
        }
        // Ascending id order, each id once, is the machine's guarantee (ADR 0007), not only
        // the compiler's.
        let mut checks = self.compiler.triggered_checks(resources);
        checks.sort_by(|left, right| left.id.cmp(&right.id));
        checks.dedup_by(|left, right| left.id == right.id);
        checks
    }

    /// After the commit's binding check: every triggered check must be configured, then the
    /// record says `validating` before the first capability exists.
    pub(super) fn start_checks(
        &mut self,
        lane: WorkLane,
        request_id: Option<String>,
        sequence: u64,
        digest: String,
        auth: String,
    ) -> Result<()> {
        let request = request_id.unwrap_or_else(|| self.request_id());
        let record = self.record().ok_or(Fault("checks_record"))?;
        let checks = self.triggered(record);
        if checks.is_empty() || record.versions.is_none() {
            return Err(Fault("checks_trigger"));
        }
        // Every endpoint is resolved before any capability or validator call (ADR 0021).
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
        self.set_phase(Phase::Validating);
        let checks = CommitChecks {
            sequence,
            digest,
            auth,
            checks,
            index: 0,
        };
        self.wait(lane, Some(request), Task::ValidatingPersist(checks), |id| {
            Effect::Persist { id }
        })
    }

    /// `validating` is stored: call the first validator, unless the deadline passed meanwhile.
    pub(super) fn validating_persisted(
        &mut self,
        lane: WorkLane,
        request_id: Option<String>,
        checks: CommitChecks,
    ) -> Result<()> {
        let expired = self
            .record()
            .and_then(|record| record.expires_at_ms)
            .is_none_or(|at| self.host.now_ms >= at);
        if expired || self.rollback_requested() {
            return self.close(lane, Phase::Expired, Some(error_reply(Code::CheckRejected)));
        }
        self.issue(lane, request_id, checks)
    }

    /// Issues the capability of `checks[index]` and calls its validator: a token from this
    /// step's entropy (only its hash is kept), expiring at `min(now + timeout, deadline)`.
    #[allow(clippy::too_many_lines)]
    pub(super) fn issue(
        &mut self,
        lane: WorkLane,
        request_id: Option<String>,
        checks: CommitChecks,
    ) -> Result<()> {
        let request = request_id.unwrap_or_else(|| self.request_id());
        let check = checks
            .checks
            .get(checks.index)
            .cloned()
            .ok_or(Fault("check_index"))?;
        let record = self.record().ok_or(Fault("checks_record"))?;
        let deadline = record.expires_at_ms.ok_or(Fault("checks_deadline"))?;
        let atomic = self
            .volatile
            .as_ref()
            .and_then(|volatile| volatile.atomic.as_deref());
        // An interactive commit lists its recorded mutations by position (the synthetic
        // `affectedRows: 1` rule); an atomic envelope lists the statements that changed rows
        // by their index in the envelope (`commit-checks.ts` `triggeredCommitChecks`).
        let (versions, statements): (Versions, Vec<(usize, Operation, String)>) =
            match (record.kind, atomic) {
                (Kind::Atomic, Some(atomic)) => (
                    atomic.versions.clone(),
                    atomic
                        .mutations
                        .iter()
                        .map(|mutation| {
                            (
                                mutation.index as usize,
                                mutation.operation,
                                mutation.resource.clone(),
                            )
                        })
                        .collect(),
                ),
                (Kind::Interactive, _) => (
                    record.versions.clone().ok_or(Fault("checks_versions"))?,
                    record
                        .mutations
                        .iter()
                        .enumerate()
                        .map(|(index, mutation)| {
                            (index, mutation.operation, mutation.resource.clone())
                        })
                        .collect(),
                ),
                (Kind::Atomic, None) => return Err(Fault("checks_atomic")),
            };
        let now = self.host.now_ms;
        let expires_at_ms = now.saturating_add(check.timeout_ms).min(deadline);
        if expires_at_ms <= now || self.connection() != Connection::Open {
            return self.close(lane, Phase::Failed, Some(error_reply(Code::CheckRejected)));
        }
        let auth = canonical::parse(&checks.auth).map_err(|_| Fault("checks_auth"))?;
        let role = match &check.role {
            Some(role) => role.clone(),
            None => auth
                .get("role")
                .and_then(Json::as_text)
                .ok_or(Fault("checks_role"))?
                .to_owned(),
        };
        let session = callback_session(&auth, &role).ok_or(Fault("checks_session"))?;
        let session_text = auth
            .get("session")
            .map(canonical::to_canonical)
            .ok_or(Fault("checks_session"))?;
        let session_raw = io::raw(session_text);
        let token = base64url(&self.host.entropy_bytes().ok_or(Fault("entropy"))?);
        let validation_id = format!("cval_{}", self.owner.trim_start_matches("tx_"));
        let payload = io::to_raw(&HookPayload {
            version: "1",
            validation_id: &validation_id,
            check: &check.id,
            request_id: &request,
            policy_version: &versions.policy,
            schema_version: &versions.schema,
            role: &role,
            session: &session_raw,
            statements: statements
                .iter()
                .map(|(index, operation, resource)| HookStatement {
                    index: *index,
                    operation: operation.as_str(),
                    resource,
                })
                .collect(),
        });
        let volatile = self.volatile_mut();
        volatile.capability = Some(Capability {
            token_hash: identity::sha256_hex(token.as_bytes()),
            expires_at_ms,
            check: check.id.clone(),
            session: canonical::to_canonical(&session),
            role,
            next_sequence: 1,
            last: None,
            rows: 0,
            result_bytes: 0,
        });
        let timeout_ms = expires_at_ms - now;
        self.wait(lane, Some(request), Task::Validator(checks), |id| {
            Effect::CallValidator {
                id,
                check: check.id,
                payload,
                capability: CapabilityGrant {
                    token,
                    expires_at_ms,
                },
                timeout_ms,
            }
        })
    }

    /// Revokes the live capability (at a verdict, an expiry, or any close).
    pub(super) fn revoke(&mut self) {
        if let Some(volatile) = &mut self.volatile {
            volatile.capability = None;
            if matches!(
                volatile.work.as_ref().map(|work| &work.task),
                Some(Task::Validator(_))
            ) {
                volatile.revoked_validator = volatile.pending.map(|pending| pending.id);
            }
        }
    }

    /// A validator answered (or failed). The capability is revoked at once; the verdict waits
    /// only for the connection, when a callback query holds it.
    pub(super) fn verdict_arrived(
        &mut self,
        lane: WorkLane,
        request_id: Option<String>,
        checks: CommitChecks,
        allowed: bool,
    ) -> Result<()> {
        if let Some(volatile) = &mut self.volatile {
            volatile.capability = None;
        }
        if self
            .volatile
            .as_ref()
            .is_some_and(Volatile::callback_executing)
        {
            self.volatile_mut().deferred = Some(Work {
                lane,
                request_id,
                task: Task::Verdict { checks, allowed },
            });
            return Ok(());
        }
        self.verdict(lane, request_id, checks, allowed)
    }

    /// A deny rejects the commit; an allow calls the next validator, or, after the last one,
    /// checks the binding again before `committing`.
    fn verdict(
        &mut self,
        lane: WorkLane,
        request_id: Option<String>,
        checks: CommitChecks,
        allowed: bool,
    ) -> Result<()> {
        self.request.clone_from(&request_id);
        if !allowed {
            return self.close(lane, Phase::Failed, Some(error_reply(Code::CheckRejected)));
        }
        if checks.index + 1 < checks.checks.len() {
            let next = CommitChecks {
                index: checks.index + 1,
                ..checks
            };
            return self.issue(lane, request_id, next);
        }
        if let Some(atomic) = self
            .volatile
            .as_mut()
            .and_then(|volatile| volatile.atomic.as_deref_mut())
        {
            atomic.checks_passed = true;
            let request = request_id.unwrap_or_else(|| self.request_id());
            return self.atomic_commit_binding(lane, request);
        }
        let record = self.record().ok_or(Fault("checks_record"))?;
        let binding = record.binding.clone();
        let deadline = record.expires_at_ms;
        self.wait(
            lane,
            request_id,
            Task::CommitBinding {
                sequence: checks.sequence,
                digest: checks.digest,
                auth: None,
                passed: true,
            },
            |id| Effect::CheckBinding {
                id,
                binding,
                deadline_ms: deadline,
            },
        )
    }

    /// `TimerFired` while a commit waits on its validator: answer the commit now, end the
    /// validation, and roll back (after the callback query that holds the connection).
    pub(super) fn expire_validating(&mut self) -> Result<()> {
        let volatile = self.volatile_mut();
        volatile.capability = None;
        let waiting = if let Some(work) = volatile.work.take() {
            volatile.revoked_validator = volatile.pending.take().map(|pending| pending.id);
            work
        } else {
            volatile.deferred.take().ok_or(Fault("expire_validating"))?
        };
        self.request.clone_from(&waiting.request_id);
        self.respond(error_reply(Code::CheckRejected));
        // In memory at once, so the late verdict is ignored and commands are unavailable.
        self.set_phase(Phase::Expired);
        if self
            .volatile
            .as_ref()
            .is_some_and(Volatile::callback_executing)
        {
            self.volatile_mut().rollback_requested = true;
            return Ok(());
        }
        self.close(WorkLane::Background, Phase::Expired, None)
    }

    /// A live capability: `validating`, its validator awaited, the connection open.
    fn capability_live(&self, token_hash: Option<&str>) -> Option<Capability> {
        let volatile = self.volatile.as_ref()?;
        let capability = volatile.capability.as_ref()?;
        // An atomic execution stays `active` while it validates (its record is never read).
        let validating = self.record().is_some_and(|record| {
            record.phase == Phase::Validating
                || (record.kind == Kind::Atomic && record.phase == Phase::Active)
        }) && volatile.connection == Connection::Open
            && matches!(
                volatile.work.as_ref().map(|work| &work.task),
                Some(Task::Validator(_))
            );
        (validating && token_hash.is_none_or(|hash| hash == capability.token_hash))
            .then(|| capability.clone())
    }

    /// A callback query (ADR 0007): `{kind, validationId, capability, command}`, where
    /// `command` is the verified body text (#70).
    #[allow(clippy::too_many_lines)]
    pub(super) fn callback_query(&mut self, input: &Value) -> Result<()> {
        let request = self.request_id();
        let Some(fields) = exact_object(
            input,
            &["kind", "validationId", "capability", "command"],
            &[],
        ) else {
            self.respond_callback(error_reply(Code::Invalid));
            return Ok(());
        };
        let (Some(validation), Some(token), Some(text)) = (
            fields.get("validationId").and_then(Value::as_str),
            fields.get("capability").and_then(Value::as_str),
            fields.get("command").and_then(Value::as_str),
        ) else {
            self.respond_callback(error_reply(Code::Invalid));
            return Ok(());
        };
        let routed = validation
            .strip_prefix("cval_")
            .is_some_and(|hex| self.owner.strip_prefix("tx_") == Some(hex));
        if !routed {
            self.respond_callback(error_reply(Code::Unavailable));
            return Ok(());
        }
        if self
            .volatile
            .as_ref()
            .is_some_and(|volatile| volatile.callback.is_some())
        {
            // The callback lane is serialized: an engine fault.
            self.respond_callback(error_reply(Code::Internal));
            return Ok(());
        }
        // Only a live validation can be called back; anything else changes nothing.
        let Some(capability) = self.capability_live(None) else {
            self.respond_callback(error_reply(Code::Unavailable));
            return Ok(());
        };
        // A validation is running. From here every failure ends the open transaction and
        // rejects the waiting commit (ADR 0007, "Callback rules of the step machine"),
        // including a malformed, wrong, or expired token: a caller that cannot present the live
        // capability is an authentication failure of that validation. Without a live
        // capability (above) nothing changes. Holding the validation id while a validation runs
        // therefore lets a caller end it; the id derives from the transaction id, which only the
        // client and its validator see.
        let now = self.host.now_ms;
        let presented = token_syntax(token)
            && same_hash(
                &identity::sha256_hex(token.as_bytes()),
                &capability.token_hash,
            );
        if !presented || now >= capability.expires_at_ms {
            return self.fail_validation(error_reply(Code::Unavailable));
        }
        let Some((members, sequence)) = parse_callback(text) else {
            return self.fail_validation(error_reply(Code::Unavailable));
        };
        let record = self.record().ok_or(Fault("callback_record"))?;
        let expired = record.expires_at_ms.is_none_or(|at| now >= at);
        if expired || record.snapshot != self.compiler.snapshot() {
            return self.fail_validation(error_reply(Code::Unavailable));
        }
        let binding = record.binding.clone();
        let deadline = record
            .expires_at_ms
            .map(|at| at.min(capability.expires_at_ms));
        // An exact retry of the last callback query replays it.
        if let Some(last) = &capability.last
            && sequence + 1 == capability.next_sequence
            && self.may_repeat_members(&capability.session, &members)
        {
            let Some(digest) = callback_digest(text) else {
                return self.fail_validation(error_reply(Code::Internal));
            };
            if same_hash(&digest, &last.digest) {
                self.respond_callback(value_reply(&last.response));
                return Ok(());
            }
        }
        if sequence != capability.next_sequence || sequence > self.limits.max_transaction_statements
        {
            return self.fail_validation(error_reply(Code::Conflict));
        }
        let compiled: Compiled = match self.compile_members(&capability.session, &members) {
            Ok(compiled) => compiled,
            Err(error) => {
                self.log_core_error(&error);
                return self.fail_validation(core_error_reply(&error));
            }
        };
        let handle = compiled.handle;
        self.allocated.push(handle);
        self.volatile_mut().handles.push(handle);
        if !compiled.read_only() || compiled.statements.len() != 1 {
            self.release(handle);
            return self.fail_validation(error_reply(Code::Conflict));
        }
        let Some(digest) = callback_digest(text) else {
            self.release(handle);
            return self.fail_validation(error_reply(Code::Internal));
        };
        let versions = Versions {
            schema: compiled.schema_version.clone(),
            policy: compiled.policy_version.clone(),
        };
        self.wait_callback(
            request,
            capability.token_hash,
            CallbackTask::Binding {
                sequence,
                digest,
                handle,
                versions,
            },
            |id| Effect::CheckBinding {
                id,
                binding,
                deadline_ms: deadline,
            },
        )
    }

    /// Emits the awaited effect of a callback task and records it as the callback lane's.
    fn wait_callback(
        &mut self,
        request_id: String,
        token_hash: String,
        task: CallbackTask,
        effect: impl FnOnce(u64) -> Effect,
    ) -> Result<()> {
        let volatile = self.volatile_mut();
        let id = volatile.next_effect_id;
        if id >= MAX_SAFE_INTEGER {
            return Err(Fault("effect_ids"));
        }
        volatile.next_effect_id = id + 1;
        volatile.callback = Some(CallbackWork {
            pending: Pending {
                id,
                effect: task.awaits(),
            },
            request_id,
            token_hash,
            task,
        });
        self.effects.push(effect(id));
        Ok(())
    }

    /// A callback failure: answer the query, then end the open transaction and reject the
    /// commit waiting on the validator (`transaction-owner.ts` `callbackQuery`).
    fn fail_validation(&mut self, reply: Box<RawValue>) -> Result<()> {
        self.respond_callback(reply);
        let callback = self.volatile_mut().callback.take();
        if let Some(callback) = callback {
            let (CallbackTask::Binding { handle, .. } | CallbackTask::Execute { handle, .. }) =
                callback.task;
            self.release(handle);
        }
        let volatile = self.volatile_mut();
        volatile.capability = None;
        volatile.revoked_validator = volatile.pending.take().map(|pending| pending.id);
        let waiting = volatile
            .work
            .take()
            .ok_or(Fault("callback_without_commit"))?;
        if !matches!(waiting.task, Task::Validator(_)) {
            return Err(Fault("callback_without_commit"));
        }
        self.request = waiting.request_id;
        self.close(
            WorkLane::Client,
            Phase::Failed,
            Some(error_reply(Code::CheckRejected)),
        )
    }

    /// The outcome of the callback lane's pending effect.
    #[allow(clippy::too_many_lines)]
    pub(super) fn callback_outcome(&mut self, event: &Event) -> Result<()> {
        let callback = self
            .volatile
            .as_mut()
            .and_then(|volatile| volatile.callback.take())
            .ok_or(Fault("no_callback"))?;
        let live = self.capability_live(Some(&callback.token_hash));
        let request = callback.request_id;
        let token_hash = callback.token_hash;
        match (callback.task, event) {
            (
                CallbackTask::Binding {
                    sequence,
                    digest,
                    handle,
                    versions,
                },
                Event::BindingChecked { allowed: true, .. },
            ) => {
                let Some(capability) = live else {
                    // Revoked meanwhile: the verdict or an expiry decided the transaction.
                    self.release(handle);
                    self.respond_callback(error_reply(Code::Unavailable));
                    return self.after_callback();
                };
                let record = self.record().ok_or(Fault("callback_record"))?;
                let now = self.host.now_ms;
                let expired = record.expires_at_ms.is_none_or(|at| now >= at)
                    || now >= capability.expires_at_ms;
                if expired || record.snapshot != self.compiler.snapshot() {
                    self.release(handle);
                    return self.fail_validation(error_reply(Code::Unavailable));
                }
                let statements = self
                    .compiler
                    .statements(handle)
                    .map_err(|_| Fault("plan"))?;
                let mut calls = Vec::with_capacity(statements.len());
                for statement in &statements {
                    calls.push(driver_call(&statement.sql, statement)?);
                }
                self.wait_callback(
                    request,
                    token_hash,
                    CallbackTask::Execute {
                        sequence,
                        digest,
                        handle,
                        versions,
                    },
                    |id| Effect::Execute {
                        id,
                        statements: calls,
                        trace: None,
                    },
                )
            }
            (CallbackTask::Binding { handle, .. }, Event::BindingChecked { .. }) => {
                self.release(handle);
                self.callback_failed(live.is_some(), error_reply(Code::BindingRejected))
            }
            (CallbackTask::Binding { handle, .. }, Event::BindingCheckFailed { class, .. }) => {
                self.release(handle);
                self.callback_failed(live.is_some(), error_reply(Code::for_class(*class)))
            }
            (
                CallbackTask::Execute {
                    handle, versions, ..
                },
                Event::ExecuteFailed {
                    class,
                    statement,
                    database_code,
                    cause,
                    ..
                },
            ) => {
                self.release(handle);
                // A complexity refusal in a callback query is traceable in the log like any other
                // (the validator still receives the code without a path).
                let reply = self.execute_failed_reply(
                    Code::for_class(*class),
                    *class,
                    FailureDetail {
                        statement: *statement,
                        database_code: database_code.as_deref(),
                        cause: cause.as_deref(),
                        versions: Some(versions),
                    },
                );
                self.callback_failed(live.is_some(), reply)
            }
            (CallbackTask::Binding { handle, .. }, Event::ExecuteFailed { .. })
            | (CallbackTask::Execute { handle, .. }, Event::BindingCheckFailed { .. }) => {
                self.release(handle);
                self.callback_failed(live.is_some(), error_reply(Code::Internal))
            }
            (
                CallbackTask::Execute {
                    sequence,
                    digest,
                    handle,
                    versions,
                },
                Event::Executed { results, .. },
            ) => {
                let executed = Executed {
                    request: &request,
                    sequence,
                    digest,
                    handle,
                    versions: &versions,
                };
                self.callback_executed(live, &executed, results)
            }
            _ => Err(Fault("unexpected_callback_outcome")),
        }
    }

    /// A callback query returned rows: validate them against its plan, count them against the
    /// check's limits, record it as the last callback, and answer it.
    fn callback_executed(
        &mut self,
        live: Option<Capability>,
        executed: &Executed<'_>,
        results: &[super::DriverResult],
    ) -> Result<()> {
        let handle = executed.handle;
        let Some(capability) = live else {
            self.release(handle);
            self.respond_callback(error_reply(Code::Unavailable));
            return self.after_callback();
        };
        let [result] = results else {
            self.release(handle);
            return self.fail_validation(error_reply(Code::Internal));
        };
        if let Some(code) = codec_failure(result) {
            self.release(handle);
            return self.fail_validation(error_reply(code));
        }
        let raw = RawResult {
            columns: result.columns.clone(),
            rows: result.rows.clone(),
            affected_rows: result.rows_affected,
        };
        let validated = self.compiler.validate(handle, 0, raw);
        self.release(handle);
        let validated = match validated {
            Ok(validated) => validated,
            Err(error) => {
                self.log_core_error(&error);
                return self.fail_validation(core_error_reply(&error));
            }
        };
        let (request, sequence, versions) =
            (executed.request, executed.sequence, executed.versions);
        let response =
            callback_response(sequence, &validated, request, versions, &capability.role)?;
        let rows = capability
            .rows
            .saturating_add(u64::try_from(validated.rows.len()).map_err(|_| Fault("rows"))?);
        let result_bytes = capability
            .result_bytes
            .saturating_add(u64::try_from(response.get().len()).map_err(|_| Fault("bytes"))?);
        if rows > self.limits.max_callback_rows
            || result_bytes > self.limits.max_transaction_result_bytes
        {
            return self.fail_validation(error_reply(Code::TransactionLimit));
        }
        if let Some(live) = self
            .volatile
            .as_mut()
            .and_then(|volatile| volatile.capability.as_mut())
        {
            live.next_sequence = sequence + 1;
            live.last = Some(Replay {
                digest: executed.digest.clone(),
                response: io::raw(response.get().to_owned()),
            });
            live.rows = rows;
            live.result_bytes = result_bytes;
        }
        self.respond_callback(value_reply(&response));
        Ok(())
    }

    /// A callback effect failed: with its capability live it ends the transaction; after a
    /// revocation it only answers the query.
    fn callback_failed(&mut self, live: bool, reply: Box<RawValue>) -> Result<()> {
        if live {
            return self.fail_validation(reply);
        }
        self.respond_callback(error_reply(Code::Unavailable));
        self.after_callback()
    }

    /// The connection is free again: run the verdict that waited for it, or the rollback of
    /// an expiry that arrived meanwhile.
    fn after_callback(&mut self) -> Result<()> {
        let deferred = self
            .volatile
            .as_mut()
            .and_then(|volatile| volatile.deferred.take());
        if let Some(Work {
            lane,
            request_id,
            task: Task::Verdict { checks, allowed },
        }) = deferred
        {
            return self.verdict(lane, request_id, checks, allowed);
        }
        if deferred.is_some() {
            return Err(Fault("deferred_task"));
        }
        let idle = self.work().is_none() && self.connection() == Connection::Open;
        let ended = self
            .durable
            .as_ref()
            .is_some_and(|durable| durable.phase().is_terminal());
        if self.rollback_requested() && idle && ended {
            let phase = self.durable.as_ref().map_or(Phase::Failed, Durable::phase);
            return self.close(WorkLane::Background, phase, None);
        }
        Ok(())
    }
}

/// A callback command's members from its verified text: exactly `sequence`, `sql` (a string),
/// and `params` (an object), with an integer sequence from 1 to 2^53 − 1.
fn parse_callback(text: &str) -> Option<(BTreeMap<String, Box<RawValue>>, u64)> {
    let members: BTreeMap<String, Box<RawValue>> = serde_json::from_str(text).ok()?;
    let exact = members.len() == 3
        && members
            .get("sql")
            .is_some_and(|sql| sql.get().starts_with('"'))
        && members
            .get("params")
            .is_some_and(|params| params.get().starts_with('{'));
    let sequence = members
        .get("sequence")
        .and_then(|raw| sequence_value(raw.get()))?;
    exact.then_some((members, sequence))
}

/// `sha256(canonical(command))` of the verified text.
fn callback_digest(text: &str) -> Option<String> {
    let parsed = canonical::parse(text).ok()?;
    Some(identity::callback_digest(&parsed))
}

#[cfg(test)]
mod tests {
    use super::{allowed_decision, base64url, token_syntax};
    use serde_json::json;

    #[test]
    fn base64url_matches_rfc_4648() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        let token = base64url(&[7; 32]);
        assert_eq!(token.len(), 43);
        assert!(token_syntax(&token));
        assert!(!token_syntax(&format!("{token}=")));
        assert!(!token_syntax(&token.replace('B', "+")));
    }

    #[test]
    fn only_an_exact_allowing_decision_allows() {
        assert!(allowed_decision(&json!({"version": "1", "allowed": true})));
        assert!(allowed_decision(
            &json!({"version": "1", "allowed": true, "error": {"code": "x"}})
        ));
        for denied in [
            json!({"version": "1", "allowed": false}),
            json!({"version": 1, "allowed": true}),
            json!({"version": "2", "allowed": true}),
            json!({"version": "1", "allowed": "true"}),
            json!({"version": "1", "allowed": true, "extra": 1}),
            json!({"version": "1", "allowed": true, "error": null}),
            json!({"version": "1", "allowed": true, "error": {}}),
            json!({"version": "1", "allowed": true, "error": {"code": 1}}),
            json!({"version": "1", "allowed": true, "error": {"code": "x", "more": 1}}),
            json!([{"version": "1", "allowed": true}]),
            json!(null),
        ] {
            assert!(!allowed_decision(&denied), "{denied}");
        }
    }
}
