#![forbid(unsafe_code)]

use policysql_core::{ConstraintScalar, LogicalType, LogicalValue, ValueDescriptor};
use policysql_execution::{
    DatabaseExecutor, TransactionFactory, TransactionSession, VerifiedExecutionPlan,
};
use policysql_sqlite::SqliteProfile;
use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub struct ExecuteResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<LogicalValue>>,
    pub redactions: Vec<Vec<bool>>,
    pub affected_rows: u64,
}

/// Turso transport boundary. Arbitrary SQL strings are intentionally not accepted.
pub trait TursoTransport: Send + Sync {
    /// Executes a plan sealed by the `SQLite` profile verifier.
    ///
    /// # Errors
    ///
    /// Returns a normalized transport, limit, or database error.
    fn execute(
        &self,
        plan: &VerifiedExecutionPlan<SqliteProfile>,
    ) -> Result<ExecuteResult, AdapterError>;
}

#[derive(Debug)]
pub struct TursoExecutor<Transport> {
    transport: Transport,
}

impl<Transport> TursoExecutor<Transport> {
    #[must_use]
    pub const fn new(transport: Transport) -> Self {
        Self { transport }
    }
}

impl<Transport: TursoTransport> DatabaseExecutor<SqliteProfile> for TursoExecutor<Transport> {
    type Output = ExecuteResult;
    type Error = AdapterError;

    fn execute(
        &self,
        plan: &VerifiedExecutionPlan<SqliteProfile>,
    ) -> Result<Self::Output, Self::Error> {
        if plan.operation() != policysql_core::OperationKind::Select {
            return Err(AdapterError::TransactionRequired);
        }
        let mut result = self.transport.execute(plan)?;
        validate_result(plan, &mut result)?;
        Ok(result)
    }
}

fn validate_result(
    plan: &VerifiedExecutionPlan<SqliteProfile>,
    result: &mut ExecuteResult,
) -> Result<(), AdapterError> {
    if result.affected_rows != 0 {
        return Err(AdapterError::InvalidResult);
    }
    if !result.redactions.is_empty() {
        return Err(AdapterError::InvalidResult);
    }
    validate_public_result(plan, result)
}

/// Validates an untrusted remote result against a profile-sealed execution plan.
///
/// # Errors
///
/// Rejects column, value, cardinality, mutation-check, and configured limit mismatches.
pub fn validate_sealed_result(
    plan: &VerifiedExecutionPlan<SqliteProfile>,
    result: &mut ExecuteResult,
) -> Result<(), AdapterError> {
    if plan.operation() == policysql_core::OperationKind::Select {
        validate_result(plan, result)
    } else {
        validate_mutation_result(plan, result)
    }
}

fn validate_public_result(
    plan: &VerifiedExecutionPlan<SqliteProfile>,
    result: &mut ExecuteResult,
) -> Result<(), AdapterError> {
    if !result.redactions.is_empty() {
        return Err(AdapterError::InvalidResult);
    }
    strip_visibility_columns(plan, result)?;
    let expected_columns = plan
        .result()
        .iter()
        .map(|column| column.name.as_str())
        .collect::<Vec<_>>();
    if result
        .columns
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        != expected_columns
    {
        return Err(AdapterError::InvalidResult);
    }
    if u64::try_from(result.rows.len()).unwrap_or(u64::MAX) > plan.limits().max_rows {
        return Err(AdapterError::LimitExceeded);
    }
    let mut bytes = 0_u64;
    for (row_index, row) in result.rows.iter().enumerate() {
        if row.len() != plan.result().len() {
            return Err(AdapterError::InvalidResult);
        }
        for (value, descriptor) in row.iter().zip(plan.result()) {
            validate_value(value, &descriptor.value, &descriptor.possible_types)?;
            bytes = bytes
                .checked_add(value_size(value))
                .ok_or(AdapterError::LimitExceeded)?;
            if bytes > plan.limits().max_result_bytes {
                return Err(AdapterError::LimitExceeded);
            }
        }
        if result.redactions.get(row_index).is_none_or(|flags| {
            flags.len() != row.len()
                || flags
                    .iter()
                    .zip(plan.result())
                    .any(|(flag, descriptor)| *flag && !descriptor.redacted_on_null)
        }) {
            return Err(AdapterError::InvalidResult);
        }
    }
    if plan
        .expected_result_rows()
        .is_some_and(|expected| u64::try_from(result.rows.len()).ok() != Some(expected))
    {
        return Err(AdapterError::ExpectationFailed);
    }
    Ok(())
}

fn physical_result_columns(plan: &VerifiedExecutionPlan<SqliteProfile>) -> Vec<String> {
    plan.result()
        .iter()
        .flat_map(|descriptor| {
            std::iter::once(descriptor.name.as_str().to_owned()).chain(
                descriptor
                    .visibility_column
                    .iter()
                    .map(|name| name.as_str().to_owned()),
            )
        })
        .collect()
}

fn strip_visibility_columns(
    plan: &VerifiedExecutionPlan<SqliteProfile>,
    result: &mut ExecuteResult,
) -> Result<(), AdapterError> {
    if result.columns != physical_result_columns(plan) {
        return Err(AdapterError::InvalidResult);
    }
    let mut public_rows = Vec::with_capacity(result.rows.len());
    let mut redactions = Vec::with_capacity(result.rows.len());
    for physical_row in &result.rows {
        let mut position = 0_usize;
        let mut public_row = Vec::with_capacity(plan.result().len());
        let mut row_redactions = Vec::with_capacity(plan.result().len());
        for descriptor in plan.result() {
            let value = physical_row
                .get(position)
                .cloned()
                .ok_or(AdapterError::InvalidResult)?;
            position += 1;
            let redacted = if descriptor.visibility_column.is_some() {
                let visible = match physical_row.get(position) {
                    Some(LogicalValue::Boolean(value)) => *value,
                    _ => return Err(AdapterError::InvalidResult),
                };
                position += 1;
                if !visible && value != LogicalValue::Null {
                    return Err(AdapterError::InvalidResult);
                }
                !visible
            } else {
                false
            };
            public_row.push(value);
            row_redactions.push(redacted);
        }
        if position != physical_row.len() {
            return Err(AdapterError::InvalidResult);
        }
        public_rows.push(public_row);
        redactions.push(row_redactions);
    }
    result.columns = plan
        .result()
        .iter()
        .map(|descriptor| descriptor.name.as_str().to_owned())
        .collect();
    result.rows = public_rows;
    result.redactions = redactions;
    Ok(())
}

/// Backend-owned transaction handle. It never accepts arbitrary SQL.
pub trait TursoTransaction: Send {
    /// Executes a sealed statement in this transaction.
    ///
    /// # Errors
    ///
    /// Returns a normalized adapter failure.
    fn execute(
        &mut self,
        plan: &VerifiedExecutionPlan<SqliteProfile>,
    ) -> Result<ExecuteResult, AdapterError>;

    /// Commits this transaction.
    ///
    /// # Errors
    ///
    /// Returns a normalized commit failure.
    fn commit(&mut self) -> Result<(), AdapterError>;

    /// Rolls this transaction back.
    ///
    /// # Errors
    ///
    /// Returns a normalized rollback failure.
    fn rollback(&mut self) -> Result<(), AdapterError>;
}

/// Opens an explicitly owned Turso transaction.
pub trait TursoTransactionTransport: Send + Sync {
    type Transaction: TursoTransaction;

    /// Begins a transaction owned by `PolicySQL`.
    ///
    /// # Errors
    ///
    /// Returns a normalized begin failure.
    fn begin(&self) -> Result<Self::Transaction, AdapterError>;
}

#[derive(Debug)]
pub struct TursoTransactionFactory<Transport> {
    transport: Transport,
}

impl<Transport> TursoTransactionFactory<Transport> {
    #[must_use]
    pub const fn new(transport: Transport) -> Self {
        Self { transport }
    }
}

#[derive(Debug)]
pub struct TursoTransactionSession<Transaction> {
    transaction: Transaction,
}

impl<Transport: TursoTransactionTransport> TransactionFactory<SqliteProfile>
    for TursoTransactionFactory<Transport>
{
    type Session = TursoTransactionSession<Transport::Transaction>;
    type Error = AdapterError;

    fn begin(&self) -> Result<Self::Session, Self::Error> {
        self.transport
            .begin()
            .map(|transaction| TursoTransactionSession { transaction })
    }
}

impl<Transaction: TursoTransaction> TransactionSession<SqliteProfile>
    for TursoTransactionSession<Transaction>
{
    type Output = ExecuteResult;
    type Error = AdapterError;

    fn execute(
        &mut self,
        plan: &VerifiedExecutionPlan<SqliteProfile>,
    ) -> Result<Self::Output, Self::Error> {
        let mut result = self.transaction.execute(plan)?;
        if plan.operation() == policysql_core::OperationKind::Select {
            validate_result(plan, &mut result)?;
        } else {
            validate_mutation_result(plan, &mut result)?;
        }
        Ok(result)
    }

    fn commit(&mut self) -> Result<(), Self::Error> {
        self.transaction.commit()
    }

    fn rollback(&mut self) -> Result<(), Self::Error> {
        self.transaction.rollback()
    }
}

fn validate_mutation_result(
    plan: &VerifiedExecutionPlan<SqliteProfile>,
    result: &mut ExecuteResult,
) -> Result<(), AdapterError> {
    if !result.redactions.is_empty() {
        return Err(AdapterError::InvalidResult);
    }
    if plan
        .expected_affected_rows()
        .is_some_and(|expected| result.affected_rows != expected)
    {
        return Err(AdapterError::ExpectationFailed);
    }
    if let Some(check_column) = plan.operation_check_column() {
        let mut expected_columns = physical_result_columns(plan);
        expected_columns.push(check_column.as_str().to_owned());
        if result.columns != expected_columns
            || u64::try_from(result.rows.len()).ok() != Some(result.affected_rows)
        {
            return Err(AdapterError::InvalidResult);
        }
        for row in &mut result.rows {
            if row.pop() != Some(LogicalValue::Boolean(true)) {
                return Err(AdapterError::Rejected(
                    "mutation post-state check failed".to_owned(),
                ));
            }
        }
        result.columns.pop();
        if plan.result().is_empty() {
            result.rows.clear();
        }
    } else {
        if result.columns != physical_result_columns(plan) {
            return Err(AdapterError::InvalidResult);
        }
        if !plan.result().is_empty()
            && u64::try_from(result.rows.len()).ok() != Some(result.affected_rows)
        {
            return Err(AdapterError::InvalidResult);
        }
    }
    let affected_rows = result.affected_rows;
    result.affected_rows = 0;
    validate_public_result(plan, result)?;
    result.affected_rows = affected_rows;
    Ok(())
}

fn validate_value(
    value: &LogicalValue,
    descriptor: &ValueDescriptor,
    possible_types: &[LogicalType],
) -> Result<(), AdapterError> {
    if matches!(value, LogicalValue::Null) {
        return if descriptor.nullable {
            Ok(())
        } else {
            Err(AdapterError::InvalidResult)
        };
    }
    let type_matches = possible_types
        .iter()
        .any(|logical_type| match (value, logical_type) {
            (
                LogicalValue::String(_),
                LogicalType::String
                | LogicalType::Date
                | LogicalType::DateTime
                | LogicalType::Instant,
            )
            | (LogicalValue::Boolean(_), LogicalType::Boolean)
            | (LogicalValue::Int64(_), LogicalType::Integer | LogicalType::Int64)
            | (LogicalValue::Bytes(_), LogicalType::Bytes)
            | (LogicalValue::Json(_), LogicalType::Json) => true,
            (LogicalValue::Number(value), LogicalType::Number) => value.is_finite(),
            _ => false,
        });
    if !type_matches
        || (descriptor.logical_type == LogicalType::Integer
            && matches!(value, LogicalValue::Int64(value) if value.unsigned_abs() > 9_007_199_254_740_991))
    {
        return Err(AdapterError::InvalidResult);
    }
    validate_format(value, descriptor)?;
    validate_constraints(value, descriptor)
}

fn validate_format(value: &LogicalValue, descriptor: &ValueDescriptor) -> Result<(), AdapterError> {
    let valid = match (descriptor.format.as_deref(), value) {
        (None | Some("int64" | "base64"), _) => true,
        (Some("uuid"), LogicalValue::String(value)) => valid_uuid(value),
        (Some("email"), LogicalValue::String(value)) => valid_email(value),
        (Some("iso-date"), LogicalValue::String(value)) => valid_date(value),
        (Some("sqlite-datetime"), LogicalValue::String(value)) => valid_datetime(value, false),
        (Some("rfc3339"), LogicalValue::String(value)) => valid_datetime(value, true),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(AdapterError::InvalidResult)
    }
}

fn validate_constraints(
    value: &LogicalValue,
    descriptor: &ValueDescriptor,
) -> Result<(), AdapterError> {
    let Some(constraints) = &descriptor.constraints else {
        return Ok(());
    };
    if !constraints.allowed.is_empty()
        && !constraints
            .allowed
            .iter()
            .any(|allowed| constraint_equal(value, allowed))
    {
        return Err(AdapterError::InvalidResult);
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
        return Err(AdapterError::InvalidResult);
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
            return Err(AdapterError::InvalidResult);
        }
    }
    Ok(())
}

fn constraint_equal(value: &LogicalValue, allowed: &ConstraintScalar) -> bool {
    match (value, allowed) {
        (LogicalValue::String(value), ConstraintScalar::String(allowed)) => value == allowed,
        (LogicalValue::Boolean(value), ConstraintScalar::Boolean(allowed)) => value == allowed,
        (LogicalValue::Int64(value), ConstraintScalar::Number(allowed)) => {
            allowed.parse::<i64>().ok() == Some(*value)
        }
        (LogicalValue::Number(value), ConstraintScalar::Number(allowed)) => {
            allowed.parse::<f64>().ok() == Some(*value)
        }
        _ => false,
    }
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[allow(clippy::cast_precision_loss)]
fn i64_as_f64(value: i64) -> f64 {
    value as f64
}

fn valid_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && local.len() <= 64
        && domain.len() <= 253
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain.contains('.')
        && !value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
}

fn valid_date(value: &str) -> bool {
    if value.len() != 10
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
    {
        return false;
    }
    let parts = value
        .get(0..4)
        .and_then(|value| value.parse::<u32>().ok())
        .zip(value.get(5..7).and_then(|value| value.parse::<u32>().ok()))
        .zip(value.get(8..10).and_then(|value| value.parse::<u32>().ok()));
    let Some(((year, month), day)) = parts else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

fn valid_datetime(value: &str, require_offset: bool) -> bool {
    if value.len() < 19
        || !valid_date(&value[..10])
        || !matches!(value.as_bytes().get(10), Some(b'T' | b' '))
    {
        return false;
    }
    let time = &value[11..19];
    if time.as_bytes().get(2) != Some(&b':') || time.as_bytes().get(5) != Some(&b':') {
        return false;
    }
    let valid_time = time[0..2].parse::<u32>().ok().is_some_and(|hour| hour < 24)
        && time[3..5]
            .parse::<u32>()
            .ok()
            .is_some_and(|minute| minute < 60)
        && time[6..8]
            .parse::<u32>()
            .ok()
            .is_some_and(|second| second < 60);
    if !valid_time {
        return false;
    }
    let mut suffix = &value[19..];
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
    if suffix == "Z" || suffix == "z" {
        return true;
    }
    suffix.len() == 6
        && matches!(suffix.as_bytes().first(), Some(b'+' | b'-'))
        && suffix.as_bytes().get(3) == Some(&b':')
        && suffix[1..3]
            .parse::<u32>()
            .ok()
            .is_some_and(|hour| hour <= 23)
        && suffix[4..6]
            .parse::<u32>()
            .ok()
            .is_some_and(|minute| minute <= 59)
}

fn value_size(value: &LogicalValue) -> u64 {
    match value {
        LogicalValue::Null => 0,
        LogicalValue::String(value) | LogicalValue::Json(value) => {
            u64::try_from(value.len()).unwrap_or(u64::MAX)
        }
        LogicalValue::Boolean(_) => 1,
        LogicalValue::Int64(_) | LogicalValue::Number(_) => 8,
        LogicalValue::Bytes(value) => u64::try_from(value.len()).unwrap_or(u64::MAX),
    }
}

/// Storage boundary for retry records. Implementations must bind records to the
/// canonical authenticated context, endpoint, and payload digest.
pub trait IdempotencyStore: Send + Sync {
    type Error: std::error::Error + Send + Sync + 'static;

    /// Atomically claims a canonical key or returns the previously committed digest.
    ///
    /// # Errors
    ///
    /// Returns a normalized storage error without exposing backend details.
    fn claim(&self, key: &str, context_digest: &[u8]) -> Result<ClaimResult, Self::Error>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimResult {
    Claimed,
    ExistingMatch,
    ExistingConflict,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdapterError {
    NotConfigured,
    Timeout,
    LimitExceeded,
    ExpectationFailed,
    InvalidResult,
    Conflict,
    TransactionRequired,
    Rejected(String),
    Remote,
}

impl fmt::Display for AdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfigured => formatter.write_str("database adapter is not configured"),
            Self::Timeout => formatter.write_str("database operation timed out"),
            Self::LimitExceeded => {
                formatter.write_str("database result exceeded configured limits")
            }
            Self::ExpectationFailed => {
                formatter.write_str("database result did not satisfy the declared expectation")
            }
            Self::InvalidResult => formatter.write_str("database returned an invalid result"),
            Self::Conflict => formatter.write_str("database transaction conflicted"),
            Self::TransactionRequired => {
                formatter.write_str("mutation requires an owned transaction")
            }
            Self::Rejected(message) => {
                write!(formatter, "database operation was rejected: {message}")
            }
            Self::Remote => formatter.write_str("remote database operation failed"),
        }
    }
}

impl std::error::Error for AdapterError {}

/// A profile mismatch is a compile-time error at the Turso boundary.
///
/// ```compile_fail
/// use policysql_execution::VerifiedExecutionPlan;
/// use policysql_turso::TursoTransport;
/// struct PostgresProfile;
/// fn execute_wrong<T: TursoTransport>(transport: &T, plan: &VerifiedExecutionPlan<PostgresProfile>) {
///     let _ = transport.execute(plan);
/// }
/// ```
fn _profile_type_safety_documentation() {}

#[cfg(test)]
mod tests {
    use super::{
        AdapterError, ExecuteResult, TursoExecutor, TursoTransaction, TursoTransactionFactory,
        TursoTransactionTransport, TursoTransport, validate_value,
    };
    use policysql_catalog::{Catalog, ResourceDescriptor};
    use policysql_core::{
        ColumnId, ColumnName, ConstraintScalar, LogicalType, LogicalValue, PolicyId, ResourceId,
        ResourceName, ResultName, SnapshotId, ValueConstraints, ValueDescriptor,
        ValueRepresentation,
    };
    use policysql_execution::{
        CheckDecision, CommitCheck, DatabaseExecutor, ExecutionLimits, ReadOnlyCallback,
        TransactionError, VerifiedExecutionPlan, execute_checked_transaction,
    };
    use policysql_ir::{
        BoundAssignment, BoundColumn, BoundExpr, BoundInsert, BoundProjection, BoundSelect,
        BoundStatement, ColumnUsage, ProtectedPlan,
    };
    use policysql_sqlite::{SqliteProfile, compile_verified_insert, compile_verified_select};
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    fn plan() -> VerifiedExecutionPlan<SqliteProfile> {
        let resource_id =
            ResourceId::new(1).unwrap_or_else(|error| unreachable!("valid ID: {error}"));
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
            resource_id,
            ResourceName::new("projects")
                .unwrap_or_else(|error| unreachable!("valid resource: {error}")),
            [(
                ColumnName::new("id").unwrap_or_else(|error| unreachable!("valid column: {error}")),
                descriptor,
            )],
        )
        .unwrap_or_else(|error| unreachable!("valid resource: {error}"));
        let snapshot = SnapshotId::new("turso_1")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        let catalog = Catalog::new(snapshot.clone(), [resource])
            .unwrap_or_else(|error| unreachable!("valid Catalog: {error}"));
        let protected = ProtectedPlan {
            statement: BoundStatement::Select(Box::new(BoundSelect {
                resource: resource_id,
                alias: None,
                joins: Vec::new(),
                projections: vec![BoundProjection {
                    expression: BoundExpr::Column(BoundColumn {
                        id: ColumnId::new(resource_id, 0),
                        logical_type: LogicalType::String,
                        usage: ColumnUsage::Projection,
                    }),
                    output_name: ResultName::new("id")
                        .unwrap_or_else(|error| unreachable!("valid result: {error}")),
                }],
                predicate: Some(BoundExpr::Equal(
                    Box::new(BoundExpr::Literal(LogicalValue::Int64(1))),
                    Box::new(BoundExpr::Literal(LogicalValue::Int64(1))),
                )),
                group_by: Vec::new(),
                having: None,
                order_by: Vec::new(),
                limit: Some(BoundExpr::Literal(LogicalValue::Int64(2))),
                offset: None,
            })),
            applied_policies: vec![
                PolicyId::new(1).unwrap_or_else(|error| unreachable!("valid policy: {error}")),
            ],
            server_values: BTreeMap::new(),
            policy_limit: Some(2),
            operation_check: None,
            expected_affected_rows: None,
            expected_result_rows: Some(1),
        };
        compile_verified_select(
            &protected,
            &catalog,
            BTreeMap::new(),
            ExecutionLimits {
                max_rows: 2,
                max_result_bytes: 32,
                timeout_ms: 1_000,
            },
            snapshot,
        )
        .unwrap_or_else(|error| unreachable!("valid plan: {error}"))
    }

    fn mutation_plan() -> VerifiedExecutionPlan<SqliteProfile> {
        let resource_id =
            ResourceId::new(1).unwrap_or_else(|error| unreachable!("valid ID: {error}"));
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
            resource_id,
            ResourceName::new("projects")
                .unwrap_or_else(|error| unreachable!("valid resource: {error}")),
            [(
                ColumnName::new("id").unwrap_or_else(|error| unreachable!("valid column: {error}")),
                descriptor,
            )],
        )
        .unwrap_or_else(|error| unreachable!("valid resource: {error}"));
        let snapshot = SnapshotId::new("turso_mutation_1")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        let catalog = Catalog::new(snapshot.clone(), [resource])
            .unwrap_or_else(|error| unreachable!("valid Catalog: {error}"));
        let column = BoundColumn {
            id: ColumnId::new(resource_id, 0),
            logical_type: LogicalType::String,
            usage: ColumnUsage::Write,
        };
        let protected = ProtectedPlan {
            statement: BoundStatement::Insert(BoundInsert {
                resource: resource_id,
                rows: vec![vec![BoundAssignment {
                    column: column.clone(),
                    value: BoundExpr::Literal(LogicalValue::String("project_1".to_owned())),
                }]],
                returning: vec![BoundProjection {
                    expression: BoundExpr::Column(BoundColumn {
                        usage: ColumnUsage::Returning,
                        ..column
                    }),
                    output_name: ResultName::new("id")
                        .unwrap_or_else(|error| unreachable!("valid result: {error}")),
                }],
            }),
            applied_policies: vec![
                PolicyId::new(1).unwrap_or_else(|error| unreachable!("valid policy: {error}")),
            ],
            server_values: BTreeMap::new(),
            policy_limit: None,
            operation_check: Some(BoundExpr::Literal(LogicalValue::Boolean(true))),
            expected_affected_rows: Some(1),
            expected_result_rows: Some(1),
        };
        compile_verified_insert(
            &protected,
            &catalog,
            BTreeMap::new(),
            ExecutionLimits {
                max_rows: 2,
                max_result_bytes: 32,
                timeout_ms: 1_000,
            },
            snapshot,
        )
        .unwrap_or_else(|error| unreachable!("valid mutation plan: {error}"))
    }

    fn conditional_plan() -> VerifiedExecutionPlan<SqliteProfile> {
        let resource_id =
            ResourceId::new(1).unwrap_or_else(|error| unreachable!("valid ID: {error}"));
        let descriptor = ValueDescriptor {
            logical_type: LogicalType::String,
            representation: ValueRepresentation::String,
            nullable: true,
            format: None,
            storage: None,
            constraints: None,
            json_schema: None,
        };
        let resource = ResourceDescriptor::new(
            resource_id,
            ResourceName::new("projects")
                .unwrap_or_else(|error| unreachable!("valid resource: {error}")),
            [(
                ColumnName::new("private_note")
                    .unwrap_or_else(|error| unreachable!("valid column: {error}")),
                descriptor,
            )],
        )
        .unwrap_or_else(|error| unreachable!("valid resource: {error}"));
        let snapshot = SnapshotId::new("turso_conditional_1")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        let catalog = Catalog::new(snapshot.clone(), [resource])
            .unwrap_or_else(|error| unreachable!("valid Catalog: {error}"));
        let column = BoundExpr::Column(BoundColumn {
            id: ColumnId::new(resource_id, 0),
            logical_type: LogicalType::String,
            usage: ColumnUsage::Projection,
        });
        let protected = ProtectedPlan {
            statement: BoundStatement::Select(Box::new(BoundSelect {
                resource: resource_id,
                alias: None,
                joins: Vec::new(),
                projections: vec![BoundProjection {
                    expression: BoundExpr::ConditionalOutput {
                        value: Box::new(column),
                        visible_if: Box::new(BoundExpr::Literal(LogicalValue::Boolean(true))),
                    },
                    output_name: ResultName::new("private_note")
                        .unwrap_or_else(|error| unreachable!("valid result: {error}")),
                }],
                predicate: None,
                group_by: Vec::new(),
                having: None,
                order_by: Vec::new(),
                limit: None,
                offset: None,
            })),
            applied_policies: vec![
                PolicyId::new(1).unwrap_or_else(|error| unreachable!("valid policy: {error}")),
            ],
            server_values: BTreeMap::new(),
            policy_limit: None,
            operation_check: None,
            expected_affected_rows: None,
            expected_result_rows: None,
        };
        compile_verified_select(
            &protected,
            &catalog,
            BTreeMap::new(),
            ExecutionLimits {
                max_rows: 2,
                max_result_bytes: 32,
                timeout_ms: 1_000,
            },
            snapshot,
        )
        .unwrap_or_else(|error| unreachable!("valid conditional plan: {error}"))
    }

    #[derive(Clone, Debug)]
    struct FakeTransport(ExecuteResult);

    impl TursoTransport for FakeTransport {
        fn execute(
            &self,
            _plan: &VerifiedExecutionPlan<SqliteProfile>,
        ) -> Result<ExecuteResult, AdapterError> {
            Ok(self.0.clone())
        }
    }

    #[test]
    fn validates_driver_result_against_verified_descriptor() {
        let verified = plan();
        let valid = TursoExecutor::new(FakeTransport(ExecuteResult {
            columns: vec!["id".to_owned()],
            rows: vec![vec![LogicalValue::String("project_1".to_owned())]],
            redactions: Vec::new(),
            affected_rows: 0,
        }));
        assert!(valid.execute(&verified).is_ok());

        let invalid = TursoExecutor::new(FakeTransport(ExecuteResult {
            columns: vec!["id".to_owned()],
            rows: vec![vec![LogicalValue::Int64(1)]],
            redactions: Vec::new(),
            affected_rows: 0,
        }));
        assert_eq!(invalid.execute(&verified), Err(AdapterError::InvalidResult));
    }

    #[test]
    fn visibility_companion_distinguishes_visible_database_null_from_redaction() {
        let verified = conditional_plan();
        assert!(
            verified
                .protected_sql()
                .contains("__policysql_visibility_0")
        );

        let visible_null = TursoExecutor::new(FakeTransport(ExecuteResult {
            columns: vec![
                "private_note".to_owned(),
                "__policysql_visibility_0".to_owned(),
            ],
            rows: vec![vec![LogicalValue::Null, LogicalValue::Boolean(true)]],
            redactions: Vec::new(),
            affected_rows: 0,
        }))
        .execute(&verified)
        .unwrap_or_else(|error| unreachable!("visible database NULL is valid: {error}"));
        assert_eq!(visible_null.columns, vec!["private_note"]);
        assert_eq!(visible_null.rows, vec![vec![LogicalValue::Null]]);
        assert_eq!(visible_null.redactions, vec![vec![false]]);

        let hidden_null = TursoExecutor::new(FakeTransport(ExecuteResult {
            columns: vec![
                "private_note".to_owned(),
                "__policysql_visibility_0".to_owned(),
            ],
            rows: vec![vec![LogicalValue::Null, LogicalValue::Boolean(false)]],
            redactions: Vec::new(),
            affected_rows: 0,
        }))
        .execute(&verified)
        .unwrap_or_else(|error| unreachable!("hidden NULL is valid: {error}"));
        assert_eq!(hidden_null.redactions, vec![vec![true]]);

        let spoofed = TursoExecutor::new(FakeTransport(ExecuteResult {
            columns: vec!["private_note".to_owned()],
            rows: vec![vec![LogicalValue::Null]],
            redactions: Vec::new(),
            affected_rows: 0,
        }));
        assert_eq!(spoofed.execute(&verified), Err(AdapterError::InvalidResult));
    }

    #[test]
    fn enforces_result_limits_after_transport() {
        let verified = plan();
        let executor = TursoExecutor::new(FakeTransport(ExecuteResult {
            columns: vec!["id".to_owned()],
            rows: vec![
                vec![LogicalValue::String("one".to_owned())],
                vec![LogicalValue::String("two".to_owned())],
                vec![LogicalValue::String("three".to_owned())],
            ],
            redactions: Vec::new(),
            affected_rows: 0,
        }));
        assert_eq!(
            executor.execute(&verified),
            Err(AdapterError::LimitExceeded)
        );
    }

    #[derive(Clone, Debug, Default)]
    struct TransactionState {
        committed: bool,
        rolled_back: bool,
    }

    #[derive(Clone, Debug)]
    struct FakeTransactionTransport {
        state: Arc<Mutex<TransactionState>>,
        result: ExecuteResult,
        fail_commit: bool,
    }

    #[derive(Debug)]
    struct FakeTransaction {
        state: Arc<Mutex<TransactionState>>,
        result: ExecuteResult,
        fail_commit: bool,
    }

    impl TursoTransactionTransport for FakeTransactionTransport {
        type Transaction = FakeTransaction;

        fn begin(&self) -> Result<Self::Transaction, AdapterError> {
            Ok(FakeTransaction {
                state: self.state.clone(),
                result: self.result.clone(),
                fail_commit: self.fail_commit,
            })
        }
    }

    impl TursoTransaction for FakeTransaction {
        fn execute(
            &mut self,
            _plan: &VerifiedExecutionPlan<SqliteProfile>,
        ) -> Result<ExecuteResult, AdapterError> {
            Ok(self.result.clone())
        }

        fn commit(&mut self) -> Result<(), AdapterError> {
            if self.fail_commit {
                return Err(AdapterError::Remote);
            }
            self.state
                .lock()
                .map_err(|_| AdapterError::Remote)?
                .committed = true;
            Ok(())
        }

        fn rollback(&mut self) -> Result<(), AdapterError> {
            self.state
                .lock()
                .map_err(|_| AdapterError::Remote)?
                .rolled_back = true;
            Ok(())
        }
    }

    #[derive(Clone, Copy, Debug)]
    struct Accept;

    impl<Transaction: TursoTransaction>
        CommitCheck<SqliteProfile, super::TursoTransactionSession<Transaction>> for Accept
    {
        type Error = AdapterError;

        fn validate(
            &self,
            _callback: &mut ReadOnlyCallback<
                '_,
                SqliteProfile,
                super::TursoTransactionSession<Transaction>,
            >,
        ) -> Result<CheckDecision, Self::Error> {
            Ok(CheckDecision::Accept)
        }
    }

    fn mutation_result(check: LogicalValue) -> ExecuteResult {
        ExecuteResult {
            columns: vec!["id".to_owned(), "__policysql_check".to_owned()],
            rows: vec![vec![LogicalValue::String("project_1".to_owned()), check]],
            redactions: Vec::new(),
            affected_rows: 1,
        }
    }

    #[test]
    fn mutation_check_is_stripped_before_commit_and_false_rolls_back() {
        let state = Arc::new(Mutex::new(TransactionState::default()));
        let factory = TursoTransactionFactory::new(FakeTransactionTransport {
            state: state.clone(),
            result: mutation_result(LogicalValue::Boolean(true)),
            fail_commit: false,
        });
        let outputs = execute_checked_transaction(&factory, &[mutation_plan()], &[Accept])
            .unwrap_or_else(|error| unreachable!("valid transaction: {error}"));
        assert_eq!(outputs[0].columns, vec!["id"]);
        assert_eq!(outputs[0].rows[0].len(), 1);
        assert!(state.lock().is_ok_and(|state| state.committed));

        let state = Arc::new(Mutex::new(TransactionState::default()));
        let factory = TursoTransactionFactory::new(FakeTransactionTransport {
            state: state.clone(),
            result: mutation_result(LogicalValue::Boolean(false)),
            fail_commit: false,
        });
        let result = execute_checked_transaction(&factory, &[mutation_plan()], &[Accept]);
        assert!(matches!(
            result,
            Err(TransactionError::Execute(AdapterError::Rejected(_)))
        ));
        assert!(state.lock().is_ok_and(|state| state.rolled_back));
    }

    #[test]
    fn affected_row_and_commit_failures_roll_back() {
        let state = Arc::new(Mutex::new(TransactionState::default()));
        let mut invalid = mutation_result(LogicalValue::Boolean(true));
        invalid.affected_rows = 2;
        let factory = TursoTransactionFactory::new(FakeTransactionTransport {
            state: state.clone(),
            result: invalid,
            fail_commit: false,
        });
        let result = execute_checked_transaction(&factory, &[mutation_plan()], &[Accept]);
        assert!(matches!(
            result,
            Err(TransactionError::Execute(AdapterError::ExpectationFailed))
        ));
        assert!(state.lock().is_ok_and(|state| state.rolled_back));

        let state = Arc::new(Mutex::new(TransactionState::default()));
        let factory = TursoTransactionFactory::new(FakeTransactionTransport {
            state: state.clone(),
            result: mutation_result(LogicalValue::Boolean(true)),
            fail_commit: true,
        });
        let result = execute_checked_transaction(&factory, &[mutation_plan()], &[Accept]);
        assert!(matches!(
            result,
            Err(TransactionError::Commit(AdapterError::Remote))
        ));
        assert!(state.lock().is_ok_and(|state| state.rolled_back));
    }

    #[test]
    fn runtime_enforces_format_and_constraints() {
        let descriptor = ValueDescriptor {
            logical_type: LogicalType::String,
            representation: ValueRepresentation::String,
            nullable: false,
            format: Some("uuid".to_owned()),
            storage: None,
            constraints: Some(ValueConstraints {
                allowed: vec![ConstraintScalar::String(
                    "123e4567-e89b-12d3-a456-426614174000".to_owned(),
                )],
                minimum: None,
                maximum: None,
                min_length: Some(36),
                max_length: Some(36),
                pattern: Some("^[0-9a-f-]+$".to_owned()),
            }),
            json_schema: None,
        };
        assert_eq!(
            validate_value(
                &LogicalValue::String("123e4567-e89b-12d3-a456-426614174000".to_owned()),
                &descriptor,
                &[LogicalType::String],
            ),
            Ok(())
        );
        assert_eq!(
            validate_value(
                &LogicalValue::String("123e4567-e89b-12d3-a456-426614174001".to_owned()),
                &descriptor,
                &[LogicalType::String],
            ),
            Err(AdapterError::InvalidResult)
        );
    }
}
