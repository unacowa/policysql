//! `step_json` with the real compiler (ADR 0024 pull request 4): the statement event carries
//! the verified body text, and compile and the digest use it (#70). The TypeScript owner path
//! still recompiles `JSON.stringify(command)` until the switch-over (pull request 7); the
//! differential harness (`deploy/cloudflare/test/step-differential.test.mjs`) lists that.

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
          columns: [id, big, ratio]
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
fn abi_7_names_the_step_machine_with_commit_checks() {
    let owner = begun();
    assert_eq!(owner.runtime.abi_version(), 7);
    assert!(owner.runtime.snapshot().ends_with(":abi-7"));
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
