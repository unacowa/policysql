#![forbid(unsafe_code)]

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
    use super::{
        CaseManifest, ExecutionEvidence, ExpectedDisposition, FixtureExecutionEvidence, OracleRow,
        OracleSession, OracleValue, RecordingExecutor, ReferenceSqlite, SurfaceDocument,
        SurfaceLeaf, SurfaceStatus, TestClass, TruthValue, build_report, evaluate_select_filter,
        evidence_path, fixture_digest, load_fixtures,
    };
    use policysql_catalog::{Catalog, ResourceDescriptor};
    use policysql_core::{
        ClientParameterName, ColumnName, JsonSchemaType, JsonValueSchema, LogicalType,
        LogicalValue, ResourceId, ResourceName, RoleName, SnapshotId, TrustedSession,
        ValueDescriptor, ValueRepresentation,
    };
    use policysql_execution::ExecutionLimits;
    use policysql_parser::SqliteFrontend;
    use policysql_policy::PolicyBundle;
    use policysql_sqlite::{
        compile_verified_delete, compile_verified_insert, compile_verified_select,
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
        ] {
            assert_select_fixture(fixture);
        }
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
                "insert-values" => bundle.compile_insert(&statement, &mutation_session()),
                "update-filtered" => bundle.compile_update(&statement, &mutation_session()),
                "delete-filtered" => bundle.compile_delete(&statement, &mutation_session()),
                _ => unreachable!("closed mutation fixture list"),
            }
            .unwrap_or_else(|error| unreachable!("fixture compiles: {error}"));
            if let Ok(negative) = SqliteFrontend::default()
                .bind(&read_fixture(&root, "negative-control.sql"), &catalog)
            {
                let denied = match directory {
                    "insert-values" => bundle.compile_insert(&negative, &mutation_session()),
                    "update-filtered" => bundle.compile_update(&negative, &mutation_session()),
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

    fn verify_denied_security_fixtures() {
        let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/sqlite-turso-v1/security");
        for directory in [
            "forbidden-filter-column",
            "forbidden-order-column",
            "missing-policy",
            "server-parameter-collision",
            "statement-smuggling",
        ] {
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
            if let Ok(statement) =
                SqliteFrontend::default().bind(&read_fixture(&root, "input.sql"), &catalog)
            {
                assert!(bundle.compile_select(&statement, &session).is_err());
            }
            let executor = RecordingExecutor::<()>::default();
            assert_eq!(executor.call_count(), 0);
        }
    }

    #[test]
    fn executed_fixture_matrix_writes_coverage_evidence() {
        protected_fixture_matches_reference_sqlite_result();
        expanded_read_fixtures_match_golden_sql_and_reference_sqlite();
        mutation_fixtures_match_golden_sql_and_reference_sqlite();
        verify_denied_security_fixtures();

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
