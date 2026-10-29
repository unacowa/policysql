//! The one authoritative trusted-session rule set (ADR 0005, ADR 0019).
//!
//! The wrapper authenticates the caller and passes the result as data. This module
//! validates that value, selects the role requested through `PolicySQL-Role`, and checks
//! the endpoint's required access. The compile and Catalog paths re-enter the same
//! function with the canonical result, so no second rule set exists.

use policysql_core::{RoleName, SessionKey, TrustedSession};
use policysql_gateway::{AuthContext, EndpointPermission};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Trusted session exactly as the wrapper supplies it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionInput {
    principal: String,
    subject: String,
    roles: Vec<String>,
    default_role: String,
    access: Vec<String>,
    session: BTreeMap<String, String>,
}

/// Canonical authorization result. The engine stores it (for example in a transaction
/// owner) and passes it back unchanged to `compile_json` and `catalog_json`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AuthorizedSession {
    pub(crate) principal: String,
    pub(crate) subject: String,
    pub(crate) role: String,
    pub(crate) roles: Vec<String>,
    pub(crate) access: Vec<String>,
    pub(crate) session: BTreeMap<String, String>,
}

/// Which part of a wrapper-supplied session is malformed. Never carries a session value.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionFault {
    Shape,
    Principal,
    Subject,
    Roles,
    DefaultRole,
    Access,
    Session,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionError {
    /// The wrapper supplied a session that violates the contract: a wrapper fault.
    Malformed(SessionFault),
    /// The client asked for a role or endpoint the valid session does not grant.
    Forbidden,
}

pub(crate) fn parse_access(value: &str) -> Option<EndpointPermission> {
    match value {
        "execute" => Some(EndpointPermission::Execute),
        "explain" => Some(EndpointPermission::Explain),
        "catalog" => Some(EndpointPermission::Catalog),
        "debug" => Some(EndpointPermission::Debug),
        _ => None,
    }
}

fn unique<T: Ord>(values: impl IntoIterator<Item = T>, expected: usize) -> bool {
    values.into_iter().collect::<BTreeSet<_>>().len() == expected
}

/// Validates the session shape, then selects the role and checks access.
///
/// Every shape rule runs before any client-caused rule, so a malformed session is
/// always reported as a wrapper fault regardless of the client's headers.
pub(crate) fn authorize_session(
    input: SessionInput,
    requested_role: Option<&str>,
    required: EndpointPermission,
) -> Result<(AuthorizedSession, AuthContext), SessionError> {
    use SessionError::Malformed;
    if input.principal.is_empty() {
        return Err(Malformed(SessionFault::Principal));
    }
    if input.subject.is_empty() {
        return Err(Malformed(SessionFault::Subject));
    }
    if input.roles.is_empty()
        || input
            .roles
            .iter()
            .any(|role| RoleName::new(role.as_str()).is_err())
        || !unique(&input.roles, input.roles.len())
    {
        return Err(Malformed(SessionFault::Roles));
    }
    if !input.roles.contains(&input.default_role) {
        return Err(Malformed(SessionFault::DefaultRole));
    }
    let permissions = input
        .access
        .iter()
        .map(|value| parse_access(value))
        .collect::<Option<BTreeSet<_>>>()
        .ok_or(Malformed(SessionFault::Access))?;
    if permissions.is_empty() || permissions.len() != input.access.len() {
        return Err(Malformed(SessionFault::Access));
    }
    if input.session.keys().any(|key| {
        matches!(key.as_str(), "subject_id" | "role") || SessionKey::new(key.as_str()).is_err()
    }) {
        return Err(Malformed(SessionFault::Session));
    }

    let role = requested_role.unwrap_or(&input.default_role);
    if !input.roles.iter().any(|candidate| candidate == role) || !permissions.contains(&required) {
        return Err(SessionError::Forbidden);
    }
    let role_name = RoleName::new(role).map_err(|_| SessionError::Forbidden)?;
    let trusted = TrustedSession::new(role_name, input.subject.clone(), input.session.clone())
        .map_err(|_| Malformed(SessionFault::Session))?;
    Ok((
        AuthorizedSession {
            principal: input.principal,
            subject: input.subject,
            role: role.to_owned(),
            roles: input.roles,
            access: input.access,
            session: input.session,
        },
        AuthContext::new(trusted, permissions),
    ))
}

/// Re-activates a canonical result through the same rules. The canonical value came from
/// `authorize_session`, so any shape failure here is an engine fault, never a client one.
pub(crate) fn activate_authorized(
    canonical: AuthorizedSession,
    required: EndpointPermission,
) -> Result<AuthContext, SessionError> {
    let role = canonical.role;
    authorize_session(
        SessionInput {
            principal: canonical.principal,
            subject: canonical.subject,
            roles: canonical.roles,
            default_role: role.clone(),
            access: canonical.access,
            session: canonical.session,
        },
        Some(&role),
        required,
    )
    .map(|(_, auth)| auth)
}

#[cfg(test)]
mod tests {
    use super::{
        AuthorizedSession, SessionError, SessionFault, SessionInput, activate_authorized,
        authorize_session,
    };
    use policysql_core::SessionKey;
    use policysql_gateway::EndpointPermission;
    use serde_json::{Value, json};

    fn valid() -> Value {
        json!({
            "principal": "https://issuer.test:user_1",
            "subject": "user_1",
            "roles": ["member", "reader"],
            "defaultRole": "member",
            "access": ["catalog", "explain", "execute"],
            "session": { "tenant_id": "tenant_a" },
        })
    }

    fn run(
        value: &Value,
        role: Option<&str>,
        required: EndpointPermission,
    ) -> Result<AuthorizedSession, SessionError> {
        let input: SessionInput = serde_json::from_value(value.clone())
            .map_err(|_| SessionError::Malformed(SessionFault::Shape))?;
        authorize_session(input, role, required).map(|(canonical, _)| canonical)
    }

    fn with(key: &str, replacement: Value) -> Value {
        let mut value = valid();
        value[key] = replacement;
        value
    }

    #[test]
    fn selects_the_default_or_requested_role_and_keeps_the_principal() {
        let canonical = run(&valid(), None, EndpointPermission::Execute)
            .unwrap_or_else(|error| unreachable!("valid session: {error:?}"));
        assert_eq!(canonical.role, "member");
        assert_eq!(canonical.principal, "https://issuer.test:user_1");
        let reader = run(&valid(), Some("reader"), EndpointPermission::Catalog)
            .unwrap_or_else(|error| unreachable!("valid role: {error:?}"));
        assert_eq!(reader.role, "reader");
    }

    #[test]
    fn exposes_subject_and_role_as_reserved_session_values() {
        let input: SessionInput = serde_json::from_value(valid())
            .unwrap_or_else(|error| unreachable!("valid input: {error}"));
        let (_, auth) = authorize_session(input, Some("reader"), EndpointPermission::Explain)
            .unwrap_or_else(|error| unreachable!("valid session: {error:?}"));
        let key = |name: &str| {
            SessionKey::new(name).unwrap_or_else(|error| unreachable!("valid key: {error}"))
        };
        assert_eq!(auth.session().get(&key("subject_id")), Some("user_1"));
        assert_eq!(auth.session().get(&key("role")), Some("reader"));
        assert_eq!(auth.session().get(&key("tenant_id")), Some("tenant_a"));
        assert_eq!(auth.session().get(&key("principal")), None);
    }

    #[test]
    fn malformed_sessions_are_wrapper_faults() {
        use SessionFault::{Access, DefaultRole, Principal, Roles, Session, Shape, Subject};
        let mut missing_session = valid();
        missing_session
            .as_object_mut()
            .map(|object| object.remove("session"));
        let mut extra = valid();
        extra["issuer"] = json!("https://issuer.test");
        let cases = [
            (json!(null), Shape),
            (json!([]), Shape),
            (missing_session, Shape),
            (extra, Shape),
            (with("principal", json!("")), Principal),
            (with("principal", json!(7)), Shape),
            (with("subject", json!("")), Subject),
            (with("subject", json!(null)), Shape),
            (with("roles", json!([])), Roles),
            (with("roles", json!(["Member"])), Roles),
            (with("roles", json!(["member", "member"])), Roles),
            (with("roles", json!("member")), Shape),
            (with("defaultRole", json!("admin")), DefaultRole),
            (with("access", json!([])), Access),
            (with("access", json!(["execute", "admin"])), Access),
            (with("access", json!(["execute", "execute"])), Access),
            (with("session", json!({ "subject_id": "other" })), Session),
            (with("session", json!({ "role": "admin" })), Session),
            (with("session", json!({ "Tenant": "x" })), Session),
            (with("session", json!({ "tenant_id": 7 })), Shape),
            (with("session", json!([])), Shape),
        ];
        for (value, fault) in cases {
            for role in [None, Some("member"), Some("admin")] {
                assert_eq!(
                    run(&value, role, EndpointPermission::Execute).err(),
                    Some(SessionError::Malformed(fault)),
                    "{value} with role {role:?}",
                );
            }
        }
    }

    #[test]
    fn role_outside_roles_and_missing_access_are_forbidden() {
        for (role, required) in [
            (Some("admin"), EndpointPermission::Execute),
            (Some(""), EndpointPermission::Execute),
            (Some("member, reader"), EndpointPermission::Execute),
            (None, EndpointPermission::Debug),
        ] {
            assert_eq!(
                run(&valid(), role, required).err(),
                Some(SessionError::Forbidden),
                "{role:?} {required:?}",
            );
        }
    }

    #[test]
    fn canonical_results_reenter_the_same_rules() {
        let canonical = run(&valid(), Some("reader"), EndpointPermission::Explain)
            .unwrap_or_else(|error| unreachable!("valid session: {error:?}"));
        let text = serde_json::to_string(&canonical)
            .unwrap_or_else(|error| unreachable!("serializes: {error}"));
        let parse = |text: &str| -> AuthorizedSession {
            serde_json::from_str(text).unwrap_or_else(|error| unreachable!("parses: {error}"))
        };
        assert!(activate_authorized(parse(&text), EndpointPermission::Execute).is_ok());
        let mut tampered: Value =
            serde_json::from_str(&text).unwrap_or_else(|error| unreachable!("{error}"));
        // A canonical role outside its own roles is an engine fault, not a client denial.
        tampered["role"] = json!("admin");
        assert_eq!(
            activate_authorized(parse(&tampered.to_string()), EndpointPermission::Execute).err(),
            Some(SessionError::Malformed(SessionFault::DefaultRole)),
        );
        tampered["role"] = json!("reader");
        tampered["session"] = json!({ "subject_id": "other" });
        assert_eq!(
            activate_authorized(parse(&tampered.to_string()), EndpointPermission::Execute).err(),
            Some(SessionError::Malformed(SessionFault::Session)),
        );
    }
}
