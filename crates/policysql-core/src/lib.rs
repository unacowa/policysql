#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::fmt;

const SERVER_PARAMETER_PREFIX: &str = "__policysql_";

macro_rules! numeric_id {
    ($name:ident, $description:literal) => {
        #[doc = $description]
        #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(u64);

        impl $name {
            /// Creates a stable, non-zero identity.
            ///
            /// # Errors
            ///
            /// Returns [`CoreError::ZeroIdentity`] when `value` is zero.
            pub fn new(value: u64) -> Result<Self, CoreError> {
                if value == 0 {
                    return Err(CoreError::ZeroIdentity);
                }
                Ok(Self(value))
            }

            #[must_use]
            pub const fn get(self) -> u64 {
                self.0
            }
        }
    };
}

numeric_id!(ResourceId, "Stable identity of a Catalog resource.");
numeric_id!(PolicyId, "Stable identity of an activated policy.");

/// Stable identity of a column within a Catalog resource.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ColumnId {
    resource: ResourceId,
    ordinal: u32,
}

impl ColumnId {
    #[must_use]
    pub const fn new(resource: ResourceId, ordinal: u32) -> Self {
        Self { resource, ordinal }
    }

    #[must_use]
    pub const fn resource(self) -> ResourceId {
        self.resource
    }

    #[must_use]
    pub const fn ordinal(self) -> u32 {
        self.ordinal
    }
}

macro_rules! validated_string {
    ($name:ident, $validation:ident, $error:expr, $description:literal) => {
        #[doc = $description]
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            /// Validates and owns the supplied value.
            ///
            /// # Errors
            ///
            /// Returns an error when the value does not satisfy this type's contract.
            pub fn new(value: impl Into<String>) -> Result<Self, CoreError> {
                let value = value.into();
                if !$validation(&value) {
                    return Err($error);
                }
                Ok(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

fn non_empty(value: &str) -> bool {
    !value.trim().is_empty()
}

fn canonical_key(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some('a'..='z'))
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

validated_string!(
    ResourceName,
    non_empty,
    CoreError::EmptyIdentifier,
    "Validated logical name of a protected resource."
);
validated_string!(
    ColumnName,
    non_empty,
    CoreError::EmptyIdentifier,
    "Validated logical name of a protected column."
);
validated_string!(
    ResultName,
    non_empty,
    CoreError::EmptyResultName,
    "Validated non-empty output-column name."
);
validated_string!(
    RoleName,
    canonical_key,
    CoreError::InvalidCanonicalKey,
    "Canonical role name from the trusted authentication contract."
);
validated_string!(
    SessionKey,
    canonical_key,
    CoreError::InvalidCanonicalKey,
    "Canonical trusted-session key."
);
validated_string!(
    SnapshotId,
    non_empty,
    CoreError::EmptyIdentifier,
    "Immutable policy, Catalog, compiler, and registry snapshot identity."
);
validated_string!(
    BackendProfileId,
    non_empty,
    CoreError::EmptyIdentifier,
    "Versioned backend-profile identity."
);

/// Name of a parameter owned by the untrusted caller.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ClientParameterName(String);

impl ClientParameterName {
    /// Validates a caller-owned named parameter without its SQL prefix.
    ///
    /// # Errors
    ///
    /// Rejects empty, non-canonical, or server-reserved names.
    pub fn new(value: impl Into<String>) -> Result<Self, CoreError> {
        let value = value.into();
        if value.starts_with(SERVER_PARAMETER_PREFIX) {
            return Err(CoreError::ReservedParameterNamespace);
        }
        if !canonical_key(&value) {
            return Err(CoreError::InvalidParameterName);
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Name of a compiler-owned parameter. Clients cannot construct this type through client APIs.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ServerParameterName(String);

impl ServerParameterName {
    /// Allocates a canonical server-owned name from a trusted suffix.
    ///
    /// # Errors
    ///
    /// Rejects a suffix that is not a canonical key.
    pub fn from_trusted_suffix(suffix: &str) -> Result<Self, CoreError> {
        if !canonical_key(suffix) {
            return Err(CoreError::InvalidParameterName);
        }
        Ok(Self(format!("{SERVER_PARAMETER_PREFIX}{suffix}")))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationKind {
    Select,
    Insert,
    Update,
    Delete,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogicalType {
    String,
    Integer,
    Boolean,
    Int64,
    Number,
    Bytes,
    Date,
    DateTime,
    Instant,
    Json,
}

/// `SQLite` storage class retained in the compiled Catalog. This is deliberately
/// separate from the public wire representation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageClass {
    Integer,
    Real,
    Text,
    Blob,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ValueRepresentation {
    String,
    Boolean,
    Number,
    Base64,
    Json,
}

/// Canonical scalar used by Catalog constraints. Numbers are retained as their
/// validated decimal spelling so Catalog equality and snapshot hashing do not
/// inherit floating-point equality semantics.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConstraintScalar {
    String(String),
    Number(String),
    Boolean(bool),
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ValueConstraints {
    pub allowed: Vec<ConstraintScalar>,
    pub minimum: Option<String>,
    pub maximum: Option<String>,
    pub min_length: Option<usize>,
    pub max_length: Option<usize>,
    pub pattern: Option<String>,
}

/// Closed Draft 2020-12 subset retained for finite JSON path type inference.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JsonValueSchema {
    pub types: Vec<JsonSchemaType>,
    pub properties: BTreeMap<String, JsonValueSchema>,
    pub items: Option<Box<JsonValueSchema>>,
    pub required: Vec<String>,
    pub additional_properties: bool,
    pub any_of: Vec<JsonValueSchema>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum JsonSchemaType {
    Null,
    Boolean,
    Integer,
    Number,
    String,
    Array,
    Object,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValueDescriptor {
    pub logical_type: LogicalType,
    pub representation: ValueRepresentation,
    pub nullable: bool,
    pub format: Option<String>,
    pub storage: Option<StorageClass>,
    pub constraints: Option<ValueConstraints>,
    pub json_schema: Option<JsonValueSchema>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LogicalValue {
    Null,
    String(String),
    Boolean(bool),
    Int64(i64),
    Number(f64),
    Bytes(Vec<u8>),
    Json(String),
}

/// Validates a logical value against the immutable Catalog contract. This is
/// used at both ingress and result boundaries; callers must still validate the
/// expression's logical type separately.
#[must_use]
pub fn value_satisfies_contract(value: &LogicalValue, descriptor: &ValueDescriptor) -> bool {
    if matches!(value, LogicalValue::Null) {
        return descriptor.nullable;
    }
    if !format_accepts(value, descriptor.format.as_deref()) {
        return false;
    }
    let Some(constraints) = &descriptor.constraints else {
        return true;
    };
    if !constraints.allowed.is_empty()
        && !constraints
            .allowed
            .iter()
            .any(|allowed| match (value, allowed) {
                (LogicalValue::String(value), ConstraintScalar::String(allowed)) => {
                    value == allowed
                }
                (LogicalValue::Boolean(value), ConstraintScalar::Boolean(allowed)) => {
                    value == allowed
                }
                (LogicalValue::Int64(value), ConstraintScalar::Number(allowed)) => {
                    allowed.parse::<i64>().ok() == Some(*value)
                }
                (LogicalValue::Number(value), ConstraintScalar::Number(allowed)) => {
                    allowed.parse::<f64>().ok() == Some(*value)
                }
                _ => false,
            })
    {
        return false;
    }
    let numeric = match value {
        LogicalValue::Int64(value) => Some(i64_as_f64(*value)),
        LogicalValue::Number(value) => Some(*value),
        _ => None,
    };
    if constraints.minimum.as_deref().is_some_and(|minimum| {
        numeric
            .zip(minimum.parse::<f64>().ok())
            .is_none_or(|(value, minimum)| value < minimum)
    }) || constraints.maximum.as_deref().is_some_and(|maximum| {
        numeric
            .zip(maximum.parse::<f64>().ok())
            .is_none_or(|(value, maximum)| value > maximum)
    }) {
        return false;
    }
    if let LogicalValue::String(value) = value {
        let length = value.chars().count();
        if constraints
            .min_length
            .is_some_and(|minimum| length < minimum)
            || constraints
                .max_length
                .is_some_and(|maximum| length > maximum)
            || constraints.pattern.as_ref().is_some_and(|pattern| {
                regex_lite::Regex::new(pattern)
                    .ok()
                    .is_none_or(|pattern| !pattern.is_match(value))
            })
        {
            return false;
        }
    }
    true
}

fn format_accepts(value: &LogicalValue, format: Option<&str>) -> bool {
    match (format, value) {
        (None | Some("int64" | "base64"), _) => true,
        (Some("uuid"), LogicalValue::String(value)) => {
            value.len() == 36
                && value.bytes().enumerate().all(|(index, byte)| {
                    if [8, 13, 18, 23].contains(&index) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                })
        }
        (Some("email"), LogicalValue::String(value)) => value
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.')),
        (Some("iso-date"), LogicalValue::String(value)) => basic_date(value),
        (Some("sqlite-datetime"), LogicalValue::String(value)) => basic_datetime(value, false),
        (Some("rfc3339"), LogicalValue::String(value)) => basic_datetime(value, true),
        _ => false,
    }
}

fn basic_date(value: &str) -> bool {
    if value.len() != 10
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
    {
        return false;
    }
    let parts = value
        .get(0..4)
        .and_then(|value| value.parse::<u16>().ok())
        .zip(value.get(5..7).and_then(|value| value.parse::<u8>().ok()))
        .zip(value.get(8..10).and_then(|value| value.parse::<u8>().ok()));
    let Some(((year, month), day)) = parts else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=maximum).contains(&day)
}

fn basic_datetime(value: &str, require_offset: bool) -> bool {
    if value.len() < 19
        || !value.get(..10).is_some_and(basic_date)
        || !matches!(value.as_bytes().get(10), Some(b'T' | b' '))
    {
        return false;
    }
    let Some(time) = value.get(11..19) else {
        return false;
    };
    if time.as_bytes().get(2) != Some(&b':') || time.as_bytes().get(5) != Some(&b':') {
        return false;
    }
    if time
        .get(0..2)
        .and_then(|value| value.parse::<u8>().ok())
        .is_none_or(|value| value >= 24)
        || time
            .get(3..5)
            .and_then(|value| value.parse::<u8>().ok())
            .is_none_or(|value| value >= 60)
        || time
            .get(6..8)
            .and_then(|value| value.parse::<u8>().ok())
            .is_none_or(|value| value >= 60)
    {
        return false;
    }
    let mut suffix = value.get(19..).unwrap_or_default();
    if suffix.starts_with('.') {
        let digits = suffix[1..].bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        suffix = &suffix[digits + 1..];
    }
    if !require_offset {
        return suffix.is_empty();
    }
    suffix == "Z"
        || (suffix.len() == 6
            && matches!(suffix.as_bytes().first(), Some(b'+' | b'-'))
            && suffix.as_bytes().get(3) == Some(&b':')
            && suffix
                .get(1..3)
                .and_then(|value| value.parse::<u8>().ok())
                .is_some_and(|value| value < 24)
            && suffix
                .get(4..6)
                .and_then(|value| value.parse::<u8>().ok())
                .is_some_and(|value| value < 60))
}

#[allow(clippy::cast_precision_loss)]
fn i64_as_f64(value: i64) -> f64 {
    value as f64
}

/// Immutable values derived from verified authentication claims.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedSession {
    role: RoleName,
    values: BTreeMap<SessionKey, String>,
}

impl TrustedSession {
    /// Canonicalizes verified authentication values without `SQLite` coercion.
    ///
    /// `session` must not contain the reserved `subject_id` or `role` keys.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid identifiers or reserved-key collisions.
    pub fn new(
        role: RoleName,
        subject_id: impl Into<String>,
        session: BTreeMap<String, String>,
    ) -> Result<Self, CoreError> {
        let subject_id = subject_id.into();
        if subject_id.is_empty() {
            return Err(CoreError::EmptySubject);
        }
        let mut values = BTreeMap::new();
        for (key, value) in session {
            if matches!(key.as_str(), "subject_id" | "role") {
                return Err(CoreError::ReservedSessionKey);
            }
            values.insert(SessionKey::new(key)?, value);
        }
        values.insert(SessionKey::new("subject_id")?, subject_id);
        values.insert(SessionKey::new("role")?, role.as_str().to_owned());
        Ok(Self { role, values })
    }

    #[must_use]
    pub fn role(&self) -> &RoleName {
        &self.role
    }

    #[must_use]
    pub fn get(&self, key: &SessionKey) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CoreError {
    EmptyIdentifier,
    EmptyResultName,
    ZeroIdentity,
    InvalidCanonicalKey,
    InvalidParameterName,
    ReservedParameterNamespace,
    ReservedSessionKey,
    EmptySubject,
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::EmptyIdentifier => "identifier must not be empty",
            Self::EmptyResultName => "result name must not be empty",
            Self::ZeroIdentity => "stable identity must not be zero",
            Self::InvalidCanonicalKey => "key must match ^[a-z][a-z0-9_]*$",
            Self::InvalidParameterName => "parameter name is invalid",
            Self::ReservedParameterNamespace => "parameter uses the reserved server namespace",
            Self::ReservedSessionKey => "session contains a reserved key",
            Self::EmptySubject => "authenticated subject must not be empty",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for CoreError {}

#[cfg(test)]
mod tests {
    use super::{
        ClientParameterName, CoreError, ResourceId, RoleName, ServerParameterName, SessionKey,
        TrustedSession,
    };
    use std::collections::BTreeMap;

    #[test]
    fn rejects_zero_identity() {
        assert_eq!(ResourceId::new(0), Err(CoreError::ZeroIdentity));
    }

    #[test]
    fn separates_client_and_server_parameter_namespaces() {
        assert_eq!(
            ClientParameterName::new("__policysql_session_tenant_id"),
            Err(CoreError::ReservedParameterNamespace)
        );
        let server = ServerParameterName::from_trusted_suffix("session_tenant_id");
        assert_eq!(
            server.as_ref().map(ServerParameterName::as_str),
            Ok("__policysql_session_tenant_id")
        );
    }

    #[test]
    fn trusted_session_is_string_only_and_adds_reserved_values() {
        let role = RoleName::new("member");
        assert!(role.is_ok());
        let session = TrustedSession::new(
            role.unwrap_or_else(|error| unreachable!("validated fixture role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        );
        assert!(session.is_ok());
        let session = session.unwrap_or_else(|error| unreachable!("valid session: {error}"));
        let tenant_key = SessionKey::new("tenant_id");
        assert!(tenant_key.is_ok());
        assert_eq!(
            session.get(&tenant_key.unwrap_or_else(|error| unreachable!("valid key: {error}"))),
            Some("tenant_1")
        );
    }

    #[test]
    fn rejects_client_supplied_reserved_session_key() {
        let role = RoleName::new("member");
        assert!(role.is_ok());
        let result = TrustedSession::new(
            role.unwrap_or_else(|error| unreachable!("validated fixture role: {error}")),
            "user_1",
            BTreeMap::from([("role".to_owned(), "admin".to_owned())]),
        );
        assert_eq!(result, Err(CoreError::ReservedSessionKey));
    }
}
