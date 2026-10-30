//! Identity goldens (ADR 0025, Follow-up 1): `keyHash`, auth fingerprints, unkeyed start
//! fingerprints, and the commit and rollback `{sequence}` digests, captured from the
//! implementation on main before ADR 0025 changed the canonical form, where core's
//! `identity_json` equalled `stableJson` + `sha256` in TypeScript. The stability requirements
//! (a)-(d) keep every one of them byte-identical; a golden that changes is a breaking change.
//! Request fingerprints are a check of (a)-(d) under one binding, not values kept across
//! releases: #80 (ABI 9) removed the binding's snapshot from them, and they were recomputed.

use policysql_transaction::identity_json;
use serde_json::Value;

const GOLDENS: &str = include_str!("../../../tests/fixtures/identity-goldens.json");

fn goldens() -> Vec<Value> {
    let fixture: Value = serde_json::from_str(GOLDENS).unwrap_or_else(|_| unreachable!());
    fixture["goldens"].as_array().cloned().unwrap_or_default()
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

#[test]
fn identity_goldens_are_unchanged() {
    let goldens = goldens();
    assert!(goldens.len() >= 40, "{}", goldens.len());
    for golden in goldens {
        let name = text(&golden["name"]);
        let input = golden["input"].to_string();
        let output: Value =
            serde_json::from_str(&identity_json(&input)).unwrap_or_else(|_| unreachable!());
        assert_eq!(output, golden["output"], "{name}");
    }
}

#[test]
fn goldens_cover_what_adr_0025_lists() {
    let goldens = goldens();
    let names: Vec<&str> = goldens.iter().map(|golden| text(&golden["name"])).collect();
    let has = |name: &str| names.contains(&name);
    for label in [
        "accented-latin",
        "cjk",
        "astral",
        "escapes",
        "many-session-keys",
    ] {
        assert!(has(&format!("auth {label}")), "{label}");
        assert!(has(&format!("request execute {label} body 0")), "{label}");
        assert!(
            has(&format!("request interactive-start {label} body 2")),
            "{label}"
        );
    }
    for kind in ["commit", "rollback"] {
        for sequence in ["0", "1", "2", "9007199254740991"] {
            assert!(has(&format!("{kind} sequence {sequence}")), "{kind}");
        }
    }
    // Unkeyed starts with and without `expected`.
    assert!(goldens.iter().any(|golden| golden["input"]["op"] == "start"
        && text(&golden["input"]["body"]).contains("expected")));
    assert!(goldens.iter().any(|golden| golden["input"]["op"] == "start"
        && !text(&golden["input"]["body"]).contains("expected")));
    let escapes = goldens
        .iter()
        .find(|golden| golden["name"] == "auth escapes")
        .cloned()
        .unwrap_or_default();
    let subject = text(&escapes["input"]["auth"]["subject"]);
    for character in ['"', '\\', '\u{0}', '\u{1f}', '\u{7f}', '\u{2028}'] {
        assert!(subject.contains(character), "{character:?}");
    }
    assert_eq!(escapes["input"]["binding"]["version"], 1);
}
