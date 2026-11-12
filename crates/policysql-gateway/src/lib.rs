#![forbid(unsafe_code)]

use policysql_catalog::Catalog;
use policysql_core::{
    ClientParameterName, ExpectationKind, LogicalValue, SnapshotId, TrustedSession,
};
use policysql_execution::{
    ComplexityCause, DatabaseExecutor, ExecutionLimits, VerificationError, VerifiedExecutionPlan,
};
use policysql_ir::BoundStatement;
use policysql_parser::{BindError, BindingLimits, SourceSpan, SqliteFrontend, UnsupportedFeature};
use policysql_policy::{Explain, PolicyBundle, PolicyError};
use policysql_sqlite::{
    ClientParameterContract, CompileError, EmitError, SqliteProfile, analyze_client_parameters,
    compile_verified_delete, compile_verified_insert, compile_verified_select,
    compile_verified_update,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum EndpointPermission {
    Execute,
    Explain,
    Catalog,
    Debug,
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
    /// Client parameter contracts of the exact protected statement whose
    /// supplied values were accepted, including the NULL proof. Explain
    /// metadata must be derived from this, never re-inferred from values.
    pub client_parameters: BTreeMap<ClientParameterName, ClientParameterContract>,
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
    binding_limits: BindingLimits,
}

/// The column metadata of one envelope's emitted statements may use this many bytes of the raw
/// response (ADR 0027, "Fixed protocol constants"): a memory guard measured on the compiled
/// statements, `Σ (2·|alias| + 2·|declared type| + 32)` over every emitted result column.
pub const MAX_COLUMN_METADATA_BYTES: u64 = 1_048_576;

impl Gateway {
    #[must_use]
    pub fn new(
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
            binding_limits: BindingLimits::default(),
        }
    }

    /// Sets the input-side limits the binder enforces on the client's SQL.
    #[must_use]
    pub const fn with_binding_limits(mut self, binding_limits: BindingLimits) -> Self {
        self.binding_limits = binding_limits;
        self
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
        let frontend = SqliteFrontend::new(self.binding_limits);
        let mut statements = Vec::with_capacity(requests.len());
        let mut metadata_bytes = 0_u64;
        for (index, request) in requests.iter().enumerate() {
            let document = frontend
                .bind_document(&request.sql, &self.catalog)
                .map_err(|error| GatewayError::Rejected {
                    rejection: classify_bind_error(&error),
                    index,
                })?;
            let statement = document.statement;
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
                rejection: policy_rejection(&error),
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
                        rejection: Rejection::plain(
                            RejectionKind::InvalidRequest,
                            "gateway.SelectExpectation",
                        ),
                        index,
                    });
                }
                (_, Some(requested), Some(compiled)) if requested != compiled => {
                    return Err(GatewayError::Rejected {
                        rejection: Rejection {
                            kind: RejectionKind::ExpectationFailed,
                            detail: Some(RejectionDetail::Expectation(
                                ExpectationKind::AffectedRows,
                            )),
                            reason: "gateway.ExpectationMismatch",
                            shape: None,
                        },
                        index,
                    });
                }
                (_, None, _) => {}
                (_, Some(requested), _) => {
                    output.plan.expected_affected_rows = Some(requested);
                }
            }
            output.plan.string_literals.client = document.string_literals;
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
            .map_err(|error| compile_failure(&error, index))?;
            metadata_bytes = metadata_bytes.saturating_add(plan.column_metadata_bytes());
            if metadata_bytes > MAX_COLUMN_METADATA_BYTES {
                return Err(GatewayError::TooComplex {
                    cause: ComplexityCause::ColumnMetadata,
                    index,
                });
            }
            // Same pass and statement that `compile_verified_*` validated against.
            let client_parameters =
                analyze_client_parameters(&output.plan.statement, &self.catalog)
                    .contracts()
                    .map_err(|_| GatewayError::Rejected {
                        rejection: Rejection {
                            kind: RejectionKind::InvalidParameter,
                            detail: Some(RejectionDetail::Parameter(ParameterReason::Type)),
                            reason: "compile.ParameterContracts",
                            shape: None,
                        },
                        index,
                    })?
                    .clone();
            statements.push(CompiledStatement {
                plan,
                explain: output.explain,
                client_parameters,
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

/// Why a client parameter was rejected. Public as `error.detail.reason`; never names the parameter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParameterReason {
    /// A parameter without a name (`?`, `?1`).
    Positional,
    /// A prefix other than `:` (`$x`, `@x`).
    Prefix,
    /// A parameter name that breaks the naming rule.
    Name,
    /// A comparison, assignment or function argument of the wrong type.
    Type,
    /// A comparison with NULL.
    Null,
    /// A literal the binder cannot read.
    Literal,
    /// A supplied value that does not fit the parameter's type or contract.
    Value,
    /// The supplied parameter names differ from the SQL's (missing or extra).
    Names,
}

impl ParameterReason {
    pub const ALL: [Self; 8] = [
        Self::Positional,
        Self::Prefix,
        Self::Name,
        Self::Type,
        Self::Null,
        Self::Literal,
        Self::Value,
        Self::Names,
    ];

    /// The public `error.detail.reason` value.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Positional => "positional",
            Self::Prefix => "prefix",
            Self::Name => "name",
            Self::Type => "type",
            Self::Null => "null",
            Self::Literal => "literal",
            Self::Value => "value",
            Self::Names => "names",
        }
    }
}

/// The public, fixed-vocabulary detail of a rejection (`error.detail`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RejectionDetail {
    Feature(UnsupportedFeature),
    Span(SourceSpan),
    Parameter(ParameterReason),
    Expectation(ExpectationKind),
}

/// A rejection: the public kind and detail, plus the internal reason that is only logged.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rejection {
    pub kind: RejectionKind,
    pub detail: Option<RejectionDetail>,
    /// The fixed internal reason (`bind.UnknownColumn`), logged and never returned.
    pub reason: &'static str,
    /// The binder's internal shape for `bind.Unsupported`, logged only.
    pub shape: Option<&'static str>,
}

impl Rejection {
    /// A rejection without a public detail.
    #[must_use]
    pub const fn plain(kind: RejectionKind, reason: &'static str) -> Self {
        Self {
            kind,
            detail: None,
            reason,
            shape: None,
        }
    }

    /// A rejection whose public detail is `detail`.
    #[must_use]
    pub const fn with_detail(
        kind: RejectionKind,
        detail: RejectionDetail,
        reason: &'static str,
    ) -> Self {
        Self {
            kind,
            detail: Some(detail),
            reason,
            shape: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GatewayError {
    AccessDenied,
    SnapshotMismatch,
    EnvelopeLimit,
    Rejected {
        rejection: Rejection,
        index: usize,
    },
    /// The emitted statement `index` reached a downstream complexity limit (ADR 0027).
    TooComplex {
        cause: ComplexityCause,
        index: usize,
    },
    /// The emitted SQL of statement `index` does not parse again: an emitter bug, answered as an
    /// internal failure and never as the client's error.
    EmittedSqlInvalid {
        index: usize,
    },
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
            Self::TooComplex { .. } => "statement is too complex",
            Self::EmittedSqlInvalid { .. } => "emitted statement is invalid",
            Self::ExecutionFailed => "database execution failed",
            Self::TransactionRequired => "mutation requires an owned transaction",
        })
    }
}

#[must_use]
pub const fn classify_bind_error(error: &BindError) -> Rejection {
    use RejectionKind as Kind;
    match error {
        BindError::Empty => Rejection::plain(Kind::InvalidSql, "bind.Empty"),
        BindError::InvalidSql(span) => Rejection {
            kind: Kind::InvalidSql,
            detail: match span {
                Some(span) => Some(RejectionDetail::Span(*span)),
                None => None,
            },
            reason: "bind.InvalidSql",
            shape: None,
        },
        BindError::MultipleStatements => {
            Rejection::plain(Kind::MultipleStatements, "bind.MultipleStatements")
        }
        BindError::UnknownColumn => Rejection::plain(Kind::ForbiddenColumn, "bind.UnknownColumn"),
        BindError::AmbiguousColumn => {
            Rejection::plain(Kind::ForbiddenColumn, "bind.AmbiguousColumn")
        }
        BindError::ImplicitRowId => Rejection::plain(Kind::ForbiddenColumn, "bind.ImplicitRowId"),
        BindError::DuplicateResultName => {
            Rejection::plain(Kind::DuplicateResultColumn, "bind.DuplicateResultName")
        }
        BindError::InvalidResultName => {
            Rejection::plain(Kind::DuplicateResultColumn, "bind.InvalidResultName")
        }
        BindError::ReservedParameterNamespace => {
            Rejection::plain(Kind::ReservedParameter, "bind.ReservedParameterNamespace")
        }
        BindError::UnprovableParameterType => {
            Rejection::plain(Kind::AmbiguousParameterType, "bind.UnprovableParameterType")
        }
        BindError::InvalidParameterName => {
            parameter_rejection(ParameterReason::Name, "bind.InvalidParameterName")
        }
        BindError::PositionalParameter => {
            parameter_rejection(ParameterReason::Positional, "bind.PositionalParameter")
        }
        BindError::UnsupportedParameterPrefix => {
            parameter_rejection(ParameterReason::Prefix, "bind.UnsupportedParameterPrefix")
        }
        BindError::IncompatibleTypes => {
            parameter_rejection(ParameterReason::Type, "bind.IncompatibleTypes")
        }
        BindError::NullComparison => {
            parameter_rejection(ParameterReason::Null, "bind.NullComparison")
        }
        BindError::InvalidLiteral => {
            parameter_rejection(ParameterReason::Literal, "bind.InvalidLiteral")
        }
        BindError::ProjectionLimit => Rejection::plain(Kind::LimitExceeded, "bind.ProjectionLimit"),
        BindError::JoinLimit => Rejection::plain(Kind::LimitExceeded, "bind.JoinLimit"),
        BindError::ParameterLimit => Rejection::plain(Kind::LimitExceeded, "bind.ParameterLimit"),
        BindError::ExpressionDepth => Rejection::plain(Kind::LimitExceeded, "bind.ExpressionDepth"),
        BindError::InvalidLimit => Rejection::plain(Kind::LimitExceeded, "bind.InvalidLimit"),
        BindError::UnknownResource => {
            Rejection::plain(Kind::ForbiddenOperation, "bind.UnknownResource")
        }
        BindError::Unsupported(feature, shape) => Rejection {
            kind: Kind::UnsupportedSql,
            detail: Some(RejectionDetail::Feature(*feature)),
            reason: "bind.Unsupported",
            shape: Some(shape),
        },
        BindError::MissingFrom => {
            feature_rejection(UnsupportedFeature::MissingFrom, "bind.MissingFrom")
        }
        BindError::DuplicateAlias => {
            feature_rejection(UnsupportedFeature::DuplicateAlias, "bind.DuplicateAlias")
        }
        BindError::DuplicateWriteColumn => feature_rejection(
            UnsupportedFeature::DuplicateWriteColumn,
            "bind.DuplicateWriteColumn",
        ),
        BindError::InsertArity => {
            feature_rejection(UnsupportedFeature::InsertArity, "bind.InsertArity")
        }
    }
}

const fn parameter_rejection(reason: ParameterReason, internal: &'static str) -> Rejection {
    Rejection::with_detail(
        RejectionKind::InvalidParameter,
        RejectionDetail::Parameter(reason),
        internal,
    )
}

const fn feature_rejection(feature: UnsupportedFeature, internal: &'static str) -> Rejection {
    Rejection::with_detail(
        RejectionKind::UnsupportedSql,
        RejectionDetail::Feature(feature),
        internal,
    )
}

const fn policy_rejection(error: &PolicyError) -> Rejection {
    use RejectionKind as Kind;
    match error {
        PolicyError::MissingPolicy => Rejection::plain(Kind::MissingPolicy, "policy.MissingPolicy"),
        PolicyError::ForbiddenColumn => {
            Rejection::plain(Kind::ForbiddenColumn, "policy.ForbiddenColumn")
        }
        PolicyError::UnknownColumn => {
            Rejection::plain(Kind::ForbiddenColumn, "policy.UnknownColumn")
        }
        PolicyError::ForbiddenColumnContext => Rejection::plain(
            Kind::ForbiddenColumnContext,
            "policy.ForbiddenColumnContext",
        ),
        PolicyError::PresetColumnOverlap => {
            Rejection::plain(Kind::PresetColumn, "policy.PresetColumnOverlap")
        }
        PolicyError::TooManyPolicies => {
            Rejection::plain(Kind::LimitExceeded, "policy.TooManyPolicies")
        }
        PolicyError::UnsupportedCapability => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.UnsupportedCapability")
        }
        PolicyError::InvalidBundle => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.InvalidBundle")
        }
        PolicyError::InvalidRole => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.InvalidRole")
        }
        PolicyError::UnknownResource => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.UnknownResource")
        }
        PolicyError::UnknownOperator => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.UnknownOperator")
        }
        PolicyError::InvalidPredicate => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.InvalidPredicate")
        }
        PolicyError::BytesPresetTooLarge => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.BytesPresetTooLarge")
        }
        PolicyError::IncompatibleOperand => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.IncompatibleOperand")
        }
        PolicyError::NullComparison => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.NullComparison")
        }
        PolicyError::UnsupportedRedaction => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.UnsupportedRedaction")
        }
        PolicyError::DuplicateColumnPermission => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.DuplicateColumnPermission")
        }
        PolicyError::DuplicatePolicy => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.DuplicatePolicy")
        }
        PolicyError::MissingSessionValue => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.MissingSessionValue")
        }
        PolicyError::InvalidSessionKey => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.InvalidSessionKey")
        }
        PolicyError::InvariantViolation(_) => {
            Rejection::plain(Kind::ForbiddenOperation, "policy.InvariantViolation")
        }
    }
}

fn compile_failure(error: &CompileError, index: usize) -> GatewayError {
    match error {
        CompileError::ClientParameterMismatch => GatewayError::Rejected {
            rejection: parameter_rejection(
                ParameterReason::Names,
                "compile.ClientParameterMismatch",
            ),
            index,
        },
        CompileError::ClientParameterTypeMismatch => GatewayError::Rejected {
            rejection: parameter_rejection(
                ParameterReason::Value,
                "compile.ClientParameterTypeMismatch",
            ),
            index,
        },
        CompileError::Emit(EmitError::TooComplex(cause)) => GatewayError::TooComplex {
            cause: *cause,
            index,
        },
        CompileError::Emit(EmitError::ReparseFailed) => GatewayError::EmittedSqlInvalid { index },
        CompileError::Emit(error) => GatewayError::Rejected {
            rejection: feature_rejection(
                UnsupportedFeature::ProtectedStatement,
                emit_reason(error),
            ),
            index,
        },
        CompileError::Verification(error) => GatewayError::Rejected {
            rejection: feature_rejection(
                UnsupportedFeature::ProtectedStatement,
                verify_reason(error),
            ),
            index,
        },
    }
}

const fn emit_reason(error: &EmitError) -> &'static str {
    match error {
        EmitError::UnsupportedStatement => "emit.UnsupportedStatement",
        EmitError::UnknownResource => "emit.UnknownResource",
        EmitError::UnknownColumn => "emit.UnknownColumn",
        EmitError::MissingServerParameter(_) => "emit.MissingServerParameter",
        EmitError::LiteralRequiresParameter => "emit.LiteralRequiresParameter",
        EmitError::UnsupportedValue => "emit.UnsupportedValue",
        EmitError::TooManyLiterals => "emit.TooManyLiterals",
        EmitError::Formatting => "emit.Formatting",
        EmitError::InvariantViolation(_) => "emit.InvariantViolation",
        EmitError::TooComplex(_) => "emit.TooComplex",
        EmitError::ReparseFailed => "emit.ReparseFailed",
    }
}

const fn verify_reason(error: &VerificationError) -> &'static str {
    match error {
        VerificationError::EmptyProtectedSql => "verify.EmptyProtectedSql",
        VerificationError::ProfileMismatch => "verify.ProfileMismatch",
        VerificationError::InvariantViolation(_) => "verify.InvariantViolation",
    }
}

impl std::error::Error for GatewayError {}

#[cfg(test)]
mod tests {
    use super::{
        AuthContext, EndpointPermission, Gateway, GatewayError, ParameterReason, Rejection,
        RejectionDetail, RejectionKind, StatementRequest, classify_bind_error, emit_reason,
        verify_reason,
    };
    use policysql_catalog::{Catalog, ResourceDescriptor};
    use policysql_core::{
        ColumnName, LogicalType, ResourceId, ResourceName, RoleName, SnapshotId, TrustedSession,
        ValueDescriptor, ValueRepresentation,
    };
    use policysql_execution::{DatabaseExecutor, ExecutionLimits, VerifiedExecutionPlan};
    use policysql_parser::{BindError, SourceSpan, UnsupportedFeature};
    use policysql_policy::PolicyBundle;
    use policysql_sqlite::EmitError;
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
                    max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
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
                rejection: Rejection {
                    kind: RejectionKind::ForbiddenColumn,
                    detail: None,
                    reason: "policy.ForbiddenColumn",
                    shape: None,
                },
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

    #[test]
    fn internal_reasons_follow_the_variant_names() {
        for (error, name) in [
            (EmitError::UnsupportedStatement, "UnsupportedStatement"),
            (EmitError::Formatting, "Formatting"),
            (
                EmitError::MissingServerParameter("x".to_owned()),
                "MissingServerParameter",
            ),
            (
                EmitError::InvariantViolation("x".to_owned()),
                "InvariantViolation",
            ),
        ] {
            assert_eq!(error.name(), name);
            assert_eq!(emit_reason(&error), format!("emit.{name}"));
        }
        let verification = policysql_execution::VerificationError::ProfileMismatch;
        assert_eq!(
            verify_reason(&verification),
            format!("verify.{}", verification.name())
        );
    }

    #[test]
    fn bind_errors_carry_a_public_detail_and_a_private_reason() {
        let span = SourceSpan { start: 3, end: 5 };
        let rejection = classify_bind_error(&BindError::InvalidSql(Some(span)));
        assert_eq!(rejection.kind, RejectionKind::InvalidSql);
        assert_eq!(rejection.detail, Some(RejectionDetail::Span(span)));
        assert_eq!(
            classify_bind_error(&BindError::InvalidSql(None)).detail,
            None
        );
        let rejection = classify_bind_error(&BindError::Unsupported(
            UnsupportedFeature::Cte,
            "CTE shadows protected resource",
        ));
        assert_eq!(rejection.reason, "bind.Unsupported");
        assert_eq!(rejection.shape, Some("CTE shadows protected resource"));
        assert_eq!(
            rejection.detail,
            Some(RejectionDetail::Feature(UnsupportedFeature::Cte))
        );
        assert_eq!(
            classify_bind_error(&BindError::PositionalParameter).detail,
            Some(RejectionDetail::Parameter(ParameterReason::Positional))
        );
        // A forbidden column and a missing one answer with the same kind and no detail.
        let unknown = classify_bind_error(&BindError::UnknownColumn);
        assert_eq!(unknown.kind, RejectionKind::ForbiddenColumn);
        assert_eq!(unknown.detail, None);
        assert_eq!(
            Rejection::plain(RejectionKind::ForbiddenColumn, "policy.ForbiddenColumn").kind,
            unknown.kind
        );
    }

    #[test]
    fn parameter_reason_names_are_unique() {
        let names = ParameterReason::ALL.map(ParameterReason::name);
        let unique: std::collections::BTreeSet<_> = names.iter().collect();
        assert_eq!(unique.len(), 8);
    }
}
