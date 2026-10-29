//! Request identities, fingerprints, and digests (ADR 0024 pull request 2).
//!
//! Each computation is byte-for-byte the one `deploy/cloudflare/src/idempotency.ts` and its
//! callers make today:
//!
//! | Operation | Today | Result |
//! | --- | --- | --- |
//! | `request` | `requestIdempotency` | `keyHash = sha256(identity + ":" + key)`, `fingerprint = sha256(identity + ":" + stable(body) + ":" + stable(binding))` |
//! | `auth` | `authFingerprint` | `sha256(stable({principal, subject, role, session, databaseBinding}))` |
//! | `start` | unkeyed `startFingerprint` in `engine.ts` begin | `sha256(stable({transactionId, request: body}))` |
//! | `command` | command digest in `transaction-owner.ts` | `sha256(stable({kind, command}))` |
//! | `callback` | callback query digest in `transaction-owner.ts` | `sha256(stable(command))` |
//!
//! where `identity = stable({principal, subject, role, session, endpoint, database: {scope,
//! databaseId}})`. Every identity field that reaches a hash is checked to be a string (the
//! session a map of strings, the binding of the ADR 0014 shape): `stableJson` would print an
//! absent field as `undefined`, and core rejects such an input before hashing instead.
//!
//! Hashes are lowercase hexadecimal SHA-256 of the UTF-8 bytes of the text, as
//! `crypto.subtle.digest` over `TextEncoder` output. Canonical text escapes every lone
//! surrogate, so it is always well-formed and that encoding is exact.

use crate::canonical::{self, Json};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

/// The largest `identity_json` input. A body is at most 1 MiB (`MAX_BODY_BYTES`); embedding it
/// as a JSON string at most doubles it.
pub const MAX_INPUT_BYTES: usize = 4 * 1_048_576;

const INTERNAL: &str = r#"{"error":{"code":"POLICYSQL_INTERNAL","message":"The request could not be completed.","path":null}}"#;
const KEY_REQUIRED: &str = r#"{"error":{"code":"POLICYSQL_IDEMPOTENCY_KEY_REQUIRED","message":"Idempotency-Key must contain 16-128 letters, digits, dots, underscores, colons, or hyphens when provided.","path":null}}"#;

/// Why an identity could not be computed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdentityError {
    /// The client's `Idempotency-Key` violates the key syntax (a client error).
    KeyRequired,
    /// The input violates this contract: a library or wrapper fault.
    Internal,
}

/// Lowercase hexadecimal SHA-256 of `bytes`.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// The key syntax: 16-128 of `A-Za-z0-9._:-`.
#[must_use]
pub fn valid_idempotency_key(key: &str) -> bool {
    (16..=128).contains(&key.len())
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

/// Computes one identity from a JSON input and returns the result as JSON.
///
/// Inputs (`auth` is the canonical session that `authorize_session_json` returned, `binding`
/// the validated database binding, `body` the exact body text the engine parsed):
///
/// - `{"op":"request","endpoint":"execute"|"interactive-start","auth":…,"binding":…,"body":"…","key"?:…}`
///   → `{"idempotency":null}` without `key`, `{"idempotency":{"keyHash":…,"fingerprint":…}}`
///   with a valid key; a `key` that is not a valid key string is
///   `POLICYSQL_IDEMPOTENCY_KEY_REQUIRED`.
/// - `{"op":"auth","auth":…,"binding":…}` → `{"fingerprint":…}`
/// - `{"op":"start","transactionId":"tx_…","body":"…"}` → `{"digest":…}`
/// - `{"op":"command","kind":"statement"|"commit"|"rollback","command":…}` → `{"digest":…}`
/// - `{"op":"callback","command":…}` → `{"digest":…}`
///
/// Anything else, an unknown member included, is `{"error":{"code":"POLICYSQL_INTERNAL",…}}`.
#[must_use]
pub fn identity_json(input: &str) -> String {
    match compute(input) {
        Ok(output) => output,
        Err(IdentityError::KeyRequired) => KEY_REQUIRED.to_owned(),
        Err(IdentityError::Internal) => INTERNAL.to_owned(),
    }
}

/// [`identity_json`] with a typed error.
///
/// # Errors
///
/// Returns [`IdentityError`] as documented on [`identity_json`].
pub fn compute(input: &str) -> Result<String, IdentityError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(IdentityError::Internal);
    }
    let input = canonical::parse(input).map_err(|_| IdentityError::Internal)?;
    let op = text(input.get("op"))?;
    match op.as_str() {
        "request" => request(&input),
        "auth" => {
            exact_keys(&input, &["op", "auth", "binding"], &[])?;
            let auth = Auth::read(input.get("auth"))?;
            let binding = binding(input.get("binding"))?;
            let value = Json::Object(vec![
                member("principal", auth.principal),
                member("subject", auth.subject),
                member("role", auth.role),
                member("session", auth.session),
                member("databaseBinding", binding.clone()),
            ]);
            Ok(format!(
                r#"{{"fingerprint":"{}"}}"#,
                sha256_hex(canonical::to_stable(&value).as_bytes())
            ))
        }
        "start" => {
            exact_keys(&input, &["op", "transactionId", "body"], &[])?;
            let transaction_id = text(input.get("transactionId"))?;
            if !valid_transaction_id(&transaction_id) {
                return Err(IdentityError::Internal);
            }
            let body = body(input.get("body"))?;
            Ok(digest(&Json::Object(vec![
                member("transactionId", Json::string(&transaction_id)),
                member("request", body),
            ])))
        }
        "command" => {
            exact_keys(&input, &["op", "kind", "command"], &[])?;
            let kind = text(input.get("kind"))?;
            if !matches!(kind.as_str(), "statement" | "commit" | "rollback") {
                return Err(IdentityError::Internal);
            }
            let command = input
                .get("command")
                .cloned()
                .ok_or(IdentityError::Internal)?;
            Ok(digest(&Json::Object(vec![
                member("kind", Json::string(&kind)),
                member("command", command),
            ])))
        }
        "callback" => {
            exact_keys(&input, &["op", "command"], &[])?;
            Ok(digest(input.get("command").ok_or(IdentityError::Internal)?))
        }
        _ => Err(IdentityError::Internal),
    }
}

/// `requestIdempotency`: no identity without a key, else `keyHash` and `fingerprint`.
fn request(input: &Json) -> Result<String, IdentityError> {
    exact_keys(
        input,
        &["op", "endpoint", "auth", "binding", "body"],
        &["key"],
    )?;
    let endpoint = text(input.get("endpoint"))?;
    if !matches!(endpoint.as_str(), "execute" | "interactive-start") {
        return Err(IdentityError::Internal);
    }
    let auth = Auth::read(input.get("auth"))?;
    let binding = binding(input.get("binding"))?;
    let body = body(input.get("body"))?;
    let Some(key) = input.get("key") else {
        return Ok(r#"{"idempotency":null}"#.to_owned());
    };
    let key = key.as_text().ok_or(IdentityError::KeyRequired)?;
    if !valid_idempotency_key(&key) {
        return Err(IdentityError::KeyRequired);
    }
    let part = |name: &str| binding.get(name).cloned().ok_or(IdentityError::Internal);
    let identity = canonical::to_stable(&Json::Object(vec![
        member("principal", auth.principal),
        member("subject", auth.subject),
        member("role", auth.role),
        member("session", auth.session),
        member("endpoint", Json::string(&endpoint)),
        member(
            "database",
            Json::Object(vec![
                member("scope", part("scope")?),
                member("databaseId", part("databaseId")?),
            ]),
        ),
    ]));
    let key_hash = sha256_hex(format!("{identity}:{key}").as_bytes());
    let fingerprint = sha256_hex(
        format!(
            "{identity}:{}:{}",
            canonical::to_stable(&body),
            canonical::to_stable(binding)
        )
        .as_bytes(),
    );
    Ok(format!(
        r#"{{"idempotency":{{"keyHash":"{key_hash}","fingerprint":"{fingerprint}"}}}}"#
    ))
}

fn digest(value: &Json) -> String {
    format!(
        r#"{{"digest":"{}"}}"#,
        sha256_hex(canonical::to_stable(value).as_bytes())
    )
}

fn member(key: &str, value: Json) -> (Vec<u16>, Json) {
    (key.encode_utf16().collect(), value)
}

fn text(value: Option<&Json>) -> Result<String, IdentityError> {
    value.and_then(Json::as_text).ok_or(IdentityError::Internal)
}

fn is_string(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::String(_)))
}

/// `value` is an object whose keys are all of `required`, plus any of `optional`.
fn exact_keys(value: &Json, required: &[&str], optional: &[&str]) -> Result<(), IdentityError> {
    let Json::Object(members) = value else {
        return Err(IdentityError::Internal);
    };
    let allowed = |name: &[u16]| {
        required
            .iter()
            .chain(optional)
            .any(|key| key.encode_utf16().eq(name.iter().copied()))
    };
    if members.iter().all(|(name, _)| allowed(name))
        && required.iter().all(|key| value.get(key).is_some())
    {
        Ok(())
    } else {
        Err(IdentityError::Internal)
    }
}

fn valid_transaction_id(value: &str) -> bool {
    value.strip_prefix("tx_").is_some_and(|hex| {
        hex.len() == 32
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// The identity fields of core's canonical session (`AuthContext`).
struct Auth {
    principal: Json,
    subject: Json,
    role: Json,
    session: Json,
}

impl Auth {
    fn read(value: Option<&Json>) -> Result<Self, IdentityError> {
        let value = value.ok_or(IdentityError::Internal)?;
        exact_keys(
            value,
            &["principal", "subject", "role", "session"],
            &["roles", "access"],
        )?;
        for list in ["roles", "access"] {
            match value.get(list) {
                None => {}
                Some(Json::Array(items)) if items.iter().all(|item| is_string(Some(item))) => {}
                Some(_) => return Err(IdentityError::Internal),
            }
        }
        for field in ["principal", "subject", "role"] {
            if !is_string(value.get(field)) {
                return Err(IdentityError::Internal);
            }
        }
        let session = value.get("session").ok_or(IdentityError::Internal)?;
        let Json::Object(entries) = session else {
            return Err(IdentityError::Internal);
        };
        if !entries.iter().all(|(_, item)| is_string(Some(item))) {
            return Err(IdentityError::Internal);
        }
        let field = |name: &str| value.get(name).cloned().ok_or(IdentityError::Internal);
        Ok(Self {
            principal: field("principal")?,
            subject: field("subject")?,
            role: field("role")?,
            session: session.clone(),
        })
    }
}

/// A database binding of the ADR 0014 shape: version 1 and four string parts.
fn binding(value: Option<&Json>) -> Result<&Json, IdentityError> {
    let value = value.ok_or(IdentityError::Internal)?;
    exact_keys(
        value,
        &["version", "scope", "databaseId", "generation", "snapshot"],
        &[],
    )?;
    if !matches!(value.get("version"), Some(Json::Number(version)) if version.to_bits() == 1.0_f64.to_bits())
    {
        return Err(IdentityError::Internal);
    }
    if ["scope", "databaseId", "generation", "snapshot"]
        .iter()
        .all(|part| is_string(value.get(part)))
    {
        Ok(value)
    } else {
        Err(IdentityError::Internal)
    }
}

/// The request body, read from its text with the canonical tokenizer.
fn body(value: Option<&Json>) -> Result<Json, IdentityError> {
    let text = text(value)?;
    canonical::parse(&text).map_err(|_| IdentityError::Internal)
}

#[cfg(test)]
mod tests {
    use super::{identity_json, sha256_hex, valid_idempotency_key};

    const AUTH: &str = r#"{"principal":"https://issuer.test:user_1","subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_a"}}"#;
    const BINDING: &str =
        r#"{"version":1,"scope":"tenant","databaseId":"db_1","generation":"g1","snapshot":"snap"}"#;

    fn request(key: &str, body: &str) -> String {
        format!(
            r#"{{"op":"request","endpoint":"execute","auth":{AUTH},"binding":{BINDING},"body":{body}{key}}}"#
        )
    }

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn key_syntax() {
        assert!(valid_idempotency_key("request-key-0001"));
        assert!(valid_idempotency_key(&"a".repeat(128)));
        assert!(!valid_idempotency_key(&"a".repeat(15)));
        assert!(!valid_idempotency_key(&"a".repeat(129)));
        assert!(!valid_idempotency_key("request-key-0001,request-key-0002"));
        assert!(!valid_idempotency_key("request key 0001"));
        assert!(!valid_idempotency_key("request-key-00é1"));
    }

    #[test]
    fn request_without_key_has_no_idempotency_and_bad_keys_are_client_errors() {
        let body = r#""{\"statements\":[]}""#;
        assert_eq!(identity_json(&request("", body)), r#"{"idempotency":null}"#);
        for key in [r#","key":null"#, r#","key":1"#, r#","key":"short""#] {
            assert!(
                identity_json(&request(key, body)).contains("POLICYSQL_IDEMPOTENCY_KEY_REQUIRED"),
                "{key}"
            );
        }
        let keyed = identity_json(&request(r#","key":"request-key-0001""#, body));
        assert!(
            keyed.starts_with(r#"{"idempotency":{"keyHash":""#),
            "{keyed}"
        );
    }

    #[test]
    fn identity_fields_must_be_strings_before_hashing() {
        // The negative case of the corpus: `stableJson` prints an absent field as `undefined`.
        // Core rejects every such input instead of hashing it.
        let body = r#""{}""#;
        for auth in [
            r#"{"subject":"user_1","role":"member","session":{}}"#,
            r#"{"principal":null,"subject":"user_1","role":"member","session":{}}"#,
            r#"{"principal":1,"subject":"user_1","role":"member","session":{}}"#,
            r#"{"principal":"p","subject":"user_1","role":"member","session":{"a":1}}"#,
            r#"{"principal":"p","subject":"user_1","role":"member","session":[]}"#,
            r#"{"principal":"p","subject":"user_1","role":"member","session":{},"extra":"x"}"#,
            r#"{"principal":"p","subject":"user_1","role":"member","roles":[1],"session":{}}"#,
        ] {
            let input = format!(r#"{{"op":"auth","auth":{auth},"binding":{BINDING}}}"#);
            assert!(
                identity_json(&input).contains("POLICYSQL_INTERNAL"),
                "{auth}"
            );
            let input = format!(
                r#"{{"op":"request","endpoint":"execute","auth":{auth},"binding":{BINDING},"body":{body},"key":"request-key-0001"}}"#
            );
            assert!(
                identity_json(&input).contains("POLICYSQL_INTERNAL"),
                "{auth}"
            );
        }
        for binding in [
            r#"{"version":2,"scope":"t","databaseId":"d","generation":"g","snapshot":"s"}"#,
            r#"{"version":"1","scope":"t","databaseId":"d","generation":"g","snapshot":"s"}"#,
            r#"{"version":1,"databaseId":"d","generation":"g","snapshot":"s"}"#,
            r#"{"version":1,"scope":null,"databaseId":"d","generation":"g","snapshot":"s"}"#,
            r#"{"version":1,"scope":"t","databaseId":"d","generation":"g","snapshot":"s","x":"y"}"#,
        ] {
            let input = format!(r#"{{"op":"auth","auth":{AUTH},"binding":{binding}}}"#);
            assert!(
                identity_json(&input).contains("POLICYSQL_INTERNAL"),
                "{binding}"
            );
        }
    }

    #[test]
    fn malformed_inputs_are_internal() {
        for input in [
            "",
            "{}",
            r#"{"op":"unknown"}"#,
            r#"{"op":"command","kind":"begin","command":{}}"#,
            r#"{"op":"command","kind":"commit"}"#,
            r#"{"op":"command","kind":"commit","command":{},"extra":1}"#,
            r#"{"op":"callback","command":{},"op":"callback"}"#,
            r#"{"op":"start","transactionId":"tx_ABC","body":"{}"}"#,
            r#"{"op":"start","transactionId":"tx_00000000000000000000000000000000","body":"{"}"#,
            r#"{"op":"start","transactionId":"tx_00000000000000000000000000000000","body":{}}"#,
        ] {
            assert!(
                identity_json(input).contains("POLICYSQL_INTERNAL"),
                "{input}"
            );
        }
        let body = r#""{\"a\":1}""#;
        let input =
            request(r#","key":"request-key-0001""#, body).replace("\"execute\"", "\"explain\"");
        assert!(identity_json(&input).contains("POLICYSQL_INTERNAL"));
    }

    #[test]
    fn digests_are_canonical() {
        let first = identity_json(
            r#"{"op":"command","kind":"commit","command":{"sequence":2,"b":[1.0,1E5]}}"#,
        );
        let second = identity_json(
            r#"{"command":{"b":[1,100000],"sequence":2},"kind":"commit","op":"command"}"#,
        );
        assert_eq!(first, second);
        let callback = identity_json(
            r#"{"op":"callback","command":{"kind":"commit","command":{"sequence":2,"b":[1,100000]}}}"#,
        );
        // `{kind, command}` hashed as a command equals the same object hashed as a callback.
        assert_eq!(first, callback);
        assert_eq!(
            identity_json(r#"{"op":"callback","command":{}}"#),
            format!(r#"{{"digest":"{}"}}"#, sha256_hex(b"{}"))
        );
    }
}
