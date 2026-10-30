//! The transaction step machine's compiler port (ADR 0024 "Where the machine lives"): the
//! runtime's gateway and execution-handle table behind `policysql_transaction::machine::Compiler`.
//!
//! Plans stay in the runtime's handle table; the machine holds only handles. The statement
//! summaries, driver statements, validated results, and public result columns are the same
//! values `compile_json` and `validate_result_json` report, so the step path and the
//! TypeScript path see one contract.

use super::{PolicySqlRuntime, RuntimeError, compiled_statement, error_body};
use policysql_transaction::machine::{
    Compiled, Compiler, CoreError, DriverStatement, Limits, Operation, RawResult, StatementSummary,
    Validated,
};
use serde::Serialize;

pub(crate) struct RuntimeCompiler<'a>(pub(crate) &'a PolicySqlRuntime);

fn core_error(error: RuntimeError) -> CoreError {
    let body = error_body(error);
    CoreError {
        code: body.code.to_owned(),
        message: body.message.to_owned(),
        path: body.path,
    }
}

fn operation(name: &str) -> Operation {
    match name {
        "insert" => Operation::Insert,
        "update" => Operation::Update,
        "delete" => Operation::Delete,
        _ => Operation::Select,
    }
}

/// `turso.ts` `publicResultColumn`: the public descriptor of one result column.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicColumn<'a> {
    name: &'a str,
    #[serde(rename = "type")]
    logical_type: &'a serde_json::Value,
    representation: &'a str,
    nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    constraints: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    json_schema: Option<&'a serde_json::Value>,
}

impl PolicySqlRuntime {
    /// The runtime's limits as the machine enforces them.
    pub(crate) const fn machine_limits(&self) -> Limits {
        Limits {
            transaction_ms: self.limits.transaction_ms,
            max_transaction_statements: self.limits.max_transaction_statements,
            max_transaction_result_bytes: self.limits.max_transaction_result_bytes,
            begin_timeout_ms: self.limits.begin_timeout_ms,
            max_statements: self.limits.max_statements,
        }
    }

    fn statement_dto(
        &self,
        handle: u64,
        index: usize,
    ) -> Result<super::CompiledStatementDto, RuntimeError> {
        let plans = self.plans.borrow();
        let statement = plans
            .get(&handle)
            .and_then(|envelope| envelope.statements.get(index))
            .ok_or(RuntimeError::Internal)?;
        compiled_statement(statement, &self.catalog)
    }
}

impl Compiler for RuntimeCompiler<'_> {
    fn snapshot(&self) -> &str {
        self.0.snapshot.as_str()
    }

    fn compile(&self, auth_json: &str, envelope_json: &str) -> Result<Compiled, CoreError> {
        let (response, compiled) = self
            .0
            .compile(auth_json, envelope_json, "execute")
            .map_err(core_error)?;
        let compiled = compiled.ok_or_else(|| core_error(RuntimeError::Internal))?;
        let handle = self.0.store_plan(compiled).map_err(core_error)?;
        Ok(Compiled {
            handle,
            statements: response
                .statements
                .iter()
                .map(|statement| StatementSummary {
                    operation: operation(statement.operation),
                    resource: statement.resource.clone(),
                })
                .collect(),
            schema_version: response.schema_version,
            policy_version: response.policy_version,
        })
    }

    fn statements(&self, handle: u64) -> Result<Vec<DriverStatement>, CoreError> {
        let count = self
            .0
            .plans
            .borrow()
            .get(&handle)
            .map(|envelope| envelope.statements.len())
            .ok_or_else(|| core_error(RuntimeError::Internal))?;
        (0..count)
            .map(|index| {
                let dto = self.0.statement_dto(handle, index).map_err(core_error)?;
                Ok(DriverStatement {
                    sql: dto.protected_sql,
                    client_parameters: dto.client_parameters,
                    server_parameters: dto.server_parameters,
                    cost_sql: dto.cost_explain_sql,
                })
            })
            .collect()
    }

    fn validate(&self, handle: u64, index: usize, raw: RawResult) -> Result<Validated, CoreError> {
        let at = |error: RuntimeError| core_error(error.at_statement(index));
        let dto = self.0.statement_dto(handle, index).map_err(at)?;
        let raw_json = serde_json::json!({
            "columns": raw.columns,
            "rows": raw.rows,
            "affectedRows": raw.affected_rows,
        })
        .to_string();
        let validated = self
            .0
            .validate_result(handle, index, &raw_json)
            .map_err(at)?;
        let result_columns = dto
            .result
            .iter()
            .map(|column| {
                let representation = match column.representation {
                    "base64" => "string",
                    "json" => "object",
                    other => other,
                };
                serde_json::value::to_raw_value(&PublicColumn {
                    name: &column.name,
                    logical_type: &column.logical_type,
                    representation,
                    nullable: column.nullable || column.redacted_on_null,
                    format: column.format.as_deref(),
                    constraints: column.constraints.as_ref(),
                    json_schema: column.json_schema.as_ref(),
                })
                .map_err(|_| core_error(RuntimeError::Internal))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Validated {
            columns: validated.columns,
            rows: validated.rows,
            redactions: validated.redactions,
            affected_rows: validated.affected_rows,
            result_columns,
            operation_check: dto.operation_check,
        })
    }

    fn release(&self, handle: u64) {
        self.0.plans.borrow_mut().remove(&handle);
    }

    fn triggered_checks(&self, resources: &[&str]) -> Vec<String> {
        let mut checks: Vec<String> = self
            .0
            .policies
            .commit_checks()
            .iter()
            .filter(|check| {
                check.triggered_by.iter().any(|resource| {
                    self.0
                        .catalog
                        .resource_by_id(*resource)
                        .is_some_and(|resource| resources.contains(&resource.name.as_str()))
                })
            })
            .map(|check| check.id.clone())
            .collect();
        checks.sort();
        checks
    }
}
