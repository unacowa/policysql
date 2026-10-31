#![forbid(unsafe_code)]

use policysql_core::{
    BackendProfileId, ClientParameterName, LogicalValue, OperationKind, ResultName,
    ServerParameterName, SnapshotId, ValueDescriptor,
};
use std::collections::BTreeMap;
use std::fmt;
use std::marker::PhantomData;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExecutionLimits {
    pub max_rows: u64,
    pub max_result_bytes: u64,
    pub timeout_ms: u64,
    /// Decoded bytes of one bytes value (parameter, preset, result cell); ADR 0027.
    pub max_bytes_per_value: usize,
}

/// Which downstream complexity limit an emitted statement reached (ADR 0027, "Emitted
/// statement complexity"). Fixed names only: the log carries the name, never SQL text,
/// parameters, or identifiers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComplexityCause {
    /// Expression tree height over the parser's cap.
    Height,
    /// Parser recursion depth over the parser's cap.
    Recursion,
    /// More emitted result columns than the database allows.
    Columns,
    /// More host parameters than the database allows.
    Parameters,
    /// A bound LIKE or GLOB pattern longer than the database allows.
    LikePattern,
    /// The column metadata of the envelope's emitted statements exceeds its memory guard.
    ColumnMetadata,
    /// The database refused the expression tree as too deep.
    DatabaseExpressionDepth,
}

impl ComplexityCause {
    /// The fixed cause name logged as `cause`.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Height => "height",
            Self::Recursion => "recursion",
            Self::Columns => "columns",
            Self::Parameters => "parameters",
            Self::LikePattern => "like_pattern",
            Self::ColumnMetadata => "column_metadata",
            Self::DatabaseExpressionDepth => "database_expression_depth",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResultColumnDescriptor {
    pub name: ResultName,
    pub value: ValueDescriptor,
    /// Finite compiler-proven output types. Scalar descriptors contain one
    /// entry; JSON traversal may contain a stable union.
    pub possible_types: Vec<policysql_core::LogicalType>,
    pub redacted_on_null: bool,
    /// Compiler-owned boolean companion column in the physical database result.
    /// It is removed before the public result is encoded.
    pub visibility_column: Option<ResultName>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CandidateExecutionPlan<Profile> {
    protected_sql: String,
    client_parameters: BTreeMap<ClientParameterName, LogicalValue>,
    server_parameters: BTreeMap<ServerParameterName, LogicalValue>,
    result: Vec<ResultColumnDescriptor>,
    operation: OperationKind,
    limits: ExecutionLimits,
    snapshot: SnapshotId,
    profile_id: BackendProfileId,
    expected_affected_rows: Option<u64>,
    expected_result_rows: Option<u64>,
    operation_check_column: Option<ResultName>,
    column_metadata_bytes: u64,
    marker: PhantomData<Profile>,
}

impl<Profile> CandidateExecutionPlan<Profile> {
    #[must_use]
    pub fn new(
        protected_sql: String,
        operation: OperationKind,
        limits: ExecutionLimits,
        snapshot: SnapshotId,
        profile_id: BackendProfileId,
    ) -> Self {
        Self {
            protected_sql,
            client_parameters: BTreeMap::new(),
            server_parameters: BTreeMap::new(),
            result: Vec::new(),
            operation,
            limits,
            snapshot,
            profile_id,
            marker: PhantomData,
            expected_affected_rows: None,
            expected_result_rows: None,
            operation_check_column: None,
            column_metadata_bytes: 0,
        }
    }

    #[must_use]
    pub fn protected_sql(&self) -> &str {
        &self.protected_sql
    }

    /// Records the exact column-metadata size of the emitted statement (ADR 0027).
    #[must_use]
    pub const fn with_column_metadata_bytes(mut self, bytes: u64) -> Self {
        self.column_metadata_bytes = bytes;
        self
    }

    #[must_use]
    pub fn profile_id(&self) -> &BackendProfileId {
        &self.profile_id
    }

    #[must_use]
    pub fn with_bindings(
        mut self,
        client_parameters: BTreeMap<ClientParameterName, LogicalValue>,
        server_parameters: BTreeMap<ServerParameterName, LogicalValue>,
        result: Vec<ResultColumnDescriptor>,
    ) -> Self {
        self.client_parameters = client_parameters;
        self.server_parameters = server_parameters;
        self.result = result;
        self
    }

    #[must_use]
    pub fn with_mutation_invariants(
        mut self,
        expected_affected_rows: u64,
        operation_check_column: ResultName,
    ) -> Self {
        self.expected_affected_rows = Some(expected_affected_rows);
        self.operation_check_column = Some(operation_check_column);
        self
    }

    #[must_use]
    pub fn with_operation_check(mut self, operation_check_column: ResultName) -> Self {
        self.operation_check_column = Some(operation_check_column);
        self
    }

    #[must_use]
    pub const fn with_expected_affected_rows(mut self, expected_affected_rows: u64) -> Self {
        self.expected_affected_rows = Some(expected_affected_rows);
        self
    }

    #[must_use]
    pub const fn with_expected_result_rows(mut self, expected_result_rows: u64) -> Self {
        self.expected_result_rows = Some(expected_result_rows);
        self
    }

    #[must_use]
    pub fn client_parameters(&self) -> &BTreeMap<ClientParameterName, LogicalValue> {
        &self.client_parameters
    }

    #[must_use]
    pub fn server_parameters(&self) -> &BTreeMap<ServerParameterName, LogicalValue> {
        &self.server_parameters
    }

    #[must_use]
    pub fn result(&self) -> &[ResultColumnDescriptor] {
        &self.result
    }

    #[must_use]
    pub fn operation(&self) -> OperationKind {
        self.operation
    }

    #[must_use]
    pub fn limits(&self) -> ExecutionLimits {
        self.limits
    }

    #[must_use]
    pub fn snapshot(&self) -> &SnapshotId {
        &self.snapshot
    }

    #[must_use]
    pub const fn expected_affected_rows(&self) -> Option<u64> {
        self.expected_affected_rows
    }

    #[must_use]
    pub const fn expected_result_rows(&self) -> Option<u64> {
        self.expected_result_rows
    }

    #[must_use]
    pub fn operation_check_column(&self) -> Option<&ResultName> {
        self.operation_check_column.as_ref()
    }
}

pub trait PlanVerifier<Profile>: Send + Sync {
    /// Verifies dialect-specific syntax and all post-emission invariants.
    ///
    /// # Errors
    ///
    /// Returns a safe error when the candidate is malformed or cannot be proven safe.
    fn verify(&self, candidate: &CandidateExecutionPlan<Profile>) -> Result<(), VerificationError>;

    fn profile_id(&self) -> &BackendProfileId;
}

/// Opaque plan whose fields cannot be constructed or changed by an executor.
///
/// ```compile_fail
/// use policysql_execution::VerifiedExecutionPlan;
/// struct Profile;
/// let _ = VerifiedExecutionPlan::<Profile> { candidate: todo!() };
/// ```
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedExecutionPlan<Profile> {
    candidate: CandidateExecutionPlan<Profile>,
}

impl<Profile> VerifiedExecutionPlan<Profile> {
    /// Runs the matching profile verifier and seals a candidate plan.
    ///
    /// # Errors
    ///
    /// Rejects empty SQL, profile mismatch, or any verifier failure.
    pub fn verify(
        candidate: CandidateExecutionPlan<Profile>,
        verifier: &impl PlanVerifier<Profile>,
    ) -> Result<Self, VerificationError> {
        if candidate.protected_sql.trim().is_empty() {
            return Err(VerificationError::EmptyProtectedSql);
        }
        if candidate.profile_id != *verifier.profile_id() {
            return Err(VerificationError::ProfileMismatch);
        }
        verifier.verify(&candidate)?;
        Ok(Self { candidate })
    }

    #[must_use]
    pub fn protected_sql(&self) -> &str {
        &self.candidate.protected_sql
    }

    #[must_use]
    pub fn operation(&self) -> OperationKind {
        self.candidate.operation
    }

    #[must_use]
    pub fn limits(&self) -> ExecutionLimits {
        self.candidate.limits
    }

    #[must_use]
    pub fn snapshot(&self) -> &SnapshotId {
        &self.candidate.snapshot
    }

    #[must_use]
    pub fn client_parameters(&self) -> &BTreeMap<ClientParameterName, LogicalValue> {
        &self.candidate.client_parameters
    }

    #[must_use]
    pub fn server_parameters(&self) -> &BTreeMap<ServerParameterName, LogicalValue> {
        &self.candidate.server_parameters
    }

    #[must_use]
    pub fn result(&self) -> &[ResultColumnDescriptor] {
        &self.candidate.result
    }

    #[must_use]
    pub const fn expected_affected_rows(&self) -> Option<u64> {
        self.candidate.expected_affected_rows
    }

    #[must_use]
    pub const fn expected_result_rows(&self) -> Option<u64> {
        self.candidate.expected_result_rows
    }

    #[must_use]
    pub fn operation_check_column(&self) -> Option<&ResultName> {
        self.candidate.operation_check_column.as_ref()
    }

    /// The exact `Σ (2·|alias| + 2·|declared type| + 32)` over the emitted result columns.
    #[must_use]
    pub const fn column_metadata_bytes(&self) -> u64 {
        self.candidate.column_metadata_bytes
    }
}

pub trait DatabaseExecutor<Profile>: Send + Sync {
    type Output;
    type Error: std::error::Error + Send + Sync + 'static;

    /// Executes only a verified plan for this exact profile marker.
    ///
    /// # Errors
    ///
    /// Returns a normalized adapter error.
    fn execute(&self, plan: &VerifiedExecutionPlan<Profile>) -> Result<Self::Output, Self::Error>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VerificationError {
    EmptyProtectedSql,
    ProfileMismatch,
    InvariantViolation(String),
}

impl fmt::Display for VerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyProtectedSql => formatter.write_str("protected SQL is empty"),
            Self::ProfileMismatch => formatter.write_str("backend profile does not match plan"),
            Self::InvariantViolation(message) => {
                write!(formatter, "execution invariant failed: {message}")
            }
        }
    }
}

impl std::error::Error for VerificationError {}

#[cfg(test)]
mod tests {
    use super::{
        CandidateExecutionPlan, ExecutionLimits, PlanVerifier, VerificationError,
        VerifiedExecutionPlan,
    };
    use policysql_core::{BackendProfileId, OperationKind, SnapshotId};

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct SqliteProfile;

    #[derive(Debug)]
    struct Verifier {
        profile_id: BackendProfileId,
    }

    impl PlanVerifier<SqliteProfile> for Verifier {
        fn verify(
            &self,
            candidate: &CandidateExecutionPlan<SqliteProfile>,
        ) -> Result<(), VerificationError> {
            if candidate.protected_sql().contains(';') {
                return Err(VerificationError::InvariantViolation(
                    "test verifier rejects semicolons".to_owned(),
                ));
            }
            Ok(())
        }

        fn profile_id(&self) -> &BackendProfileId {
            &self.profile_id
        }
    }

    fn profile_id(value: &str) -> BackendProfileId {
        BackendProfileId::new(value)
            .unwrap_or_else(|error| unreachable!("test profile is valid: {error}"))
    }

    fn candidate(profile: BackendProfileId) -> CandidateExecutionPlan<SqliteProfile> {
        CandidateExecutionPlan::new(
            "SELECT id FROM projects".to_owned(),
            OperationKind::Select,
            ExecutionLimits {
                max_rows: 100,
                max_result_bytes: 10_000,
                timeout_ms: 1_000,
                max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
            },
            SnapshotId::new("snapshot_1")
                .unwrap_or_else(|error| unreachable!("test snapshot is valid: {error}")),
            profile,
        )
    }

    #[test]
    fn profile_mismatch_fails_closed() {
        let verifier = Verifier {
            profile_id: profile_id("sqlite-turso-v1"),
        };
        let result = VerifiedExecutionPlan::verify(candidate(profile_id("other")), &verifier);
        assert_eq!(result, Err(VerificationError::ProfileMismatch));
    }

    #[test]
    fn verifier_failure_does_not_create_plan() {
        let verifier = Verifier {
            profile_id: profile_id("sqlite-turso-v1"),
        };
        let mut candidate = candidate(profile_id("sqlite-turso-v1"));
        candidate.protected_sql.push(';');
        let result = VerifiedExecutionPlan::verify(candidate, &verifier);
        assert!(matches!(
            result,
            Err(VerificationError::InvariantViolation(_))
        ));
    }
}
