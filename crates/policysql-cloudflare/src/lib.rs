#![forbid(unsafe_code)]

use policysql_catalog::{Catalog, ResourceDescriptor};
use policysql_core::{
    ClientParameterName, ColumnName, ConstraintScalar, JsonSchemaType, JsonValueSchema,
    LogicalType, LogicalValue, ResourceId, ResourceName, RoleName, SnapshotId, StorageClass,
    TrustedSession, ValueConstraints, ValueDescriptor, ValueRepresentation,
};
use policysql_execution::ExecutionLimits;
use policysql_gateway::{
    AuthContext, EndpointPermission, Gateway, GatewayError, RejectionKind, StatementRequest,
    classify_bind_error,
};
use policysql_ir::{BoundExpr, BoundSelect, BoundStatement};
use policysql_parser::SqliteFrontend;
use policysql_policy::PolicyBundle;
use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

const ABI_VERSION: u32 = 1;
const PROFILE_ID: &str = "sqlite-turso-v1";
const MAX_CONFIGURATION_BYTES: usize = 1_048_576;
const MAX_REQUEST_BYTES: usize = 1_048_576;
const MAX_SQL_BYTES: usize = 65_536;
const MAX_ACTIVE_EXECUTIONS: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogManifest {
    version: u32,
    resources: BTreeMap<String, CatalogResource>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogResource {
    source: CatalogSource,
    columns: BTreeMap<String, CatalogColumn>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogSource {
    table: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogColumn {
    #[serde(rename = "type")]
    logical_type: Option<String>,
    representation: Option<String>,
    storage: Option<String>,
    nullable: Option<bool>,
    format: Option<String>,
    #[serde(default)]
    constraints: Option<serde_yaml::Value>,
    #[serde(rename = "jsonSchema", default)]
    json_schema: Option<serde_yaml::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PhysicalSchema {
    tables: BTreeMap<String, PhysicalTable>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PhysicalTable {
    columns: BTreeMap<String, PhysicalColumn>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PhysicalColumn {
    declared_type: String,
    nullable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeLimits {
    max_rows: u64,
    max_result_bytes: u64,
    timeout_ms: u64,
    max_statements: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifiedAuth {
    subject: String,
    role: String,
    roles: Vec<String>,
    access: Vec<String>,
    #[serde(default)]
    session: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AtomicRequest {
    expected: Option<ExpectedSnapshot>,
    statements: Vec<RequestStatement>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedSnapshot {
    schema_version: String,
    policy_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestStatement {
    sql: String,
    params: BTreeMap<String, serde_json::Value>,
    expect: Option<RequestExpectation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestExpectation {
    affected_rows: Option<u64>,
    row_count: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompileResponse {
    abi_version: u32,
    profile: &'static str,
    schema_version: String,
    policy_version: String,
    snapshot: String,
    transaction_mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_handle: Option<u64>,
    statements: Vec<CompiledStatementDto>,
    commit_checks: Vec<CommitCheckDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitCheckDto {
    id: String,
    triggered_by: Vec<String>,
    role: Option<String>,
    url_env: String,
    timeout_ms: u64,
    hmac_secret_env: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawExecuteResult {
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    affected_rows: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidatedExecuteResult {
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    redactions: Vec<Vec<bool>>,
    affected_rows: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompiledStatementDto {
    operation: &'static str,
    resource: Option<String>,
    operation_check: bool,
    protected_sql: String,
    cost_explain_sql: String,
    client_parameters: BTreeMap<String, serde_json::Value>,
    client_parameter_types: BTreeMap<String, &'static str>,
    server_parameters: BTreeMap<String, serde_json::Value>,
    result: Vec<ResultColumnDto>,
    limits: LimitsDto,
    expected_affected_rows: Option<u64>,
    expected_result_rows: Option<u64>,
    explain: ExplainDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultColumnDto {
    name: String,
    logical_type: serde_json::Value,
    representation: &'static str,
    nullable: bool,
    format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    constraints: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    json_schema: Option<serde_json::Value>,
    redacted_on_null: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LimitsDto {
    max_rows: u64,
    max_result_bytes: u64,
    timeout_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExplainDto {
    resource: Option<u64>,
    resources: Vec<u64>,
    resource_names: Vec<String>,
    public_resources: Vec<ExplainResourceDto>,
    applied_policies: Vec<u64>,
    policy_limit: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ExplainResourceDto {
    name: String,
    columns: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogResponse {
    schema_version: String,
    policy_version: String,
    role: String,
    resources: Vec<CatalogResourceDto>,
}

#[derive(Debug, Serialize)]
struct CatalogResourceDto {
    name: String,
    operations: CatalogOperationsDto,
}

#[derive(Debug, Serialize)]
struct CatalogOperationsDto {
    select: CatalogSelectDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    insert: Option<CatalogInsertDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    update: Option<CatalogUpdateDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    delete: Option<CatalogDeleteDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogSelectDto {
    columns: Vec<CatalogColumnDto>,
    allow_aggregations: bool,
    allow_windows: bool,
    max_rows: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogColumnDto {
    name: String,
    #[serde(rename = "type")]
    logical_type: &'static str,
    representation: &'static str,
    nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    constraints: Option<serde_json::Value>,
    nullable_on_denied: bool,
    usage: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
struct CatalogInsertDto {
    columns: Vec<CatalogInsertColumnDto>,
    returning: CatalogReturningDto,
}

#[derive(Debug, Serialize)]
struct CatalogUpdateDto {
    columns: Vec<CatalogDescriptorDto>,
    returning: CatalogReturningDto,
}

#[derive(Debug, Serialize)]
struct CatalogDeleteDto {
    returning: CatalogReturningDto,
}

#[derive(Debug, Serialize)]
struct CatalogReturningDto {
    columns: Vec<CatalogColumnDto>,
}

#[derive(Debug, Serialize)]
struct CatalogInsertColumnDto {
    #[serde(flatten)]
    descriptor: CatalogDescriptorDto,
    required: bool,
}

#[derive(Debug, Serialize)]
struct CatalogDescriptorDto {
    name: String,
    #[serde(rename = "type")]
    logical_type: &'static str,
    representation: &'static str,
    nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    constraints: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: &'static str,
    message: &'static str,
    path: Option<String>,
}

#[wasm_bindgen]
#[derive(Debug)]
pub struct PolicySqlRuntime {
    gateway: Gateway,
    catalog: Catalog,
    policies: PolicyBundle,
    schema_version: String,
    policy_version: String,
    snapshot: SnapshotId,
    plans: RefCell<BTreeMap<u64, policysql_gateway::CompiledEnvelope>>,
    next_handle: Cell<u64>,
}

fn build_runtime(
    catalog_yaml: &str,
    policy_yaml: &str,
    schema_version: &str,
    policy_version: &str,
    limits_json: &str,
    physical_schema: Option<&PhysicalSchema>,
) -> Result<PolicySqlRuntime, JsValue> {
    if catalog_yaml.len().saturating_add(policy_yaml.len()) > MAX_CONFIGURATION_BYTES {
        return Err(js_error("configuration exceeds deployment limit"));
    }
    let snapshot_text = format!("{PROFILE_ID}:{schema_version}:{policy_version}:abi-{ABI_VERSION}");
    let snapshot =
        SnapshotId::new(snapshot_text).map_err(|_| js_error("deployment snapshot is invalid"))?;
    let catalog = activate_catalog_with_schema(catalog_yaml, snapshot.clone(), physical_schema)
        .map_err(|_| js_error("Catalog activation failed"))?;
    let policies = PolicyBundle::activate(policy_yaml, &catalog, snapshot.clone())
        .map_err(|_| js_error("policy activation failed"))?;
    let limits: RuntimeLimits =
        serde_json::from_str(limits_json).map_err(|_| js_error("runtime limits are invalid"))?;
    if limits.max_rows == 0
        || limits.max_result_bytes == 0
        || limits.timeout_ms == 0
        || limits.max_statements == 0
    {
        return Err(js_error("runtime limits are invalid"));
    }
    Ok(PolicySqlRuntime {
        gateway: Gateway::new(
            catalog.clone(),
            policies.clone(),
            snapshot.clone(),
            ExecutionLimits {
                max_rows: limits.max_rows,
                max_result_bytes: limits.max_result_bytes,
                timeout_ms: limits.timeout_ms,
            },
            limits.max_statements,
        ),
        catalog,
        policies,
        schema_version: schema_version.to_owned(),
        policy_version: policy_version.to_owned(),
        snapshot,
        plans: RefCell::new(BTreeMap::new()),
        next_handle: Cell::new(1),
    })
}

#[wasm_bindgen]
impl PolicySqlRuntime {
    /// Activates one immutable deployment snapshot.
    ///
    /// # Errors
    ///
    /// Returns a safe JavaScript error when configuration is malformed or inconsistent.
    #[wasm_bindgen(constructor)]
    pub fn new(
        catalog_yaml: &str,
        policy_yaml: &str,
        schema_version: &str,
        policy_version: &str,
        limits_json: &str,
    ) -> Result<Self, JsValue> {
        build_runtime(
            catalog_yaml,
            policy_yaml,
            schema_version,
            policy_version,
            limits_json,
            None,
        )
    }

    /// Activates a snapshot after comparing the manifest with trusted `SQLite`
    /// introspection captured by the deployment Catalog builder.
    ///
    /// # Errors
    ///
    /// Fails closed when a table, column, storage affinity, or nullability does
    /// not match, or when an omitted basic type cannot be derived.
    #[wasm_bindgen(js_name = newWithPhysicalSchema)]
    pub fn new_with_physical_schema(
        catalog_yaml: &str,
        policy_yaml: &str,
        schema_version: &str,
        policy_version: &str,
        limits_json: &str,
        physical_schema_json: &str,
    ) -> Result<Self, JsValue> {
        let physical_schema: PhysicalSchema = serde_json::from_str(physical_schema_json)
            .map_err(|_| js_error("physical schema is invalid"))?;
        build_runtime(
            catalog_yaml,
            policy_yaml,
            schema_version,
            policy_version,
            limits_json,
            Some(&physical_schema),
        )
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn abi_version(&self) -> u32 {
        ABI_VERSION
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn profile(&self) -> String {
        PROFILE_ID.to_owned()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn snapshot(&self) -> String {
        self.snapshot.as_str().to_owned()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn commit_checks_enabled(&self) -> bool {
        !self.policies.commit_checks().is_empty()
    }

    /// Compiles an authenticated atomic request into profile-verified statements.
    #[must_use]
    pub fn compile_json(
        &self,
        verified_auth_json: &str,
        request_json: &str,
        permission: &str,
    ) -> String {
        match self.compile(verified_auth_json, request_json, permission) {
            Ok((mut response, compiled)) => {
                if let Some(compiled) = compiled {
                    match self.store_plan(compiled) {
                        Ok(handle) => response.execution_handle = Some(handle),
                        Err(error) => {
                            return serialize_or_internal(&ErrorEnvelope {
                                error: error_body(error),
                            });
                        }
                    }
                }
                serialize_or_internal(&response)
            }
            Err(error) => serialize_or_internal(&ErrorEnvelope {
                error: error_body(error),
            }),
        }
    }

    /// Validates a raw remote result against a previously sealed statement.
    #[must_use]
    pub fn validate_result_json(&self, handle: u64, index: usize, raw_result_json: &str) -> String {
        match self.validate_result(handle, index, raw_result_json) {
            Ok(response) => serialize_or_internal(&response),
            Err(error) => serialize_or_internal(&ErrorEnvelope {
                error: error_body(error.at_statement(index)),
            }),
        }
    }

    /// Releases a sealed envelope after commit, rollback, or transport failure.
    pub fn release_execution(&self, handle: u64) -> bool {
        self.plans.borrow_mut().remove(&handle).is_some()
    }

    /// Returns the activated, role-visible logical Catalog.
    #[must_use]
    pub fn catalog_json(&self, verified_auth_json: &str) -> String {
        match self.catalog(verified_auth_json) {
            Ok(response) => serialize_or_internal(&response),
            Err(error) => serialize_or_internal(&ErrorEnvelope {
                error: error_body(error),
            }),
        }
    }
}

impl PolicySqlRuntime {
    fn store_plan(
        &self,
        compiled: policysql_gateway::CompiledEnvelope,
    ) -> Result<u64, RuntimeError> {
        let mut plans = self.plans.borrow_mut();
        if plans.len() >= MAX_ACTIVE_EXECUTIONS {
            return Err(RuntimeError::Busy);
        }
        let handle = self.next_handle.get();
        let next = handle.checked_add(1).ok_or(RuntimeError::Busy)?;
        self.next_handle.set(next);
        plans.insert(handle, compiled);
        Ok(handle)
    }

    fn validate_result(
        &self,
        handle: u64,
        index: usize,
        raw_result_json: &str,
    ) -> Result<ValidatedExecuteResult, RuntimeError> {
        if raw_result_json.len() > MAX_REQUEST_BYTES {
            return Err(RuntimeError::Envelope);
        }
        let raw: RawExecuteResult =
            serde_json::from_str(raw_result_json).map_err(|_| RuntimeError::RemoteResult)?;
        let plans = self.plans.borrow();
        let statement = plans
            .get(&handle)
            .and_then(|envelope| envelope.statements.get(index))
            .ok_or(RuntimeError::RemoteResult)?;
        let mut expected_types = statement
            .plan
            .result()
            .iter()
            .flat_map(|column| {
                std::iter::once(column.possible_types.clone()).chain(
                    column
                        .visibility_column
                        .iter()
                        .map(|_| vec![LogicalType::Boolean]),
                )
            })
            .collect::<Vec<_>>();
        if statement.plan.operation_check_column().is_some() {
            expected_types.push(vec![LogicalType::Boolean]);
        }
        let mut result = policysql_turso::ExecuteResult {
            columns: raw.columns,
            rows: raw
                .rows
                .into_iter()
                .map(|row| {
                    row.into_iter()
                        .enumerate()
                        .map(|(column, value)| {
                            logical_result_value(
                                value,
                                expected_types
                                    .get(column)
                                    .ok_or(RuntimeError::RemoteResult)?,
                            )
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .collect::<Result<Vec<_>, _>>()?,
            redactions: Vec::new(),
            affected_rows: raw.affected_rows,
        };
        policysql_turso::validate_sealed_result(&statement.plan, &mut result).map_err(|error| {
            if error == policysql_turso::AdapterError::ExpectationFailed {
                RuntimeError::Rejected(RejectionKind::ExpectationFailed)
            } else {
                RuntimeError::RemoteResult
            }
        })?;
        Ok(ValidatedExecuteResult {
            columns: result.columns,
            rows: result
                .rows
                .iter()
                .map(|row| {
                    row.iter()
                        .map(encode_result_value)
                        .collect::<Result<Vec<_>, _>>()
                })
                .collect::<Result<Vec<_>, _>>()?,
            redactions: result.redactions,
            affected_rows: result.affected_rows,
        })
    }

    fn catalog(&self, verified_auth_json: &str) -> Result<CatalogResponse, RuntimeError> {
        if verified_auth_json.len() > MAX_REQUEST_BYTES {
            return Err(RuntimeError::Envelope);
        }
        let raw_auth: VerifiedAuth =
            serde_json::from_str(verified_auth_json).map_err(|_| RuntimeError::Authentication)?;
        let auth = activate_auth(raw_auth, EndpointPermission::Catalog)?;
        let role = auth.session().role();
        let resources =
            self.catalog
                .resources()
                .filter_map(|resource| {
                    let access = self.policies.select_access(resource.id, role)?;
                    let columns = resource
                        .columns()
                        .filter_map(|column| {
                            let regular = access.regular_columns.contains(&column.id);
                            let conditional = access.conditional_columns.contains(&column.id);
                            (regular || conditional).then(|| CatalogColumnDto {
                                name: column.name.as_str().to_owned(),
                                logical_type: logical_type_name(column.value.logical_type),
                                representation: catalog_representation_name(
                                    column.value.representation,
                                ),
                                nullable: column.value.nullable,
                                format: column.value.format.clone(),
                                constraints: constraints_json(column.value.constraints.as_ref()),
                                nullable_on_denied: conditional,
                                usage: select_column_usage(
                                    conditional,
                                    access.allow_aggregations,
                                    access.allow_windows,
                                ),
                            })
                        })
                        .collect();
                    Some(CatalogResourceDto {
                        name: resource.name.as_str().to_owned(),
                        operations: CatalogOperationsDto {
                            select: CatalogSelectDto {
                                columns,
                                allow_aggregations: access.allow_aggregations,
                                allow_windows: access.allow_windows,
                                max_rows: access.max_rows.unwrap_or(self.gateway.limits().max_rows),
                            },
                            insert: self.policies.insert_access(resource.id, role).map(
                                |mutation| CatalogInsertDto {
                                    columns: mutation
                                        .columns
                                        .iter()
                                        .filter_map(|id| resource.column_by_id(*id))
                                        .map(|column| CatalogInsertColumnDto {
                                            required: !column.value.nullable,
                                            descriptor: catalog_descriptor(column),
                                        })
                                        .collect(),
                                    returning: CatalogReturningDto {
                                        columns: returning_columns(resource, &mutation.returning),
                                    },
                                },
                            ),
                            update: self.policies.update_access(resource.id, role).map(
                                |mutation| CatalogUpdateDto {
                                    columns: mutation
                                        .columns
                                        .iter()
                                        .filter_map(|id| resource.column_by_id(*id))
                                        .map(catalog_descriptor)
                                        .collect(),
                                    returning: CatalogReturningDto {
                                        columns: returning_columns(resource, &mutation.returning),
                                    },
                                },
                            ),
                            delete: self.policies.delete_access(resource.id, role).map(
                                |mutation| CatalogDeleteDto {
                                    returning: CatalogReturningDto {
                                        columns: returning_columns(resource, &mutation.returning),
                                    },
                                },
                            ),
                        },
                    })
                })
                .collect();
        Ok(CatalogResponse {
            schema_version: self.schema_version.clone(),
            policy_version: self.policy_version.clone(),
            role: role.as_str().to_owned(),
            resources,
        })
    }

    fn compile(
        &self,
        verified_auth_json: &str,
        request_json: &str,
        permission: &str,
    ) -> Result<(CompileResponse, Option<policysql_gateway::CompiledEnvelope>), RuntimeError> {
        if verified_auth_json.len().saturating_add(request_json.len()) > MAX_REQUEST_BYTES {
            return Err(RuntimeError::Envelope);
        }
        let raw_auth: VerifiedAuth =
            serde_json::from_str(verified_auth_json).map_err(|_| RuntimeError::Authentication)?;
        let endpoint = endpoint_permission(permission)?;
        let auth = activate_auth(raw_auth, endpoint)?;
        let raw_request: AtomicRequest =
            serde_json::from_str(request_json).map_err(|_| RuntimeError::Envelope)?;
        if raw_request.expected.as_ref().is_some_and(|expected| {
            expected.schema_version != self.schema_version
                || expected.policy_version != self.policy_version
        }) {
            return Err(RuntimeError::Snapshot);
        }
        validate_deployment_surface(&raw_request.statements, &self.catalog)?;
        let requests = raw_request
            .statements
            .into_iter()
            .enumerate()
            .map(|(index, statement)| {
                statement_request(statement, endpoint, &self.catalog)
                    .map_err(|error| error.at_statement(index))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let compiled = self
            .gateway
            .compile_envelope(&auth, endpoint, Some(&self.snapshot), &requests)
            .map_err(runtime_gateway_error)?;
        let transaction_mode =
            if compiled.statements.iter().all(|statement| {
                statement.plan.operation() == policysql_core::OperationKind::Select
            }) {
                "read"
            } else {
                "write"
            };
        let statements = compiled
            .statements
            .iter()
            .map(|statement| compiled_statement(statement, &self.catalog))
            .collect::<Result<Vec<_>, _>>()?;
        let commit_checks = self
            .policies
            .commit_checks()
            .iter()
            .map(|check| CommitCheckDto {
                id: check.id.clone(),
                triggered_by: check
                    .triggered_by
                    .iter()
                    .filter_map(|resource| self.catalog.resource_by_id(*resource))
                    .map(|resource| resource.name.as_str().to_owned())
                    .collect(),
                role: check.role.as_ref().map(|role| role.as_str().to_owned()),
                url_env: check.url_env.clone(),
                timeout_ms: check.timeout_ms,
                hmac_secret_env: check.hmac_secret_env.clone(),
            })
            .collect();
        let retain = (endpoint == EndpointPermission::Execute).then(|| compiled.clone());
        Ok((
            CompileResponse {
                abi_version: ABI_VERSION,
                profile: PROFILE_ID,
                schema_version: self.schema_version.clone(),
                policy_version: self.policy_version.clone(),
                snapshot: self.snapshot.as_str().to_owned(),
                transaction_mode,
                execution_handle: None,
                statements,
                commit_checks,
            },
            retain,
        ))
    }
}

fn catalog_descriptor(column: &policysql_catalog::ColumnDescriptor) -> CatalogDescriptorDto {
    CatalogDescriptorDto {
        name: column.name.as_str().to_owned(),
        logical_type: logical_type_name(column.value.logical_type),
        representation: catalog_representation_name(column.value.representation),
        nullable: column.value.nullable,
        format: column.value.format.clone(),
        constraints: constraints_json(column.value.constraints.as_ref()),
    }
}

fn constraints_json(constraints: Option<&ValueConstraints>) -> Option<serde_json::Value> {
    let constraints = constraints?;
    let mut object = serde_json::Map::new();
    if !constraints.allowed.is_empty() {
        object.insert(
            "enum".to_owned(),
            serde_json::Value::Array(
                constraints
                    .allowed
                    .iter()
                    .map(|value| match value {
                        ConstraintScalar::String(value) => serde_json::Value::String(value.clone()),
                        ConstraintScalar::Boolean(value) => serde_json::Value::Bool(*value),
                        ConstraintScalar::Number(value) => value
                            .parse::<serde_json::Number>()
                            .map_or(serde_json::Value::Null, serde_json::Value::Number),
                    })
                    .collect(),
            ),
        );
    }
    for (name, value) in [
        ("minimum", constraints.minimum.as_deref()),
        ("maximum", constraints.maximum.as_deref()),
    ] {
        if let Some(value) = value.and_then(|value| value.parse::<serde_json::Number>().ok()) {
            object.insert(name.to_owned(), serde_json::Value::Number(value));
        }
    }
    if let Some(value) = constraints.min_length {
        object.insert("minLength".to_owned(), serde_json::Value::from(value));
    }
    if let Some(value) = constraints.max_length {
        object.insert("maxLength".to_owned(), serde_json::Value::from(value));
    }
    if let Some(value) = &constraints.pattern {
        object.insert(
            "pattern".to_owned(),
            serde_json::Value::String(value.clone()),
        );
    }
    Some(serde_json::Value::Object(object))
}

fn json_schema_json(schema: &JsonValueSchema) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    let names = schema
        .types
        .iter()
        .map(|value| {
            serde_json::Value::String(
                match value {
                    JsonSchemaType::Null => "null",
                    JsonSchemaType::Boolean => "boolean",
                    JsonSchemaType::Integer => "integer",
                    JsonSchemaType::Number => "number",
                    JsonSchemaType::String => "string",
                    JsonSchemaType::Array => "array",
                    JsonSchemaType::Object => "object",
                }
                .to_owned(),
            )
        })
        .collect::<Vec<_>>();
    if names.len() == 1 {
        object.insert("type".to_owned(), names[0].clone());
    } else if !names.is_empty() {
        object.insert("type".to_owned(), serde_json::Value::Array(names));
    }
    if !schema.properties.is_empty() {
        object.insert(
            "properties".to_owned(),
            serde_json::Value::Object(
                schema
                    .properties
                    .iter()
                    .map(|(name, value)| (name.clone(), json_schema_json(value)))
                    .collect(),
            ),
        );
    }
    if let Some(items) = &schema.items {
        object.insert("items".to_owned(), json_schema_json(items));
    }
    if !schema.required.is_empty() {
        object.insert(
            "required".to_owned(),
            serde_json::Value::Array(
                schema
                    .required
                    .iter()
                    .cloned()
                    .map(serde_json::Value::String)
                    .collect(),
            ),
        );
    }
    object.insert(
        "additionalProperties".to_owned(),
        serde_json::Value::Bool(schema.additional_properties),
    );
    if !schema.any_of.is_empty() {
        object.insert(
            "anyOf".to_owned(),
            serde_json::Value::Array(schema.any_of.iter().map(json_schema_json).collect()),
        );
    }
    serde_json::Value::Object(object)
}

fn returning_columns(
    resource: &ResourceDescriptor,
    columns: &BTreeSet<policysql_core::ColumnId>,
) -> Vec<CatalogColumnDto> {
    resource
        .columns()
        .filter(|column| columns.contains(&column.id))
        .map(|column| CatalogColumnDto {
            name: column.name.as_str().to_owned(),
            logical_type: logical_type_name(column.value.logical_type),
            representation: catalog_representation_name(column.value.representation),
            nullable: column.value.nullable,
            format: column.value.format.clone(),
            constraints: constraints_json(column.value.constraints.as_ref()),
            nullable_on_denied: false,
            usage: vec!["projection"],
        })
        .collect()
}

fn select_column_usage(
    conditional: bool,
    allow_aggregations: bool,
    allow_windows: bool,
) -> Vec<&'static str> {
    if conditional {
        return vec!["projection"];
    }
    let mut usage = vec!["projection", "predicate", "join", "order"];
    if allow_aggregations {
        usage.extend(["group", "aggregate"]);
    }
    if allow_windows {
        usage.push("window");
    }
    usage
}

fn validate_deployment_surface(
    requests: &[RequestStatement],
    catalog: &Catalog,
) -> Result<(), RuntimeError> {
    let frontend = SqliteFrontend::default();
    for (index, request) in requests.iter().enumerate() {
        let statement = frontend
            .bind(&request.sql, catalog)
            .map_err(|error| RuntimeError::RejectedAt(classify_bind_error(&error), index))?;
        let accepted = match statement {
            BoundStatement::Select(select) => supported_select(&select),
            BoundStatement::ConstantSelect(select) => !select.projections.is_empty(),
            BoundStatement::JsonCollectionSelect(select) => {
                basic_expression(&select.path)
                    && select.predicate.as_ref().is_none_or(basic_expression)
            }
            BoundStatement::Insert(insert) => {
                insert
                    .rows
                    .iter()
                    .flatten()
                    .all(|assignment| basic_expression(&assignment.value))
                    && insert
                        .returning
                        .iter()
                        .all(|projection| basic_expression(&projection.expression))
            }
            BoundStatement::Update(update) => {
                update
                    .assignments
                    .iter()
                    .all(|assignment| basic_expression(&assignment.value))
                    && update.predicate.as_ref().is_none_or(basic_expression)
                    && update
                        .returning
                        .iter()
                        .all(|projection| basic_expression(&projection.expression))
            }
            BoundStatement::Delete(delete) => {
                delete.predicate.as_ref().is_none_or(basic_expression)
                    && delete
                        .returning
                        .iter()
                        .all(|projection| basic_expression(&projection.expression))
            }
        };
        if !accepted {
            return Err(RuntimeError::RejectedAt(
                RejectionKind::UnsupportedSql,
                index,
            ));
        }
    }
    Ok(())
}

fn supported_select(select: &BoundSelect) -> bool {
    select.joins.iter().all(|join| basic_expression(&join.on))
        && select
            .projections
            .iter()
            .all(|projection| basic_expression(&projection.expression))
        && select.predicate.as_ref().is_none_or(basic_expression)
        && select.having.as_ref().is_none_or(basic_expression)
        && select.limit.as_ref().is_none_or(basic_expression)
        && select.offset.as_ref().is_none_or(basic_expression)
}

fn basic_expression(expression: &BoundExpr) -> bool {
    match expression {
        BoundExpr::Column(_)
        | BoundExpr::ClientParameter { .. }
        | BoundExpr::ServerParameter { .. }
        | BoundExpr::Literal(_)
        | BoundExpr::CountAll(_) => true,
        BoundExpr::Equal(left, right)
        | BoundExpr::NotEqual(left, right)
        | BoundExpr::Less(left, right)
        | BoundExpr::LessEqual(left, right)
        | BoundExpr::Greater(left, right)
        | BoundExpr::GreaterEqual(left, right)
        | BoundExpr::And(left, right)
        | BoundExpr::Or(left, right)
        | BoundExpr::Like(left, right)
        | BoundExpr::Glob(left, right)
        | BoundExpr::Least(left, right)
        | BoundExpr::Concat(left, right) => basic_expression(left) && basic_expression(right),
        BoundExpr::Not(value) | BoundExpr::IsNull(value) | BoundExpr::CastText(value) => {
            basic_expression(value)
        }
        BoundExpr::In {
            expression, values, ..
        } => basic_expression(expression) && values.iter().all(basic_expression),
        BoundExpr::ConditionalOutput { value, visible_if } => {
            basic_expression(value) && basic_expression(visible_if)
        }
        BoundExpr::Exists(select) => supported_select(select),
        BoundExpr::ScalarFunction { arguments, .. } => arguments.iter().all(basic_expression),
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => {
            branches
                .iter()
                .all(|(condition, value)| basic_expression(condition) && basic_expression(value))
                && else_expression.as_deref().is_none_or(basic_expression)
        }
        BoundExpr::RowNumber { order_by, .. } => !order_by.is_empty(),
    }
}

#[derive(Clone, Copy, Debug)]
enum RuntimeError {
    Authentication,
    Access,
    Snapshot,
    Envelope,
    EnvelopeAt(usize),
    Rejected(RejectionKind),
    RejectedAt(RejectionKind, usize),
    Internal,
    Busy,
    RemoteResult,
    RemoteResultAt(usize),
}

impl RuntimeError {
    const fn at_statement(self, index: usize) -> Self {
        match self {
            Self::Envelope => Self::EnvelopeAt(index),
            Self::Rejected(kind) => Self::RejectedAt(kind, index),
            Self::RemoteResult => Self::RemoteResultAt(index),
            other => other,
        }
    }
}

#[cfg(test)]
fn activate_catalog(yaml: &str, snapshot: SnapshotId) -> Result<Catalog, RuntimeError> {
    activate_catalog_with_schema(yaml, snapshot, None)
}

#[allow(clippy::too_many_lines)]
fn activate_catalog_with_schema(
    yaml: &str,
    snapshot: SnapshotId,
    physical_schema: Option<&PhysicalSchema>,
) -> Result<Catalog, RuntimeError> {
    let manifest: CatalogManifest = serde_yaml::from_str(yaml)
        .map_err(|_| RuntimeError::Rejected(RejectionKind::InvalidRequest))?;
    if manifest.version != 1 || manifest.resources.is_empty() {
        return Err(RuntimeError::Rejected(RejectionKind::InvalidRequest));
    }
    let resources = manifest
        .resources
        .into_iter()
        .enumerate()
        .map(|(index, (name, resource))| {
            if resource.columns.is_empty() {
                return Err(RuntimeError::Rejected(RejectionKind::InvalidRequest));
            }
            let physical_table = physical_schema
                .map(|schema| {
                    schema
                        .tables
                        .get(&resource.source.table)
                        .ok_or(RuntimeError::Rejected(RejectionKind::InvalidRequest))
                })
                .transpose()?;
            let id = u64::try_from(index + 1)
                .map_err(|_| RuntimeError::Rejected(RejectionKind::InvalidRequest))?;
            let columns = resource
                .columns
                .into_iter()
                .map(|(column_name, column)| {
                    let physical_column = physical_table
                        .map(|table| {
                            table
                                .columns
                                .get(&column_name)
                                .ok_or(RuntimeError::Rejected(RejectionKind::InvalidRequest))
                        })
                        .transpose()?;
                    let derived_storage = physical_column
                        .map(|column| declared_storage(&column.declared_type))
                        .transpose()?;
                    let (logical_type, default_representation) = if column.logical_type.is_some() {
                        logical_type(column.logical_type.as_deref())?
                    } else {
                        derived_storage
                            .map(derived_logical_type)
                            .ok_or(RuntimeError::Rejected(RejectionKind::InvalidRequest))?
                    };
                    let representation =
                        representation(column.representation.as_deref(), default_representation)?;
                    validate_format(logical_type, column.format.as_deref())?;
                    let constraints = column
                        .constraints
                        .as_ref()
                        .map(|value| parse_constraints(value, logical_type))
                        .transpose()?;
                    let json_schema = if let Some(schema) = &column.json_schema {
                        if logical_type != LogicalType::Json
                            || representation != ValueRepresentation::Json
                            || !valid_json_value_schema(schema, 0)
                        {
                            return Err(RuntimeError::Rejected(RejectionKind::InvalidRequest));
                        }
                        Some(parse_json_value_schema(schema)?)
                    } else {
                        None
                    };
                    let storage = column
                        .storage
                        .as_deref()
                        .map(storage_class)
                        .transpose()?
                        .or(derived_storage);
                    if column
                        .storage
                        .as_deref()
                        .map(storage_class)
                        .transpose()?
                        .zip(derived_storage)
                        .is_some_and(|(declared, derived)| declared != derived)
                    {
                        return Err(RuntimeError::Rejected(RejectionKind::InvalidRequest));
                    }
                    validate_storage(logical_type, storage)?;
                    let nullable = column
                        .nullable
                        .or_else(|| physical_column.map(|column| column.nullable))
                        .unwrap_or(false);
                    if column
                        .nullable
                        .zip(physical_column.map(|column| column.nullable))
                        .is_some_and(|(manifest, physical)| manifest != physical)
                    {
                        return Err(RuntimeError::Rejected(RejectionKind::InvalidRequest));
                    }
                    Ok((
                        ColumnName::new(column_name)
                            .map_err(|_| RuntimeError::Rejected(RejectionKind::InvalidRequest))?,
                        ValueDescriptor {
                            logical_type,
                            representation,
                            nullable,
                            format: column.format,
                            storage,
                            constraints,
                            json_schema,
                        },
                    ))
                })
                .collect::<Result<Vec<_>, _>>()?;
            ResourceDescriptor::new_with_source(
                ResourceId::new(id)
                    .map_err(|_| RuntimeError::Rejected(RejectionKind::InvalidRequest))?,
                ResourceName::new(name)
                    .map_err(|_| RuntimeError::Rejected(RejectionKind::InvalidRequest))?,
                ResourceName::new(resource.source.table)
                    .map_err(|_| RuntimeError::Rejected(RejectionKind::InvalidRequest))?,
                columns,
            )
            .map_err(|_| RuntimeError::Rejected(RejectionKind::InvalidRequest))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Catalog::new(snapshot, resources)
        .map_err(|_| RuntimeError::Rejected(RejectionKind::InvalidRequest))
}

fn valid_json_value_schema(value: &serde_yaml::Value, depth: usize) -> bool {
    const KEYS: [&str; 7] = [
        "$schema",
        "type",
        "properties",
        "items",
        "required",
        "additionalProperties",
        "anyOf",
    ];
    if depth > 32 {
        return false;
    }
    let Some(object) = value.as_mapping() else {
        return false;
    };
    if object.is_empty() {
        return false;
    }
    if object
        .keys()
        .any(|key| key.as_str().is_none_or(|key| !KEYS.contains(&key)))
    {
        return false;
    }
    if object.get("$schema").is_some_and(|schema| {
        schema.as_str() != Some("https://json-schema.org/draft/2020-12/schema")
    }) {
        return false;
    }
    if object
        .get("additionalProperties")
        .is_some_and(|value| value.as_bool() != Some(false))
    {
        return false;
    }
    if object
        .get("type")
        .is_some_and(|value| !valid_json_schema_type(value))
    {
        return false;
    }
    let properties = object
        .get("properties")
        .and_then(serde_yaml::Value::as_mapping);
    if object.contains_key("properties")
        && properties.is_none_or(|properties| {
            properties.iter().any(|(name, schema)| {
                name.as_str().is_none_or(str::is_empty)
                    || !valid_json_value_schema(schema, depth + 1)
            })
        })
    {
        return false;
    }
    if object
        .get("items")
        .is_some_and(|items| !valid_json_value_schema(items, depth + 1))
    {
        return false;
    }
    if object.get("required").is_some_and(|required| {
        let Some(required) = required.as_sequence() else {
            return true;
        };
        let mut names = BTreeSet::new();
        required.iter().any(|name| {
            name.as_str().is_none_or(str::is_empty)
                || !names.insert(name.as_str().unwrap_or_default())
                || properties.is_none_or(|properties| !properties.contains_key(name))
        })
    }) {
        return false;
    }
    if object.get("anyOf").is_some_and(|branches| {
        branches.as_sequence().is_none_or(|branches| {
            branches.len() < 2
                || branches
                    .iter()
                    .any(|branch| !valid_json_value_schema(branch, depth + 1))
        })
    }) {
        return false;
    }
    object.contains_key("type") || object.contains_key("anyOf")
}

fn valid_json_schema_type(value: &serde_yaml::Value) -> bool {
    const TYPES: [&str; 7] = [
        "null", "boolean", "integer", "number", "string", "array", "object",
    ];
    if let Some(value) = value.as_str() {
        return TYPES.contains(&value);
    }
    let Some(values) = value.as_sequence() else {
        return false;
    };
    if values.len() < 2 {
        return false;
    }
    let mut unique = BTreeSet::new();
    values.iter().all(|value| {
        value
            .as_str()
            .is_some_and(|value| TYPES.contains(&value) && unique.insert(value))
    })
}

fn parse_json_value_schema(value: &serde_yaml::Value) -> Result<JsonValueSchema, RuntimeError> {
    let object = value
        .as_mapping()
        .ok_or(RuntimeError::Rejected(RejectionKind::InvalidRequest))?;
    let types = object
        .get("type")
        .map(json_schema_types)
        .transpose()?
        .unwrap_or_default();
    let properties = object
        .get("properties")
        .and_then(serde_yaml::Value::as_mapping)
        .map(|properties| {
            properties
                .iter()
                .map(|(name, schema)| {
                    Ok((
                        name.as_str()
                            .ok_or(RuntimeError::Rejected(RejectionKind::InvalidRequest))?
                            .to_owned(),
                        parse_json_value_schema(schema)?,
                    ))
                })
                .collect::<Result<BTreeMap<_, _>, RuntimeError>>()
        })
        .transpose()?
        .unwrap_or_default();
    let items = object
        .get("items")
        .map(parse_json_value_schema)
        .transpose()?
        .map(Box::new);
    let required = object
        .get("required")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_yaml::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let any_of = object
        .get("anyOf")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|branches| {
            branches
                .iter()
                .map(parse_json_value_schema)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(JsonValueSchema {
        types,
        properties,
        items,
        required,
        additional_properties: false,
        any_of,
    })
}

fn json_schema_types(value: &serde_yaml::Value) -> Result<Vec<JsonSchemaType>, RuntimeError> {
    let values = value
        .as_sequence()
        .map_or_else(|| vec![value], |values| values.iter().collect());
    values
        .into_iter()
        .map(|value| match value.as_str() {
            Some("null") => Ok(JsonSchemaType::Null),
            Some("boolean") => Ok(JsonSchemaType::Boolean),
            Some("integer") => Ok(JsonSchemaType::Integer),
            Some("number") => Ok(JsonSchemaType::Number),
            Some("string") => Ok(JsonSchemaType::String),
            Some("array") => Ok(JsonSchemaType::Array),
            Some("object") => Ok(JsonSchemaType::Object),
            _ => Err(RuntimeError::Rejected(RejectionKind::InvalidRequest)),
        })
        .collect()
}

fn parse_constraints(
    value: &serde_yaml::Value,
    logical_type: LogicalType,
) -> Result<ValueConstraints, RuntimeError> {
    let object = value
        .as_mapping()
        .ok_or(RuntimeError::Rejected(RejectionKind::InvalidRequest))?;
    let allowed = object
        .get("enum")
        .and_then(serde_yaml::Value::as_sequence)
        .map(|values| {
            values
                .iter()
                .map(constraint_scalar)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let minimum = object.get("minimum").map(canonical_number).transpose()?;
    let maximum = object.get("maximum").map(canonical_number).transpose()?;
    let min_length = object.get("minLength").map(nonnegative_usize).transpose()?;
    let max_length = object.get("maxLength").map(nonnegative_usize).transpose()?;
    let pattern = object
        .get("pattern")
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_owned);
    if minimum
        .as_deref()
        .zip(maximum.as_deref())
        .is_some_and(|(minimum, maximum)| {
            minimum
                .parse::<f64>()
                .ok()
                .zip(maximum.parse::<f64>().ok())
                .is_none_or(|(minimum, maximum)| minimum > maximum)
        })
        || min_length
            .zip(max_length)
            .is_some_and(|(minimum, maximum)| minimum > maximum)
    {
        return Err(RuntimeError::Rejected(RejectionKind::InvalidRequest));
    }
    let numeric = matches!(
        logical_type,
        LogicalType::Integer | LogicalType::Int64 | LogicalType::Number
    );
    let string = matches!(
        logical_type,
        LogicalType::String | LogicalType::Date | LogicalType::DateTime | LogicalType::Instant
    );
    if (!numeric && (minimum.is_some() || maximum.is_some()))
        || (!string && (min_length.is_some() || max_length.is_some() || pattern.is_some()))
        || allowed
            .iter()
            .any(|value| !constraint_matches_type(value, logical_type))
    {
        return Err(RuntimeError::Rejected(RejectionKind::InvalidRequest));
    }
    if let Some(pattern) = &pattern {
        if pattern.len() > 256 || regex_lite::Regex::new(pattern).is_err() {
            return Err(RuntimeError::Rejected(RejectionKind::InvalidRequest));
        }
    }
    Ok(ValueConstraints {
        allowed,
        minimum,
        maximum,
        min_length,
        max_length,
        pattern,
    })
}

fn canonical_number(value: &serde_yaml::Value) -> Result<String, RuntimeError> {
    let value = value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or(RuntimeError::Rejected(RejectionKind::InvalidRequest))?;
    Ok(value.to_string())
}

fn nonnegative_usize(value: &serde_yaml::Value) -> Result<usize, RuntimeError> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(RuntimeError::Rejected(RejectionKind::InvalidRequest))
}

fn constraint_scalar(value: &serde_yaml::Value) -> Result<ConstraintScalar, RuntimeError> {
    if let Some(value) = value.as_str() {
        return Ok(ConstraintScalar::String(value.to_owned()));
    }
    if let Some(value) = value.as_bool() {
        return Ok(ConstraintScalar::Boolean(value));
    }
    canonical_number(value).map(ConstraintScalar::Number)
}

fn constraint_matches_type(value: &ConstraintScalar, logical_type: LogicalType) -> bool {
    matches!(
        (value, logical_type),
        (
            ConstraintScalar::String(_),
            LogicalType::String | LogicalType::Date | LogicalType::DateTime | LogicalType::Instant
        ) | (ConstraintScalar::Boolean(_), LogicalType::Boolean)
            | (
                ConstraintScalar::Number(_),
                LogicalType::Integer | LogicalType::Int64 | LogicalType::Number
            )
    )
}

fn storage_class(value: &str) -> Result<StorageClass, RuntimeError> {
    match value {
        "integer" => Ok(StorageClass::Integer),
        "real" => Ok(StorageClass::Real),
        "text" => Ok(StorageClass::Text),
        "blob" => Ok(StorageClass::Blob),
        _ => Err(RuntimeError::Rejected(RejectionKind::InvalidRequest)),
    }
}

fn declared_storage(value: &str) -> Result<StorageClass, RuntimeError> {
    let value = value.trim().to_ascii_uppercase();
    if value.contains("INT") {
        Ok(StorageClass::Integer)
    } else if value.contains("CHAR") || value.contains("CLOB") || value.contains("TEXT") {
        Ok(StorageClass::Text)
    } else if value.contains("BLOB") {
        Ok(StorageClass::Blob)
    } else if value.contains("REAL") || value.contains("FLOA") || value.contains("DOUB") {
        Ok(StorageClass::Real)
    } else {
        Err(RuntimeError::Rejected(RejectionKind::InvalidRequest))
    }
}

const fn derived_logical_type(storage: StorageClass) -> (LogicalType, ValueRepresentation) {
    match storage {
        StorageClass::Integer => (LogicalType::Int64, ValueRepresentation::String),
        StorageClass::Real => (LogicalType::Number, ValueRepresentation::Number),
        StorageClass::Text => (LogicalType::String, ValueRepresentation::String),
        StorageClass::Blob => (LogicalType::Bytes, ValueRepresentation::Base64),
    }
}

fn validate_storage(
    logical_type: LogicalType,
    storage: Option<StorageClass>,
) -> Result<(), RuntimeError> {
    if storage.is_some_and(|storage| {
        !matches!(
            (logical_type, storage),
            (
                LogicalType::String
                    | LogicalType::Date
                    | LogicalType::DateTime
                    | LogicalType::Instant
                    | LogicalType::Json,
                StorageClass::Text
            ) | (
                LogicalType::Integer | LogicalType::Int64 | LogicalType::Boolean,
                StorageClass::Integer
            ) | (
                LogicalType::Number,
                StorageClass::Real | StorageClass::Integer
            ) | (LogicalType::Bytes, StorageClass::Blob)
        )
    }) {
        return Err(RuntimeError::Rejected(RejectionKind::InvalidRequest));
    }
    Ok(())
}

fn validate_format(logical_type: LogicalType, format: Option<&str>) -> Result<(), RuntimeError> {
    let valid = matches!(
        (logical_type, format),
        (LogicalType::String, None | Some("uuid" | "email"))
            | (
                LogicalType::Integer
                    | LogicalType::Number
                    | LogicalType::Boolean
                    | LogicalType::Json,
                None,
            )
            | (LogicalType::Int64, None | Some("int64"))
            | (LogicalType::Bytes, None | Some("base64"))
            | (LogicalType::Date, Some("iso-date"))
            | (LogicalType::DateTime, Some("sqlite-datetime"))
            | (LogicalType::Instant, Some("rfc3339"))
    );
    if valid {
        Ok(())
    } else {
        Err(RuntimeError::Rejected(RejectionKind::InvalidRequest))
    }
}

fn logical_type(value: Option<&str>) -> Result<(LogicalType, ValueRepresentation), RuntimeError> {
    match value {
        Some("string") => Ok((LogicalType::String, ValueRepresentation::String)),
        Some("integer") => Ok((LogicalType::Integer, ValueRepresentation::Number)),
        Some("boolean") => Ok((LogicalType::Boolean, ValueRepresentation::Boolean)),
        Some("int64") => Ok((LogicalType::Int64, ValueRepresentation::String)),
        Some("number") => Ok((LogicalType::Number, ValueRepresentation::Number)),
        Some("bytes") => Ok((LogicalType::Bytes, ValueRepresentation::Base64)),
        Some("date") => Ok((LogicalType::Date, ValueRepresentation::String)),
        Some("datetime") => Ok((LogicalType::DateTime, ValueRepresentation::String)),
        Some("instant") => Ok((LogicalType::Instant, ValueRepresentation::String)),
        Some("json") => Ok((LogicalType::Json, ValueRepresentation::Json)),
        _ => Err(RuntimeError::Rejected(RejectionKind::InvalidRequest)),
    }
}

fn representation(
    value: Option<&str>,
    default: ValueRepresentation,
) -> Result<ValueRepresentation, RuntimeError> {
    let output = match value {
        None => default,
        Some("string") => ValueRepresentation::String,
        Some("number") => ValueRepresentation::Number,
        Some("boolean") => ValueRepresentation::Boolean,
        Some("object" | "array") => ValueRepresentation::Json,
        _ => return Err(RuntimeError::Rejected(RejectionKind::InvalidRequest)),
    };
    Ok(output)
}

fn endpoint_permission(value: &str) -> Result<EndpointPermission, RuntimeError> {
    match value {
        "execute" => Ok(EndpointPermission::Execute),
        "explain" => Ok(EndpointPermission::Explain),
        "catalog" => Ok(EndpointPermission::Catalog),
        "debug" => Ok(EndpointPermission::Debug),
        _ => Err(RuntimeError::Access),
    }
}

fn activate_auth(
    raw: VerifiedAuth,
    requested: EndpointPermission,
) -> Result<AuthContext, RuntimeError> {
    if raw.roles.is_empty()
        || !raw.roles.iter().any(|role| role == &raw.role)
        || raw.roles.iter().collect::<BTreeSet<_>>().len() != raw.roles.len()
    {
        return Err(RuntimeError::Authentication);
    }
    let permissions = raw
        .access
        .into_iter()
        .map(|access| endpoint_permission(&access))
        .collect::<Result<BTreeSet<_>, _>>()?;
    if !permissions.contains(&requested) {
        return Err(RuntimeError::Access);
    }
    let session = TrustedSession::new(
        RoleName::new(raw.role).map_err(|_| RuntimeError::Authentication)?,
        raw.subject,
        raw.session,
    )
    .map_err(|_| RuntimeError::Authentication)?;
    Ok(AuthContext::new(session, permissions))
}

fn statement_request(
    raw: RequestStatement,
    endpoint: EndpointPermission,
    catalog: &Catalog,
) -> Result<StatementRequest, RuntimeError> {
    if raw.sql.is_empty() || raw.sql.len() > MAX_SQL_BYTES {
        return Err(RuntimeError::Envelope);
    }
    let expectation = raw.expect.unwrap_or(RequestExpectation {
        affected_rows: None,
        row_count: None,
    });
    let statement = SqliteFrontend::default()
        .bind(&raw.sql, catalog)
        .map_err(|error| RuntimeError::Rejected(classify_bind_error(&error)))?;
    let parameter_types = statement_parameter_types(&statement)?;
    let mut parameters = raw
        .params
        .into_iter()
        .map(|(name, value)| {
            let name = ClientParameterName::new(name)
                .map_err(|_| RuntimeError::Rejected(RejectionKind::InvalidParameter))?;
            let value = logical_value(value, parameter_types.get(&name).copied())?;
            Ok((name, value))
        })
        .collect::<Result<BTreeMap<_, _>, RuntimeError>>()?;
    if endpoint == EndpointPermission::Explain {
        for (name, logical_type) in parameter_types {
            parameters
                .entry(name)
                .or_insert_with(|| placeholder_value(logical_type));
        }
    }
    Ok(StatementRequest {
        sql: raw.sql,
        parameters,
        expected_affected_rows: expectation.affected_rows,
        expected_row_count: expectation.row_count,
    })
}

fn placeholder_value(logical_type: LogicalType) -> LogicalValue {
    match logical_type {
        LogicalType::String | LogicalType::Date | LogicalType::DateTime | LogicalType::Instant => {
            LogicalValue::String(String::new())
        }
        LogicalType::Boolean => LogicalValue::Boolean(false),
        LogicalType::Integer | LogicalType::Int64 => LogicalValue::Int64(0),
        LogicalType::Number => LogicalValue::Number(0.0),
        LogicalType::Bytes => LogicalValue::Bytes(Vec::new()),
        LogicalType::Json => LogicalValue::Json("null".to_owned()),
    }
}

fn statement_parameter_types(
    statement: &BoundStatement,
) -> Result<BTreeMap<ClientParameterName, LogicalType>, RuntimeError> {
    let mut output = BTreeMap::new();
    match statement {
        BoundStatement::Select(select) => collect_select_parameter_types(select, &mut output)?,
        BoundStatement::ConstantSelect(select) => {
            for projection in &select.projections {
                collect_parameter_types(&projection.expression, &mut output)?;
            }
        }
        BoundStatement::JsonCollectionSelect(select) => {
            collect_parameter_types(&select.path, &mut output)?;
            if let Some(predicate) = &select.predicate {
                collect_parameter_types(predicate, &mut output)?;
            }
        }
        BoundStatement::Insert(insert) => {
            for assignment in insert.rows.iter().flatten() {
                collect_parameter_types(&assignment.value, &mut output)?;
            }
        }
        BoundStatement::Update(update) => {
            for assignment in &update.assignments {
                collect_parameter_types(&assignment.value, &mut output)?;
            }
            if let Some(predicate) = &update.predicate {
                collect_parameter_types(predicate, &mut output)?;
            }
        }
        BoundStatement::Delete(delete) => {
            if let Some(predicate) = &delete.predicate {
                collect_parameter_types(predicate, &mut output)?;
            }
        }
    }
    Ok(output)
}

fn collect_select_parameter_types(
    select: &BoundSelect,
    output: &mut BTreeMap<ClientParameterName, LogicalType>,
) -> Result<(), RuntimeError> {
    for projection in &select.projections {
        collect_parameter_types(&projection.expression, output)?;
    }
    for join in &select.joins {
        collect_parameter_types(&join.on, output)?;
    }
    for expression in [
        select.predicate.as_ref(),
        select.having.as_ref(),
        select.limit.as_ref(),
        select.offset.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        collect_parameter_types(expression, output)?;
    }
    Ok(())
}

fn collect_parameter_types(
    expression: &BoundExpr,
    output: &mut BTreeMap<ClientParameterName, LogicalType>,
) -> Result<(), RuntimeError> {
    match expression {
        BoundExpr::ClientParameter { name, logical_type } => {
            if output
                .insert(name.clone(), *logical_type)
                .is_some_and(|old| old != *logical_type)
            {
                return Err(RuntimeError::Rejected(
                    RejectionKind::AmbiguousParameterType,
                ));
            }
        }
        BoundExpr::Equal(left, right)
        | BoundExpr::NotEqual(left, right)
        | BoundExpr::Less(left, right)
        | BoundExpr::LessEqual(left, right)
        | BoundExpr::Greater(left, right)
        | BoundExpr::GreaterEqual(left, right)
        | BoundExpr::And(left, right)
        | BoundExpr::Or(left, right)
        | BoundExpr::Like(left, right)
        | BoundExpr::Glob(left, right)
        | BoundExpr::Least(left, right)
        | BoundExpr::Concat(left, right)
        | BoundExpr::ConditionalOutput {
            value: left,
            visible_if: right,
        } => {
            collect_parameter_types(left, output)?;
            collect_parameter_types(right, output)?;
        }
        BoundExpr::Not(inner) | BoundExpr::IsNull(inner) | BoundExpr::CastText(inner) => {
            collect_parameter_types(inner, output)?;
        }
        BoundExpr::In {
            expression, values, ..
        } => {
            collect_parameter_types(expression, output)?;
            for value in values {
                collect_parameter_types(value, output)?;
            }
        }
        BoundExpr::ScalarFunction { arguments, .. } => {
            for argument in arguments {
                collect_parameter_types(argument, output)?;
            }
        }
        BoundExpr::Exists(select) => collect_select_parameter_types(select, output)?,
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => {
            for (condition, value) in branches {
                collect_parameter_types(condition, output)?;
                collect_parameter_types(value, output)?;
            }
            if let Some(value) = else_expression {
                collect_parameter_types(value, output)?;
            }
        }
        BoundExpr::Column(_)
        | BoundExpr::ServerParameter { .. }
        | BoundExpr::Literal(_)
        | BoundExpr::CountAll(_)
        | BoundExpr::RowNumber { .. } => {}
    }
    Ok(())
}

fn logical_value(
    value: serde_json::Value,
    expected: Option<LogicalType>,
) -> Result<LogicalValue, RuntimeError> {
    match value {
        serde_json::Value::Null => Ok(LogicalValue::Null),
        serde_json::Value::Bool(value) => Ok(LogicalValue::Boolean(value)),
        serde_json::Value::Number(value) => value.as_i64().map_or_else(
            || {
                value
                    .as_f64()
                    .filter(|number| number.is_finite())
                    .map(LogicalValue::Number)
                    .ok_or(RuntimeError::Rejected(RejectionKind::InvalidParameter))
            },
            |value| Ok(LogicalValue::Int64(value)),
        ),
        serde_json::Value::String(value) => Ok(LogicalValue::String(value)),
        value @ (serde_json::Value::Array(_) | serde_json::Value::Object(_))
            if expected == Some(LogicalType::Json) =>
        {
            serde_json::to_string(&value)
                .map(LogicalValue::Json)
                .map_err(|_| RuntimeError::Rejected(RejectionKind::InvalidParameter))
        }
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            Err(RuntimeError::Rejected(RejectionKind::InvalidParameter))
        }
    }
}

fn logical_result_value(
    value: serde_json::Value,
    expected: &[LogicalType],
) -> Result<LogicalValue, RuntimeError> {
    if expected.contains(&LogicalType::Boolean) {
        return match value {
            serde_json::Value::Bool(value) => Ok(LogicalValue::Boolean(value)),
            serde_json::Value::Number(value) if value.as_i64() == Some(0) => {
                Ok(LogicalValue::Boolean(false))
            }
            serde_json::Value::Number(value) if value.as_i64() == Some(1) => {
                Ok(LogicalValue::Boolean(true))
            }
            serde_json::Value::Null => Ok(LogicalValue::Null),
            value if expected.len() > 1 => logical_result_value_without_boolean(value, expected),
            _ => Err(RuntimeError::RemoteResult),
        };
    }
    logical_result_value_without_boolean(value, expected)
}

fn logical_result_value_without_boolean(
    value: serde_json::Value,
    expected: &[LogicalType],
) -> Result<LogicalValue, RuntimeError> {
    if expected.contains(&LogicalType::Json) {
        return match value {
            serde_json::Value::String(value)
                if serde_json::from_str::<serde_json::Value>(&value).is_ok() =>
            {
                Ok(LogicalValue::Json(value))
            }
            serde_json::Value::Null => Ok(LogicalValue::Null),
            value if expected.len() > 1 => logical_result_value_scalar(value, expected),
            _ => Err(RuntimeError::RemoteResult),
        };
    }
    logical_result_value_scalar(value, expected)
}

#[allow(clippy::needless_pass_by_value)]
fn logical_result_value_scalar(
    value: serde_json::Value,
    expected: &[LogicalType],
) -> Result<LogicalValue, RuntimeError> {
    if value.is_null() {
        return Ok(LogicalValue::Null);
    }
    for logical_type in expected {
        if let Ok(value) = logical_value(value.clone(), Some(*logical_type)) {
            return Ok(value);
        }
    }
    Err(RuntimeError::RemoteResult)
}

fn compiled_statement(
    statement: &policysql_gateway::CompiledStatement,
    catalog: &Catalog,
) -> Result<CompiledStatementDto, RuntimeError> {
    let plan = &statement.plan;
    let limits = plan.limits();
    Ok(CompiledStatementDto {
        operation: operation(plan.operation()),
        resource: statement
            .explain
            .resource
            .and_then(|resource| catalog.resource_by_id(resource))
            .map(|resource| resource.name.as_str().to_owned()),
        operation_check: plan.operation_check_column().is_some(),
        protected_sql: plan.protected_sql().to_owned(),
        cost_explain_sql: policysql_sqlite::explain_query_plan_sql(plan.protected_sql())
            .map_err(|_| RuntimeError::Internal)?,
        client_parameters: encode_parameters(plan.client_parameters()),
        client_parameter_types: plan
            .client_parameters()
            .iter()
            .map(|(name, value)| (name.as_str().to_owned(), logical_value_type_name(value)))
            .collect(),
        server_parameters: encode_parameters(plan.server_parameters()),
        result: plan
            .result()
            .iter()
            .map(|column| ResultColumnDto {
                name: column.name.as_str().to_owned(),
                logical_type: logical_types_json(&column.possible_types),
                representation: representation_name(column.value.representation),
                nullable: column.value.nullable,
                format: column.value.format.clone(),
                constraints: constraints_json(column.value.constraints.as_ref()),
                json_schema: column.value.json_schema.as_ref().map(json_schema_json),
                redacted_on_null: column.redacted_on_null,
            })
            .collect(),
        limits: LimitsDto {
            max_rows: limits.max_rows,
            max_result_bytes: limits.max_result_bytes,
            timeout_ms: limits.timeout_ms,
        },
        expected_affected_rows: plan.expected_affected_rows(),
        expected_result_rows: plan.expected_result_rows(),
        explain: ExplainDto {
            resource: statement
                .explain
                .resource
                .map(policysql_core::ResourceId::get),
            resources: statement
                .explain
                .resources
                .iter()
                .map(|resource| resource.get())
                .collect(),
            resource_names: statement
                .explain
                .resources
                .iter()
                .filter_map(|resource| catalog.resource_by_id(*resource))
                .map(|resource| resource.name.as_str().to_owned())
                .collect(),
            public_resources: statement
                .explain
                .resources
                .iter()
                .filter_map(|resource_id| {
                    let resource = catalog.resource_by_id(*resource_id)?;
                    let columns = statement
                        .explain
                        .referenced_columns
                        .get(resource_id)
                        .into_iter()
                        .flatten()
                        .filter_map(|column_id| resource.column_by_id(*column_id))
                        .map(|column| column.name.as_str().to_owned())
                        .collect();
                    Some(ExplainResourceDto {
                        name: resource.name.as_str().to_owned(),
                        columns,
                    })
                })
                .collect(),
            applied_policies: statement
                .explain
                .applied_policies
                .iter()
                .map(|policy| policy.get())
                .collect(),
            policy_limit: statement.explain.policy_limit,
        },
    })
}

fn encode_parameters<Name>(
    parameters: &BTreeMap<Name, LogicalValue>,
) -> BTreeMap<String, serde_json::Value>
where
    Name: Ord + ParameterName,
{
    parameters
        .iter()
        .map(|(name, value)| (name.name().to_owned(), encode_parameter_value(value)))
        .collect()
}

trait ParameterName {
    fn name(&self) -> &str;
}

impl ParameterName for ClientParameterName {
    fn name(&self) -> &str {
        self.as_str()
    }
}

impl ParameterName for policysql_core::ServerParameterName {
    fn name(&self) -> &str {
        self.as_str()
    }
}

fn encode_parameter_value(value: &LogicalValue) -> serde_json::Value {
    match value {
        LogicalValue::Null => serde_json::Value::Null,
        LogicalValue::String(value) | LogicalValue::Json(value) => {
            serde_json::Value::String(value.clone())
        }
        LogicalValue::Boolean(value) => serde_json::Value::Bool(*value),
        LogicalValue::Int64(value) => serde_json::Value::Number((*value).into()),
        LogicalValue::Number(value) => serde_json::Number::from_f64(*value)
            .map_or(serde_json::Value::Null, serde_json::Value::Number),
        LogicalValue::Bytes(value) => serde_json::Value::Array(
            value
                .iter()
                .map(|byte| serde_json::Value::Number((*byte).into()))
                .collect(),
        ),
    }
}

fn encode_result_value(value: &LogicalValue) -> Result<serde_json::Value, RuntimeError> {
    if let LogicalValue::Json(value) = value {
        return serde_json::from_str(value).map_err(|_| RuntimeError::RemoteResult);
    }
    Ok(encode_parameter_value(value))
}

const fn operation(value: policysql_core::OperationKind) -> &'static str {
    match value {
        policysql_core::OperationKind::Select => "select",
        policysql_core::OperationKind::Insert => "insert",
        policysql_core::OperationKind::Update => "update",
        policysql_core::OperationKind::Delete => "delete",
    }
}

const fn logical_type_name(value: LogicalType) -> &'static str {
    match value {
        LogicalType::String => "string",
        LogicalType::Integer => "integer",
        LogicalType::Boolean => "boolean",
        LogicalType::Int64 => "int64",
        LogicalType::Number => "number",
        LogicalType::Bytes => "bytes",
        LogicalType::Date => "date",
        LogicalType::DateTime => "datetime",
        LogicalType::Instant => "instant",
        LogicalType::Json => "json",
    }
}

fn logical_types_json(values: &[LogicalType]) -> serde_json::Value {
    if let [value] = values {
        serde_json::Value::String(logical_type_name(*value).to_owned())
    } else {
        serde_json::Value::Array(
            values
                .iter()
                .map(|value| serde_json::Value::String(logical_type_name(*value).to_owned()))
                .collect(),
        )
    }
}

const fn logical_value_type_name(value: &LogicalValue) -> &'static str {
    match value {
        LogicalValue::Null => "null",
        LogicalValue::String(_) => "string",
        LogicalValue::Boolean(_) => "boolean",
        LogicalValue::Int64(_) => "int64",
        LogicalValue::Number(_) => "number",
        LogicalValue::Bytes(_) => "bytes",
        LogicalValue::Json(_) => "json",
    }
}

const fn representation_name(value: ValueRepresentation) -> &'static str {
    match value {
        ValueRepresentation::String => "string",
        ValueRepresentation::Boolean => "boolean",
        ValueRepresentation::Number => "number",
        ValueRepresentation::Base64 => "base64",
        ValueRepresentation::Json => "json",
    }
}

const fn catalog_representation_name(value: ValueRepresentation) -> &'static str {
    match value {
        ValueRepresentation::String | ValueRepresentation::Base64 => "string",
        ValueRepresentation::Boolean => "boolean",
        ValueRepresentation::Number => "number",
        ValueRepresentation::Json => "object",
    }
}

fn runtime_gateway_error(error: GatewayError) -> RuntimeError {
    match error {
        GatewayError::AccessDenied => RuntimeError::Access,
        GatewayError::SnapshotMismatch => RuntimeError::Snapshot,
        GatewayError::EnvelopeLimit => RuntimeError::Envelope,
        GatewayError::Rejected { kind, index } => RuntimeError::RejectedAt(kind, index),
        GatewayError::TransactionRequired => {
            RuntimeError::Rejected(RejectionKind::ForbiddenOperation)
        }
        GatewayError::ExecutionFailed => RuntimeError::Internal,
    }
}

fn error_body(runtime_error: RuntimeError) -> ErrorBody {
    match runtime_error {
        RuntimeError::Authentication => error(
            "POLICYSQL_UNAUTHENTICATED",
            "Authentication is required.",
            None,
        ),
        RuntimeError::Access => error(
            "POLICYSQL_FORBIDDEN_ACCESS",
            "The authenticated session cannot use this endpoint.",
            None,
        ),
        RuntimeError::Snapshot => error(
            "POLICYSQL_STALE_OPERATION",
            "The operation was compiled for a different active snapshot.",
            None,
        ),
        RuntimeError::Envelope => error(
            "POLICYSQL_INVALID_REQUEST",
            "Request envelope is invalid.",
            None,
        ),
        RuntimeError::EnvelopeAt(index) => error(
            "POLICYSQL_INVALID_REQUEST",
            "Request envelope is invalid.",
            Some(index),
        ),
        RuntimeError::Rejected(kind) => rejection_body(kind, None),
        RuntimeError::RejectedAt(kind, index) => rejection_body(kind, Some(index)),
        RuntimeError::Internal => error(
            "POLICYSQL_INTERNAL",
            "The request could not be completed.",
            None,
        ),
        RuntimeError::Busy => error(
            "POLICYSQL_DATABASE_UNAVAILABLE",
            "The database adapter is temporarily unavailable.",
            None,
        ),
        RuntimeError::RemoteResult => error(
            "POLICYSQL_SCHEMA_MISMATCH",
            "The database result does not match the compiled logical contract.",
            None,
        ),
        RuntimeError::RemoteResultAt(index) => error(
            "POLICYSQL_SCHEMA_MISMATCH",
            "The database result does not match the compiled logical contract.",
            Some(index),
        ),
    }
}

fn error(code: &'static str, message: &'static str, index: Option<usize>) -> ErrorBody {
    ErrorBody {
        code,
        message,
        path: index.map(|index| format!("/statements/{index}")),
    }
}

fn rejection_body(kind: RejectionKind, index: Option<usize>) -> ErrorBody {
    let (code, message) = match kind {
        RejectionKind::InvalidRequest => ("POLICYSQL_INVALID_REQUEST", "The request is invalid."),
        RejectionKind::InvalidSql => (
            "POLICYSQL_INVALID_SQL",
            "The SQL statement cannot be parsed.",
        ),
        RejectionKind::MultipleStatements => (
            "POLICYSQL_MULTIPLE_STATEMENTS",
            "Exactly one SQL statement is required.",
        ),
        RejectionKind::UnsupportedSql => (
            "POLICYSQL_UNSUPPORTED_SQL",
            "The SQL statement uses an unsupported form.",
        ),
        RejectionKind::MissingPolicy => (
            "POLICYSQL_MISSING_POLICY",
            "No policy permits this operation.",
        ),
        RejectionKind::ForbiddenOperation => (
            "POLICYSQL_FORBIDDEN_OPERATION",
            "The operation is not available.",
        ),
        RejectionKind::ForbiddenColumn => (
            "POLICYSQL_FORBIDDEN_COLUMN",
            "The statement references a column that is not available for this operation.",
        ),
        RejectionKind::ForbiddenColumnContext => (
            "POLICYSQL_FORBIDDEN_COLUMN_CONTEXT",
            "The statement uses a column in a context that is not available.",
        ),
        RejectionKind::DuplicateResultColumn => (
            "POLICYSQL_DUPLICATE_RESULT_COLUMN",
            "Result column names must be unique.",
        ),
        RejectionKind::InvalidParameter => (
            "POLICYSQL_INVALID_PARAMETER",
            "A statement parameter is missing or invalid.",
        ),
        RejectionKind::AmbiguousParameterType => (
            "POLICYSQL_AMBIGUOUS_PARAMETER_TYPE",
            "A parameter type cannot be proven.",
        ),
        RejectionKind::ReservedParameter => (
            "POLICYSQL_RESERVED_PARAMETER",
            "A parameter uses the server-owned namespace.",
        ),
        RejectionKind::PresetColumn => (
            "POLICYSQL_PRESET_COLUMN",
            "A server-owned preset column cannot be supplied by the client.",
        ),
        RejectionKind::LimitExceeded => (
            "POLICYSQL_LIMIT_EXCEEDED",
            "The request or result exceeded a configured limit.",
        ),
        RejectionKind::ExpectationFailed => (
            "POLICYSQL_EXPECTATION_FAILED",
            "The operation did not satisfy its declared expectation.",
        ),
    };
    error(code, message, index)
}

fn serialize_or_internal(value: &impl Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| {
        "{\"error\":{\"code\":\"POLICYSQL_INTERNAL\",\"message\":\"The request could not be completed.\"}}"
            .to_owned()
    })
}

fn js_error(message: &str) -> JsValue {
    JsValue::from_str(message)
}

#[cfg(test)]
mod tests {
    use super::{
        LogicalType, LogicalValue, PhysicalSchema, PolicySqlRuntime, SnapshotId, activate_catalog,
        activate_catalog_with_schema, encode_parameter_value, encode_result_value,
        logical_result_value,
    };

    const CATALOG: &str = r"
version: 1
resources:
  projects:
    source: { table: projects }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      name: { type: string }
      status: { type: string }
";

    const POLICY: &str = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, name, status]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
        insert:
          columns: [id, name, status]
          presets:
            tenant_id: { session: tenant_id }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name, status] }
";

    fn runtime() -> PolicySqlRuntime {
        PolicySqlRuntime::new(
            CATALOG,
            POLICY,
            "schema_test",
            "policy_test",
            r#"{"max_rows":100,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":4}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid runtime"))
    }

    #[test]
    fn catalog_activation_accepts_only_the_documented_json_schema_subset() {
        let valid = CATALOG.replace(
            "      status: { type: string }",
            r"      status: { type: string }
      metadata:
        type: json
        representation: object
        jsonSchema:
          $schema: https://json-schema.org/draft/2020-12/schema
          type: object
          additionalProperties: false
          properties:
            score:
              anyOf:
                - { type: integer }
                - { type: 'null' }",
        );
        let snapshot = SnapshotId::new("schema_json")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        assert!(activate_catalog(&valid, snapshot.clone()).is_ok());

        let invalid = CATALOG.replace(
            "      status: { type: string }",
            r"      status: { type: string }
      metadata:
        type: json
        jsonSchema:
          $ref: https://example.com/remote-schema.json",
        );
        assert!(activate_catalog(&invalid, snapshot).is_err());
    }

    #[test]
    fn catalog_retains_storage_format_constraints_and_json_schema() {
        let manifest = CATALOG.replace(
            "      status: { type: string }",
            r"      status:
        type: string
        storage: text
        format: uuid
        constraints:
          minLength: 36
          maxLength: 36
          pattern: '^[0-9a-f-]+$'
      metadata:
        type: json
        storage: text
        representation: object
        jsonSchema:
          type: object
          additionalProperties: false
          required: [score]
          properties:
            score: { type: integer }",
        );
        let snapshot = SnapshotId::new("schema_contract")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        let catalog = activate_catalog(&manifest, snapshot)
            .unwrap_or_else(|error| unreachable!("valid Catalog: {error:?}"));
        let resource = catalog
            .resource("projects")
            .unwrap_or_else(|| unreachable!("resource exists"));
        let status = resource
            .column("status")
            .unwrap_or_else(|| unreachable!("column exists"));
        assert!(status.value.storage.is_some());
        assert_eq!(status.value.format.as_deref(), Some("uuid"));
        assert_eq!(
            status
                .value
                .constraints
                .as_ref()
                .and_then(|constraints| constraints.min_length),
            Some(36)
        );
        assert!(
            resource
                .column("metadata")
                .is_some_and(|column| column.value.json_schema.is_some())
        );

        let invalid_format = CATALOG.replace(
            "      status: { type: string }",
            "      status: { type: string, format: rfc3339 }",
        );
        let snapshot = SnapshotId::new("schema_invalid_format")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        assert!(activate_catalog(&invalid_format, snapshot).is_err());
    }

    #[test]
    fn gateway_revalidates_catalog_constraints_on_client_parameters() {
        let catalog = CATALOG.replace(
            "      status: { type: string }",
            "      status:\n        type: string\n        constraints: { enum: [active, archived] }",
        );
        let runtime = PolicySqlRuntime::new(
            &catalog,
            POLICY,
            "schema_constraints",
            "policy_constraints",
            r#"{"max_rows":100,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":2}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid runtime"));
        let auth = r#"{"subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#;
        let accepted = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE status = :status","params":{"status":"active"}}]}"#,
            "explain",
        );
        assert!(!accepted.contains("\"error\""), "{accepted}");
        let rejected = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE status = :status","params":{"status":"deleted"}}]}"#,
            "explain",
        );
        assert!(
            rejected.contains("POLICYSQL_INVALID_PARAMETER"),
            "{rejected}"
        );
    }

    #[test]
    fn catalog_build_derives_basic_types_and_rejects_physical_drift() {
        let manifest = r"
version: 1
resources:
  projects:
    source: { table: physical_projects }
    columns:
      id: {}
      title: {}
      score: {}
      payload: {}
";
        let physical: PhysicalSchema = serde_json::from_str(
            r#"{"tables":{"physical_projects":{"columns":{"id":{"declaredType":"INTEGER","nullable":false},"title":{"declaredType":"TEXT","nullable":true},"score":{"declaredType":"REAL","nullable":false},"payload":{"declaredType":"BLOB","nullable":false}}}}}"#,
        )
        .unwrap_or_else(|error| unreachable!("valid physical schema: {error}"));
        let snapshot = SnapshotId::new("schema_introspection")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"));
        let catalog = activate_catalog_with_schema(manifest, snapshot.clone(), Some(&physical))
            .unwrap_or_else(|error| unreachable!("valid Catalog: {error:?}"));
        let resource = catalog
            .resource("projects")
            .unwrap_or_else(|| unreachable!("resource exists"));
        assert_eq!(resource.source.as_str(), "physical_projects");
        assert_eq!(
            resource
                .column("id")
                .map(|column| column.value.logical_type),
            Some(LogicalType::Int64)
        );
        assert!(
            resource
                .column("title")
                .is_some_and(|column| column.value.nullable)
        );

        let drifted = manifest.replace("      payload: {}", "      missing: {}\n");
        assert!(activate_catalog_with_schema(&drifted, snapshot, Some(&physical)).is_err());
    }

    #[test]
    fn compiles_only_authenticated_policy_protected_sql() {
        let output = runtime().compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"expected":{"schemaVersion":"schema_test","policyVersion":"policy_test"},"statements":[{"sql":"SELECT id, name FROM projects WHERE status = :status","params":{"status":"active"}}]}"#,
            "explain",
        );
        let value: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        assert_eq!(value["profile"], "sqlite-turso-v1");
        assert_eq!(value["transactionMode"], "read");
        assert_eq!(
            value["statements"][0]["explain"]["resourceNames"],
            serde_json::json!(["projects"])
        );
        let protected = value["statements"][0]["protectedSql"]
            .as_str()
            .unwrap_or_default();
        assert!(protected.contains("__policysql_session_tenant_id"));
    }

    #[test]
    fn constant_select_is_typed_without_catalog_resource_access() {
        let output = runtime().compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT 1 AS value","params":{}}]}"#,
            "explain",
        );
        let value: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        assert!(value.get("error").is_none(), "{output}");
        assert_eq!(
            value["statements"][0]["result"][0]["logicalType"],
            "integer"
        );
        assert_eq!(
            value["statements"][0]["explain"]["resourceNames"],
            serde_json::json!([])
        );
        assert!(
            value["statements"][0]["protectedSql"]
                .as_str()
                .is_some_and(|sql| { sql == "SELECT 1 AS \"value\"" }),
            "{output}"
        );
    }

    #[test]
    fn compile_exports_activated_commit_check_and_mutation_resource() {
        let policy = format!(
            "{POLICY}\ncommit_checks:\n  project_consistency:\n    triggered_by: [projects]\n    role: member\n    hook:\n      url_env: PROJECT_CHECK_URL\n      timeout_ms: 1000\n      hmac_secret_env: PROJECT_CHECK_SECRET\n"
        );
        let runtime = PolicySqlRuntime::new(
            CATALOG,
            &policy,
            "schema_commit",
            "policy_commit",
            r#"{"max_rows":100,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":4}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid runtime"));
        assert!(runtime.commit_checks_enabled());
        let output = runtime.compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"INSERT INTO projects (id, name, status) VALUES (:id, :name, :status)","params":{"id":"p1","name":"one","status":"active"}}]}"#,
            "execute",
        );
        let compiled: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid JSON: {error}"));
        assert_eq!(compiled["statements"][0]["resource"], "projects");
        assert_eq!(compiled["commitChecks"][0]["id"], "project_consistency");
        assert_eq!(compiled["commitChecks"][0]["triggeredBy"][0], "projects");
        assert_eq!(compiled["commitChecks"][0]["urlEnv"], "PROJECT_CHECK_URL");
    }

    #[test]
    fn explain_infers_missing_runtime_parameter_values_from_bound_usage() {
        let output = runtime().compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE status = :status LIMIT :limit","params":{}}]}"#,
            "explain",
        );
        let value: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        assert!(value.get("error").is_none(), "{output}");
        assert_eq!(value["statements"][0]["clientParameters"]["status"], "");
        assert_eq!(value["statements"][0]["clientParameters"]["limit"], 0);
    }

    #[test]
    fn rejects_access_and_snapshot_mismatch_without_exposing_detail() {
        let request = r#"{"statements":[{"sql":"SELECT id FROM projects","params":{}}]}"#;
        let debug = runtime().compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["execute","debug"],"session":{"tenant_id":"tenant_1"}}"#,
            request,
            "execute",
        );
        assert!(!debug.contains("POLICYSQL_FORBIDDEN_ACCESS"), "{debug}");

        let denied = runtime().compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["catalog"],"session":{"tenant_id":"tenant_1"}}"#,
            request,
            "explain",
        );
        assert!(denied.contains("POLICYSQL_FORBIDDEN_ACCESS"));

        let stale = runtime().compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"expected":{"schemaVersion":"stale","policyVersion":"policy_test"},"statements":[{"sql":"SELECT id FROM projects","params":{}}]}"#,
            "explain",
        );
        assert!(stale.contains("POLICYSQL_STALE_OPERATION"));
    }

    #[test]
    fn classifies_public_sql_errors_without_exposing_catalog_detail() {
        let runtime = runtime();
        let auth = r#"{"subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#;
        for (sql, params, code) in [
            ("SELECT", "{}", "POLICYSQL_INVALID_SQL"),
            (
                "SELECT id FROM projects; SELECT id FROM projects",
                "{}",
                "POLICYSQL_MULTIPLE_STATEMENTS",
            ),
            ("SELECT * FROM projects", "{}", "POLICYSQL_UNSUPPORTED_SQL"),
            (
                "SELECT tenant_id FROM projects",
                "{}",
                "POLICYSQL_FORBIDDEN_COLUMN",
            ),
            (
                "SELECT id FROM projects WHERE status = :status",
                "{}",
                "POLICYSQL_INVALID_PARAMETER",
            ),
            (
                "SELECT id FROM projects WHERE status = :__policysql_secret",
                r#"{"__policysql_secret":"active"}"#,
                "POLICYSQL_RESERVED_PARAMETER",
            ),
        ] {
            let request = format!(
                r#"{{"statements":[{{"sql":{},"params":{params}}}]}}"#,
                serde_json::to_string(sql)
                    .unwrap_or_else(|error| unreachable!("SQL string serializes: {error}"))
            );
            let output = runtime.compile_json(auth, &request, "execute");
            assert!(output.contains(code), "expected {code} for {sql}: {output}");
            assert!(output.contains(r#""path":"/statements/0""#));
            assert!(!output.contains("executionHandle"));
            assert!(!output.contains("tenant_id"));
        }

        let output = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT id FROM projects","params":{}},{"sql":"SELECT tenant_id FROM projects","params":{}}]}"#,
            "execute",
        );
        let error: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|parse_error| unreachable!("safe error parses: {parse_error}"));
        assert_eq!(error["error"]["code"], "POLICYSQL_FORBIDDEN_COLUMN");
        assert_eq!(error["error"]["path"], "/statements/1");
    }

    #[test]
    fn execute_handle_validates_remote_columns_rows_and_limits() {
        let runtime = runtime();
        let compiled = runtime.compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT id, name FROM projects","params":{}}]}"#,
            "execute",
        );
        let value: serde_json::Value = serde_json::from_str(&compiled)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        let handle = value["executionHandle"]
            .as_u64()
            .unwrap_or_else(|| unreachable!("execute handle"));
        let valid = runtime.validate_result_json(
            handle,
            0,
            r#"{"columns":["id","name"],"rows":[["p1","Project"]],"affectedRows":0}"#,
        );
        assert!(!valid.contains("error"));
        let invalid = runtime.validate_result_json(
            handle,
            0,
            r#"{"columns":["name","id"],"rows":[["Project","p1"]],"affectedRows":0}"#,
        );
        assert!(invalid.contains("POLICYSQL_SCHEMA_MISMATCH"));
        assert!(runtime.release_execution(handle));
        assert!(!runtime.release_execution(handle));
    }

    #[test]
    fn execute_expectation_mismatch_has_its_public_error_code() {
        let runtime = runtime();
        let compiled = runtime.compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE id = :id","params":{"id":"p1"},"expect":{"rowCount":0}}]}"#,
            "execute",
        );
        let value: serde_json::Value = serde_json::from_str(&compiled)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        let handle = value["executionHandle"]
            .as_u64()
            .unwrap_or_else(|| unreachable!("execute handle"));
        let mismatch = runtime.validate_result_json(
            handle,
            0,
            r#"{"columns":["id"],"rows":[["p1"]],"affectedRows":0}"#,
        );
        assert!(mismatch.contains("POLICYSQL_EXPECTATION_FAILED"));
        assert!(runtime.release_execution(handle));
    }

    #[test]
    fn catalog_reports_only_policy_enabled_column_usage() {
        let output = runtime().catalog_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["catalog"],"session":{"tenant_id":"tenant_1"}}"#,
        );
        let catalog: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid catalog JSON: {error}"));
        let usage = catalog["resources"][0]["operations"]["select"]["columns"][0]["usage"]
            .as_array()
            .unwrap_or_else(|| unreachable!("column usage"));
        assert!(usage.iter().any(|value| value == "projection"));
        assert!(usage.iter().any(|value| value == "join"));
        assert!(!usage.iter().any(|value| value == "group"));
        assert!(!usage.iter().any(|value| value == "aggregate"));
        assert!(!usage.iter().any(|value| value == "window"));
    }

    #[test]
    fn deployment_surface_keeps_parser_structural_join_limits() {
        let output = runtime().compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT a.id FROM projects AS a JOIN projects AS b ON a.id = b.id","params":{}}]}"#,
            "execute",
        );
        assert!(
            output.contains("POLICYSQL_UNSUPPORTED_SQL"),
            "unexpected safe error: {output}"
        );
        assert!(!output.contains("executionHandle"));
    }

    #[test]
    fn json_results_are_validated_and_emitted_as_json_values() {
        let encoded = logical_result_value(
            serde_json::Value::String(r#"{"tag":"first"}"#.to_owned()),
            &[LogicalType::Json],
        )
        .and_then(|value| encode_result_value(&value))
        .unwrap_or_else(|error| unreachable!("valid JSON result: {error:?}"));
        assert_eq!(encoded, serde_json::json!({"tag": "first"}));
        assert!(
            logical_result_value(
                serde_json::Value::String("not-json".to_owned()),
                &[LogicalType::Json],
            )
            .is_err()
        );
        assert_eq!(
            encode_parameter_value(&LogicalValue::Json(r#"{"tag":"first"}"#.to_owned())),
            serde_json::Value::String(r#"{"tag":"first"}"#.to_owned())
        );
    }

    #[test]
    fn json_parameters_are_accepted_only_from_catalog_typed_usage() {
        let catalog = CATALOG.replace(
            "      status: { type: string }",
            "      status: { type: string }\n      metadata: { type: json, representation: object }",
        );
        let policy = POLICY.replace(
            "columns: [id, name, status]",
            "columns: [id, name, status, metadata]",
        );
        let runtime = PolicySqlRuntime::new(
            &catalog,
            &policy,
            "schema_json_parameter",
            "policy_json_parameter",
            r#"{"max_rows":100,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":4}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid JSON runtime"));
        let auth = r#"{"subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#;
        let accepted = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE metadata = :metadata","params":{"metadata":{"tags":["safe"]}}}]}"#,
            "execute",
        );
        let compiled: serde_json::Value = serde_json::from_str(&accepted)
            .unwrap_or_else(|error| unreachable!("compiled JSON parses: {error}"));
        assert_eq!(
            compiled["statements"][0]["clientParameters"]["metadata"],
            r#"{"tags":["safe"]}"#
        );
        let explained = runtime.compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE metadata = :metadata","params":{}}]}"#,
            "explain",
        );
        let explained: serde_json::Value = serde_json::from_str(&explained)
            .unwrap_or_else(|error| unreachable!("Explain JSON parses: {error}"));
        assert_eq!(
            explained["statements"][0]["clientParameterTypes"]["metadata"],
            "json"
        );

        let rejected = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT id FROM projects WHERE status = :status","params":{"status":{"nested":true}}}]}"#,
            "execute",
        );
        assert!(rejected.contains("POLICYSQL_INVALID_PARAMETER"));
        assert!(rejected.contains(r#""path":"/statements/0""#));
    }

    #[test]
    fn json_extract_uses_path_value_and_explain_uses_finite_schema_union() {
        let catalog = r"
version: 1
resources:
  projects:
    source: { table: projects }
    columns:
      tenant_id: { type: string }
      metadata:
        type: json
        representation: object
        jsonSchema:
          type: object
          additionalProperties: false
          properties:
            score: { type: integer }
            label: { type: string }
";
        let policy = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [metadata]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 10
";
        let runtime = PolicySqlRuntime::new(
            catalog,
            policy,
            "schema_json_path",
            "policy_json_path",
            r#"{"max_rows":10,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":2}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid runtime"));
        let auth = r#"{"subject":"user_1","role":"member","roles":["member"],"access":["explain"],"session":{"tenant_id":"tenant_1"}}"#;
        let execute = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT json_extract(metadata, :path) AS value FROM projects","params":{"path":"$.score"}}]}"#,
            "explain",
        );
        let execute: serde_json::Value = serde_json::from_str(&execute)
            .unwrap_or_else(|error| unreachable!("valid JSON: {error}"));
        assert_eq!(
            execute["statements"][0]["result"][0]["logicalType"],
            "integer"
        );

        let explain = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT json_extract(metadata, :path) AS value FROM projects","params":{}}]}"#,
            "explain",
        );
        let explain: serde_json::Value = serde_json::from_str(&explain)
            .unwrap_or_else(|error| unreachable!("valid JSON: {error}"));
        assert_eq!(
            explain["statements"][0]["result"][0]["logicalType"],
            serde_json::json!(["integer", "string", "json"])
        );
    }

    #[test]
    fn json_table_collection_is_policy_filtered_typed_and_sealed() {
        let catalog = r"
version: 1
resources:
  projects:
    source: { table: projects }
    columns:
      id: { type: string }
      tenant_id: { type: string }
      metadata:
        type: json
        representation: object
        jsonSchema:
          type: object
          additionalProperties: false
          properties:
            score: { type: integer }
            label: { type: string }
";
        let policy = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, metadata]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          allow_aggregations: true
          limit: 10
";
        let runtime = PolicySqlRuntime::new(
            catalog,
            policy,
            "schema_json_collection",
            "policy_json_collection",
            r#"{"max_rows":10,"max_result_bytes":10000,"timeout_ms":1000,"max_statements":2}"#,
        )
        .unwrap_or_else(|_| unreachable!("valid runtime"));
        let auth = r#"{"subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#;
        let output = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.metadata, :path) AS j WHERE p.id = :id","params":{"path":"$","id":"p1"}}]}"#,
            "execute",
        );
        let compiled: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid JSON: {error}"));
        assert!(compiled.get("error").is_none(), "{output}");
        assert_eq!(
            compiled["statements"][0]["result"][0]["logicalType"],
            "json"
        );
        assert_eq!(
            compiled["statements"][0]["result"][0]["jsonSchema"]["type"],
            "array"
        );
        assert_eq!(
            compiled["statements"][0]["expectedResultRows"],
            serde_json::json!(1)
        );
        let sql = compiled["statements"][0]["protectedSql"]
            .as_str()
            .unwrap_or_else(|| unreachable!("protected SQL"));
        assert!(sql.contains("JSON_EACH"));
        assert!(sql.contains(":__policysql_session_tenant_id"));

        let denied = runtime.compile_json(
            auth,
            r#"{"statements":[{"sql":"SELECT json_group_array(j.key) AS items FROM projects AS p, json_each(p.metadata, :path) AS j","params":{"path":"$"}}]}"#,
            "execute",
        );
        assert!(denied.contains("POLICYSQL_UNSUPPORTED_SQL"));
    }

    #[test]
    fn mutation_result_check_is_validated_before_handle_release() {
        let runtime = runtime();
        let output = runtime.compile_json(
            r#"{"subject":"user_1","role":"member","roles":["member"],"access":["execute"],"session":{"tenant_id":"tenant_1"}}"#,
            r#"{"statements":[{"sql":"INSERT INTO projects (id, name, status) VALUES (:id, :name, :status) RETURNING id, name, status","params":{"id":"new_1","name":"New","status":"active"}}]}"#,
            "execute",
        );
        let compiled: serde_json::Value = serde_json::from_str(&output)
            .unwrap_or_else(|error| unreachable!("valid response JSON: {error}"));
        assert_eq!(compiled["statements"][0]["operationCheck"], true);
        let handle = compiled["executionHandle"]
            .as_u64()
            .unwrap_or_else(|| unreachable!("mutation handle"));
        let raw = serde_json::json!({
            "columns": ["id", "name", "status", "__policysql_check"],
            "rows": [["new_1", "New", "active", 1]],
            "affectedRows": 1
        });
        let validated = runtime.validate_result_json(handle, 0, &raw.to_string());
        assert!(!validated.contains("error"));
        assert!(runtime.release_execution(handle));
    }
}
