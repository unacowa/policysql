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
        }
    }

    #[must_use]
    pub fn protected_sql(&self) -> &str {
        &self.protected_sql
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

pub trait TransactionSession<Profile> {
    type Output;
    type Error: std::error::Error + Send + Sync + 'static;

    /// Executes one sealed plan inside the owned transaction.
    ///
    /// # Errors
    ///
    /// Returns a normalized transactional error.
    fn execute(
        &mut self,
        plan: &VerifiedExecutionPlan<Profile>,
    ) -> Result<Self::Output, Self::Error>;

    /// Durably commits the owned transaction.
    ///
    /// # Errors
    ///
    /// Returns a normalized commit error.
    fn commit(&mut self) -> Result<(), Self::Error>;

    /// Rolls back the owned transaction.
    ///
    /// # Errors
    ///
    /// Returns a normalized rollback error.
    fn rollback(&mut self) -> Result<(), Self::Error>;
}

pub trait TransactionFactory<Profile> {
    type Session: TransactionSession<Profile>;
    type Error: std::error::Error + Send + Sync + 'static;

    /// Opens one explicitly owned transaction.
    ///
    /// # Errors
    ///
    /// Returns a normalized begin error.
    fn begin(&self) -> Result<Self::Session, Self::Error>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CheckDecision {
    Accept,
    Reject,
}

pub trait CommitCheck<Profile, Session>
where
    Session: TransactionSession<Profile>,
{
    type Error: std::error::Error + Send + Sync + 'static;

    /// Validates uncommitted state through a read-only callback capability.
    ///
    /// # Errors
    ///
    /// Timeout, owner loss, malformed protocol, and callback failure are errors.
    fn validate(
        &self,
        callback: &mut ReadOnlyCallback<'_, Profile, Session>,
    ) -> Result<CheckDecision, Self::Error>;
}

pub struct ReadOnlyCallback<'a, Profile, Session>
where
    Session: TransactionSession<Profile>,
{
    session: &'a mut Session,
    marker: PhantomData<Profile>,
}

impl<Profile, Session> fmt::Debug for ReadOnlyCallback<'_, Profile, Session>
where
    Session: TransactionSession<Profile>,
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReadOnlyCallback")
            .finish_non_exhaustive()
    }
}

impl<Profile, Session> ReadOnlyCallback<'_, Profile, Session>
where
    Session: TransactionSession<Profile>,
{
    /// Executes a sealed SELECT against the same uncommitted transaction.
    ///
    /// # Errors
    ///
    /// Rejects every mutation plan before it reaches the transaction adapter.
    pub fn query(
        &mut self,
        plan: &VerifiedExecutionPlan<Profile>,
    ) -> Result<Session::Output, CallbackError<Session::Error>> {
        if plan.operation() != OperationKind::Select {
            return Err(CallbackError::MutationForbidden);
        }
        self.session.execute(plan).map_err(CallbackError::Execution)
    }
}

#[derive(Debug)]
pub enum CallbackError<Error> {
    MutationForbidden,
    Execution(Error),
}

impl<Error: fmt::Display> fmt::Display for CallbackError<Error> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MutationForbidden => formatter.write_str("callback permits SELECT only"),
            Self::Execution(_) => formatter.write_str("callback query failed"),
        }
    }
}

impl<Error: std::error::Error + 'static> std::error::Error for CallbackError<Error> {}

#[derive(Debug)]
pub enum TransactionError<BeginError, SessionError, CheckError> {
    Begin(BeginError),
    Execute(SessionError),
    Check(CheckError),
    CheckRejected,
    Commit(SessionError),
    Rollback(SessionError),
}

impl<BeginError: fmt::Display, SessionError: fmt::Display, CheckError: fmt::Display> fmt::Display
    for TransactionError<BeginError, SessionError, CheckError>
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Begin(_) => "transaction begin failed",
            Self::Execute(_) => "transaction execution failed",
            Self::Check(_) => "commit check failed",
            Self::CheckRejected => "commit check rejected transaction",
            Self::Commit(_) => "transaction commit failed",
            Self::Rollback(_) => "transaction rollback failed",
        })
    }
}

impl<BeginError, SessionError, CheckError> std::error::Error
    for TransactionError<BeginError, SessionError, CheckError>
where
    BeginError: std::error::Error + 'static,
    SessionError: std::error::Error + 'static,
    CheckError: std::error::Error + 'static,
{
}

pub type TransactionOutputs<Profile, Factory> =
    Vec<<<Factory as TransactionFactory<Profile>>::Session as TransactionSession<Profile>>::Output>;

pub type CoordinatedTransactionError<Profile, Factory, Check> = TransactionError<
    <Factory as TransactionFactory<Profile>>::Error,
    <<Factory as TransactionFactory<Profile>>::Session as TransactionSession<Profile>>::Error,
    <Check as CommitCheck<Profile, <Factory as TransactionFactory<Profile>>::Session>>::Error,
>;

/// Runs all plans and checks in one owned transaction, suppressing partial results on failure.
///
/// # Errors
///
/// Any execution/check/commit failure rolls back; rollback failure replaces the prior safe error.
pub fn execute_checked_transaction<Profile, Factory, Check>(
    factory: &Factory,
    plans: &[VerifiedExecutionPlan<Profile>],
    checks: &[Check],
) -> Result<
    TransactionOutputs<Profile, Factory>,
    CoordinatedTransactionError<Profile, Factory, Check>,
>
where
    Factory: TransactionFactory<Profile>,
    Check: CommitCheck<Profile, Factory::Session>,
{
    let mut session = factory.begin().map_err(TransactionError::Begin)?;
    let mut results = Vec::with_capacity(plans.len());
    for plan in plans {
        match session.execute(plan) {
            Ok(result) => results.push(result),
            Err(error) => {
                return match session.rollback() {
                    Ok(()) => Err(TransactionError::Execute(error)),
                    Err(rollback) => Err(TransactionError::Rollback(rollback)),
                };
            }
        }
    }
    for check in checks {
        let decision = {
            let mut callback = ReadOnlyCallback {
                session: &mut session,
                marker: PhantomData,
            };
            check.validate(&mut callback)
        };
        match decision {
            Ok(CheckDecision::Accept) => {}
            Ok(CheckDecision::Reject) => {
                return match session.rollback() {
                    Ok(()) => Err(TransactionError::CheckRejected),
                    Err(rollback) => Err(TransactionError::Rollback(rollback)),
                };
            }
            Err(error) => {
                return match session.rollback() {
                    Ok(()) => Err(TransactionError::Check(error)),
                    Err(rollback) => Err(TransactionError::Rollback(rollback)),
                };
            }
        }
    }
    if let Err(error) = session.commit() {
        return match session.rollback() {
            Ok(()) => Err(TransactionError::Commit(error)),
            Err(rollback) => Err(TransactionError::Rollback(rollback)),
        };
    }
    Ok(results)
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
        CandidateExecutionPlan, CheckDecision, CommitCheck, ExecutionLimits, PlanVerifier,
        ReadOnlyCallback, TransactionError, TransactionFactory, TransactionSession,
        VerificationError, VerifiedExecutionPlan, execute_checked_transaction,
    };
    use policysql_core::{BackendProfileId, OperationKind, SnapshotId};
    use std::fmt;
    use std::sync::{Arc, Mutex};

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

    #[derive(Clone, Copy, Debug)]
    struct TestError;

    impl fmt::Display for TestError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("test transaction error")
        }
    }

    impl std::error::Error for TestError {}

    #[derive(Clone, Debug, Default)]
    struct State {
        executed: usize,
        committed: bool,
        rolled_back: bool,
    }

    #[derive(Clone, Debug)]
    struct Factory(Arc<Mutex<State>>);

    #[derive(Debug)]
    struct Session(Arc<Mutex<State>>);

    impl TransactionFactory<SqliteProfile> for Factory {
        type Session = Session;
        type Error = TestError;

        fn begin(&self) -> Result<Self::Session, Self::Error> {
            Ok(Session(self.0.clone()))
        }
    }

    impl TransactionSession<SqliteProfile> for Session {
        type Output = ();
        type Error = TestError;

        fn execute(
            &mut self,
            _plan: &VerifiedExecutionPlan<SqliteProfile>,
        ) -> Result<Self::Output, Self::Error> {
            let mut state = self.0.lock().map_err(|_| TestError)?;
            state.executed += 1;
            Ok(())
        }

        fn commit(&mut self) -> Result<(), Self::Error> {
            self.0.lock().map_err(|_| TestError)?.committed = true;
            Ok(())
        }

        fn rollback(&mut self) -> Result<(), Self::Error> {
            self.0.lock().map_err(|_| TestError)?.rolled_back = true;
            Ok(())
        }
    }

    #[derive(Clone, Copy, Debug)]
    struct Decision(CheckDecision);

    impl CommitCheck<SqliteProfile, Session> for Decision {
        type Error = TestError;

        fn validate(
            &self,
            callback: &mut ReadOnlyCallback<'_, SqliteProfile, Session>,
        ) -> Result<CheckDecision, Self::Error> {
            if self.0 == CheckDecision::Accept {
                let verifier = Verifier {
                    profile_id: profile_id("sqlite-turso-v1"),
                };
                let plan = VerifiedExecutionPlan::verify(
                    candidate(profile_id("sqlite-turso-v1")),
                    &verifier,
                )
                .map_err(|_| TestError)?;
                callback.query(&plan).map_err(|_| TestError)?;
            }
            Ok(self.0)
        }
    }

    #[derive(Clone, Copy, Debug)]
    struct MutationCallbackAttempt;

    impl CommitCheck<SqliteProfile, Session> for MutationCallbackAttempt {
        type Error = TestError;

        fn validate(
            &self,
            callback: &mut ReadOnlyCallback<'_, SqliteProfile, Session>,
        ) -> Result<CheckDecision, Self::Error> {
            let verifier = Verifier {
                profile_id: profile_id("sqlite-turso-v1"),
            };
            let mutation = CandidateExecutionPlan::new(
                "DELETE FROM projects".to_owned(),
                OperationKind::Delete,
                ExecutionLimits {
                    max_rows: 100,
                    max_result_bytes: 10_000,
                    timeout_ms: 1_000,
                },
                SnapshotId::new("snapshot_1")
                    .unwrap_or_else(|error| unreachable!("valid snapshot: {error}")),
                profile_id("sqlite-turso-v1"),
            );
            let mutation =
                VerifiedExecutionPlan::verify(mutation, &verifier).map_err(|_| TestError)?;
            callback.query(&mutation).map_err(|_| TestError)?;
            Ok(CheckDecision::Accept)
        }
    }

    fn verified() -> VerifiedExecutionPlan<SqliteProfile> {
        let verifier = Verifier {
            profile_id: profile_id("sqlite-turso-v1"),
        };
        VerifiedExecutionPlan::verify(candidate(profile_id("sqlite-turso-v1")), &verifier)
            .unwrap_or_else(|error| unreachable!("valid plan: {error}"))
    }

    #[test]
    fn commit_check_accepts_then_commits_same_transaction() {
        let state = Arc::new(Mutex::new(State::default()));
        let result = execute_checked_transaction(
            &Factory(state.clone()),
            &[verified()],
            &[Decision(CheckDecision::Accept)],
        );
        assert!(result.is_ok());
        let state = state
            .lock()
            .unwrap_or_else(|error| unreachable!("test mutex: {error}"));
        assert_eq!(state.executed, 2);
        assert!(state.committed);
        assert!(!state.rolled_back);
    }

    #[test]
    fn rejected_commit_check_rolls_back_and_suppresses_results() {
        let state = Arc::new(Mutex::new(State::default()));
        let result = execute_checked_transaction(
            &Factory(state.clone()),
            &[verified()],
            &[Decision(CheckDecision::Reject)],
        );
        assert!(matches!(result, Err(TransactionError::CheckRejected)));
        let state = state
            .lock()
            .unwrap_or_else(|error| unreachable!("test mutex: {error}"));
        assert!(!state.committed);
        assert!(state.rolled_back);
    }

    #[test]
    fn callback_mutation_is_rejected_before_session_execution_and_rolls_back() {
        let state = Arc::new(Mutex::new(State::default()));
        let result = execute_checked_transaction(
            &Factory(state.clone()),
            &[verified()],
            &[MutationCallbackAttempt],
        );
        assert!(matches!(result, Err(TransactionError::Check(TestError))));
        let state = state
            .lock()
            .unwrap_or_else(|error| unreachable!("test mutex: {error}"));
        assert_eq!(state.executed, 1);
        assert!(!state.committed);
        assert!(state.rolled_back);
    }
}
