#![forbid(unsafe_code)]

use policysql_catalog::Catalog;
use policysql_core::{ClientParameterName, LogicalValue, SnapshotId, TrustedSession};
use policysql_execution::{
    CommitCheck, DatabaseExecutor, ExecutionLimits, TransactionFactory, TransactionOutputs,
    VerifiedExecutionPlan, execute_checked_transaction,
};
use policysql_ir::BoundStatement;
use policysql_parser::{BindError, SqliteFrontend};
use policysql_policy::{Explain, PolicyBundle, PolicyError};
use policysql_sqlite::{
    CompileError, SqliteProfile, compile_verified_delete, compile_verified_insert,
    compile_verified_select, compile_verified_update,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum EndpointPermission {
    Execute,
    Explain,
    Catalog,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthContext {
    session: TrustedSession,
    permissions: BTreeSet<EndpointPermission>,
}

impl AuthContext {
    #[must_use]
    pub fn new(
        session: TrustedSession,
        permissions: impl IntoIterator<Item = EndpointPermission>,
    ) -> Self {
        Self {
            session,
            permissions: permissions.into_iter().collect(),
        }
    }

    #[must_use]
    pub const fn session(&self) -> &TrustedSession {
        &self.session
    }
}

pub trait JwtVerifier: Send + Sync {
    type Error: std::error::Error + Send + Sync + 'static;

    /// Verifies one external credential and canonicalizes its trusted session.
    ///
    /// # Errors
    ///
    /// Rejects invalid, ambiguous, expired, or unauthorized credentials.
    fn verify(&self, credential: &str) -> Result<AuthContext, Self::Error>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct StatementRequest {
    pub sql: String,
    pub parameters: BTreeMap<ClientParameterName, LogicalValue>,
    pub expected_affected_rows: Option<u64>,
    pub expected_row_count: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct CompiledStatement {
    pub plan: VerifiedExecutionPlan<SqliteProfile>,
    pub explain: Explain,
}

#[derive(Clone, Debug)]
pub struct CompiledEnvelope {
    pub statements: Vec<CompiledStatement>,
}

#[derive(Clone, Debug)]
pub struct Gateway {
    catalog: Catalog,
    policies: PolicyBundle,
    snapshot: SnapshotId,
    limits: ExecutionLimits,
    max_statements: usize,
}

impl Gateway {
    #[must_use]
    pub const fn new(
        catalog: Catalog,
        policies: PolicyBundle,
        snapshot: SnapshotId,
        limits: ExecutionLimits,
        max_statements: usize,
    ) -> Self {
        Self {
            catalog,
            policies,
            snapshot,
            limits,
            max_statements,
        }
    }

    #[must_use]
    pub const fn limits(&self) -> ExecutionLimits {
        self.limits
    }

    /// Compiles and verifies every item before returning any executable plan.
    ///
    /// # Errors
    ///
    /// Fails the whole envelope on access, snapshot, size, binding, policy, or verification error.
    #[allow(clippy::too_many_lines)]
    pub fn compile_envelope(
        &self,
        auth: &AuthContext,
        permission: EndpointPermission,
        precondition: Option<&SnapshotId>,
        requests: &[StatementRequest],
    ) -> Result<CompiledEnvelope, GatewayError> {
        if !auth.permissions.contains(&permission) {
            return Err(GatewayError::AccessDenied);
        }
        if precondition.is_some_and(|value| value != &self.snapshot) {
            return Err(GatewayError::SnapshotMismatch);
        }
        if requests.is_empty() || requests.len() > self.max_statements {
            return Err(GatewayError::EnvelopeLimit);
        }
        let frontend = SqliteFrontend::default();
        let mut statements = Vec::with_capacity(requests.len());
        for (index, request) in requests.iter().enumerate() {
            let statement = frontend
                .bind(&request.sql, &self.catalog)
                .map_err(|error| GatewayError::Rejected {
                    kind: classify_bind_error(&error),
                    index,
                })?;
            let mut output = match &statement {
                BoundStatement::Select(_)
                | BoundStatement::ConstantSelect(_)
                | BoundStatement::JsonCollectionSelect(_) => {
                    self.policies.compile_select(&statement, &auth.session)
                }
                BoundStatement::Insert(_) => {
                    self.policies.compile_insert(&statement, &auth.session)
                }
                BoundStatement::Update(_) => {
                    self.policies.compile_update(&statement, &auth.session)
                }
                BoundStatement::Delete(_) => {
                    self.policies.compile_delete(&statement, &auth.session)
                }
            }
            .map_err(|error| GatewayError::Rejected {
                kind: policy_rejection(&error),
                index,
            })?;
            match (
                &output.plan.statement,
                request.expected_affected_rows,
                output.plan.expected_affected_rows,
            ) {
                (
                    BoundStatement::Select(_)
                    | BoundStatement::ConstantSelect(_)
                    | BoundStatement::JsonCollectionSelect(_),
                    Some(_),
                    _,
                ) => {
                    return Err(GatewayError::Rejected {
                        kind: RejectionKind::InvalidRequest,
                        index,
                    });
                }
                (_, Some(requested), Some(compiled)) if requested != compiled => {
                    return Err(GatewayError::Rejected {
                        kind: RejectionKind::ExpectationFailed,
                        index,
                    });
                }
                (_, None, _) => {}
                (_, Some(requested), _) => {
                    output.plan.expected_affected_rows = Some(requested);
                }
            }
            output.plan.expected_result_rows = request
                .expected_row_count
                .or(output.plan.expected_result_rows);
            let plan = match &output.plan.statement {
                BoundStatement::Select(_)
                | BoundStatement::ConstantSelect(_)
                | BoundStatement::JsonCollectionSelect(_) => compile_verified_select(
                    &output.plan,
                    &self.catalog,
                    request.parameters.clone(),
                    self.limits,
                    self.snapshot.clone(),
                ),
                BoundStatement::Insert(_) => compile_verified_insert(
                    &output.plan,
                    &self.catalog,
                    request.parameters.clone(),
                    self.limits,
                    self.snapshot.clone(),
                ),
                BoundStatement::Update(_) => compile_verified_update(
                    &output.plan,
                    &self.catalog,
                    request.parameters.clone(),
                    self.limits,
                    self.snapshot.clone(),
                ),
                BoundStatement::Delete(_) => compile_verified_delete(
                    &output.plan,
                    &self.catalog,
                    request.parameters.clone(),
                    self.limits,
                    self.snapshot.clone(),
                ),
            }
            .map_err(|error| GatewayError::Rejected {
                kind: compile_rejection(&error),
                index,
            })?;
            statements.push(CompiledStatement {
                plan,
                explain: output.explain,
            });
        }
        Ok(CompiledEnvelope { statements })
    }

    /// Compiles the complete envelope before making the first executor call.
    ///
    /// # Errors
    ///
    /// Returns no partial result when compilation or an executor call fails.
    pub fn execute_atomic<E: DatabaseExecutor<SqliteProfile>>(
        &self,
        auth: &AuthContext,
        precondition: Option<&SnapshotId>,
        requests: &[StatementRequest],
        executor: &E,
    ) -> Result<Vec<E::Output>, GatewayError> {
        let compiled =
            self.compile_envelope(auth, EndpointPermission::Execute, precondition, requests)?;
        if compiled
            .statements
            .iter()
            .any(|statement| statement.plan.operation() != policysql_core::OperationKind::Select)
        {
            return Err(GatewayError::TransactionRequired);
        }
        let mut results = Vec::with_capacity(compiled.statements.len());
        for statement in &compiled.statements {
            results.push(
                executor
                    .execute(&statement.plan)
                    .map_err(|_| GatewayError::ExecutionFailed)?,
            );
        }
        Ok(results)
    }

    /// Compiles the whole envelope and executes it inside one owned transaction.
    ///
    /// # Errors
    ///
    /// Any compile, execute, commit-check, commit, or rollback failure suppresses all results.
    pub fn execute_transactional<Factory, Check>(
        &self,
        auth: &AuthContext,
        precondition: Option<&SnapshotId>,
        requests: &[StatementRequest],
        factory: &Factory,
        checks: &[Check],
    ) -> Result<TransactionOutputs<SqliteProfile, Factory>, GatewayError>
    where
        Factory: TransactionFactory<SqliteProfile>,
        Check: CommitCheck<SqliteProfile, Factory::Session>,
    {
        let compiled =
            self.compile_envelope(auth, EndpointPermission::Execute, precondition, requests)?;
        let plans = compiled
            .statements
            .into_iter()
            .map(|statement| statement.plan)
            .collect::<Vec<_>>();
        execute_checked_transaction(factory, &plans, checks)
            .map_err(|_| GatewayError::ExecutionFailed)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RejectionKind {
    InvalidRequest,
    InvalidSql,
    MultipleStatements,
    UnsupportedSql,
    MissingPolicy,
    ForbiddenOperation,
    ForbiddenColumn,
    ForbiddenColumnContext,
    DuplicateResultColumn,
    InvalidParameter,
    AmbiguousParameterType,
    ReservedParameter,
    PresetColumn,
    LimitExceeded,
    ExpectationFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GatewayError {
    AccessDenied,
    SnapshotMismatch,
    EnvelopeLimit,
    Rejected { kind: RejectionKind, index: usize },
    ExecutionFailed,
    TransactionRequired,
}

impl fmt::Display for GatewayError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AccessDenied => "endpoint access denied",
            Self::SnapshotMismatch => "snapshot precondition failed",
            Self::EnvelopeLimit => "request envelope is invalid",
            Self::Rejected { .. } => "statement was rejected",
            Self::ExecutionFailed => "database execution failed",
            Self::TransactionRequired => "mutation requires an owned transaction",
        })
    }
}

#[must_use]
pub const fn classify_bind_error(error: &BindError) -> RejectionKind {
    match error {
        BindError::Empty | BindError::InvalidSql => RejectionKind::InvalidSql,
        BindError::MultipleStatements => RejectionKind::MultipleStatements,
        BindError::UnknownColumn | BindError::AmbiguousColumn | BindError::ImplicitRowId => {
            RejectionKind::ForbiddenColumn
        }
        BindError::DuplicateResultName | BindError::InvalidResultName => {
            RejectionKind::DuplicateResultColumn
        }
        BindError::ReservedParameterNamespace => RejectionKind::ReservedParameter,
        BindError::UnprovableParameterType => RejectionKind::AmbiguousParameterType,
        BindError::InvalidParameterName
        | BindError::PositionalParameter
        | BindError::UnsupportedParameterPrefix
        | BindError::IncompatibleTypes
        | BindError::NullComparison
        | BindError::InvalidLiteral => RejectionKind::InvalidParameter,
        BindError::ProjectionLimit
        | BindError::JoinLimit
        | BindError::ParameterLimit
        | BindError::ExpressionDepth
        | BindError::InvalidLimit => RejectionKind::LimitExceeded,
        BindError::UnknownResource => RejectionKind::ForbiddenOperation,
        BindError::Unsupported(_)
        | BindError::MissingFrom
        | BindError::DuplicateAlias
        | BindError::DuplicateWriteColumn
        | BindError::InsertArity => RejectionKind::UnsupportedSql,
    }
}

const fn policy_rejection(error: &PolicyError) -> RejectionKind {
    match error {
        PolicyError::MissingPolicy => RejectionKind::MissingPolicy,
        PolicyError::ForbiddenColumn | PolicyError::UnknownColumn => RejectionKind::ForbiddenColumn,
        PolicyError::ForbiddenColumnContext => RejectionKind::ForbiddenColumnContext,
        PolicyError::PresetColumnOverlap => RejectionKind::PresetColumn,
        PolicyError::TooManyPolicies => RejectionKind::LimitExceeded,
        PolicyError::UnsupportedCapability
        | PolicyError::InvalidBundle
        | PolicyError::InvalidRole
        | PolicyError::UnknownResource
        | PolicyError::UnknownOperator
        | PolicyError::InvalidPredicate
        | PolicyError::IncompatibleOperand
        | PolicyError::NullComparison
        | PolicyError::UnsupportedRedaction
        | PolicyError::DuplicateColumnPermission
        | PolicyError::DuplicatePolicy
        | PolicyError::MissingSessionValue
        | PolicyError::InvalidSessionKey
        | PolicyError::InvariantViolation(_) => RejectionKind::ForbiddenOperation,
    }
}

const fn compile_rejection(error: &CompileError) -> RejectionKind {
    match error {
        CompileError::ClientParameterMismatch | CompileError::ClientParameterTypeMismatch => {
            RejectionKind::InvalidParameter
        }
        CompileError::Emit(_) | CompileError::Verification(_) => RejectionKind::UnsupportedSql,
    }
}

impl std::error::Error for GatewayError {}

#[cfg(test)]
mod tests {
    use super::{
        AuthContext, EndpointPermission, Gateway, GatewayError, RejectionKind, StatementRequest,
    };
    use policysql_catalog::{Catalog, ResourceDescriptor};
    use policysql_core::{
        ColumnName, LogicalType, ResourceId, ResourceName, RoleName, SnapshotId, TrustedSession,
        ValueDescriptor, ValueRepresentation,
    };
    use policysql_execution::{DatabaseExecutor, ExecutionLimits, VerifiedExecutionPlan};
    use policysql_policy::PolicyBundle;
    use policysql_sqlite::SqliteProfile;
    use std::collections::BTreeMap;
    use std::fmt;
    use std::sync::Mutex;

    fn snapshot() -> SnapshotId {
        SnapshotId::new("gateway_1").unwrap_or_else(|error| unreachable!("valid snapshot: {error}"))
    }

    fn gateway() -> (Gateway, AuthContext) {
        let descriptor = ValueDescriptor {
            logical_type: LogicalType::String,
            representation: ValueRepresentation::String,
            nullable: false,
            format: None,
            storage: None,
            constraints: None,
            json_schema: None,
        };
        let resource = ResourceDescriptor::new(
            ResourceId::new(1).unwrap_or_else(|error| unreachable!("valid ID: {error}")),
            ResourceName::new("projects")
                .unwrap_or_else(|error| unreachable!("valid resource: {error}")),
            ["id", "tenant_id", "private_note"].map(|name| {
                (
                    ColumnName::new(name)
                        .unwrap_or_else(|error| unreachable!("valid column: {error}")),
                    descriptor.clone(),
                )
            }),
        )
        .unwrap_or_else(|error| unreachable!("valid resource: {error}"));
        let catalog = Catalog::new(snapshot(), [resource])
            .unwrap_or_else(|error| unreachable!("valid Catalog: {error}"));
        let policy = PolicyBundle::activate(
            r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 10
        insert:
          columns: [id]
          presets:
            tenant_id: { session: tenant_id }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id] }
",
            &catalog,
            snapshot(),
        )
        .unwrap_or_else(|error| unreachable!("valid policy: {error}"));
        let session = TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("valid role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("valid session: {error}"));
        (
            Gateway::new(
                catalog,
                policy,
                snapshot(),
                ExecutionLimits {
                    max_rows: 10,
                    max_result_bytes: 1_000,
                    timeout_ms: 1_000,
                },
                4,
            ),
            AuthContext::new(session, [EndpointPermission::Execute]),
        )
    }

    #[derive(Debug)]
    struct TestError;

    impl fmt::Display for TestError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("test executor failed")
        }
    }

    impl std::error::Error for TestError {}

    #[derive(Debug, Default)]
    struct CountingExecutor {
        calls: Mutex<usize>,
    }

    impl DatabaseExecutor<SqliteProfile> for CountingExecutor {
        type Output = ();
        type Error = TestError;

        fn execute(
            &self,
            _plan: &VerifiedExecutionPlan<SqliteProfile>,
        ) -> Result<Self::Output, Self::Error> {
            let mut calls = self.calls.lock().map_err(|_| TestError)?;
            *calls += 1;
            Ok(())
        }
    }

    #[test]
    fn compiles_all_items_before_first_executor_call() {
        let (gateway, auth) = gateway();
        let executor = CountingExecutor::default();
        let requests = [
            StatementRequest {
                sql: "SELECT id FROM projects".to_owned(),
                parameters: BTreeMap::new(),
                expected_affected_rows: None,
                expected_row_count: None,
            },
            StatementRequest {
                sql: "SELECT private_note FROM projects".to_owned(),
                parameters: BTreeMap::new(),
                expected_affected_rows: None,
                expected_row_count: None,
            },
        ];
        assert_eq!(
            gateway.execute_atomic(&auth, Some(&snapshot()), &requests, &executor),
            Err(GatewayError::Rejected {
                kind: RejectionKind::ForbiddenColumn,
                index: 1,
            })
        );
        let calls = executor
            .calls
            .lock()
            .unwrap_or_else(|error| unreachable!("test mutex is healthy: {error}"));
        assert_eq!(*calls, 0);
    }

    #[test]
    fn endpoint_permission_and_snapshot_are_enforced_before_compile() {
        let (gateway, auth) = gateway();
        let request = [StatementRequest {
            sql: "SELECT id FROM projects".to_owned(),
            parameters: BTreeMap::new(),
            expected_affected_rows: None,
            expected_row_count: None,
        }];
        assert_eq!(
            gateway
                .compile_envelope(&auth, EndpointPermission::Explain, None, &request)
                .map(|_| ()),
            Err(GatewayError::AccessDenied)
        );
        let stale = SnapshotId::new("stale")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        assert_eq!(
            gateway
                .compile_envelope(&auth, EndpointPermission::Execute, Some(&stale), &request)
                .map(|_| ()),
            Err(GatewayError::SnapshotMismatch)
        );
    }

    #[test]
    fn mutation_compiles_but_cannot_cross_the_read_executor_boundary() {
        let (gateway, auth) = gateway();
        let executor = CountingExecutor::default();
        let request = [StatementRequest {
            sql: "INSERT INTO projects (id) VALUES (:id) RETURNING id".to_owned(),
            parameters: BTreeMap::from([(
                policysql_core::ClientParameterName::new("id")
                    .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
                policysql_core::LogicalValue::String("p1".to_owned()),
            )]),
            expected_affected_rows: Some(1),
            expected_row_count: Some(1),
        }];
        let compiled = gateway
            .compile_envelope(&auth, EndpointPermission::Execute, None, &request)
            .unwrap_or_else(|error| unreachable!("mutation compiles: {error}"));
        assert_eq!(
            compiled.statements[0].plan.operation(),
            policysql_core::OperationKind::Insert
        );
        assert_eq!(compiled.statements[0].plan.expected_result_rows(), Some(1));
        assert_eq!(
            gateway.execute_atomic(&auth, None, &request, &executor),
            Err(GatewayError::TransactionRequired)
        );
        assert_eq!(
            *executor
                .calls
                .lock()
                .unwrap_or_else(|error| unreachable!("test mutex: {error}")),
            0
        );
    }
}
