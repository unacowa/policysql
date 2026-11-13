#![forbid(unsafe_code)]

pub mod fuzz;

use policysql_core::LogicalValue;
use policysql_execution::VerifiedExecutionPlan;
use policysql_sqlite::SqliteProfile;
use rusqlite::Connection;
use rusqlite::types::{Value as SqlValue, ValueRef};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{self, Write as _};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

const REQUIRED_INPUT_FILES: [&str; 7] = [
    "schema.sql",
    "catalog-manifest.yaml",
    "policy.yaml",
    "session.json",
    "input.sql",
    "client-params.json",
    "case.yaml",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SqlFixture {
    pub input_path: PathBuf,
    pub expected_path: Option<PathBuf>,
}

/// In-memory executor spy used to prove that rejected requests never reach an adapter.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RecordingExecutor<Request> {
    calls: Vec<Request>,
}

pub struct ReferenceSqlite {
    connection: Connection,
}

impl fmt::Debug for ReferenceSqlite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReferenceSqlite")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReferenceResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<LogicalValue>>,
    pub redactions: Vec<Vec<bool>>,
}

#[derive(Debug)]
pub enum ReferenceError {
    Database,
    MissingParameter(String),
    UnsupportedValue,
    InvalidResult,
    RowLimit,
    ByteLimit,
}

impl fmt::Display for ReferenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Database => "reference database failed",
            Self::MissingParameter(_) => "protected parameter is unavailable",
            Self::UnsupportedValue => "reference value is unsupported",
            Self::InvalidResult => "reference result violates its descriptor",
            Self::RowLimit => "reference result exceeded its row limit",
            Self::ByteLimit => "reference result exceeded its byte limit",
        })
    }
}

impl std::error::Error for ReferenceError {}

impl ReferenceSqlite {
    /// Creates an isolated in-memory reference database from trusted test setup SQL.
    ///
    /// # Errors
    ///
    /// Returns a safe error when schema or seed setup fails.
    pub fn new(schema: &str, seed: &str) -> Result<Self, ReferenceError> {
        let connection = Connection::open_in_memory().map_err(|_| ReferenceError::Database)?;
        connection
            .execute_batch(schema)
            .map_err(|_| ReferenceError::Database)?;
        connection
            .execute_batch(seed)
            .map_err(|_| ReferenceError::Database)?;
        Ok(Self { connection })
    }

    /// Runs trusted test SQL against the reference database, binding `parameters` to `?1`, `?2`,
    /// ...; every cell comes back by its SQLite storage class. For the checks a test makes about
    /// what a protected statement wrote, never for client SQL.
    ///
    /// # Errors
    ///
    /// Fails closed on a database error or a parameter that has no SQLite value.
    pub fn trusted_rows(
        &self,
        sql: &str,
        parameters: &[LogicalValue],
    ) -> Result<Vec<Vec<LogicalValue>>, ReferenceError> {
        let mut statement = self
            .connection
            .prepare(sql)
            .map_err(|_| ReferenceError::Database)?;
        let values = parameters
            .iter()
            .map(encode)
            .collect::<Result<Vec<_>, _>>()?;
        let width = statement.column_count();
        let mut query = statement
            .query(rusqlite::params_from_iter(values))
            .map_err(|_| ReferenceError::Database)?;
        let mut rows = Vec::new();
        while let Some(row) = query.next().map_err(|_| ReferenceError::Database)? {
            rows.push(
                (0..width)
                    .map(|index| {
                        Ok(
                            match row.get_ref(index).map_err(|_| ReferenceError::Database)? {
                                ValueRef::Null => LogicalValue::Null,
                                ValueRef::Integer(value) => LogicalValue::Int64(value),
                                ValueRef::Real(value) => LogicalValue::Number(value),
                                ValueRef::Text(value) => LogicalValue::String(
                                    String::from_utf8_lossy(value).into_owned(),
                                ),
                                ValueRef::Blob(value) => LogicalValue::Bytes(value.to_vec()),
                            },
                        )
                    })
                    .collect::<Result<Vec<_>, ReferenceError>>()?,
            );
        }
        Ok(rows)
    }

    /// Executes only a profile-verified SELECT and validates row shape, storage class, and limits.
    ///
    /// # Errors
    ///
    /// Fails closed on binding, database, descriptor, row-limit, or byte-limit errors.
    pub fn execute(
        &self,
        plan: &VerifiedExecutionPlan<SqliteProfile>,
    ) -> Result<ReferenceResult, ReferenceError> {
        let mut statement = self
            .connection
            .prepare(plan.protected_sql())
            .map_err(|_| ReferenceError::Database)?;
        for (name, value) in plan.client_parameters() {
            bind(&mut statement, name.as_str(), value)?;
        }
        for (name, value) in plan.server_parameters() {
            bind(&mut statement, name.as_str(), value)?;
        }
        let mut query = statement.raw_query();
        let mut rows = Vec::new();
        let mut redactions = Vec::new();
        let mut bytes = 0_u64;
        while let Some(row) = query.next().map_err(|_| ReferenceError::Database)? {
            if u64::try_from(rows.len()).unwrap_or(u64::MAX) >= plan.limits().max_rows {
                return Err(ReferenceError::RowLimit);
            }
            let mut values = Vec::with_capacity(plan.result().len());
            let mut row_redactions = Vec::with_capacity(plan.result().len());
            let mut physical_index = 0_usize;
            for descriptor in plan.result() {
                let value = decode(
                    row.get_ref(physical_index)
                        .map_err(|_| ReferenceError::InvalidResult)?,
                    descriptor.value.logical_type,
                    descriptor.value.nullable,
                )?;
                physical_index += 1;
                let redacted = if descriptor.visibility_column.is_some() {
                    let visibility = decode(
                        row.get_ref(physical_index)
                            .map_err(|_| ReferenceError::InvalidResult)?,
                        policysql_core::LogicalType::Boolean,
                        false,
                    )?;
                    physical_index += 1;
                    match visibility {
                        LogicalValue::Boolean(visible) => {
                            if !visible && value != LogicalValue::Null {
                                return Err(ReferenceError::InvalidResult);
                            }
                            !visible
                        }
                        _ => return Err(ReferenceError::InvalidResult),
                    }
                } else {
                    false
                };
                row_redactions.push(redacted);
                bytes = bytes
                    .checked_add(value_size(&value))
                    .ok_or(ReferenceError::ByteLimit)?;
                if bytes > plan.limits().max_result_bytes {
                    return Err(ReferenceError::ByteLimit);
                }
                values.push(value);
            }
            rows.push(values);
            redactions.push(row_redactions);
        }
        Ok(ReferenceResult {
            columns: plan
                .result()
                .iter()
                .map(|column| column.name.as_str().to_owned())
                .collect(),
            rows,
            redactions,
        })
    }
}

fn bind(
    statement: &mut rusqlite::Statement<'_>,
    name: &str,
    value: &LogicalValue,
) -> Result<(), ReferenceError> {
    let sql_name = format!(":{name}");
    let index = statement
        .parameter_index(&sql_name)
        .map_err(|_| ReferenceError::Database)?
        .ok_or_else(|| ReferenceError::MissingParameter(name.to_owned()))?;
    let value = encode(value)?;
    statement
        .raw_bind_parameter(index, value)
        .map_err(|_| ReferenceError::Database)
}

fn encode(value: &LogicalValue) -> Result<SqlValue, ReferenceError> {
    Ok(match value {
        LogicalValue::Null => SqlValue::Null,
        LogicalValue::String(value) | LogicalValue::Json(value) => SqlValue::Text(value.clone()),
        LogicalValue::Boolean(value) => SqlValue::Integer(i64::from(*value)),
        LogicalValue::Int64(value) => SqlValue::Integer(*value),
        LogicalValue::Number(value) if value.is_finite() => SqlValue::Real(*value),
        LogicalValue::Bytes(value) => SqlValue::Blob(value.clone()),
        LogicalValue::Number(_) => return Err(ReferenceError::UnsupportedValue),
    })
}

fn decode(
    value: ValueRef<'_>,
    expected: policysql_core::LogicalType,
    nullable: bool,
) -> Result<LogicalValue, ReferenceError> {
    if matches!(value, ValueRef::Null) {
        return nullable
            .then_some(LogicalValue::Null)
            .ok_or(ReferenceError::InvalidResult);
    }
    match (expected, value) {
        (
            policysql_core::LogicalType::String
            | policysql_core::LogicalType::Date
            | policysql_core::LogicalType::DateTime
            | policysql_core::LogicalType::Instant,
            ValueRef::Text(value),
        ) => std::str::from_utf8(value)
            .map(|value| LogicalValue::String(value.to_owned()))
            .map_err(|_| ReferenceError::InvalidResult),
        (policysql_core::LogicalType::Boolean, ValueRef::Integer(0)) => {
            Ok(LogicalValue::Boolean(false))
        }
        (policysql_core::LogicalType::Boolean, ValueRef::Integer(1)) => {
            Ok(LogicalValue::Boolean(true))
        }
        (
            policysql_core::LogicalType::Integer | policysql_core::LogicalType::Int64,
            ValueRef::Integer(value),
        ) => Ok(LogicalValue::Int64(value)),
        (policysql_core::LogicalType::Number, ValueRef::Real(value)) => {
            Ok(LogicalValue::Number(value))
        }
        (policysql_core::LogicalType::Bytes, ValueRef::Blob(value)) => {
            Ok(LogicalValue::Bytes(value.to_vec()))
        }
        (policysql_core::LogicalType::Json, ValueRef::Text(value)) => std::str::from_utf8(value)
            .map(|value| LogicalValue::Json(value.to_owned()))
            .map_err(|_| ReferenceError::InvalidResult),
        _ => Err(ReferenceError::InvalidResult),
    }
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TruthValue {
    True,
    False,
    Unknown,
}

impl TruthValue {
    #[must_use]
    pub const fn and(self, other: Self) -> Self {
        match (self, other) {
            (Self::False, _) | (_, Self::False) => Self::False,
            (Self::True, Self::True) => Self::True,
            _ => Self::Unknown,
        }
    }

    #[must_use]
    pub const fn or(self, other: Self) -> Self {
        match (self, other) {
            (Self::True, _) | (_, Self::True) => Self::True,
            (Self::False, Self::False) => Self::False,
            _ => Self::Unknown,
        }
    }

    #[must_use]
    pub const fn not(self) -> Self {
        match self {
            Self::True => Self::False,
            Self::False => Self::True,
            Self::Unknown => Self::Unknown,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum OracleValue {
    Null,
    String(String),
    Boolean(bool),
    Int64(i64),
    Number(f64),
}

pub type OracleRow = BTreeMap<String, OracleValue>;
pub type OracleSession = BTreeMap<String, String>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OracleError {
    InvalidPolicy,
    MissingResource,
    MissingRole,
    MissingColumn,
    MissingSession,
    IncompatibleValues,
    UnsupportedOperator,
}

impl fmt::Display for OracleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPolicy => "reference policy is invalid",
            Self::MissingResource => "reference resource is unavailable",
            Self::MissingRole => "reference role is unavailable",
            Self::MissingColumn => "reference row column is unavailable",
            Self::MissingSession => "reference session value is unavailable",
            Self::IncompatibleValues => "reference values are incompatible",
            Self::UnsupportedOperator => "reference operator is unsupported",
        })
    }
}

impl std::error::Error for OracleError {}

/// Evaluates a SELECT row filter independently from the production policy compiler.
///
/// # Errors
///
/// Rejects malformed policy shapes and missing or incompatible reference values.
pub fn evaluate_select_filter(
    policy_yaml: &str,
    resource: &str,
    role: &str,
    row: &OracleRow,
    session: &OracleSession,
) -> Result<TruthValue, OracleError> {
    let document: serde_yaml::Value =
        serde_yaml::from_str(policy_yaml).map_err(|_| OracleError::InvalidPolicy)?;
    let filter = document
        .get("resources")
        .and_then(|resources| resources.get(resource))
        .ok_or(OracleError::MissingResource)?
        .get("roles")
        .and_then(|roles| roles.get(role))
        .ok_or(OracleError::MissingRole)?
        .get("select")
        .and_then(|select| select.get("filter"))
        .ok_or(OracleError::InvalidPolicy)?;
    evaluate_predicate(filter, row, session)
}

fn evaluate_predicate(
    predicate: &serde_yaml::Value,
    row: &OracleRow,
    session: &OracleSession,
) -> Result<TruthValue, OracleError> {
    let mapping = predicate.as_mapping().ok_or(OracleError::InvalidPolicy)?;
    if mapping.len() != 1 {
        return Err(OracleError::InvalidPolicy);
    }
    let (key, value) = mapping.iter().next().ok_or(OracleError::InvalidPolicy)?;
    let key = key.as_str().ok_or(OracleError::InvalidPolicy)?;
    match key {
        "and" | "or" => {
            let values = value.as_sequence().ok_or(OracleError::InvalidPolicy)?;
            if values.is_empty() {
                return Err(OracleError::InvalidPolicy);
            }
            let identity = if key == "and" {
                TruthValue::True
            } else {
                TruthValue::False
            };
            values.iter().try_fold(identity, |current, value| {
                let next = evaluate_predicate(value, row, session)?;
                Ok(if key == "and" {
                    current.and(next)
                } else {
                    current.or(next)
                })
            })
        }
        "not" => Ok(evaluate_predicate(value, row, session)?.not()),
        column => evaluate_comparison(column, value, row, session),
    }
}

fn evaluate_comparison(
    column: &str,
    comparison: &serde_yaml::Value,
    row: &OracleRow,
    session: &OracleSession,
) -> Result<TruthValue, OracleError> {
    let left = row.get(column).ok_or(OracleError::MissingColumn)?;
    let mapping = comparison.as_mapping().ok_or(OracleError::InvalidPolicy)?;
    if mapping.len() != 1 {
        return Err(OracleError::InvalidPolicy);
    }
    let (operator, operand) = mapping.iter().next().ok_or(OracleError::InvalidPolicy)?;
    let operator = operator.as_str().ok_or(OracleError::InvalidPolicy)?;
    match operator {
        "is_null" => {
            let expected = operand.as_bool().ok_or(OracleError::InvalidPolicy)?;
            Ok(bool_truth(matches!(left, OracleValue::Null) == expected))
        }
        "in" | "not_in" => {
            let values = operand.as_sequence().ok_or(OracleError::InvalidPolicy)?;
            if values.is_empty() {
                return Err(OracleError::InvalidPolicy);
            }
            if matches!(left, OracleValue::Null) {
                return Ok(TruthValue::Unknown);
            }
            let mut found = false;
            for value in values {
                let right = yaml_oracle_value(value)?;
                found |= compare_values(left, &right, "eq")? == TruthValue::True;
            }
            Ok(bool_truth(if operator == "in" { found } else { !found }))
        }
        _ => {
            let right = oracle_operand(operand, row, session)?;
            compare_values(left, &right, operator)
        }
    }
}

fn oracle_operand(
    value: &serde_yaml::Value,
    row: &OracleRow,
    session: &OracleSession,
) -> Result<OracleValue, OracleError> {
    if let Some(mapping) = value.as_mapping() {
        if mapping.len() != 1 {
            return Err(OracleError::InvalidPolicy);
        }
        if let Some(key) = mapping.get(serde_yaml::Value::String("session".to_owned())) {
            let key = key.as_str().ok_or(OracleError::InvalidPolicy)?;
            return session
                .get(key)
                .cloned()
                .map(OracleValue::String)
                .ok_or(OracleError::MissingSession);
        }
        if let Some(column) = mapping.get(serde_yaml::Value::String("column".to_owned())) {
            let column = column.as_str().ok_or(OracleError::InvalidPolicy)?;
            return row.get(column).cloned().ok_or(OracleError::MissingColumn);
        }
        if let Some(literal) = mapping.get(serde_yaml::Value::String("literal".to_owned())) {
            return yaml_oracle_value(literal);
        }
        return Err(OracleError::InvalidPolicy);
    }
    yaml_oracle_value(value)
}

fn yaml_oracle_value(value: &serde_yaml::Value) -> Result<OracleValue, OracleError> {
    if value.is_null() {
        return Ok(OracleValue::Null);
    }
    if let Some(value) = value.as_str() {
        return Ok(OracleValue::String(value.to_owned()));
    }
    if let Some(value) = value.as_bool() {
        return Ok(OracleValue::Boolean(value));
    }
    if let Some(value) = value.as_i64() {
        return Ok(OracleValue::Int64(value));
    }
    value
        .as_f64()
        .map(OracleValue::Number)
        .ok_or(OracleError::InvalidPolicy)
}

fn compare_values(
    left: &OracleValue,
    right: &OracleValue,
    operator: &str,
) -> Result<TruthValue, OracleError> {
    if matches!(left, OracleValue::Null) || matches!(right, OracleValue::Null) {
        return Ok(TruthValue::Unknown);
    }
    let ordering = match (left, right) {
        (OracleValue::String(left), OracleValue::String(right)) => Some(left.cmp(right)),
        (OracleValue::Boolean(left), OracleValue::Boolean(right)) => Some(left.cmp(right)),
        (OracleValue::Int64(left), OracleValue::Int64(right)) => Some(left.cmp(right)),
        (OracleValue::Number(left), OracleValue::Number(right)) => left.partial_cmp(right),
        _ => return Err(OracleError::IncompatibleValues),
    };
    let ordering = ordering.ok_or(OracleError::IncompatibleValues)?;
    let result = match operator {
        "eq" => ordering.is_eq(),
        "neq" => !ordering.is_eq(),
        "lt" => ordering.is_lt(),
        "lte" => !ordering.is_gt(),
        "gt" => ordering.is_gt(),
        "gte" => !ordering.is_lt(),
        "like" => {
            let (OracleValue::String(value), OracleValue::String(pattern)) = (left, right) else {
                return Err(OracleError::IncompatibleValues);
            };
            sqlite_like(value, pattern)
        }
        _ => return Err(OracleError::UnsupportedOperator),
    };
    Ok(bool_truth(result))
}

fn bool_truth(value: bool) -> TruthValue {
    if value {
        TruthValue::True
    } else {
        TruthValue::False
    }
}

fn sqlite_like(value: &str, pattern: &str) -> bool {
    let value = value.to_ascii_lowercase().into_bytes();
    let pattern = pattern.to_ascii_lowercase().into_bytes();
    let mut table = vec![vec![false; pattern.len() + 1]; value.len() + 1];
    table[0][0] = true;
    for pattern_index in 1..=pattern.len() {
        if pattern[pattern_index - 1] == b'%' {
            table[0][pattern_index] = table[0][pattern_index - 1];
        }
    }
    for value_index in 1..=value.len() {
        for pattern_index in 1..=pattern.len() {
            table[value_index][pattern_index] = match pattern[pattern_index - 1] {
                b'%' => {
                    table[value_index][pattern_index - 1] || table[value_index - 1][pattern_index]
                }
                b'_' => table[value_index - 1][pattern_index - 1],
                character => {
                    character == value[value_index - 1] && table[value_index - 1][pattern_index - 1]
                }
            };
        }
    }
    table[value.len()][pattern.len()]
}

impl<Request> RecordingExecutor<Request> {
    pub fn execute(&mut self, request: Request) {
        self.calls.push(request);
    }

    #[must_use]
    pub fn call_count(&self) -> usize {
        self.calls.len()
    }

    #[must_use]
    pub fn calls(&self) -> &[Request] {
        &self.calls
    }
}

impl SqlFixture {
    /// Discovers SQL fixture files directly beneath `root`.
    ///
    /// # Errors
    ///
    /// Returns an I/O error when the directory or one of its entries cannot be read.
    pub fn discover(root: &Path) -> std::io::Result<Vec<Self>> {
        let mut fixtures = Vec::new();
        if !root.exists() {
            return Ok(fixtures);
        }
        for entry in fs::read_dir(root)? {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) == Some("sql") {
                fixtures.push(Self {
                    input_path: path,
                    expected_path: None,
                });
            }
        }
        fixtures.sort_by(|left, right| left.input_path.cmp(&right.input_path));
        Ok(fixtures)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceStatus {
    Advertised,
    Planned,
    Disabled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TestClass {
    Positive,
    Negative,
    Bypass,
    Differential,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceLeaf {
    pub id: String,
    pub profile: String,
    pub kind: String,
    pub status: SurfaceStatus,
    #[serde(default)]
    pub contexts: Vec<String>,
    #[serde(default)]
    pub required_tests: BTreeSet<TestClass>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceDocument {
    pub version: u32,
    pub profile: String,
    pub leaves: Vec<SurfaceLeaf>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExpectedDisposition {
    Allow,
    Deny,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CaseManifest {
    pub id: String,
    pub profile: String,
    pub description: String,
    pub covers: BTreeSet<String>,
    pub tests: BTreeSet<TestClass>,
    pub expected: ExpectedDisposition,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct FixtureExecutionEvidence {
    id: String,
    digest: String,
    tests: BTreeSet<TestClass>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ExecutionEvidence {
    version: u32,
    fixtures: Vec<FixtureExecutionEvidence>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct RejectionExpectation {
    stage: String,
    code: String,
    executor_calls: u32,
    public_message_contains_hidden_identifier: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CoverageRow {
    pub coverage_id: String,
    pub profile: String,
    pub status: SurfaceStatus,
    pub required: BTreeSet<TestClass>,
    pub covered: BTreeSet<TestClass>,
    pub fixtures: BTreeSet<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CoverageReport {
    pub rows: Vec<CoverageRow>,
    pub fixture_count: usize,
    pub errors: Vec<String>,
}

impl CoverageReport {
    #[must_use]
    pub fn is_success(&self) -> bool {
        self.errors.is_empty()
    }

    #[must_use]
    pub fn to_markdown(&self) -> String {
        let mut output = String::from(
            "# PolicySQL SQL surface coverage\n\n| Coverage ID | Profile | Status | Required | Covered | Fixtures |\n| --- | --- | --- | --- | --- | --- |\n",
        );
        for row in &self.rows {
            let required = join_debug(&row.required);
            let covered = join_debug(&row.covered);
            let fixtures = row.fixtures.iter().cloned().collect::<Vec<_>>().join(", ");
            let _ = writeln!(
                output,
                "| `{}` | `{}` | `{:?}` | {} | {} | {} |",
                row.coverage_id, row.profile, row.status, required, covered, fixtures
            );
        }
        let _ = writeln!(output, "\nFixtures: {}", self.fixture_count);
        if self.errors.is_empty() {
            output.push_str("\nResult: PASS\n");
        } else {
            output.push_str("\n## Errors\n\n");
            for error in &self.errors {
                let _ = writeln!(output, "- {error}");
            }
        }
        output
    }
}

fn join_debug(values: &BTreeSet<TestClass>) -> String {
    values
        .iter()
        .map(|value| format!("`{value:?}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Debug)]
pub enum CoverageError {
    Io(std::io::Error),
    Yaml {
        path: PathBuf,
        source: serde_yaml::Error,
    },
    Json(serde_json::Error),
    Evidence(String),
}

impl fmt::Display for CoverageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "fixture I/O failed: {error}"),
            Self::Yaml { path, source } => {
                write!(formatter, "invalid YAML {}: {source}", path.display())
            }
            Self::Json(error) => write!(formatter, "report JSON encoding failed: {error}"),
            Self::Evidence(error) => {
                write!(formatter, "executed coverage evidence is invalid: {error}")
            }
        }
    }
}

impl std::error::Error for CoverageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Yaml { source, .. } => Some(source),
            Self::Json(error) => Some(error),
            Self::Evidence(_) => None,
        }
    }
}

impl From<std::io::Error> for CoverageError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for CoverageError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// Validates all surface documents and fixture pairs, then builds a traceable report.
///
/// # Errors
///
/// Returns an error when files cannot be read or a YAML document cannot be decoded.
pub fn check_coverage(
    surface_root: &Path,
    fixture_root: &Path,
) -> Result<CoverageReport, CoverageError> {
    let surfaces = load_surfaces(surface_root)?;
    let mut fixtures = load_fixtures(fixture_root)?;
    apply_execution_evidence(fixture_root, &mut fixtures)?;
    Ok(build_report(surfaces, &fixtures))
}

fn evidence_path(fixture_root: &Path) -> PathBuf {
    fixture_root
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."))
        .join("target/policysql-test-coverage/executed-fixtures.json")
}

fn fixture_digest(directory: &Path) -> Result<String, CoverageError> {
    let mut files = Vec::new();
    let mut pending = vec![directory.to_path_buf()];
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(&current)? {
            let path = entry?.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push(path);
            }
        }
    }
    files.sort();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for path in files {
        path.strip_prefix(directory)
            .unwrap_or(&path)
            .to_string_lossy()
            .hash(&mut hasher);
        fs::read(path)?.hash(&mut hasher);
    }
    Ok(format!("{:016x}", hasher.finish()))
}

fn apply_execution_evidence(
    fixture_root: &Path,
    fixtures: &mut [(PathBuf, CaseManifest)],
) -> Result<(), CoverageError> {
    let evidence: ExecutionEvidence =
        serde_json::from_slice(&fs::read(evidence_path(fixture_root))?)?;
    if evidence.version != 1 {
        return Err(CoverageError::Evidence(
            "unsupported evidence version".to_owned(),
        ));
    }
    let by_id = evidence
        .fixtures
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect::<BTreeMap<_, _>>();
    for (case_path, fixture) in fixtures {
        let item = by_id.get(&fixture.id).ok_or_else(|| {
            CoverageError::Evidence(format!("missing executed evidence for {}", fixture.id))
        })?;
        let directory = case_path.parent().unwrap_or_else(|| Path::new("."));
        if item.digest != fixture_digest(directory)? {
            return Err(CoverageError::Evidence(format!(
                "stale executed evidence for {}",
                fixture.id
            )));
        }
        fixture.tests.clone_from(&item.tests);
    }
    Ok(())
}

fn load_surfaces(root: &Path) -> Result<Vec<(PathBuf, SurfaceDocument)>, CoverageError> {
    let mut documents = Vec::new();
    for path in files_named(root, "yaml")? {
        let document = read_yaml::<SurfaceDocument>(&path)?;
        documents.push((path, document));
    }
    Ok(documents)
}

fn load_fixtures(root: &Path) -> Result<Vec<(PathBuf, CaseManifest)>, CoverageError> {
    let mut fixtures = Vec::new();
    for path in files_named(root, "yaml")?
        .into_iter()
        .filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("case.yaml"))
    {
        let manifest = read_yaml::<CaseManifest>(&path)?;
        fixtures.push((path, manifest));
    }
    Ok(fixtures)
}

fn read_yaml<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, CoverageError> {
    let content = fs::read_to_string(path)?;
    serde_yaml::from_str(&content).map_err(|source| CoverageError::Yaml {
        path: path.to_path_buf(),
        source,
    })
}

fn files_named(root: &Path, extension: &str) -> Result<Vec<PathBuf>, CoverageError> {
    let mut output = Vec::new();
    if !root.exists() {
        return Ok(output);
    }
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().and_then(|value| value.to_str()) == Some(extension) {
                output.push(path);
            }
        }
    }
    output.sort();
    Ok(output)
}

fn build_report(
    surfaces: Vec<(PathBuf, SurfaceDocument)>,
    fixtures: &[(PathBuf, CaseManifest)],
) -> CoverageReport {
    let mut errors = Vec::new();
    let mut leaves = BTreeMap::<String, SurfaceLeaf>::new();
    for (path, document) in surfaces {
        if document.version != 1 {
            errors.push(format!(
                "{}: unsupported surface document version {}",
                path.display(),
                document.version
            ));
        }
        for leaf in document.leaves {
            if leaf.profile != document.profile && leaf.profile != "common" {
                errors.push(format!(
                    "{}: leaf {} profile does not match document profile",
                    path.display(),
                    leaf.id
                ));
            }
            if leaves.insert(leaf.id.clone(), leaf.clone()).is_some() {
                errors.push(format!("duplicate coverage ID: {}", leaf.id));
            }
        }
    }

    let mut case_ids = BTreeSet::new();
    let mut covered = BTreeMap::<String, BTreeSet<TestClass>>::new();
    let mut fixture_ids = BTreeMap::<String, BTreeSet<String>>::new();
    for (case_path, fixture) in fixtures {
        let directory = case_path.parent().unwrap_or_else(|| Path::new("."));
        if !case_ids.insert(fixture.id.clone()) {
            errors.push(format!("duplicate fixture ID: {}", fixture.id));
        }
        lint_fixture_files(directory, fixture, &mut errors);
        for coverage_id in &fixture.covers {
            let Some(leaf) = leaves.get(coverage_id) else {
                errors.push(format!("{}: unknown coverage ID {coverage_id}", fixture.id));
                continue;
            };
            if leaf.profile != "common" && leaf.profile != fixture.profile {
                errors.push(format!(
                    "{}: coverage ID {coverage_id} belongs to profile {}",
                    fixture.id, leaf.profile
                ));
            }
            covered
                .entry(coverage_id.clone())
                .or_default()
                .extend(fixture.tests.iter().copied());
            fixture_ids
                .entry(coverage_id.clone())
                .or_default()
                .insert(fixture.id.clone());
        }
        if fixture.tests.contains(&TestClass::Bypass)
            && !fixture
                .covers
                .iter()
                .any(|coverage_id| coverage_id.starts_with("threat."))
        {
            errors.push(format!(
                "{}: bypass fixture must cover a threat.* ID",
                fixture.id
            ));
        }
        if fixture.tests.contains(&TestClass::Differential) && !directory.join("seed.sql").is_file()
        {
            errors.push(format!(
                "{}: differential fixture requires seed.sql",
                fixture.id
            ));
        }
    }

    let mut rows = Vec::new();
    for leaf in leaves.into_values() {
        let actual = covered.remove(&leaf.id).unwrap_or_default();
        if leaf.status == SurfaceStatus::Advertised {
            for missing in leaf.required_tests.difference(&actual) {
                errors.push(format!(
                    "advertised coverage {} is missing {missing:?}",
                    leaf.id
                ));
            }
        }
        rows.push(CoverageRow {
            coverage_id: leaf.id.clone(),
            profile: leaf.profile,
            status: leaf.status,
            required: leaf.required_tests,
            covered: actual,
            fixtures: fixture_ids.remove(&leaf.id).unwrap_or_default(),
        });
    }
    rows.sort_by(|left, right| left.coverage_id.cmp(&right.coverage_id));

    CoverageReport {
        rows,
        fixture_count: fixtures.len(),
        errors,
    }
}

fn lint_fixture_files(directory: &Path, fixture: &CaseManifest, errors: &mut Vec<String>) {
    for name in REQUIRED_INPUT_FILES {
        if !directory.join(name).is_file() {
            errors.push(format!("{}: missing required file {name}", fixture.id));
        }
    }
    match fixture.expected {
        ExpectedDisposition::Allow => {
            for name in [
                "expected/protected.sql",
                "expected/plan.yaml",
                "expected/result.json",
            ] {
                if !directory.join(name).is_file() {
                    errors.push(format!("{}: missing required file {name}", fixture.id));
                }
            }
        }
        ExpectedDisposition::Deny => {
            let path = directory.join("expected/rejection.yaml");
            if !path.is_file() {
                errors.push(format!(
                    "{}: missing required file expected/rejection.yaml",
                    fixture.id
                ));
                return;
            }
            match read_yaml::<RejectionExpectation>(&path) {
                Ok(expectation) => {
                    if expectation.stage.trim().is_empty() || expectation.code.trim().is_empty() {
                        errors.push(format!(
                            "{}: rejection stage and code must be non-empty",
                            fixture.id
                        ));
                    }
                    if expectation.executor_calls != 0 {
                        errors.push(format!(
                            "{}: denied fixture must assert executor_calls: 0",
                            fixture.id
                        ));
                    }
                    if expectation.public_message_contains_hidden_identifier {
                        errors.push(format!(
                            "{}: denied fixture must forbid hidden identifiers in public errors",
                            fixture.id
                        ));
                    }
                }
                Err(error) => errors.push(format!("{}: {error}", fixture.id)),
            }
        }
    }
}

/// Writes JSON and Markdown coverage artifacts.
///
/// # Errors
///
/// Returns an error when the output directory cannot be created or written.
pub fn write_report(report: &CoverageReport, output_root: &Path) -> Result<(), CoverageError> {
    fs::create_dir_all(output_root)?;
    fs::write(output_root.join("coverage.md"), report.to_markdown())?;
    fs::write(
        output_root.join("coverage.json"),
        serde_json::to_vec_pretty(report)?,
    )?;
    let uncovered = report
        .rows
        .iter()
        .filter(|row| {
            row.status == SurfaceStatus::Advertised && !row.required.is_subset(&row.covered)
        })
        .collect::<Vec<_>>();
    fs::write(
        output_root.join("uncovered.json"),
        serde_json::to_vec_pretty(&uncovered)?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {

    fn context() -> policysql_core::CompileContext {
        policysql_core::CompileContext::new(1_793_366_096_789)
            .unwrap_or_else(|| unreachable!("the test time is in range"))
    }
    use super::{
        CaseManifest, ExecutionEvidence, ExpectedDisposition, FixtureExecutionEvidence, OracleRow,
        OracleSession, OracleValue, RecordingExecutor, ReferenceSqlite, RejectionExpectation,
        SurfaceDocument, SurfaceLeaf, SurfaceStatus, TestClass, TruthValue, build_report,
        evaluate_select_filter, evidence_path, fixture_digest, load_fixtures, read_yaml,
    };
    use policysql_catalog::{Catalog, ResourceDescriptor};
    use policysql_core::{
        ClientParameterName, ColumnName, JsonSchemaType, JsonValueSchema, LogicalType,
        LogicalValue, ResourceId, ResourceName, RoleName, SnapshotId, TrustedSession,
        ValueDescriptor, ValueRepresentation,
    };
    use policysql_execution::ExecutionLimits;
    use policysql_gateway::{GatewayError, RejectionKind, classify_bind_error, compile_failure};
    use policysql_ir::BoundStatement;
    use policysql_parser::SqliteFrontend;
    use policysql_policy::{PolicyBundle, PolicyError};
    use policysql_sqlite::{
        CompileError, compile_verified_delete, compile_verified_insert, compile_verified_select,
        compile_verified_update,
    };
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::path::{Path, PathBuf};

    #[derive(serde::Deserialize)]
    struct FixtureCatalog {
        resources: BTreeMap<String, FixtureResource>,
    }

    #[derive(serde::Deserialize)]
    struct FixtureResource {
        columns: BTreeMap<String, FixtureColumn>,
    }

    #[derive(serde::Deserialize)]
    struct FixtureColumn {
        r#type: String,
        #[serde(default)]
        nullable: bool,
    }

    #[derive(serde::Deserialize)]
    struct FixtureSession {
        role: String,
        values: BTreeMap<String, String>,
    }

    fn read_fixture(path: &Path, name: &str) -> String {
        fs::read_to_string(path.join(name))
            .unwrap_or_else(|error| unreachable!("fixture {name} reads: {error}"))
    }

    fn fixture_value(value: &serde_json::Value) -> LogicalValue {
        match value {
            serde_json::Value::Null => LogicalValue::Null,
            serde_json::Value::Bool(value) => LogicalValue::Boolean(*value),
            serde_json::Value::Number(value) => value.as_i64().map_or_else(
                || {
                    LogicalValue::Number(
                        value
                            .as_f64()
                            .unwrap_or_else(|| unreachable!("finite fixture number")),
                    )
                },
                LogicalValue::Int64,
            ),
            serde_json::Value::String(value) => LogicalValue::String(value.clone()),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => LogicalValue::Json(
                serde_json::to_string(value)
                    .unwrap_or_else(|error| unreachable!("fixture JSON serializes: {error}")),
            ),
        }
    }

    fn fixture_json_schema(logical_type: LogicalType) -> Option<JsonValueSchema> {
        (logical_type == LogicalType::Json).then(|| JsonValueSchema {
            types: vec![JsonSchemaType::Object],
            properties: BTreeMap::from([
                (
                    "label".to_owned(),
                    JsonValueSchema {
                        types: vec![JsonSchemaType::String],
                        properties: BTreeMap::new(),
                        items: None,
                        required: Vec::new(),
                        additional_properties: false,
                        any_of: Vec::new(),
                    },
                ),
                (
                    "score".to_owned(),
                    JsonValueSchema {
                        types: vec![JsonSchemaType::Integer],
                        properties: BTreeMap::new(),
                        items: None,
                        required: Vec::new(),
                        additional_properties: false,
                        any_of: Vec::new(),
                    },
                ),
            ]),
            items: None,
            required: Vec::new(),
            additional_properties: false,
            any_of: Vec::new(),
        })
    }

    #[allow(clippy::too_many_lines)]
    fn assert_select_fixture(directory: &str) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/sqlite-turso-v1/select")
            .join(directory);
        let raw_catalog: FixtureCatalog =
            serde_yaml::from_str(&read_fixture(&root, "catalog-manifest.yaml"))
                .unwrap_or_else(|error| unreachable!("fixture Catalog parses: {error}"));
        let snapshot = SnapshotId::new(format!("fixture_{directory}"))
            .unwrap_or_else(|error| unreachable!("fixture snapshot: {error}"));
        let resources = raw_catalog
            .resources
            .into_iter()
            .enumerate()
            .map(|(index, (resource_name, resource))| {
                let resource_id = ResourceId::new(u64::try_from(index + 1).unwrap_or(u64::MAX))
                    .unwrap_or_else(|error| unreachable!("fixture resource ID: {error}"));
                let columns = resource.columns.into_iter().map(|(name, column)| {
                    let logical_type = match column.r#type.as_str() {
                        "string" => LogicalType::String,
                        "boolean" => LogicalType::Boolean,
                        "int64" => LogicalType::Int64,
                        "json" => LogicalType::Json,
                        other => unreachable!("unsupported fixture type: {other}"),
                    };
                    let representation = match logical_type {
                        LogicalType::String => ValueRepresentation::String,
                        LogicalType::Boolean => ValueRepresentation::Boolean,
                        LogicalType::Int64 => ValueRepresentation::Number,
                        LogicalType::Json => ValueRepresentation::Json,
                        _ => unreachable!("closed fixture type set"),
                    };
                    (
                        ColumnName::new(name)
                            .unwrap_or_else(|error| unreachable!("fixture column: {error}")),
                        ValueDescriptor {
                            logical_type,
                            representation,
                            nullable: column.nullable,
                            format: None,
                            storage: None,
                            constraints: None,
                            json_schema: fixture_json_schema(logical_type),
                        },
                    )
                });
                ResourceDescriptor::new(
                    resource_id,
                    ResourceName::new(resource_name)
                        .unwrap_or_else(|error| unreachable!("fixture resource: {error}")),
                    columns,
                )
                .unwrap_or_else(|error| unreachable!("fixture descriptor: {error}"))
            })
            .collect::<Vec<_>>();
        let catalog = Catalog::new(snapshot.clone(), resources)
            .unwrap_or_else(|error| unreachable!("fixture Catalog: {error}"));
        let statement = SqliteFrontend::default()
            .bind(&read_fixture(&root, "input.sql"), &catalog)
            .unwrap_or_else(|error| unreachable!("fixture binds: {error}"));
        let bundle = PolicyBundle::activate(
            &read_fixture(&root, "policy.yaml"),
            &catalog,
            snapshot.clone(),
        )
        .unwrap_or_else(|error| unreachable!("fixture policy: {error}"));
        let mut raw_session: FixtureSession =
            serde_json::from_str(&read_fixture(&root, "session.json"))
                .unwrap_or_else(|error| unreachable!("fixture session: {error}"));
        let subject = raw_session
            .values
            .remove("subject_id")
            .unwrap_or_else(|| "fixture_subject".to_owned());
        let session = TrustedSession::new(
            RoleName::new(raw_session.role)
                .unwrap_or_else(|error| unreachable!("fixture role: {error}")),
            subject,
            raw_session.values,
        )
        .unwrap_or_else(|error| unreachable!("trusted fixture session: {error}"));
        let protected = bundle
            .compile_select(&statement, &session)
            .unwrap_or_else(|error| unreachable!("fixture compiles: {error}"));
        let raw_parameters: BTreeMap<String, serde_json::Value> =
            serde_json::from_str(&read_fixture(&root, "client-params.json"))
                .unwrap_or_else(|error| unreachable!("fixture parameters: {error}"));
        let parameters = raw_parameters
            .into_iter()
            .map(|(name, value)| {
                (
                    ClientParameterName::new(name)
                        .unwrap_or_else(|error| unreachable!("fixture parameter: {error}")),
                    fixture_value(&value),
                )
            })
            .collect();
        let verified = compile_verified_select(
            &protected.plan,
            &catalog,
            parameters,
            ExecutionLimits {
                max_rows: 100,
                max_result_bytes: 10_000,
                timeout_ms: 1_000,
                max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
            },
            snapshot,
        )
        .unwrap_or_else(|error| unreachable!("fixture verifies: {error}"));
        assert_eq!(
            verified.protected_sql(),
            read_fixture(&root, "expected/protected.sql").trim()
        );
        let database = ReferenceSqlite::new(
            &read_fixture(&root, "schema.sql"),
            &read_fixture(&root, "seed.sql"),
        )
        .unwrap_or_else(|error| unreachable!("fixture database: {error}"));
        let actual = database
            .execute(&verified)
            .unwrap_or_else(|error| unreachable!("fixture executes: {error}"));
        let expected: serde_json::Value =
            serde_json::from_str(&read_fixture(&root, "expected/result.json"))
                .unwrap_or_else(|error| unreachable!("fixture result: {error}"));
        let expected_columns = expected["columns"]
            .as_array()
            .unwrap_or_else(|| unreachable!("fixture result columns"))
            .iter()
            .map(|value| value.as_str().unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(actual.columns, expected_columns);
        let expected_rows = expected["rows"]
            .as_array()
            .unwrap_or_else(|| unreachable!("fixture result rows"))
            .iter()
            .map(|row| {
                actual
                    .columns
                    .iter()
                    .map(|column| fixture_value(&row[column]))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assert_eq!(actual.rows, expected_rows);
        if root.join("negative-control.sql").is_file() {
            if let Ok(negative) = SqliteFrontend::default()
                .bind(&read_fixture(&root, "negative-control.sql"), &catalog)
            {
                assert!(
                    bundle.compile_select(&negative, &session).is_err(),
                    "negative control unexpectedly compiled: {directory}"
                );
            }
        }
    }

    fn leaf(status: SurfaceStatus) -> SurfaceLeaf {
        SurfaceLeaf {
            id: "statement.select".to_owned(),
            profile: "sqlite-turso-v1".to_owned(),
            kind: "statement".to_owned(),
            status,
            contexts: Vec::new(),
            required_tests: BTreeSet::from([
                TestClass::Positive,
                TestClass::Negative,
                TestClass::Bypass,
                TestClass::Differential,
            ]),
        }
    }

    #[test]
    fn uncovered_advertised_leaf_fails() {
        let report = build_report(
            vec![(
                PathBuf::from("surface.yaml"),
                SurfaceDocument {
                    version: 1,
                    profile: "sqlite-turso-v1".to_owned(),
                    leaves: vec![leaf(SurfaceStatus::Advertised)],
                },
            )],
            &[],
        );
        assert!(!report.is_success());
        assert_eq!(report.errors.len(), 4);
    }

    #[test]
    fn planned_leaf_does_not_claim_coverage() {
        let report = build_report(
            vec![(
                PathBuf::from("surface.yaml"),
                SurfaceDocument {
                    version: 1,
                    profile: "sqlite-turso-v1".to_owned(),
                    leaves: vec![leaf(SurfaceStatus::Planned)],
                },
            )],
            &[],
        );
        assert!(report.is_success());
    }

    #[test]
    fn duplicate_fixture_ids_fail() {
        let fixture = CaseManifest {
            id: "duplicate".to_owned(),
            profile: "sqlite-turso-v1".to_owned(),
            description: "duplicate negative control".to_owned(),
            covers: BTreeSet::new(),
            tests: BTreeSet::new(),
            expected: ExpectedDisposition::Allow,
        };
        let report = build_report(
            Vec::new(),
            &[
                (PathBuf::from("one/case.yaml"), fixture.clone()),
                (PathBuf::from("two/case.yaml"), fixture),
            ],
        );
        assert!(
            report
                .errors
                .iter()
                .any(|error| error == "duplicate fixture ID: duplicate")
        );
    }

    #[test]
    fn incomplete_allow_fixture_fails_closed() {
        let fixture = CaseManifest {
            id: "incomplete.allow".to_owned(),
            profile: "sqlite-turso-v1".to_owned(),
            description: "missing expected execution plan".to_owned(),
            covers: BTreeSet::new(),
            tests: BTreeSet::from([TestClass::Positive]),
            expected: ExpectedDisposition::Allow,
        };
        let report = build_report(
            Vec::new(),
            &[(PathBuf::from("missing/allow/case.yaml"), fixture)],
        );
        assert!(report.errors.iter().any(|error| {
            error == "incomplete.allow: missing required file expected/protected.sql"
        }));
    }

    #[test]
    fn incomplete_deny_fixture_fails_closed() {
        let fixture = CaseManifest {
            id: "incomplete.deny".to_owned(),
            profile: "sqlite-turso-v1".to_owned(),
            description: "missing rejection proof".to_owned(),
            covers: BTreeSet::new(),
            tests: BTreeSet::from([TestClass::Negative]),
            expected: ExpectedDisposition::Deny,
        };
        let report = build_report(
            Vec::new(),
            &[(PathBuf::from("missing/deny/case.yaml"), fixture)],
        );
        assert!(report.errors.iter().any(|error| {
            error == "incomplete.deny: missing required file expected/rejection.yaml"
        }));
    }

    #[test]
    fn recording_executor_starts_with_zero_calls() {
        let mut executor = RecordingExecutor::default();
        assert_eq!(executor.call_count(), 0);
        executor.execute("verified-plan");
        assert_eq!(executor.call_count(), 1);
        assert_eq!(executor.calls(), &["verified-plan"]);
    }

    #[test]
    fn independent_oracle_evaluates_fixture_tenant_filter() {
        let policy = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/select/basic-row-policy/policy.yaml"
        );
        let session = OracleSession::from([("tenant_id".to_owned(), "tenant_1".to_owned())]);
        let visible = OracleRow::from([(
            "tenant_id".to_owned(),
            OracleValue::String("tenant_1".to_owned()),
        )]);
        let hidden = OracleRow::from([(
            "tenant_id".to_owned(),
            OracleValue::String("tenant_2".to_owned()),
        )]);
        assert_eq!(
            evaluate_select_filter(policy, "projects", "member", &visible, &session),
            Ok(TruthValue::True)
        );
        assert_eq!(
            evaluate_select_filter(policy, "projects", "member", &hidden, &session),
            Ok(TruthValue::False)
        );
    }

    #[test]
    fn protected_fixture_matches_reference_sqlite_result() {
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
            ["id", "tenant_id", "name", "status", "created_by"].map(|name| {
                (
                    ColumnName::new(name)
                        .unwrap_or_else(|error| unreachable!("valid column: {error}")),
                    descriptor.clone(),
                )
            }),
        )
        .unwrap_or_else(|error| unreachable!("valid resource: {error}"));
        let snapshot = SnapshotId::new("fixture_1")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        let catalog = Catalog::new(snapshot.clone(), [resource])
            .unwrap_or_else(|error| unreachable!("valid Catalog: {error}"));
        let sql = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/select/basic-row-policy/input.sql"
        );
        let policy = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/select/basic-row-policy/policy.yaml"
        );
        let statement = SqliteFrontend::default()
            .bind(sql, &catalog)
            .unwrap_or_else(|error| unreachable!("fixture binds: {error}"));
        let bundle = PolicyBundle::activate(policy, &catalog, snapshot.clone())
            .unwrap_or_else(|error| unreachable!("fixture activates: {error}"));
        let session = TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("valid role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("valid session: {error}"));
        let protected = bundle
            .compile_select(&statement, &session)
            .unwrap_or_else(|error| unreachable!("fixture compiles: {error}"));
        let parameters = BTreeMap::from([
            (
                ClientParameterName::new("status")
                    .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
                LogicalValue::String("active".to_owned()),
            ),
            (
                ClientParameterName::new("limit")
                    .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
                LogicalValue::Int64(200),
            ),
        ]);
        let verified = compile_verified_select(
            &protected.plan,
            &catalog,
            parameters,
            ExecutionLimits {
                max_rows: 100,
                max_result_bytes: 10_000,
                timeout_ms: 1_000,
                max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
            },
            snapshot,
        )
        .unwrap_or_else(|error| unreachable!("fixture verifies: {error}"));
        let schema = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/select/basic-row-policy/schema.sql"
        );
        let seed = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/select/basic-row-policy/seed.sql"
        );
        let database = ReferenceSqlite::new(schema, seed)
            .unwrap_or_else(|error| unreachable!("reference database: {error}"));
        let result = database
            .execute(&verified)
            .unwrap_or_else(|error| unreachable!("verified query executes: {error}"));
        assert_eq!(result.columns, ["id", "name"]);
        assert_eq!(
            result.rows,
            [vec![
                LogicalValue::String("project_1".to_owned()),
                LogicalValue::String("Visible".to_owned()),
            ]]
        );
    }

    #[test]
    fn expanded_read_fixtures_match_golden_sql_and_reference_sqlite() {
        for fixture in [
            "constant-select",
            "json-collection",
            "projection-expressions",
            "correlated-exists",
            "aggregate-group",
            "window-row-number",
            "functions-offset",
            "filtered-cte-join",
            "joins",
            "order-by",
            "transparent-sources",
            "in-null-predicates",
            "parent-exists",
        ] {
            assert_select_fixture(fixture);
        }
    }

    type ParentExistsCase<'a> = (&'a str, Result<Vec<Vec<LogicalValue>>, PolicyError>);

    /// Runs `cases` against `posts`/`comments`/`readers` on SQLite, where the `comments` row
    /// filter is `comments_filter` (a select-policy `exists`, issue #112). `posts` has its own
    /// narrower policy (`columns: [id, title]`), so the client may join it while the `comments`
    /// rule reads `posts.tenant_id`, which the client may not.
    ///
    /// Data: p2 is another tenant's post; p4 is ours with no comment; p5 is ours but hidden by
    /// the posts policy, so its comment c5 is visible alone but never joined to it; c3 has a
    /// NULL `post_id`.
    #[allow(clippy::too_many_lines)]
    fn run_parent_exists_cases(comments_filter: &str, cases: Vec<ParentExistsCase<'_>>) {
        let snapshot = SnapshotId::new("parent_exists_placements")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        let value = |nullable| ValueDescriptor {
            logical_type: LogicalType::String,
            representation: ValueRepresentation::String,
            nullable,
            format: None,
            storage: None,
            constraints: None,
            json_schema: None,
        };
        let resource = |id, name: &str, columns: &[(&str, bool)]| {
            ResourceDescriptor::new(
                ResourceId::new(id).unwrap_or_else(|error| unreachable!("valid ID: {error}")),
                ResourceName::new(name)
                    .unwrap_or_else(|error| unreachable!("valid resource: {error}")),
                columns.iter().map(|(column, nullable)| {
                    (
                        ColumnName::new(*column)
                            .unwrap_or_else(|error| unreachable!("valid column: {error}")),
                        value(*nullable),
                    )
                }),
            )
            .unwrap_or_else(|error| unreachable!("valid resource: {error}"))
        };
        let catalog = Catalog::new(
            snapshot.clone(),
            [
                resource(
                    1,
                    "posts",
                    &[("id", false), ("tenant_id", false), ("title", false)],
                ),
                resource(
                    2,
                    "comments",
                    &[("id", false), ("post_id", true), ("body", false)],
                ),
                resource(3, "readers", &[("id", false), ("comment_id", false)]),
            ],
        )
        .unwrap_or_else(|error| unreachable!("valid Catalog: {error}"));
        let bundle = PolicyBundle::activate(
            &format!(
                r"
version: 1
resources:
  posts:
    roles:
      member:
        select:
          columns: [id, title]
          filter: {{ title: {{ neq: hidden }} }}
  comments:
    roles:
      member:
        select:
          columns: [id, post_id, body]
          filter: {comments_filter}
  readers:
    roles:
      member:
        select:
          columns: [id, comment_id]
          filter: {{ id: {{ neq: none }} }}
"
            ),
            &catalog,
            snapshot.clone(),
        )
        .unwrap_or_else(|error| unreachable!("valid policy: {error}"));
        let session = TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("valid role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("valid session: {error}"));
        let database = ReferenceSqlite::new(
            "CREATE TABLE posts (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL) STRICT;
             CREATE TABLE comments (id TEXT NOT NULL, post_id TEXT, body TEXT NOT NULL) STRICT;
             CREATE TABLE readers (id TEXT NOT NULL, comment_id TEXT NOT NULL) STRICT;",
            "INSERT INTO posts VALUES ('p1','tenant_1','a'), ('p2','tenant_2','b'), ('p4','tenant_1','d'), ('p5','tenant_1','hidden');
             INSERT INTO comments VALUES ('c1','p1','x'), ('c2','p2','y'), ('c3',NULL,'z'), ('c5','p5','w');
             INSERT INTO readers VALUES ('r1','c1'), ('r2','c2'), ('r3','c3');",
        )
        .unwrap_or_else(|error| unreachable!("reference database: {error}"));
        for (sql, expected) in cases {
            let statement = SqliteFrontend::default()
                .bind(sql, &catalog)
                .unwrap_or_else(|error| unreachable!("{sql} binds: {error}"));
            let protected = match (bundle.compile_select(&statement, &session), &expected) {
                (Ok(protected), Ok(_)) => protected,
                (Err(error), Err(expected)) => {
                    assert_eq!(&error, expected, "{sql}");
                    continue;
                }
                (actual, _) => unreachable!("{sql}: unexpected compile result {actual:?}"),
            };
            let verified = compile_verified_select(
                &protected.plan,
                &catalog,
                BTreeMap::new(),
                ExecutionLimits {
                    max_rows: 100,
                    max_result_bytes: 10_000,
                    timeout_ms: 1_000,
                    max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
                },
                snapshot.clone(),
            )
            .unwrap_or_else(|error| unreachable!("{sql} verifies: {error}"));
            let actual = database
                .execute(&verified)
                .unwrap_or_else(|error| unreachable!("{sql} executes: {error}"));
            assert_eq!(
                Ok(actual.rows),
                expected,
                "{sql}\n{}",
                verified.protected_sql()
            );
        }
    }

    const PARENT_TENANT: &str = "{ exists: { resource: posts, on: { id: post_id }, where: { tenant_id: { eq: { session: tenant_id } } } } }";

    fn text(value: &str) -> LogicalValue {
        LogicalValue::String(value.to_owned())
    }

    /// The select-policy `exists` (issue #112) keeps its meaning wherever the child's row
    /// filter is placed: the root `WHERE`, an INNER JOIN, a LEFT JOIN's `ON`, and inside a
    /// client `EXISTS`; and it does not widen what the client may reference.
    #[test]
    fn parent_exists_filter_holds_in_every_placement() {
        run_parent_exists_cases(
            PARENT_TENANT,
            vec![
                (
                    "SELECT c.id FROM comments c ORDER BY c.id",
                    Ok(vec![vec![text("c1")], vec![text("c5")]]),
                ),
                (
                    "SELECT c.id, p.title FROM comments c JOIN posts p ON p.id = c.post_id ORDER BY c.id",
                    Ok(vec![vec![text("c1"), text("a")]]),
                ),
                // The nullable side's rule sits in `ON`: p4 keeps its row with no comment, and
                // p2's comment (another tenant) is not attached to it.
                (
                    "SELECT p.id, c.id AS comment_id FROM posts p LEFT JOIN comments c ON c.post_id = p.id ORDER BY p.id",
                    Ok(vec![
                        vec![text("p1"), text("c1")],
                        vec![text("p2"), LogicalValue::Null],
                        vec![text("p4"), LogicalValue::Null],
                    ]),
                ),
                (
                    "SELECT c.id, p.id AS post_id FROM comments c LEFT JOIN posts p ON p.id = c.post_id ORDER BY c.id",
                    Ok(vec![
                        vec![text("c1"), text("p1")],
                        vec![text("c5"), LogicalValue::Null],
                    ]),
                ),
                // `posts` appears nowhere else, so the subquery in `ON` needs its own alias.
                (
                    "SELECT r.id, c.id AS comment_id FROM readers r LEFT JOIN comments c ON c.id = r.comment_id ORDER BY r.id",
                    Ok(vec![
                        vec![text("r1"), text("c1")],
                        vec![text("r2"), LogicalValue::Null],
                        vec![text("r3"), LogicalValue::Null],
                    ]),
                ),
                // Inside a client EXISTS over the child: the policy's `posts` subquery shadows
                // the outer `posts` alias and still correlates with the middle `comments` row.
                (
                    "SELECT p.id FROM posts p WHERE EXISTS (SELECT 1 FROM comments c WHERE c.post_id = p.id) ORDER BY p.id",
                    Ok(vec![vec![text("p1")]]),
                ),
                // A client EXISTS over the parent sits beside the policy's own `posts` subquery.
                (
                    "SELECT c.id FROM comments c WHERE EXISTS (SELECT 1 FROM posts p WHERE p.id = c.post_id AND p.title = 'a') ORDER BY c.id",
                    Ok(vec![vec![text("c1")]]),
                ),
                // The rule reads `posts.tenant_id`; the client still may not.
                (
                    "SELECT c.id FROM comments c JOIN posts p ON p.id = c.post_id WHERE p.tenant_id = 'tenant_2'",
                    Err(PolicyError::ForbiddenColumn),
                ),
                (
                    "SELECT c.id FROM comments c WHERE EXISTS (SELECT 1 FROM posts p WHERE p.id = c.post_id AND p.tenant_id = 'tenant_2')",
                    Err(PolicyError::ForbiddenColumn),
                ),
            ],
        );
    }

    /// Under `not`, a NULL or dangling child column matches: SQL `NOT EXISTS` is TRUE there.
    #[test]
    fn parent_exists_inside_not_and_and() {
        run_parent_exists_cases(
            &format!("{{ not: {PARENT_TENANT} }}"),
            vec![(
                "SELECT c.id FROM comments c ORDER BY c.id",
                Ok(vec![vec![text("c2")], vec![text("c3")]]),
            )],
        );
        run_parent_exists_cases(
            &format!("{{ and: [ {PARENT_TENANT}, {{ body: {{ neq: w }} }} ] }}"),
            vec![(
                "SELECT c.id FROM comments c ORDER BY c.id",
                Ok(vec![vec![text("c1")]]),
            )],
        );
    }

    fn mutation_catalog(snapshot: &SnapshotId) -> Catalog {
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
            ["id", "tenant_id", "name", "created_by"].map(|name| {
                (
                    ColumnName::new(name)
                        .unwrap_or_else(|error| unreachable!("valid column: {error}")),
                    descriptor.clone(),
                )
            }),
        )
        .unwrap_or_else(|error| unreachable!("valid descriptor: {error}"));
        Catalog::new(snapshot.clone(), [resource])
            .unwrap_or_else(|error| unreachable!("valid Catalog: {error}"))
    }

    fn mutation_session() -> TrustedSession {
        TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("valid role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("valid session: {error}"))
    }

    fn fixture_parameters(root: &Path) -> BTreeMap<ClientParameterName, LogicalValue> {
        let values: BTreeMap<String, serde_json::Value> =
            serde_json::from_str(&read_fixture(root, "client-params.json"))
                .unwrap_or_else(|error| unreachable!("fixture parameters: {error}"));
        values
            .into_iter()
            .map(|(name, value)| {
                (
                    ClientParameterName::new(name)
                        .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
                    fixture_value(&value),
                )
            })
            .collect()
    }

    #[test]
    fn mutation_fixtures_match_golden_sql_and_reference_sqlite() {
        let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/sqlite-turso-v1/mutation");
        for (directory, expected_rows) in [
            (
                "insert-values",
                vec![vec![
                    LogicalValue::String("p1".to_owned()),
                    LogicalValue::String("Created".to_owned()),
                ]],
            ),
            (
                "update-filtered",
                vec![vec![
                    LogicalValue::String("p1".to_owned()),
                    LogicalValue::String("Renamed".to_owned()),
                ]],
            ),
            (
                "delete-filtered",
                vec![vec![LogicalValue::String("p1".to_owned())]],
            ),
        ] {
            let root = fixture_root.join(directory);
            let snapshot = SnapshotId::new(format!("mutation_{directory}"))
                .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
            let catalog = mutation_catalog(&snapshot);
            let statement = SqliteFrontend::default()
                .bind(&read_fixture(&root, "input.sql"), &catalog)
                .unwrap_or_else(|error| unreachable!("fixture binds: {error}"));
            let bundle = PolicyBundle::activate(
                &read_fixture(&root, "policy.yaml"),
                &catalog,
                snapshot.clone(),
            )
            .unwrap_or_else(|error| unreachable!("fixture policy: {error}"));
            let protected = match directory {
                "insert-values" => {
                    bundle.compile_insert(&statement, &mutation_session(), &context())
                }
                "update-filtered" => {
                    bundle.compile_update(&statement, &mutation_session(), &context())
                }
                "delete-filtered" => bundle.compile_delete(&statement, &mutation_session()),
                _ => unreachable!("closed mutation fixture list"),
            }
            .unwrap_or_else(|error| unreachable!("fixture compiles: {error}"));
            if let Ok(negative) = SqliteFrontend::default()
                .bind(&read_fixture(&root, "negative-control.sql"), &catalog)
            {
                let denied = match directory {
                    "insert-values" => {
                        bundle.compile_insert(&negative, &mutation_session(), &context())
                    }
                    "update-filtered" => {
                        bundle.compile_update(&negative, &mutation_session(), &context())
                    }
                    "delete-filtered" => bundle.compile_delete(&negative, &mutation_session()),
                    _ => unreachable!("closed mutation fixture list"),
                };
                assert!(denied.is_err());
            }
            let parameters = fixture_parameters(&root);
            let limits = ExecutionLimits {
                max_rows: 100,
                max_result_bytes: 10_000,
                timeout_ms: 1_000,
                max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
            };
            let verified = match directory {
                "insert-values" => {
                    compile_verified_insert(&protected.plan, &catalog, parameters, limits, snapshot)
                }
                "update-filtered" => {
                    compile_verified_update(&protected.plan, &catalog, parameters, limits, snapshot)
                }
                "delete-filtered" => {
                    compile_verified_delete(&protected.plan, &catalog, parameters, limits, snapshot)
                }
                _ => unreachable!("closed mutation fixture list"),
            }
            .unwrap_or_else(|error| unreachable!("fixture verifies: {error}"));
            assert_eq!(
                verified.protected_sql(),
                read_fixture(&root, "expected/protected.sql").trim()
            );
            let database = ReferenceSqlite::new(
                &read_fixture(&root, "schema.sql"),
                &read_fixture(&root, "seed.sql"),
            )
            .unwrap_or_else(|error| unreachable!("reference database: {error}"));
            let result = database
                .execute(&verified)
                .unwrap_or_else(|error| unreachable!("mutation executes: {error}"));
            assert_eq!(result.rows, expected_rows);
        }
    }

    #[derive(serde::Deserialize)]
    struct FixtureContext {
        #[serde(rename = "nowMs")]
        now_ms: u64,
    }

    /// The Catalog of a fixture whose manifest uses `string`, `instant`, `datetime`, and `int64`;
    /// a temporal type fixes its format, as the runtime does.
    fn typed_fixture_catalog(root: &Path, snapshot: &SnapshotId) -> Catalog {
        let raw: FixtureCatalog =
            serde_yaml::from_str(&read_fixture(root, "catalog-manifest.yaml"))
                .unwrap_or_else(|error| unreachable!("fixture Catalog parses: {error}"));
        let resources = raw
            .resources
            .into_iter()
            .enumerate()
            .map(|(index, (resource_name, resource))| {
                let columns = resource.columns.into_iter().map(|(name, column)| {
                    let (logical_type, representation, format) = match column.r#type.as_str() {
                        "string" => (LogicalType::String, ValueRepresentation::String, None),
                        "instant" => (
                            LogicalType::Instant,
                            ValueRepresentation::String,
                            Some("rfc3339"),
                        ),
                        "datetime" => (
                            LogicalType::DateTime,
                            ValueRepresentation::String,
                            Some("sqlite-datetime"),
                        ),
                        "int64" => (LogicalType::Int64, ValueRepresentation::String, None),
                        other => unreachable!("unsupported fixture type: {other}"),
                    };
                    (
                        ColumnName::new(name)
                            .unwrap_or_else(|error| unreachable!("fixture column: {error}")),
                        ValueDescriptor {
                            logical_type,
                            representation,
                            nullable: column.nullable,
                            format: format.map(str::to_owned),
                            storage: None,
                            constraints: None,
                            json_schema: None,
                        },
                    )
                });
                ResourceDescriptor::new(
                    ResourceId::new(u64::try_from(index + 1).unwrap_or(u64::MAX))
                        .unwrap_or_else(|error| unreachable!("fixture resource ID: {error}")),
                    ResourceName::new(resource_name)
                        .unwrap_or_else(|error| unreachable!("fixture resource: {error}")),
                    columns,
                )
                .unwrap_or_else(|error| unreachable!("fixture descriptor: {error}"))
            })
            .collect::<Vec<_>>();
        Catalog::new(snapshot.clone(), resources)
            .unwrap_or_else(|error| unreachable!("fixture Catalog: {error}"))
    }

    /// `mutation/update-now-preset` (ADR 0031): the golden SQL, the server parameters, the
    /// reference SQLite's RETURNING row, the time spelled by SQLite's own calendar, and the
    /// other tenant's row left alone.
    #[allow(clippy::too_many_lines)]
    fn now_preset_fixture() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/sqlite-turso-v1/mutation/update-now-preset");
        let snapshot = SnapshotId::new("mutation_update_now_preset")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        let catalog = typed_fixture_catalog(&root, &snapshot);
        let bundle = PolicyBundle::activate(
            &read_fixture(&root, "policy.yaml"),
            &catalog,
            snapshot.clone(),
        )
        .unwrap_or_else(|error| unreachable!("fixture policy: {error}"));
        let raw_context: FixtureContext =
            serde_json::from_str(&read_fixture(&root, "context.json"))
                .unwrap_or_else(|error| unreachable!("fixture context: {error}"));
        let context = policysql_core::CompileContext::new(raw_context.now_ms)
            .unwrap_or_else(|| unreachable!("the fixture time is in range"));
        let mut raw_session: FixtureSession =
            serde_json::from_str(&read_fixture(&root, "session.json"))
                .unwrap_or_else(|error| unreachable!("fixture session: {error}"));
        let subject = raw_session
            .values
            .remove("subject_id")
            .unwrap_or_else(|| unreachable!("fixture subject"));
        let session = TrustedSession::new(
            RoleName::new(raw_session.role)
                .unwrap_or_else(|error| unreachable!("fixture role: {error}")),
            subject,
            raw_session.values,
        )
        .unwrap_or_else(|error| unreachable!("trusted fixture session: {error}"));

        // Negative: the client cannot assign a `now` column.
        let negative = SqliteFrontend::default()
            .bind(&read_fixture(&root, "negative-control.sql"), &catalog)
            .unwrap_or_else(|error| unreachable!("negative control binds: {error}"));
        assert_eq!(
            bundle.compile_update(&negative, &session, &context).err(),
            Some(PolicyError::ForbiddenColumn)
        );

        let statement = SqliteFrontend::default()
            .bind(&read_fixture(&root, "input.sql"), &catalog)
            .unwrap_or_else(|error| unreachable!("fixture binds: {error}"));
        let protected = bundle
            .compile_update(&statement, &session, &context)
            .unwrap_or_else(|error| unreachable!("fixture compiles: {error}"));
        let verified = compile_verified_update(
            &protected.plan,
            &catalog,
            fixture_parameters(&root),
            ExecutionLimits {
                max_rows: 100,
                max_result_bytes: 10_000,
                timeout_ms: 1_000,
                max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
            },
            snapshot,
        )
        .unwrap_or_else(|error| unreachable!("fixture verifies: {error}"));
        assert_eq!(
            verified.protected_sql(),
            read_fixture(&root, "expected/protected.sql").trim()
        );
        let server: BTreeMap<&str, &LogicalValue> = verified
            .server_parameters()
            .iter()
            .map(|(name, value)| (name.as_str(), value))
            .collect();
        assert_eq!(
            server,
            BTreeMap::from([
                (
                    "__policysql_now_epoch_ms",
                    &LogicalValue::Int64(1_793_366_096_789)
                ),
                (
                    "__policysql_now_rfc3339",
                    &LogicalValue::String("2026-10-30T13:14:56.789Z".to_owned())
                ),
                (
                    "__policysql_session_subject_id",
                    &LogicalValue::String("user_1".to_owned())
                ),
                (
                    "__policysql_session_tenant_id",
                    &LogicalValue::String("tenant_1".to_owned())
                ),
            ])
        );

        // Differential: the reference SQLite runs the sealed statement.
        let database = ReferenceSqlite::new(
            &read_fixture(&root, "schema.sql"),
            &read_fixture(&root, "seed.sql"),
        )
        .unwrap_or_else(|error| unreachable!("reference database: {error}"));
        let result = database
            .execute(&verified)
            .unwrap_or_else(|error| unreachable!("mutation executes: {error}"));
        // `result.json` spells a safe `int64` as a JSON number, as the public API does.
        let expected: serde_json::Value =
            serde_json::from_str(&read_fixture(&root, "expected/result.json"))
                .unwrap_or_else(|error| unreachable!("fixture result: {error}"));
        let wire_rows: Vec<serde_json::Value> = result
            .rows
            .iter()
            .map(|row| {
                serde_json::Value::Object(
                    result
                        .columns
                        .iter()
                        .zip(row)
                        .map(|(column, value)| {
                            (
                                column.clone(),
                                match value {
                                    LogicalValue::String(value) => value.clone().into(),
                                    LogicalValue::Int64(value) => (*value).into(),
                                    other => unreachable!("unexpected result value {other:?}"),
                                },
                            )
                        })
                        .collect(),
                )
            })
            .collect();
        assert_eq!(expected["columns"], serde_json::json!(result.columns));
        assert_eq!(expected["rows"], serde_json::Value::Array(wire_rows));
        // SQLite's own calendar spells the same instant, and the `int64` is stored as INTEGER.
        let ms = LogicalValue::Int64(raw_context.now_ms.try_into().unwrap_or(i64::MAX));
        assert_eq!(
            database.trusted_rows(
                "SELECT updated_at = strftime('%Y-%m-%dT%H:%M:%S', ?1 / 1000, 'unixepoch') || printf('.%03dZ', ?1 % 1000), \
                 updated_ms = ?1, typeof(updated_ms) FROM projects WHERE id = 'p1'",
                &[ms],
            )
            .unwrap_or_else(|error| unreachable!("trusted query: {error}")),
            vec![vec![
                LogicalValue::Int64(1),
                LogicalValue::Int64(1),
                LogicalValue::String("integer".to_owned())
            ]]
        );
        // Bypass: the other tenant's row keeps the seed's time columns.
        assert_eq!(
            database
                .trusted_rows(
                    "SELECT name, updated_by, updated_at, updated_ms FROM projects WHERE id = 'p2'",
                    &[],
                )
                .unwrap_or_else(|error| unreachable!("trusted query: {error}")),
            vec![vec![
                LogicalValue::String("Hidden".to_owned()),
                LogicalValue::String("other".to_owned()),
                LogicalValue::String("2000-01-01T00:00:00.000Z".to_owned()),
                LogicalValue::Int64(0)
            ]]
        );
    }

    /// Compiles `statement` with the policy entry point for its kind, requires a rejection, and
    /// compares the public code `policysql-gateway` maps the policy error to.
    fn assert_policy_rejection(
        directory: &str,
        bundle: &PolicyBundle,
        statement: &BoundStatement,
        session: &TrustedSession,
        expected_code: &str,
    ) {
        let error = match statement {
            BoundStatement::Insert(_) => bundle.compile_insert(statement, session, &context()),
            BoundStatement::Update(_) => bundle.compile_update(statement, session, &context()),
            BoundStatement::Delete(_) => bundle.compile_delete(statement, session),
            _ => bundle.compile_select(statement, session),
        }
        .err()
        .unwrap_or_else(|| unreachable!("{directory} must be denied"));
        let code = match error {
            PolicyError::MissingPolicy => "POLICYSQL_MISSING_POLICY",
            PolicyError::ForbiddenColumn | PolicyError::UnknownColumn => {
                "POLICYSQL_FORBIDDEN_COLUMN"
            }
            PolicyError::UnsupportedCapability => "POLICYSQL_FORBIDDEN_OPERATION",
            other => unreachable!("{directory}: unmapped policy error {other:?}"),
        };
        assert_eq!(code, expected_code, "{directory}");
    }

    /// The public code `policysql-gateway` gives a rejection kind (the strings of the WASM
    /// boundary's `rejection_body`). Exhaustive, so a new kind is a decision here.
    fn rejection_code(kind: RejectionKind) -> &'static str {
        match kind {
            RejectionKind::InvalidRequest => "POLICYSQL_INVALID_REQUEST",
            RejectionKind::InvalidSql => "POLICYSQL_INVALID_SQL",
            RejectionKind::MultipleStatements => "POLICYSQL_MULTIPLE_STATEMENTS",
            RejectionKind::UnsupportedSql => "POLICYSQL_UNSUPPORTED_SQL",
            RejectionKind::MissingPolicy => "POLICYSQL_MISSING_POLICY",
            RejectionKind::ForbiddenOperation => "POLICYSQL_FORBIDDEN_OPERATION",
            RejectionKind::ForbiddenColumn => "POLICYSQL_FORBIDDEN_COLUMN",
            RejectionKind::ForbiddenColumnContext => "POLICYSQL_FORBIDDEN_COLUMN_CONTEXT",
            RejectionKind::DuplicateResultColumn => "POLICYSQL_DUPLICATE_RESULT_COLUMN",
            RejectionKind::InvalidParameter => "POLICYSQL_INVALID_PARAMETER",
            RejectionKind::AmbiguousParameterType => "POLICYSQL_AMBIGUOUS_PARAMETER_TYPE",
            RejectionKind::ReservedParameter => "POLICYSQL_RESERVED_PARAMETER",
            RejectionKind::PresetColumn => "POLICYSQL_PRESET_COLUMN",
            RejectionKind::LimitExceeded => "POLICYSQL_LIMIT_EXCEEDED",
            RejectionKind::ExpectationFailed => "POLICYSQL_EXPECTATION_FAILED",
        }
    }

    /// Compiles a bound fixture statement with the fixture's client parameters: the policy must
    /// accept it, so that the refusal under test is the one of the client's values.
    fn compile_with_fixture_parameters(
        root: &Path,
        catalog: &Catalog,
        bundle: &PolicyBundle,
        statement: &BoundStatement,
        session: &TrustedSession,
    ) -> Result<(), CompileError> {
        let limits = ExecutionLimits {
            max_rows: 100,
            max_result_bytes: 10_000,
            timeout_ms: 1_000,
            max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
        };
        let parameters = fixture_parameters(root);
        let snapshot = catalog.snapshot().clone();
        let unreachable_policy = |error: PolicyError| -> ! {
            unreachable!("the policy must accept the fixture statement: {error}")
        };
        match statement {
            BoundStatement::Insert(_) => {
                let output = bundle
                    .compile_insert(statement, session, &context())
                    .unwrap_or_else(|error| unreachable_policy(error));
                compile_verified_insert(&output.plan, catalog, parameters, limits, snapshot)
                    .map(|_| ())
            }
            BoundStatement::Update(_) => {
                let output = bundle
                    .compile_update(statement, session, &context())
                    .unwrap_or_else(|error| unreachable_policy(error));
                compile_verified_update(&output.plan, catalog, parameters, limits, snapshot)
                    .map(|_| ())
            }
            BoundStatement::Delete(_) => {
                let output = bundle
                    .compile_delete(statement, session)
                    .unwrap_or_else(|error| unreachable_policy(error));
                compile_verified_delete(&output.plan, catalog, parameters, limits, snapshot)
                    .map(|_| ())
            }
            _ => {
                let output = bundle
                    .compile_select(statement, session)
                    .unwrap_or_else(|error| unreachable_policy(error));
                compile_verified_select(&output.plan, catalog, parameters, limits, snapshot)
                    .map(|_| ())
            }
        }
    }

    /// Denied security fixtures under `tests/fixtures/sqlite-turso-v1/security`.
    const SECURITY_DENY_FIXTURES: &[&str] = &[
        "aggregate-exists-resource",
        "aggregate-joined-resource",
        "aggregate-outside-select-list",
        "exists-outside-where",
        "forbidden-filter-column",
        "forbidden-order-column",
        "missing-policy",
        "mutation-delete-forbidden-filter-column",
        "mutation-forbidden-filter-column",
        "negative-limit-parameter",
        "server-parameter-collision",
        "statement-smuggling",
        "window-joined-resource",
    ];

    #[allow(clippy::too_many_lines)]
    fn verify_denied_security_fixtures() {
        let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/sqlite-turso-v1/security");
        for directory in SECURITY_DENY_FIXTURES {
            let root = fixture_root.join(directory);
            let raw_catalog: FixtureCatalog =
                serde_yaml::from_str(&read_fixture(&root, "catalog-manifest.yaml"))
                    .unwrap_or_else(|error| unreachable!("fixture Catalog parses: {error}"));
            let snapshot = SnapshotId::new(format!("security_{directory}"))
                .unwrap_or_else(|error| unreachable!("fixture snapshot: {error}"));
            let resources = raw_catalog
                .resources
                .into_iter()
                .enumerate()
                .map(|(index, (resource_name, resource))| {
                    let resource_id = ResourceId::new(u64::try_from(index + 1).unwrap_or(u64::MAX))
                        .unwrap_or_else(|error| unreachable!("fixture resource ID: {error}"));
                    let columns = resource.columns.into_iter().map(|(name, column)| {
                        let logical_type = match column.r#type.as_str() {
                            "string" => LogicalType::String,
                            "boolean" => LogicalType::Boolean,
                            "int64" => LogicalType::Int64,
                            "json" => LogicalType::Json,
                            other => unreachable!("unsupported fixture type: {other}"),
                        };
                        (
                            ColumnName::new(name)
                                .unwrap_or_else(|error| unreachable!("fixture column: {error}")),
                            ValueDescriptor {
                                logical_type,
                                representation: match logical_type {
                                    LogicalType::String => ValueRepresentation::String,
                                    LogicalType::Boolean => ValueRepresentation::Boolean,
                                    LogicalType::Int64 => ValueRepresentation::Number,
                                    LogicalType::Json => ValueRepresentation::Json,
                                    _ => unreachable!("closed fixture type set"),
                                },
                                nullable: column.nullable,
                                format: None,
                                storage: None,
                                constraints: None,
                                json_schema: fixture_json_schema(logical_type),
                            },
                        )
                    });
                    ResourceDescriptor::new(
                        resource_id,
                        ResourceName::new(resource_name)
                            .unwrap_or_else(|error| unreachable!("fixture resource: {error}")),
                        columns,
                    )
                    .unwrap_or_else(|error| unreachable!("fixture descriptor: {error}"))
                })
                .collect::<Vec<_>>();
            let catalog = Catalog::new(snapshot.clone(), resources)
                .unwrap_or_else(|error| unreachable!("fixture Catalog: {error}"));
            let bundle =
                PolicyBundle::activate(&read_fixture(&root, "policy.yaml"), &catalog, snapshot)
                    .unwrap_or_else(|error| unreachable!("fixture policy: {error}"));
            let mut raw_session: FixtureSession =
                serde_json::from_str(&read_fixture(&root, "session.json"))
                    .unwrap_or_else(|error| unreachable!("fixture session: {error}"));
            let subject = raw_session
                .values
                .remove("subject_id")
                .unwrap_or_else(|| "fixture_subject".to_owned());
            let session = TrustedSession::new(
                RoleName::new(raw_session.role)
                    .unwrap_or_else(|error| unreachable!("fixture role: {error}")),
                subject,
                raw_session.values,
            )
            .unwrap_or_else(|error| unreachable!("trusted fixture session: {error}"));
            let expectation: RejectionExpectation =
                read_yaml(&root.join("expected/rejection.yaml"))
                    .unwrap_or_else(|error| unreachable!("{directory} rejection: {error}"));
            let bound = SqliteFrontend::default().bind(&read_fixture(&root, "input.sql"), &catalog);
            match expectation.stage.as_str() {
                "authorization" => {
                    // An authorization fixture must reach the policy layer, or it tests nothing.
                    let statement = bound
                        .unwrap_or_else(|error| unreachable!("{directory} must bind: {error}"));
                    assert_policy_rejection(
                        directory,
                        &bundle,
                        &statement,
                        &session,
                        &expectation.code,
                    );
                }
                // Refused before the policy: by the parser or binder, or by the client's values.
                "parse" | "binding" | "parameter_validation" => {
                    let code = match bound {
                        Err(error) => rejection_code(classify_bind_error(&error).kind),
                        Ok(statement) => {
                            assert_eq!(
                                expectation.stage, "parameter_validation",
                                "{directory} must not bind"
                            );
                            let error = compile_with_fixture_parameters(
                                &root, &catalog, &bundle, &statement, &session,
                            )
                            .err()
                            .unwrap_or_else(|| unreachable!("{directory} must be refused"));
                            match compile_failure(&error, 0) {
                                GatewayError::Rejected { rejection, .. } => {
                                    rejection_code(rejection.kind)
                                }
                                other => unreachable!("{directory}: not a rejection: {other:?}"),
                            }
                        }
                    };
                    assert_eq!(code, expectation.code, "{directory}");
                }
                // Older fixtures whose stage names no layer the test reproduces (`policy`).
                _ => {
                    if let Ok(statement) = bound {
                        assert!(bundle.compile_select(&statement, &session).is_err());
                    }
                }
            }
            let executor = RecordingExecutor::<()>::default();
            assert_eq!(executor.call_count(), 0);
        }
    }

    /// Catalog for an all-string fixture manifest.
    fn string_fixture_catalog(root: &Path, snapshot: &SnapshotId) -> Catalog {
        let raw: FixtureCatalog =
            serde_yaml::from_str(&read_fixture(root, "catalog-manifest.yaml"))
                .unwrap_or_else(|error| unreachable!("fixture Catalog parses: {error}"));
        let resources = raw
            .resources
            .into_iter()
            .enumerate()
            .map(|(index, (name, resource))| {
                let columns = resource.columns.into_iter().map(|(column, value)| {
                    assert_eq!(value.r#type, "string", "string-only fixture Catalog");
                    (
                        ColumnName::new(column)
                            .unwrap_or_else(|error| unreachable!("fixture column: {error}")),
                        ValueDescriptor {
                            logical_type: LogicalType::String,
                            representation: ValueRepresentation::String,
                            nullable: value.nullable,
                            format: None,
                            storage: None,
                            constraints: None,
                            json_schema: None,
                        },
                    )
                });
                ResourceDescriptor::new(
                    ResourceId::new(u64::try_from(index + 1).unwrap_or(u64::MAX))
                        .unwrap_or_else(|error| unreachable!("fixture resource ID: {error}")),
                    ResourceName::new(name)
                        .unwrap_or_else(|error| unreachable!("fixture resource: {error}")),
                    columns,
                )
                .unwrap_or_else(|error| unreachable!("fixture descriptor: {error}"))
            })
            .collect::<Vec<_>>();
        Catalog::new(snapshot.clone(), resources)
            .unwrap_or_else(|error| unreachable!("fixture Catalog: {error}"))
    }

    /// Runs SQL with named arguments directly on SQLite and returns every physical row.
    fn raw_rows(
        connection: &rusqlite::Connection,
        sql: &str,
        arguments: &BTreeMap<String, LogicalValue>,
    ) -> Vec<Vec<rusqlite::types::Value>> {
        let mut statement = connection
            .prepare(sql)
            .unwrap_or_else(|error| unreachable!("SQL prepares: {error}"));
        for (name, value) in arguments {
            let index = statement
                .parameter_index(&format!(":{name}"))
                .unwrap_or_else(|error| unreachable!("parameter index: {error}"))
                .unwrap_or_else(|| unreachable!("SQL references :{name}"));
            statement
                .raw_bind_parameter(
                    index,
                    super::encode(value).unwrap_or_else(|error| unreachable!("encode: {error}")),
                )
                .unwrap_or_else(|error| unreachable!("bind: {error}"));
        }
        let width = statement.column_count();
        let mut rows = statement.raw_query();
        let mut output = Vec::new();
        while let Some(row) = rows
            .next()
            .unwrap_or_else(|error| unreachable!("SQL executes: {error}"))
        {
            output.push(
                (0..width)
                    .map(|index| {
                        row.get_ref(index).map_or_else(
                            |error| unreachable!("column: {error}"),
                            rusqlite::types::Value::from,
                        )
                    })
                    .collect(),
            );
        }
        output
    }

    /// Issue #39 regression: client string literals bind decoded values, `<>`
    /// excludes the decoded row, and a policy `neq` check sees the decoded value.
    #[allow(clippy::too_many_lines)]
    fn string_literal_security_fixture() {
        use rusqlite::types::Value as SqlValue;
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/sqlite-turso-v1/security/string-literal-decoding");
        let snapshot = SnapshotId::new("security_string_literal_decoding")
            .unwrap_or_else(|error| unreachable!("fixture snapshot: {error}"));
        let catalog = string_fixture_catalog(&root, &snapshot);
        let bundle = PolicyBundle::activate(
            &read_fixture(&root, "policy.yaml"),
            &catalog,
            snapshot.clone(),
        )
        .unwrap_or_else(|error| unreachable!("fixture policy: {error}"));
        let compile = |sql: &str| {
            // Same composition as the gateway: client witnesses travel with the plan.
            let document = SqliteFrontend::default()
                .bind_document(sql, &catalog)
                .unwrap_or_else(|error| unreachable!("fixture binds: {error}"));
            let mut output = bundle
                .compile_update(&document.statement, &mutation_session(), &context())
                .unwrap_or_else(|error| unreachable!("fixture compiles: {error}"));
            output.plan.string_literals.client = document.string_literals;
            compile_verified_update(
                &output.plan,
                &catalog,
                fixture_parameters(&root),
                ExecutionLimits {
                    max_rows: 100,
                    max_result_bytes: 10_000,
                    timeout_ms: 1_000,
                    max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
                },
                snapshot.clone(),
            )
            .unwrap_or_else(|error| unreachable!("fixture verifies: {error}"))
        };
        let arguments =
            |plan: &policysql_execution::VerifiedExecutionPlan<policysql_sqlite::SqliteProfile>| {
                plan.client_parameters()
                    .iter()
                    .map(|(name, value)| (name.as_str().to_owned(), value.clone()))
                    .chain(
                        plan.server_parameters()
                            .iter()
                            .map(|(name, value)| (name.as_str().to_owned(), value.clone())),
                    )
                    .collect::<BTreeMap<_, _>>()
            };
        let database = |single_tenant: bool| {
            let connection = rusqlite::Connection::open_in_memory()
                .unwrap_or_else(|error| unreachable!("database: {error}"));
            connection
                .execute_batch(&read_fixture(&root, "schema.sql"))
                .and_then(|()| connection.execute_batch(&read_fixture(&root, "seed.sql")))
                .unwrap_or_else(|error| unreachable!("seed: {error}"));
            if single_tenant {
                connection
                    .execute_batch("DELETE FROM projects WHERE tenant_id <> 'tenant_1'")
                    .unwrap_or_else(|error| unreachable!("single tenant: {error}"));
            }
            connection
        };
        let text = |value: &str| SqlValue::Text(value.to_owned());

        // Positive and golden: decoded server literals and sealed SQL.
        let verified = compile(&read_fixture(&root, "input.sql"));
        assert_eq!(
            verified.protected_sql(),
            read_fixture(&root, "expected/protected.sql").trim()
        );
        let literals = verified
            .server_parameters()
            .iter()
            .filter(|(name, _)| name.as_str().starts_with("__policysql_literal_"))
            .map(|(_, value)| match value {
                LogicalValue::String(value) => value.clone(),
                other => unreachable!("string literal expected: {other:?}"),
            })
            .collect::<BTreeSet<_>>();
        let expected_literals = ["it's", "p2", "archived"]
            .map(str::to_owned)
            .into_iter()
            .collect::<BTreeSet<_>>();
        assert_eq!(literals, expected_literals);

        // Differential: protected on multi-tenant data vs client SQL unprotected
        // on the single-tenant data the policy exposes.
        let protected_database = database(false);
        let rows = raw_rows(
            &protected_database,
            verified.protected_sql(),
            &arguments(&verified),
        );
        let width = verified.result().len();
        assert!(
            rows.iter()
                .all(|row| matches!(row.get(width), Some(SqlValue::Integer(1))))
        );
        let returned = rows
            .into_iter()
            .map(|row| row.into_iter().take(width).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        let reference_database = database(true);
        let reference = raw_rows(
            &reference_database,
            &read_fixture(&root, "input.sql"),
            &BTreeMap::new(),
        );
        assert_eq!(returned, reference);
        let expected: serde_json::Value =
            serde_json::from_str(&read_fixture(&root, "expected/result.json"))
                .unwrap_or_else(|error| unreachable!("fixture result: {error}"));
        assert_eq!(
            returned,
            vec![vec![text("p1"), text("it's"), text("active")]]
        );
        assert_eq!(expected["affectedRows"], 1);
        let state = "SELECT id, tenant_id, name, status FROM projects ORDER BY id";
        assert_eq!(
            raw_rows(&protected_database, state, &BTreeMap::new()),
            vec![
                vec![text("p1"), text("tenant_1"), text("it's"), text("active")],
                // Bypass: the row excluded by `<> 'p2'` and the other tenant are untouched.
                vec![text("p2"), text("tenant_1"), text("Keep"), text("active")],
                vec![text("p3"), text("tenant_2"), text("Other"), text("active")],
            ]
        );

        // Negative control: writing the decoded `archived` fails the policy `neq` check.
        let negative = compile(&read_fixture(&root, "negative-control.sql"));
        let rows = raw_rows(
            &database(false),
            negative.protected_sql(),
            &arguments(&negative),
        );
        let width = negative.result().len();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get(width), Some(&SqlValue::Integer(0)));
    }

    /// Issue #136 differential: SQLite reads a negative `LIMIT` as no bound, so a negative client
    /// parameter in `MIN(:limit, policy limit)` would lift the policy cap. The contract refuses it
    /// before execution; the protected SQL itself, run with a negative value, would not hold.
    #[test]
    #[allow(clippy::too_many_lines)]
    fn negative_limit_parameter_would_lift_the_policy_cap_on_sqlite() {
        use rusqlite::types::Value as SqlValue;
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/sqlite-turso-v1/security/negative-limit-parameter");
        let snapshot = SnapshotId::new("security_negative_limit_parameter")
            .unwrap_or_else(|error| unreachable!("fixture snapshot: {error}"));
        let catalog = string_fixture_catalog(&root, &snapshot);
        let bundle = PolicyBundle::activate(
            &read_fixture(&root, "policy.yaml"),
            &catalog,
            snapshot.clone(),
        )
        .unwrap_or_else(|error| unreachable!("fixture policy: {error}"));
        let statement = SqliteFrontend::default()
            .bind(&read_fixture(&root, "input.sql"), &catalog)
            .unwrap_or_else(|error| unreachable!("fixture binds: {error}"));
        let protected = bundle
            .compile_select(&statement, &mutation_session())
            .unwrap_or_else(|error| unreachable!("fixture compiles: {error}"));
        let compile = |limit: i64| {
            compile_verified_select(
                &protected.plan,
                &catalog,
                BTreeMap::from([(
                    ClientParameterName::new("limit")
                        .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
                    LogicalValue::Int64(limit),
                )]),
                ExecutionLimits {
                    max_rows: 100,
                    max_result_bytes: 10_000,
                    timeout_ms: 1_000,
                    max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
                },
                snapshot.clone(),
            )
        };

        // 1. The policy cap is composed as `MIN(:limit, 2)`.
        let verified = compile(1)
            .unwrap_or_else(|error| unreachable!("a non-negative limit compiles: {error}"));
        assert!(
            verified.protected_sql().contains("LIMIT MIN (:limit, 2)"),
            "{}",
            verified.protected_sql()
        );

        let connection = rusqlite::Connection::open_in_memory()
            .unwrap_or_else(|error| unreachable!("database: {error}"));
        connection
            .execute_batch(&read_fixture(&root, "schema.sql"))
            .unwrap_or_else(|error| unreachable!("schema: {error}"));
        for (id, tenant) in [
            ("p1", "tenant_1"),
            ("p2", "tenant_1"),
            ("p3", "tenant_1"),
            ("p4", "tenant_1"),
            ("p5", "tenant_1"),
            ("p6", "tenant_2"),
        ] {
            connection
                .execute(
                    "INSERT INTO projects (id, tenant_id, name) VALUES (?1, ?2, 'n')",
                    [id, tenant],
                )
                .unwrap_or_else(|error| unreachable!("seed: {error}"));
        }
        let arguments =
            |plan: &policysql_execution::VerifiedExecutionPlan<policysql_sqlite::SqliteProfile>,
             limit: i64| {
                plan.server_parameters()
                    .iter()
                    .map(|(name, value)| (name.as_str().to_owned(), value.clone()))
                    .chain([("limit".to_owned(), LogicalValue::Int64(limit))])
                    .collect::<BTreeMap<_, _>>()
            };
        let ids = |rows: Vec<Vec<SqlValue>>| {
            rows.into_iter()
                .filter_map(|row| match row.into_iter().next() {
                    Some(SqlValue::Text(id)) => Some(id),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };

        // 2. Every non-negative limit returns `min(limit, 2)` rows, the first ones of tenant_1.
        for (limit, expected) in [(0, 0), (1, 1), (2, 2), (5, 2)] {
            let verified = compile(limit)
                .unwrap_or_else(|error| unreachable!("limit {limit} compiles: {error}"));
            let returned = ids(raw_rows(
                &connection,
                verified.protected_sql(),
                &arguments(&verified, limit),
            ));
            assert_eq!(returned, ["p1", "p2"][..expected].to_vec(), "limit {limit}");
        }

        // 3. The danger the contract exists for: the same SQL with a negative value returns every
        //    row of the tenant, past the policy cap. A SQLite that stops doing so changes this.
        assert_eq!(
            ids(raw_rows(
                &connection,
                verified.protected_sql(),
                &arguments(&verified, -1)
            )),
            ["p1", "p2", "p3", "p4", "p5"].map(str::to_owned).to_vec()
        );

        // 4. Compile refuses the negative value before any execution.
        assert!(matches!(
            compile(-1),
            Err(CompileError::ClientParameterTypeMismatch)
        ));
    }

    #[test]
    fn executed_fixture_matrix_writes_coverage_evidence() {
        protected_fixture_matches_reference_sqlite_result();
        expanded_read_fixtures_match_golden_sql_and_reference_sqlite();
        mutation_fixtures_match_golden_sql_and_reference_sqlite();
        now_preset_fixture();
        verify_denied_security_fixtures();
        string_literal_security_fixture();

        let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures");
        let fixtures = load_fixtures(&fixture_root)
            .unwrap_or_else(|error| unreachable!("fixture manifests load: {error}"));
        let evidence = ExecutionEvidence {
            version: 1,
            fixtures: fixtures
                .into_iter()
                .map(|(case_path, fixture)| FixtureExecutionEvidence {
                    id: fixture.id,
                    digest: fixture_digest(case_path.parent().unwrap_or_else(|| Path::new(".")))
                        .unwrap_or_else(|error| unreachable!("fixture digest: {error}")),
                    tests: fixture.tests,
                })
                .collect(),
        };
        let output = evidence_path(&fixture_root);
        fs::create_dir_all(output.parent().unwrap_or_else(|| Path::new(".")))
            .unwrap_or_else(|error| unreachable!("evidence directory: {error}"));
        fs::write(
            output,
            serde_json::to_vec_pretty(&evidence)
                .unwrap_or_else(|error| unreachable!("evidence serializes: {error}")),
        )
        .unwrap_or_else(|error| unreachable!("evidence writes: {error}"));
    }
}
