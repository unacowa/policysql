//! `step_json` with the real compiler (ADR 0024 pull request 4): the statement event carries
//! the verified body text, and compile and the digest use it (#70). Production owners run it.

use serde_json::{Value, json};

const CATALOG: &str = "version: 1
resources:
  counters:
    source: { table: counters }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      big: { type: int64, representation: number, nullable: true }
      ratio: { type: number, nullable: true }
      meta: { type: json, representation: object, storage: text, nullable: true }
";
const POLICY: &str = "version: 1
resources:
  counters:
    roles:
      member:
        select:
          columns: [id, big, ratio]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
        insert:
          columns: [id, big, ratio, meta]
          presets: { tenant_id: { session: tenant_id } }
          check: { tenant_id: { eq: { session: tenant_id } } }
";
const OWNER: &str = "tx_0123456789abcdef0123456789abcdef";
const AUTH: &str = r#"{"principal":"test:user","subject":"u","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_a"}}"#;

fn runtime(limits: &str) -> Option<super::PolicySqlRuntime> {
    super::PolicySqlRuntime::new(CATALOG, POLICY, "schema_1", "policy_1", limits).ok()
}

struct Owner {
    runtime: super::PolicySqlRuntime,
    durable: Option<String>,
    volatile: Option<String>,
    requests: u64,
    configured: Vec<String>,
}

impl Owner {
    fn step(&mut self, event: &Value) -> Value {
        self.requests += 1;
        let host = json!({
            "nowMs": 1_790_000_000_000_u64, "entropy": format!("{:064x}", self.requests),
            "requestId": format!("req_{}", self.requests), "owner": OWNER,
            "configuredChecks": self.configured,
        });
        let output = self.runtime.step_json(
            self.durable.clone(),
            self.volatile.clone(),
            &event.to_string(),
            &host.to_string(),
        );
        let mut parsed: Value = serde_json::from_str(&output).unwrap_or(Value::Null);
        self.durable = parsed["durable"].as_str().map(str::to_owned);
        self.volatile = parsed["volatile"].as_str().map(str::to_owned);
        parsed["raw"] = Value::String(output);
        parsed
    }

    /// Feeds the success outcome of the batch's awaited effect.
    fn succeed(&mut self, output: &Value) -> Value {
        let effect = output["effects"]
            .as_array()
            .and_then(|effects| effects.last().cloned())
            .unwrap_or_default();
        let id = effect["id"].clone();
        let event = match effect["type"].as_str() {
            Some("checkBinding") => json!({"type": "bindingChecked", "id": id, "allowed": true}),
            Some("open") => json!({"type": "opened", "id": id}),
            Some("persist") => json!({"type": "persisted", "id": id}),
            Some("setTimer") => json!({"type": "timerSet", "id": id}),
            Some("commit") => json!({"type": "committed", "id": id}),
            Some("rollback") => json!({"type": "rolledBack", "id": id}),
            Some("execute") => json!({"type": "executed", "id": id, "results": [{
                "columns": [], "rows": [], "rowsAffected": 1,
                "usage": {"rowsRead": 0, "rowsWritten": 1, "queryDurationMs": 1},
            }]}),
            _ => return output.clone(),
        };
        self.step(&event)
    }

    fn statement(&mut self, text: &str) -> Value {
        let auth: Value = serde_json::from_str(AUTH).unwrap_or_default();
        let snapshot = self.runtime.snapshot();
        self.step(&json!({"type": "forwarded", "input": {
            "kind": "statement", "transactionId": OWNER, "auth": auth, "command": text,
            "databaseBinding": binding(&snapshot), "snapshot": snapshot,
        }}))
    }
}

fn binding(snapshot: &str) -> Value {
    json!({"version": 1, "scope": "tenant", "databaseId": "db_a", "generation": "1", "snapshot": snapshot})
}

fn begun() -> Owner {
    let runtime = runtime(
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|| unreachable!("valid runtime"));
    begun_with(runtime)
}

fn begun_with(runtime: super::PolicySqlRuntime) -> Owner {
    let snapshot = runtime.snapshot();
    let auth: Value = serde_json::from_str(AUTH).unwrap_or_default();
    let mut owner = Owner {
        runtime,
        durable: None,
        volatile: None,
        requests: 0,
        configured: vec!["consistency".to_owned()],
    };
    let mut output = owner.step(&json!({"type": "forwarded", "input": {
        "kind": "begin", "transactionId": OWNER, "startFingerprint": "c".repeat(64), "mode": "write",
        "auth": auth, "databaseBinding": binding(&snapshot), "snapshot": snapshot,
    }}));
    for _ in 0..4 {
        output = owner.succeed(&output);
    }
    assert_eq!(
        output["effects"][1]["reply"]["value"]["status"], "active",
        "{output}"
    );
    owner
}

#[test]
fn abi_25_names_the_step_machine_with_the_limit_detail() {
    let owner = begun();
    assert_eq!(owner.runtime.abi_version(), 26);
    assert!(owner.runtime.snapshot().ends_with(":abi-26"));
}

/// Runs a statement of a begun write transaction up to its `execute`, answers that effect with
/// `failed` (an `executeFailed` without its `id`), and returns the reply and every raw log text.
fn failed_statement(failed: &Value) -> (Value, String) {
    let mut owner = begun();
    let mut output = owner.statement(
        r#"{"sequence":1,"sql":"INSERT INTO counters (id) VALUES (:id)","params":{"id":"x"}}"#,
    );
    let mut guard = 0;
    while output["effects"]
        .as_array()
        .and_then(|effects| effects.last())
        .is_some_and(|effect| effect["type"] != "execute")
    {
        output = owner.succeed(&output);
        guard += 1;
        assert!(guard < 8, "an execute is awaited: {output}");
    }
    let id = output["effects"][output["effects"]
        .as_array()
        .map_or(0, |effects| effects.len() - 1)]["id"]
        .clone();
    let mut event = failed.clone();
    event["id"] = id;
    let mut output = owner.step(&event);
    let mut texts = vec![output["raw"].as_str().unwrap_or_default().to_owned()];
    let mut reply = Value::Null;
    for _ in 0..8 {
        if let Some(effect) = output["effects"]
            .as_array()
            .and_then(|effects| effects.iter().find(|effect| effect["type"] == "respond"))
        {
            reply = effect["reply"].clone();
            break;
        }
        output = owner.succeed(&output);
        texts.push(output["raw"].as_str().unwrap_or_default().to_owned());
    }
    (reply, texts.join("\n"))
}

/// #145 at the ABI boundary: the real `step_json` reads an `executeFailed` of class `constraint`
/// and answers 409 `POLICYSQL_CONSTRAINT_VIOLATION` with `error.detail` and the log event.
#[test]
fn a_constraint_class_is_a_conflict_with_detail_and_a_logged_record() {
    let (reply, all) = failed_statement(&json!({
        "type": "executeFailed", "class": "constraint", "statement": 0,
        "constraint": "not_null", "databaseCode": "SQLITE_CONSTRAINT",
    }));
    assert_eq!(
        reply["error"]["code"], "POLICYSQL_CONSTRAINT_VIOLATION",
        "{reply}"
    );
    assert_eq!(reply["error"]["detail"], json!({"constraint": "not_null"}));
    assert_eq!(reply["error"]["path"], "/statements/0");
    assert_eq!(
        reply["error"]["message"],
        "The statement violates a NOT NULL constraint."
    );
    assert!(all.contains("database_constraint_violation"), "{all}");
}

/// #145 pull request E at the ABI boundary: the class `refused` is 500 `POLICYSQL_DATABASE_ERROR`
/// with the fixed message, no path and no detail, logged once with the database's code only.
#[test]
fn a_refused_class_is_a_database_error_without_path_or_detail_and_a_logged_code() {
    let (reply, all) = failed_statement(&json!({
        "type": "executeFailed", "class": "refused", "databaseCode": "SQLITE_UNKNOWN",
    }));
    let error = &reply["error"];
    assert_eq!(error["code"], "POLICYSQL_DATABASE_ERROR", "{reply}");
    assert_eq!(error["message"], "The database refused the statement.");
    assert_eq!(error["path"], Value::Null);
    assert!(error.get("detail").is_none(), "{reply}");
    assert_eq!(
        all.matches("database_error_unclassified").count(),
        1,
        "{all}"
    );
    assert!(all.contains("SQLITE_UNKNOWN"), "{all}");
}

/// #85 path 1 with the real compiler: a keyed execute whose compile fails (here an operation
/// the policy does not grant) is answered 500 `POLICYSQL_OUTCOME_UNKNOWN`, the unknown outcome, with
/// the unkeyed answer's code and path as `detail.cause`, and an unkeyed one keeps the definite
/// compile error. The engine's `request` event reaches the
/// compile after its binding check; nothing is looked up or executed, and no state remains.
#[test]
fn a_keyed_compile_failure_is_the_unknown_outcome_with_the_real_compiler() {
    let runtime = runtime(
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|| unreachable!("valid runtime"));
    let snapshot = runtime.snapshot();
    let auth: Value = serde_json::from_str(AUTH).unwrap_or_default();
    // An operation the policy does not grant, and a resource that does not exist: one answer
    // (#145 pull request D).
    for sql in ["DELETE FROM counters", "SELECT id FROM no_such_table"] {
        let body = json!({"statements": [{"sql": sql, "params": {}}]}).to_string();
        let answer = |key: Option<&str>| {
            let mut volatile = None;
            let mut operation = json!({
                "kind": "execute", "auth": auth.clone(), "databaseBinding": binding(&snapshot),
                "snapshot": snapshot.clone(), "bodyText": body.clone(),
            });
            if let Some(key) = key {
                operation["idempotencyKey"] = json!(key);
            }
            let output = engine_step(
                &runtime,
                &mut volatile,
                &json!({"type": "request", "operation": operation}),
                1,
            );
            assert_eq!(
                output["effects"][0]["type"], "checkBinding",
                "{}",
                output["raw"]
            );
            let id = output["effects"][0]["id"].clone();
            let checked = engine_step(
                &runtime,
                &mut volatile,
                &json!({"type": "bindingChecked", "id": id, "allowed": true}),
                1,
            );
            let reply = checked["effects"]
                .as_array()
                .and_then(|effects| {
                    effects
                        .iter()
                        .find(|effect| effect["type"] == "respond")
                        .cloned()
                })
                .unwrap_or_default();
            (reply, volatile, checked)
        };
        let (keyed, volatile, output) = answer(Some("keyed-compile-failure-0001"));
        assert_eq!(
            keyed["reply"]["error"]["code"], "POLICYSQL_OUTCOME_UNKNOWN",
            "{}",
            output["raw"]
        );
        assert_eq!(
            keyed["reply"]["error"]["message"],
            "This request was not executed. The outcome of an earlier request with the same \
             Idempotency-Key is unknown."
        );
        assert_eq!(keyed["reply"]["error"]["path"], Value::Null);
        assert!(volatile.is_none(), "the failed request leaves no state");
        let (unkeyed, _, output) = answer(None);
        assert_eq!(
            unkeyed["reply"]["error"]["code"], "POLICYSQL_MISSING_POLICY",
            "{}",
            output["raw"]
        );
        assert!(unkeyed["reply"]["error"].get("detail").is_none());
        assert_eq!(
            keyed["reply"]["error"]["detail"],
            json!({"cause": {
                "code": unkeyed["reply"]["error"]["code"],
                "path": unkeyed["reply"]["error"]["path"],
                "detail": null,
            }}),
            "the cause is the unkeyed answer's code and path"
        );
        assert_eq!(
            keyed["reply"]["error"]["detail"]["cause"]["path"], "/statements/0",
            "{}",
            output["raw"]
        );
    }
}

/// #145 pull request F with the real compiler: a compile limit is the same answer, `detail.limit`
/// included, unkeyed (413) and as the cause of a keyed request's unknown outcome.
#[test]
fn a_keyed_compile_limit_carries_the_unkeyed_answers_limit_as_its_cause() {
    let runtime = runtime(
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":1,"max_sql_bytes":1024}"#,
    )
    .unwrap_or_else(|| unreachable!("valid runtime"));
    let snapshot = runtime.snapshot();
    let auth: Value = serde_json::from_str(AUTH).unwrap_or_default();
    let long_sql = format!("SELECT id FROM counters WHERE id = '{}'", "a".repeat(1_100));
    for (statements, code, path, limit) in [
        (
            json!([
                {"sql": "SELECT id FROM counters", "params": {}},
                {"sql": "SELECT id FROM counters", "params": {}},
            ]),
            "POLICYSQL_LIMIT_EXCEEDED",
            Value::Null,
            "maxStatements",
        ),
        (
            json!([{"sql": long_sql, "params": {}}]),
            "POLICYSQL_REQUEST_TOO_LARGE",
            json!("/statements/0/sql"),
            "maxSqlBytes",
        ),
    ] {
        let body = json!({"statements": statements}).to_string();
        let answer = |key: Option<&str>| {
            let mut volatile = None;
            let mut operation = json!({
                "kind": "execute", "auth": auth.clone(), "databaseBinding": binding(&snapshot),
                "snapshot": snapshot.clone(), "bodyText": body.clone(),
            });
            if let Some(key) = key {
                operation["idempotencyKey"] = json!(key);
            }
            let output = engine_step(
                &runtime,
                &mut volatile,
                &json!({"type": "request", "operation": operation}),
                1,
            );
            let id = output["effects"][0]["id"].clone();
            let checked = engine_step(
                &runtime,
                &mut volatile,
                &json!({"type": "bindingChecked", "id": id, "allowed": true}),
                1,
            );
            checked["effects"]
                .as_array()
                .and_then(|effects| {
                    effects
                        .iter()
                        .find(|effect| effect["type"] == "respond")
                        .cloned()
                })
                .unwrap_or_default()
        };
        let unkeyed = answer(None);
        let error = &unkeyed["reply"]["error"];
        assert_eq!(error["code"], code, "{unkeyed}");
        assert_eq!(error["path"], path, "{unkeyed}");
        assert_eq!(error["detail"], json!({"limit": limit}), "{unkeyed}");
        let keyed = answer(Some("keyed-compile-limit-0001"));
        assert_eq!(
            keyed["reply"]["error"]["code"], "POLICYSQL_OUTCOME_UNKNOWN",
            "{keyed}"
        );
        assert_eq!(
            keyed["reply"]["error"]["detail"],
            json!({"cause": {"code": code, "path": path, "detail": {"limit": limit}}}),
            "the cause is the unkeyed answer, limit included"
        );
    }
}

/// ADR 0024 pull request 5 with the real compiler: the policy's check triggers on the
/// insert, the validator gets the hook payload and a capability, and a callback query is
/// compiled under the callback session from its verified text and validated.
#[test]
fn commit_checks_run_with_the_policy_and_the_callback_session() {
    let policy = format!(
        "{POLICY}commit_checks:\n  consistency:\n    triggered_by: [counters]\n    role: member\n    hook:\n      timeout_ms: 700\n"
    );
    let runtime = super::PolicySqlRuntime::new(
        CATALOG,
        &policy,
        "schema_1",
        "policy_1",
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|_| unreachable!("valid runtime"));
    let mut owner = begun_with(runtime);
    let mut output = owner.statement(
        r#"{"sequence":1,"sql":"INSERT INTO counters (id) VALUES (:id)","params":{"id":"x"}}"#,
    );
    output = owner.succeed(&output); // binding checked: Execute
    let id = output["effects"][0]["id"].clone();
    // The insert returns the policy's check column.
    output = owner.step(&json!({"type": "executed", "id": id, "results": [{
        "columns": ["__policysql_check"], "rows": [[1]], "rowsAffected": 1,
        "usage": {"rowsRead": 0, "rowsWritten": 1, "queryDurationMs": 1},
    }]}));
    owner.succeed(&output);
    let auth: Value = serde_json::from_str(AUTH).unwrap_or_default();
    let snapshot = owner.runtime.snapshot();
    output = owner.step(&json!({"type": "forwarded", "input": {
        "kind": "commit", "transactionId": OWNER, "auth": auth, "command": r#"{"sequence":2}"#,
        "databaseBinding": binding(&snapshot), "snapshot": snapshot,
    }}));
    for _ in 0..2 {
        output = owner.succeed(&output);
    }
    let call = output["effects"][0].clone();
    assert_eq!(call["type"], "callValidator", "{output}");
    assert_eq!(call["check"], "consistency");
    assert_eq!(call["timeoutMs"], 700);
    assert_eq!(call["payload"]["role"], "member");
    assert_eq!(
        call["payload"]["statements"],
        json!([{"index": 0, "type": "insert", "resource": "counters"}])
    );
    let token = call["capability"]["token"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let validation = format!("cval_{}", &OWNER[3..]);
    let text = r#"{"sequence":1,"sql":"SELECT id, big FROM counters","params":{}}"#;
    let checked = owner.step(&json!({"type": "forwarded", "input": {
        "kind": "callbackQuery", "validationId": validation, "capability": token, "command": text,
    }}));
    assert_eq!(checked["effects"][0]["type"], "checkBinding", "{checked}");
    let id = checked["effects"][0]["id"].clone();
    let execute = owner.step(&json!({"type": "bindingChecked", "id": id, "allowed": true}));
    let statement = &execute["effects"][0]["statements"][0];
    assert!(
        statement["sql"]
            .as_str()
            .unwrap_or_default()
            .contains("tenant_id"),
        "the callback runs the policy's protected SQL: {execute}"
    );
    let id = execute["effects"][0]["id"].clone();
    let replied = owner.step(&json!({"type": "executed", "id": id, "results": [{
        "columns": ["id", "big"], "rows": [["x", 9_007_199_254_740_991_u64]], "rowsAffected": 0,
        "usage": {"rowsRead": 1, "rowsWritten": 0, "queryDurationMs": 1},
    }]}));
    let reply = &replied["effects"][0];
    assert_eq!(reply["lane"], "callback", "{replied}");
    assert_eq!(reply["reply"]["value"]["rowCount"], 1, "{replied}");
    assert_eq!(reply["reply"]["value"]["meta"]["role"], "member");
    assert_eq!(reply["reply"]["value"]["meta"]["policyVersion"], "policy_1");
    // The verdict, the second binding check, `committing`, COMMIT, and the terminal record.
    let mut output = owner.step(
        &json!({"type": "validatorReplied", "id": call["id"], "ok": true,
        "decision": {"version": "1", "allowed": true}}),
    );
    for _ in 0..4 {
        output = owner.succeed(&output);
    }
    assert_eq!(
        output["effects"][1]["reply"]["value"]["meta"]["commitChecks"], "passed",
        "{output}"
    );
}

#[test]
fn issue_70_overflow_is_rejected_from_the_text() {
    let mut owner = begun();
    let output = owner.statement(
        r#"{"sequence":1,"sql":"INSERT INTO counters (id, ratio) VALUES (:id, :value)","params":{"id":"x","value":1e400}}"#,
    );
    let reply = output["effects"]
        .as_array()
        .and_then(|effects| effects.iter().find(|effect| effect["type"] == "respond"))
        .cloned()
        .unwrap_or_else(|| {
            // The compile error closes the transaction: rollback, persist, then the reply.
            let rolled = owner.succeed(&output);
            let persisted = owner.succeed(&rolled);
            persisted["effects"][0].clone()
        });
    assert_eq!(
        reply["reply"]["error"]["code"], "POLICYSQL_INVALID_REQUEST",
        "{reply}"
    );
}

#[test]
fn command_text_over_the_depth_limit_is_json_too_deep() {
    let mut owner = begun();
    let nested = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
    let accepted = owner.statement(&format!(
        r#"{{"sequence":1,"sql":"SELECT id FROM counters","params":{{}},"extra":{}}}"#,
        nested(63)
    ));
    let accepted = accepted["effects"]
        .as_array()
        .and_then(|effects| effects.iter().find(|effect| effect["type"] == "respond"));
    assert!(accepted.is_some(), "an unknown member is still invalid");
    if let Some(accepted) = accepted {
        assert_eq!(
            accepted["reply"]["error"]["code"], "POLICYSQL_INVALID_REQUEST",
            "64 levels pass the strict check and the typed read rejects the extra member"
        );
    }
    let deep = owner.statement(&format!(
        r#"{{"sequence":1,"sql":"SELECT id FROM counters","params":{{}},"extra":{}}}"#,
        nested(64)
    ));
    let deep = &deep["effects"][0];
    assert_eq!(deep["type"], "respond", "{deep}");
    assert_eq!(
        deep["reply"]["error"]["code"], "POLICYSQL_JSON_TOO_DEEP",
        "{deep}"
    );
    assert_eq!(
        deep["reply"]["error"]["message"], "The request JSON nests too deeply.",
        "{deep}"
    );
}

#[test]
fn a_command_at_the_depth_limit_compiles_inside_the_machine_envelope() {
    // The command is one level short of the limit: its root object is level 1, the parameter
    // object is level 2, and 62 nested parameter objects put the deepest value at level 64. The
    // machine wraps the command in a one-statement envelope, whose two fixed levels must not
    // spend the client's budget.
    let mut owner = begun();
    let object = |depth: usize| format!("{}1{}", "{\"a\":".repeat(depth), "}".repeat(depth));
    let body = format!(
        r#"{{"sequence":1,"sql":"INSERT INTO counters (id, meta) VALUES (:id, :meta)","params":{{"id":"x","meta":{}}}}}"#,
        object(62)
    );
    let output = owner.statement(&body);
    let execute = owner.succeed(&output);
    assert_eq!(
        execute["effects"][0]["type"], "execute",
        "a body at the limit must not be rejected by the envelope wrapper: {execute}"
    );
}

#[test]
fn issue_70_large_integers_keep_their_digits() {
    let mut owner = begun();
    let output = owner.statement(
        r#"{"sequence":1,"sql":"INSERT INTO counters (id, big) VALUES (:id, :value)","params":{"id":"x","value":9007199254740993}}"#,
    );
    let execute = owner.succeed(&output);
    assert_eq!(execute["effects"][0]["type"], "execute", "{execute}");
    let raw = execute["raw"].as_str().unwrap_or_default();
    assert!(raw.contains(r#""value":9007199254740993"#), "{raw}");
}

#[test]
fn json_parameters_keep_their_exact_text_for_the_driver() {
    let mut owner = begun();
    // Whitespace, member order, and number spelling are all deliberate: a tree round trip
    // would compact the object, reorder its members, and print `1E2` as `100.0`.
    let meta = r#"{ "z" : 1.0, "a" : [ 1E2, "x" ], "n" : 9007199254740993 }"#;
    let body = format!(
        r#"{{"sequence":1,"sql":"INSERT INTO counters (id, meta) VALUES (:id, :meta)","params":{{"id":"x","meta":{meta}}}}}"#
    );
    let output = owner.statement(&body);
    let execute = owner.succeed(&output);
    assert_eq!(execute["effects"][0]["type"], "execute", "{execute}");
    let statement = &execute["effects"][0]["statements"][0];
    assert_eq!(
        statement["args"]["meta"],
        Value::String(meta.to_owned()),
        "the driver receives the exact JSON-typed parameter text: {execute}"
    );
}

#[test]
fn limits_that_could_overflow_the_durable_record_are_rejected() {
    // 256 statements of a resource named at the longest the bound allows still fit; the
    // check is in `durable_bound_holds` and runs at construction.
    assert!(runtime(r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8,"max_transaction_statements":256,"max_transaction_result_bytes":65536}"#).is_some());
    assert!(policysql_transaction::machine::durable_bound_holds(
        64, 256, 65_536, 8
    ));
    assert!(!policysql_transaction::machine::durable_bound_holds(
        64, 256, 65_536, 200
    ));
}

/// One step in the engine (no owner): the direct placement of atomic execution.
fn engine_step(
    runtime: &super::PolicySqlRuntime,
    volatile: &mut Option<String>,
    event: &Value,
    request: u64,
) -> Value {
    let host = json!({
        "nowMs": 1_790_000_000_000_u64, "entropy": format!("{request:064x}"),
        "requestId": format!("req_{request}"), "owner": null,
    });
    let output = runtime.step_json(
        None,
        volatile.clone(),
        &event.to_string(),
        &host.to_string(),
    );
    let mut parsed: Value = serde_json::from_str(&output).unwrap_or(Value::Null);
    assert!(
        parsed["durable"].is_null(),
        "the engine holds no durable state: {output}"
    );
    *volatile = parsed["volatile"].as_str().map(str::to_owned);
    parsed["raw"] = Value::String(output);
    parsed
}

/// ADR 0024 pull request 6 with the real compiler: a direct atomic read compiles the verified
/// body text (#70: the integer beyond 2^53 keeps its digits in the driver arguments), ignores
/// the key (no lookup for a read), carries the execution trace on `Execute`, validates the real
/// result, and commits once.
#[test]
fn a_direct_atomic_read_compiles_the_text_and_carries_its_trace() {
    let runtime = runtime(
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|| unreachable!("valid runtime"));
    let snapshot = runtime.snapshot();
    let body = r#"{"statements":[{"sql":"SELECT id, big, ratio FROM counters WHERE big = :big","params":{"big":9007199254740993}}]}"#;
    let auth: Value = serde_json::from_str(
        &AUTH.replace(r#""access":["execute"]"#, r#""access":["execute","debug"]"#),
    )
    .unwrap_or_default();
    let request = json!({"type": "request", "operation": {
        "kind": "execute", "auth": auth, "databaseBinding": binding(&snapshot), "snapshot": snapshot,
        "bodyText": body, "idempotencyKey": "request-key-0001", "trace": true,
    }});
    let mut volatile = None;
    let mut output = engine_step(&runtime, &mut volatile, &request, 1);
    let mut kinds = Vec::new();
    let mut raw_execute = String::new();
    for request in 2..20 {
        let Some(effect) = output["effects"]
            .as_array()
            .and_then(|effects| effects.last().cloned())
        else {
            break;
        };
        let id = effect["id"].clone();
        if id.is_null() {
            break;
        }
        kinds.push(effect["type"].as_str().unwrap_or("").to_owned());
        let event = match effect["type"].as_str() {
            Some("checkBinding") => json!({"type": "bindingChecked", "id": id, "allowed": true}),
            Some("open") => json!({"type": "opened", "id": id}),
            Some("commit") => json!({"type": "committed", "id": id}),
            Some("execute")
                if effect["statements"][0]["sql"]
                    .as_str()
                    .is_some_and(|sql| sql.starts_with("SELECT fingerprint")) =>
            {
                json!({"type": "executed", "id": id, "results": [{"columns": ["fingerprint", "response_json"], "rows": [], "rowsAffected": 0, "usage": {"rowsRead": 0, "rowsWritten": 0, "queryDurationMs": 0}}]})
            }
            Some("execute")
                if effect["statements"][0]["sql"]
                    .as_str()
                    .is_some_and(|sql| sql.starts_with("INSERT INTO policysql_idempotency")) =>
            {
                json!({"type": "executed", "id": id, "results": [{"columns": [], "rows": [], "rowsAffected": 1, "usage": {"rowsRead": 0, "rowsWritten": 1, "queryDurationMs": 0}}]})
            }
            Some("execute") => {
                raw_execute = output["raw"].as_str().unwrap_or("").to_owned();
                assert_eq!(effect["trace"]["disposition"], "executed");
                assert_eq!(
                    effect["trace"]["statements"][0]["inputSql"],
                    "SELECT id, big, ratio FROM counters WHERE big = :big"
                );
                assert_eq!(
                    effect["trace"]["statements"][0]["executedSql"],
                    effect["statements"][0]["sql"]
                );
                assert!(
                    effect["trace"]["statements"][0]["parameters"]
                        .as_array()
                        .is_some_and(|parameters| parameters
                            .iter()
                            .all(|parameter| parameter["value"] == "[redacted]"))
                );
                json!({"type": "executed", "id": id, "results": [{"columns": ["id", "big", "ratio"], "rows": [["c1", 7, 1.5]], "rowsAffected": 0, "usage": {"rowsRead": 1, "rowsWritten": 0, "queryDurationMs": 1}}]})
            }
            _ => break,
        };
        output = engine_step(&runtime, &mut volatile, &event, request);
    }
    assert_eq!(
        kinds,
        ["checkBinding", "open", "execute", "commit"],
        "{}",
        output["raw"]
    );
    assert!(raw_execute.contains("9007199254740993"), "{raw_execute}");
    let reply = output["effects"]
        .as_array()
        .and_then(|effects| {
            effects
                .iter()
                .find(|effect| effect["type"] == "respond")
                .cloned()
        })
        .unwrap_or_default();
    let value = &reply["reply"]["value"];
    assert_eq!(value["status"], "committed", "{reply}");
    assert_eq!(
        value["results"][0]["rows"],
        json!([{"id": "c1", "big": 7, "ratio": 1.5}])
    );
    assert_eq!(value["meta"]["schemaVersion"], "schema_1");
    assert_eq!(value["debug"]["executionTrace"]["source"], "turso-egress");
    assert!(volatile.is_none());
    assert!(runtime.plans.borrow().is_empty(), "the plan is released");
}

/// `cost_estimate_json` is exported by the runtime (ADR 0024 "Cost").
#[test]
fn cost_estimate_json_is_exported() {
    let runtime = runtime(
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|| unreachable!("valid runtime"));
    let output: Value = serde_json::from_str(&runtime.cost_estimate_json(&json!({
        "catalog": {"maxEstimatedRowsRead": 100, "maxEstimatedRowsWritten": 100, "resources": {"1": {"upperRows": 20}}},
        "statements": [{"operation": "select", "explainResource": 1}],
        "results": [{"columns": ["detail"], "rows": [["SCAN counters"]]}],
    }).to_string())).unwrap_or_default();
    assert_eq!(output["estimates"][0]["upperRowsRead"], 20);
}

/// Drives a direct atomic `execute` of `body` (no key) through `step_json`, answering the
/// envelope's `execute` with `columns` and `rows`; returns the type of every effect emitted and
/// the reply.
fn direct_atomic_with_result(body: &str, columns: &Value, rows: &Value) -> (Vec<String>, Value) {
    let runtime = runtime(
        r#"{"max_rows":100,"max_result_bytes":64000,"timeout_ms":1000,"max_statements":8}"#,
    )
    .unwrap_or_else(|| unreachable!("valid runtime"));
    let snapshot = runtime.snapshot();
    let auth: Value = serde_json::from_str(AUTH).unwrap_or_default();
    let request = json!({"type": "request", "operation": {
        "kind": "execute", "auth": auth, "databaseBinding": binding(&snapshot),
        "snapshot": snapshot, "bodyText": body,
    }});
    let mut volatile = None;
    let mut output = engine_step(&runtime, &mut volatile, &request, 1);
    let mut kinds = Vec::new();
    for request in 2..20 {
        let effects = output["effects"].as_array().cloned().unwrap_or_default();
        kinds.extend(
            effects
                .iter()
                .filter_map(|effect| effect["type"].as_str().map(str::to_owned)),
        );
        if let Some(respond) = effects.iter().find(|effect| effect["type"] == "respond") {
            return (kinds, respond["reply"].clone());
        }
        let Some(effect) = effects.last() else { break };
        let id = effect["id"].clone();
        let event = match effect["type"].as_str() {
            Some("checkBinding") => json!({"type": "bindingChecked", "id": id, "allowed": true}),
            Some("open") => json!({"type": "opened", "id": id}),
            Some("rollback") => json!({"type": "rolledBack", "id": id}),
            Some("execute") => json!({"type": "executed", "id": id, "results": [{
                "columns": columns, "rows": rows, "rowsAffected": rows.as_array().map_or(0, Vec::len),
                "usage": {"rowsRead": 0, "rowsWritten": 1, "queryDurationMs": 1},
            }]}),
            _ => break,
        };
        output = engine_step(&runtime, &mut volatile, &event, request);
    }
    (kinds, output)
}

/// #145 pull request B with the real compiler: a changed row whose check column is FALSE is
/// answered 403 `POLICYSQL_CHECK_FAILED` at the statement, after a ROLLBACK and never a COMMIT.
#[test]
fn a_false_check_column_rolls_back_and_answers_check_failed() {
    let body =
        r#"{"statements":[{"sql":"INSERT INTO counters (id) VALUES (:id)","params":{"id":"x"}}]}"#;
    let (kinds, reply) =
        direct_atomic_with_result(body, &json!(["__policysql_check"]), &json!([[false]]));
    assert!(
        kinds.iter().any(|kind| kind == "rollback"),
        "{kinds:?} {reply}"
    );
    assert!(!kinds.iter().any(|kind| kind == "commit"), "{kinds:?}");
    assert_eq!(reply["error"]["code"], "POLICYSQL_CHECK_FAILED", "{reply}");
    assert_eq!(reply["error"]["path"], "/statements/0");
    assert!(reply["error"].get("detail").is_none(), "{reply}");
    assert_eq!(
        reply["error"]["message"],
        "A changed row does not satisfy the policy check."
    );
    // Control: the same statement with a TRUE check column commits.
    let (kinds, reply) =
        direct_atomic_with_result(body, &json!(["__policysql_check"]), &json!([[true]]));
    assert!(
        kinds.iter().any(|kind| kind == "commit"),
        "{kinds:?} {reply}"
    );
}
