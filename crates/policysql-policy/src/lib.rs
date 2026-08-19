#![forbid(unsafe_code)]

use policysql_catalog::{Catalog, ColumnDescriptor, ResourceDescriptor};
use policysql_core::{
    ColumnId, CoreError, LogicalType, LogicalValue, OperationKind, PolicyId, RoleName,
    ServerParameterName, SessionKey, SnapshotId, TrustedSession,
};
use policysql_ir::{
    BoundAssignment, BoundColumn, BoundExpr, BoundJsonCollectionSelect, BoundProjection,
    BoundSelect, BoundStatement, ColumnUsage, ProtectedPlan,
};
use serde::Deserialize;
use serde_yaml::{Mapping, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

const MAX_COMMIT_CHECKS: usize = 4;
const MAX_COMMIT_CHECK_TIMEOUT_MS: u64 = 1_500;

#[derive(Clone, Debug)]
pub struct PolicyBundle {
    snapshot: SnapshotId,
    select: BTreeMap<policysql_core::ResourceId, BTreeMap<RoleName, SelectPolicy>>,
    insert: BTreeMap<policysql_core::ResourceId, BTreeMap<RoleName, InsertPolicy>>,
    update: BTreeMap<policysql_core::ResourceId, BTreeMap<RoleName, UpdatePolicy>>,
    delete: BTreeMap<policysql_core::ResourceId, BTreeMap<RoleName, DeletePolicy>>,
    commit_checks: Vec<ActivatedCommitCheck>,
}

/// Read-only, role-scoped policy information used to construct the public Catalog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectAccess {
    pub regular_columns: BTreeSet<ColumnId>,
    pub conditional_columns: BTreeSet<ColumnId>,
    pub max_rows: Option<u64>,
    pub allow_aggregations: bool,
    pub allow_windows: bool,
}

/// Role-scoped activated mutation columns used by public Catalog projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MutationAccess {
    pub columns: BTreeSet<ColumnId>,
    pub returning: BTreeSet<ColumnId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivatedCommitCheck {
    pub id: String,
    pub triggered_by: BTreeSet<policysql_core::ResourceId>,
    pub role: Option<RoleName>,
    pub url_env: String,
    pub timeout_ms: u64,
    pub hmac_secret_env: String,
}

#[derive(Clone, Debug)]
struct InsertPolicy {
    id: PolicyId,
    columns: BTreeSet<ColumnId>,
    presets: BTreeMap<ColumnId, (LogicalType, PolicyOperand)>,
    check: PolicyPredicate,
    returning: BTreeSet<ColumnId>,
}

#[derive(Clone, Debug)]
struct UpdatePolicy {
    id: PolicyId,
    columns: BTreeSet<ColumnId>,
    presets: BTreeMap<ColumnId, (LogicalType, PolicyOperand)>,
    filter: PolicyPredicate,
    check: PolicyPredicate,
    returning: BTreeSet<ColumnId>,
}

#[derive(Clone, Debug)]
struct DeletePolicy {
    id: PolicyId,
    filter: PolicyPredicate,
    returning: BTreeSet<ColumnId>,
}

#[derive(Clone, Debug)]
struct SelectPolicy {
    id: PolicyId,
    regular_columns: BTreeSet<ColumnId>,
    conditional_columns: BTreeMap<ColumnId, PolicyPredicate>,
    filter: PolicyPredicate,
    limit: Option<u64>,
    allow_aggregations: bool,
    allow_windows: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ComparisonOperator {
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    Like,
}

#[derive(Clone, Debug)]
enum PolicyOperand {
    Session(SessionKey),
    Literal(LogicalValue),
    Column(BoundColumn),
}

#[derive(Clone, Debug)]
enum PolicyPredicate {
    Comparison {
        column: BoundColumn,
        operator: ComparisonOperator,
        operand: PolicyOperand,
    },
    In {
        column: BoundColumn,
        values: Vec<LogicalValue>,
        negated: bool,
    },
    IsNull {
        column: BoundColumn,
        is_null: bool,
    },
    And(Vec<Self>),
    Or(Vec<Self>),
    Not(Box<Self>),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBundle {
    version: u32,
    resources: BTreeMap<String, RawResource>,
    #[serde(default)]
    commit_checks: BTreeMap<String, RawCommitCheck>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCommitCheck {
    triggered_by: Vec<String>,
    role: Option<String>,
    hook: RawCommitHook,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCommitHook {
    url_env: String,
    timeout_ms: u64,
    hmac_secret_env: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawResource {
    roles: BTreeMap<String, RawRole>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRole {
    select: Option<RawSelect>,
    insert: Option<RawInsert>,
    update: Option<RawUpdate>,
    delete: Option<RawDelete>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawInsert {
    columns: Vec<String>,
    #[serde(default)]
    presets: BTreeMap<String, Value>,
    check: Value,
    returning: Option<RawReturning>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawUpdate {
    columns: Vec<String>,
    #[serde(default)]
    presets: BTreeMap<String, Value>,
    filter: Value,
    check: Value,
    returning: Option<RawReturning>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDelete {
    filter: Value,
    returning: Option<RawReturning>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawReturning {
    columns: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSelect {
    columns: Vec<RawColumn>,
    filter: Value,
    limit: Option<u64>,
    #[serde(default)]
    allow_aggregations: bool,
    #[serde(default)]
    allow_windows: bool,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawColumn {
    Regular(String),
    Conditional {
        name: String,
        visible_if: Value,
        on_deny: Value,
    },
}

impl PolicyBundle {
    /// Returns only the already-activated SELECT surface visible to one role.
    #[must_use]
    pub fn select_access(
        &self,
        resource: policysql_core::ResourceId,
        role: &RoleName,
    ) -> Option<SelectAccess> {
        self.select
            .get(&resource)?
            .get(role)
            .map(|policy| SelectAccess {
                regular_columns: policy.regular_columns.clone(),
                conditional_columns: policy.conditional_columns.keys().copied().collect(),
                max_rows: policy.limit,
                allow_aggregations: policy.allow_aggregations,
                allow_windows: policy.allow_windows,
            })
    }

    #[must_use]
    pub fn insert_access(
        &self,
        resource: policysql_core::ResourceId,
        role: &RoleName,
    ) -> Option<MutationAccess> {
        self.insert
            .get(&resource)?
            .get(role)
            .map(|policy| MutationAccess {
                columns: policy.columns.clone(),
                returning: policy.returning.clone(),
            })
    }

    #[must_use]
    pub fn update_access(
        &self,
        resource: policysql_core::ResourceId,
        role: &RoleName,
    ) -> Option<MutationAccess> {
        self.update
            .get(&resource)?
            .get(role)
            .map(|policy| MutationAccess {
                columns: policy.columns.clone(),
                returning: policy.returning.clone(),
            })
    }

    #[must_use]
    pub fn delete_access(
        &self,
        resource: policysql_core::ResourceId,
        role: &RoleName,
    ) -> Option<MutationAccess> {
        self.delete
            .get(&resource)?
            .get(role)
            .map(|policy| MutationAccess {
                columns: BTreeSet::new(),
                returning: policy.returning.clone(),
            })
    }

    /// Parses and activates one immutable policy bundle against a Catalog snapshot.
    ///
    /// # Errors
    ///
    /// Rejects unknown metadata, resources, columns, roles, operators, and incompatible values.
    pub fn activate(
        yaml: &str,
        catalog: &Catalog,
        snapshot: SnapshotId,
    ) -> Result<Self, PolicyError> {
        let raw: RawBundle = serde_yaml::from_str(yaml).map_err(|_| PolicyError::InvalidBundle)?;
        if raw.version != 1 || raw.resources.is_empty() {
            return Err(PolicyError::InvalidBundle);
        }
        let commit_checks = activate_commit_checks(raw.commit_checks, catalog)?;
        let mut next_policy_id = 1_u64;
        let mut select = BTreeMap::new();
        let mut insert_policies = BTreeMap::new();
        let mut update_policies = BTreeMap::new();
        let mut delete_policies = BTreeMap::new();
        for (resource_name, raw_resource) in raw.resources {
            let resource = catalog
                .resource(&resource_name)
                .ok_or(PolicyError::UnknownResource)?;
            let mut select_roles = BTreeMap::new();
            let mut insert_roles = BTreeMap::new();
            let mut update_roles = BTreeMap::new();
            let mut delete_roles = BTreeMap::new();
            for (role_name, raw_role) in raw_resource.roles {
                let role = RoleName::new(role_name).map_err(|_| PolicyError::InvalidRole)?;
                let RawRole {
                    select: raw_select,
                    insert,
                    update,
                    delete,
                } = raw_role;
                if let Some(raw_select) = raw_select {
                    let policy = activate_select(raw_select, resource, next_policy_id)?;
                    next_policy_id = next_policy_id
                        .checked_add(1)
                        .ok_or(PolicyError::TooManyPolicies)?;
                    if select_roles.insert(role.clone(), policy).is_some() {
                        return Err(PolicyError::DuplicatePolicy);
                    }
                }
                if let Some(raw_insert) = insert {
                    let policy = activate_insert(raw_insert, resource, next_policy_id)?;
                    next_policy_id = next_policy_id
                        .checked_add(1)
                        .ok_or(PolicyError::TooManyPolicies)?;
                    if insert_roles.insert(role.clone(), policy).is_some() {
                        return Err(PolicyError::DuplicatePolicy);
                    }
                }
                if let Some(raw_update) = update {
                    let policy = activate_update(raw_update, resource, next_policy_id)?;
                    next_policy_id = next_policy_id
                        .checked_add(1)
                        .ok_or(PolicyError::TooManyPolicies)?;
                    if update_roles.insert(role.clone(), policy).is_some() {
                        return Err(PolicyError::DuplicatePolicy);
                    }
                }
                if let Some(raw_delete) = delete {
                    let policy = activate_delete(raw_delete, resource, next_policy_id)?;
                    next_policy_id = next_policy_id
                        .checked_add(1)
                        .ok_or(PolicyError::TooManyPolicies)?;
                    if delete_roles.insert(role, policy).is_some() {
                        return Err(PolicyError::DuplicatePolicy);
                    }
                }
            }
            if select.insert(resource.id, select_roles).is_some()
                || insert_policies.insert(resource.id, insert_roles).is_some()
                || update_policies.insert(resource.id, update_roles).is_some()
                || delete_policies.insert(resource.id, delete_roles).is_some()
            {
                return Err(PolicyError::DuplicatePolicy);
            }
        }
        Ok(Self {
            snapshot,
            select,
            insert: insert_policies,
            update: update_policies,
            delete: delete_policies,
            commit_checks,
        })
    }

    #[must_use]
    pub fn snapshot(&self) -> &SnapshotId {
        &self.snapshot
    }

    #[must_use]
    pub fn commit_checks(&self) -> &[ActivatedCommitCheck] {
        &self.commit_checks
    }

    /// Applies the selected row/column policy to a bound statement.
    ///
    /// # Errors
    ///
    /// Missing policy, forbidden columns, missing session values, and type mismatches fail closed.
    #[allow(clippy::too_many_lines)]
    pub fn compile_select(
        &self,
        statement: &BoundStatement,
        session: &TrustedSession,
    ) -> Result<CompileOutput, PolicyError> {
        if let BoundStatement::ConstantSelect(select) = statement {
            return Ok(CompileOutput {
                plan: ProtectedPlan {
                    statement: BoundStatement::ConstantSelect(select.clone()),
                    applied_policies: Vec::new(),
                    server_values: BTreeMap::new(),
                    policy_limit: None,
                    operation_check: None,
                    expected_affected_rows: None,
                    expected_result_rows: None,
                },
                explain: Explain {
                    operation: OperationKind::Select,
                    resource: None,
                    resources: Vec::new(),
                    referenced_columns: BTreeMap::new(),
                    applied_policies: Vec::new(),
                    policy_limit: None,
                },
            });
        }
        if let BoundStatement::JsonCollectionSelect(select) = statement {
            return self.compile_json_collection_select(select, statement, session);
        }
        let BoundStatement::Select(select) = statement else {
            return Err(PolicyError::UnsupportedCapability);
        };
        let (resource_ids, selected) = self.select_policies(select, session.role())?;
        let mut protected = select.as_ref().clone();
        let mut server_values = BTreeMap::new();
        apply_projection_permissions(
            &mut protected.projections,
            &selected,
            session,
            &mut server_values,
        )?;
        let left_resources = protected
            .joins
            .iter()
            .filter(|join| join.kind == policysql_ir::JoinKind::Left)
            .map(|join| join.resource)
            .collect::<BTreeSet<_>>();
        for projection in &protected.projections {
            if let BoundExpr::ConditionalOutput { value, .. } = &projection.expression {
                let BoundExpr::Column(column) = value.as_ref() else {
                    return Err(PolicyError::ForbiddenColumnContext);
                };
                if left_resources.contains(&column.id.resource()) {
                    return Err(PolicyError::ForbiddenColumnContext);
                }
            }
        }
        let regular_columns = selected
            .values()
            .flat_map(|policy| policy.regular_columns.iter().copied())
            .collect::<BTreeSet<_>>();
        if let Some(predicate) = &protected.predicate {
            validate_client_expression(predicate, &regular_columns)?;
        }
        for order in &protected.order_by {
            validate_client_expression(&order.expression, &regular_columns)?;
        }
        for column in &protected.group_by {
            if !regular_columns.contains(&column.id) {
                return Err(PolicyError::ForbiddenColumn);
            }
        }
        if let Some(having) = &protected.having {
            validate_client_expression(having, &regular_columns)?;
        }
        for projection in &protected.projections {
            match &projection.expression {
                BoundExpr::CountAll(resource) => {
                    let policy = selected.get(resource).ok_or(PolicyError::MissingPolicy)?;
                    if !policy.allow_aggregations {
                        return Err(PolicyError::UnsupportedCapability);
                    }
                }
                BoundExpr::RowNumber {
                    resource,
                    partition_by,
                    order_by,
                } => {
                    let policy = selected.get(resource).ok_or(PolicyError::MissingPolicy)?;
                    if !policy.allow_windows
                        || partition_by
                            .iter()
                            .any(|column| !regular_columns.contains(&column.id))
                        || order_by.iter().any(|order| {
                            validate_client_expression(&order.expression, &regular_columns).is_err()
                        })
                    {
                        return Err(PolicyError::UnsupportedCapability);
                    }
                }
                BoundExpr::ScalarFunction { .. }
                | BoundExpr::Concat(_, _)
                | BoundExpr::CastText(_)
                | BoundExpr::Case { .. } => {
                    validate_client_expression(&projection.expression, &regular_columns)?;
                }
                _ => {}
            }
        }
        for join in &protected.joins {
            validate_client_expression(&join.on, &regular_columns)?;
        }
        if let Some(predicate) = &mut protected.predicate {
            protect_nested_selects(predicate, &selected, session, &mut server_values)?;
        }

        let root = selected
            .get(&protected.resource)
            .ok_or(PolicyError::MissingPolicy)?;
        let root_filter = instantiate_predicate(&root.filter, session, &mut server_values)?;
        protected.predicate = Some(and_optional(protected.predicate.take(), root_filter));
        for join in &mut protected.joins {
            let policy = selected
                .get(&join.resource)
                .ok_or(PolicyError::MissingPolicy)?;
            let filter = instantiate_predicate(&policy.filter, session, &mut server_values)?;
            match join.kind {
                policysql_ir::JoinKind::Inner => {
                    protected.predicate = Some(and_optional(protected.predicate.take(), filter));
                }
                policysql_ir::JoinKind::Left => {
                    join.on = BoundExpr::And(Box::new(join.on.clone()), Box::new(filter));
                }
            }
        }
        let policy_limit = selected.values().filter_map(|policy| policy.limit).min();
        apply_policy_limit(&mut protected, policy_limit);
        let applied_policies = resource_ids
            .iter()
            .filter_map(|resource| selected.get(resource).map(|policy| policy.id))
            .collect::<Vec<_>>();

        Ok(CompileOutput {
            plan: ProtectedPlan {
                statement: BoundStatement::Select(Box::new(protected)),
                applied_policies: applied_policies.clone(),
                server_values,
                policy_limit,
                operation_check: None,
                expected_affected_rows: None,
                expected_result_rows: None,
            },
            explain: Explain {
                operation: OperationKind::Select,
                resource: Some(select.resource),
                resources: resource_ids,
                referenced_columns: referenced_columns(statement),
                applied_policies,
                policy_limit,
            },
        })
    }

    fn compile_json_collection_select(
        &self,
        select: &BoundJsonCollectionSelect,
        original: &BoundStatement,
        session: &TrustedSession,
    ) -> Result<CompileOutput, PolicyError> {
        let policy = self
            .select
            .get(&select.resource)
            .and_then(|roles| roles.get(session.role()))
            .ok_or(PolicyError::MissingPolicy)?;
        if !policy.allow_aggregations || !policy.regular_columns.contains(&select.document.id) {
            return Err(PolicyError::UnsupportedCapability);
        }
        if let Some(predicate) = &select.predicate {
            validate_client_expression(predicate, &policy.regular_columns)?;
        }
        let mut protected = select.clone();
        let mut server_values = BTreeMap::new();
        let filter = instantiate_predicate(&policy.filter, session, &mut server_values)?;
        protected.predicate = Some(and_optional(protected.predicate.take(), filter));
        Ok(CompileOutput {
            plan: ProtectedPlan {
                statement: BoundStatement::JsonCollectionSelect(protected),
                applied_policies: vec![policy.id],
                server_values,
                policy_limit: None,
                operation_check: None,
                expected_affected_rows: None,
                expected_result_rows: Some(1),
            },
            explain: Explain {
                operation: OperationKind::Select,
                resource: Some(select.resource),
                resources: vec![select.resource],
                referenced_columns: referenced_columns(original),
                applied_policies: vec![policy.id],
                policy_limit: None,
            },
        })
    }

    /// Applies caller-column, preset, and post-state rules to `INSERT VALUES`.
    ///
    /// # Errors
    ///
    /// Missing policy, caller/preset overlap, missing session values, and type errors deny.
    pub fn compile_insert(
        &self,
        statement: &BoundStatement,
        session: &TrustedSession,
    ) -> Result<CompileOutput, PolicyError> {
        let BoundStatement::Insert(insert) = statement else {
            return Err(PolicyError::UnsupportedCapability);
        };
        let policy = self
            .insert
            .get(&insert.resource)
            .and_then(|roles| roles.get(session.role()))
            .ok_or(PolicyError::MissingPolicy)?;
        let mut protected = insert.clone();
        validate_returning(&protected.returning, &policy.returning)?;
        let mut server_values = BTreeMap::new();
        for row in &mut protected.rows {
            for assignment in row.iter() {
                if !policy.columns.contains(&assignment.column.id)
                    || policy.presets.contains_key(&assignment.column.id)
                {
                    return Err(PolicyError::ForbiddenColumn);
                }
            }
            for (column_id, (logical_type, operand)) in &policy.presets {
                row.push(BoundAssignment {
                    column: BoundColumn {
                        id: *column_id,
                        logical_type: *logical_type,
                        usage: ColumnUsage::Write,
                    },
                    value: instantiate_operand(
                        operand,
                        *logical_type,
                        session,
                        &mut server_values,
                    )?,
                });
            }
        }
        let check = instantiate_predicate(&policy.check, session, &mut server_values)?;
        let expected_affected_rows = u64::try_from(protected.rows.len())
            .map_err(|_| PolicyError::InvariantViolation("too many INSERT rows".to_owned()))?;
        Ok(CompileOutput {
            plan: ProtectedPlan {
                statement: BoundStatement::Insert(protected),
                applied_policies: vec![policy.id],
                server_values,
                policy_limit: None,
                operation_check: Some(check),
                expected_affected_rows: Some(expected_affected_rows),
                expected_result_rows: None,
            },
            explain: Explain {
                operation: OperationKind::Insert,
                resource: Some(insert.resource),
                resources: vec![insert.resource],
                referenced_columns: referenced_columns(statement),
                applied_policies: vec![policy.id],
                policy_limit: None,
            },
        })
    }

    /// Applies write-column, row-filter, preset, post-state, and RETURNING rules.
    ///
    /// # Errors
    ///
    /// Denies missing policies, forbidden columns, invalid session values, and wrong statements.
    pub fn compile_update(
        &self,
        statement: &BoundStatement,
        session: &TrustedSession,
    ) -> Result<CompileOutput, PolicyError> {
        let BoundStatement::Update(update) = statement else {
            return Err(PolicyError::UnsupportedCapability);
        };
        let policy = self
            .update
            .get(&update.resource)
            .and_then(|roles| roles.get(session.role()))
            .ok_or(PolicyError::MissingPolicy)?;
        let mut protected = update.clone();
        validate_returning(&protected.returning, &policy.returning)?;
        let mut server_values = BTreeMap::new();
        for assignment in &protected.assignments {
            if !policy.columns.contains(&assignment.column.id)
                || policy.presets.contains_key(&assignment.column.id)
            {
                return Err(PolicyError::ForbiddenColumn);
            }
        }
        for (column_id, (logical_type, operand)) in &policy.presets {
            protected.assignments.push(BoundAssignment {
                column: BoundColumn {
                    id: *column_id,
                    logical_type: *logical_type,
                    usage: ColumnUsage::Write,
                },
                value: instantiate_operand(operand, *logical_type, session, &mut server_values)?,
            });
        }
        let filter = instantiate_predicate(&policy.filter, session, &mut server_values)?;
        protected.predicate = Some(and_optional(protected.predicate.take(), filter));
        let check = instantiate_predicate(&policy.check, session, &mut server_values)?;
        Ok(CompileOutput {
            plan: ProtectedPlan {
                statement: BoundStatement::Update(protected),
                applied_policies: vec![policy.id],
                server_values,
                policy_limit: None,
                operation_check: Some(check),
                expected_affected_rows: None,
                expected_result_rows: None,
            },
            explain: Explain {
                operation: OperationKind::Update,
                resource: Some(update.resource),
                resources: vec![update.resource],
                referenced_columns: referenced_columns(statement),
                applied_policies: vec![policy.id],
                policy_limit: None,
            },
        })
    }

    /// Applies the row-filter and independently authorized RETURNING rules to DELETE.
    ///
    /// # Errors
    ///
    /// Denies missing policies, forbidden RETURNING columns, and invalid session values.
    pub fn compile_delete(
        &self,
        statement: &BoundStatement,
        session: &TrustedSession,
    ) -> Result<CompileOutput, PolicyError> {
        let BoundStatement::Delete(delete) = statement else {
            return Err(PolicyError::UnsupportedCapability);
        };
        let policy = self
            .delete
            .get(&delete.resource)
            .and_then(|roles| roles.get(session.role()))
            .ok_or(PolicyError::MissingPolicy)?;
        let mut protected = delete.clone();
        validate_returning(&protected.returning, &policy.returning)?;
        let mut server_values = BTreeMap::new();
        let filter = instantiate_predicate(&policy.filter, session, &mut server_values)?;
        protected.predicate = Some(and_optional(protected.predicate.take(), filter));
        Ok(CompileOutput {
            plan: ProtectedPlan {
                statement: BoundStatement::Delete(protected),
                applied_policies: vec![policy.id],
                server_values,
                policy_limit: None,
                operation_check: None,
                expected_affected_rows: None,
                expected_result_rows: None,
            },
            explain: Explain {
                operation: OperationKind::Delete,
                resource: Some(delete.resource),
                resources: vec![delete.resource],
                referenced_columns: referenced_columns(statement),
                applied_policies: vec![policy.id],
                policy_limit: None,
            },
        })
    }

    fn select_policies<'a>(
        &'a self,
        select: &BoundSelect,
        role: &RoleName,
    ) -> Result<
        (
            Vec<policysql_core::ResourceId>,
            BTreeMap<policysql_core::ResourceId, &'a SelectPolicy>,
        ),
        PolicyError,
    > {
        let mut resources = vec![select.resource];
        resources.extend(select.joins.iter().map(|join| join.resource));
        if let Some(predicate) = &select.predicate {
            collect_expression_resources(predicate, &mut resources);
        }
        resources.sort_unstable();
        resources.dedup();
        let selected = resources
            .iter()
            .map(|resource| {
                self.select
                    .get(resource)
                    .and_then(|roles| roles.get(role))
                    .map(|policy| (*resource, policy))
                    .ok_or(PolicyError::MissingPolicy)
            })
            .collect::<Result<_, _>>()?;
        Ok((resources, selected))
    }
}

fn activate_commit_checks(
    raw: BTreeMap<String, RawCommitCheck>,
    catalog: &Catalog,
) -> Result<Vec<ActivatedCommitCheck>, PolicyError> {
    if raw.len() > MAX_COMMIT_CHECKS {
        return Err(PolicyError::InvalidBundle);
    }
    raw.into_iter()
        .map(|(id, check)| {
            RoleName::new(&id).map_err(|_| PolicyError::InvalidBundle)?;
            if check.triggered_by.is_empty()
                || check.hook.timeout_ms == 0
                || check.hook.timeout_ms > MAX_COMMIT_CHECK_TIMEOUT_MS
                || !environment_key(&check.hook.url_env)
                || !environment_key(&check.hook.hmac_secret_env)
            {
                return Err(PolicyError::InvalidBundle);
            }
            let triggered_by = check
                .triggered_by
                .into_iter()
                .map(|name| {
                    catalog
                        .resource(&name)
                        .map(|resource| resource.id)
                        .ok_or(PolicyError::UnknownResource)
                })
                .collect::<Result<BTreeSet<_>, _>>()?;
            let role = check
                .role
                .map(RoleName::new)
                .transpose()
                .map_err(|_| PolicyError::InvalidRole)?;
            Ok(ActivatedCommitCheck {
                id,
                triggered_by,
                role,
                url_env: check.hook.url_env,
                timeout_ms: check.hook.timeout_ms,
                hmac_secret_env: check.hook.hmac_secret_env,
            })
        })
        .collect()
}

fn environment_key(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some('A'..='Z' | '_'))
        && characters.all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

fn activate_select(
    raw: RawSelect,
    resource: &ResourceDescriptor,
    policy_id: u64,
) -> Result<SelectPolicy, PolicyError> {
    if raw.columns.is_empty() {
        return Err(PolicyError::InvalidBundle);
    }
    let mut names = BTreeSet::new();
    let mut regular_columns = BTreeSet::new();
    let mut conditional_columns = BTreeMap::new();
    for raw_column in raw.columns {
        match raw_column {
            RawColumn::Regular(name) => {
                let column = policy_column(resource, &name, ColumnUsage::Projection)?;
                if !names.insert(column.id) {
                    return Err(PolicyError::DuplicateColumnPermission);
                }
                regular_columns.insert(column.id);
            }
            RawColumn::Conditional {
                name,
                visible_if,
                on_deny,
            } => {
                if !matches!(on_deny, Value::Null) {
                    return Err(PolicyError::UnsupportedRedaction);
                }
                let column = policy_column(resource, &name, ColumnUsage::Projection)?;
                if resource
                    .column(&name)
                    .is_some_and(|descriptor| descriptor.value.nullable)
                {
                    return Err(PolicyError::UnsupportedRedaction);
                }
                if !names.insert(column.id) {
                    return Err(PolicyError::DuplicateColumnPermission);
                }
                let predicate = parse_predicate(&visible_if, resource)?;
                conditional_columns.insert(column.id, predicate);
            }
        }
    }
    Ok(SelectPolicy {
        id: PolicyId::new(policy_id).map_err(|_| PolicyError::TooManyPolicies)?,
        regular_columns,
        conditional_columns,
        filter: parse_predicate(&raw.filter, resource)?,
        limit: raw.limit,
        allow_aggregations: raw.allow_aggregations,
        allow_windows: raw.allow_windows,
    })
}

fn activate_insert(
    raw: RawInsert,
    resource: &ResourceDescriptor,
    policy_id: u64,
) -> Result<InsertPolicy, PolicyError> {
    if raw.columns.is_empty() {
        return Err(PolicyError::UnsupportedCapability);
    }
    let mut columns = BTreeSet::new();
    for name in raw.columns {
        let column = resource.column(&name).ok_or(PolicyError::UnknownColumn)?;
        if !columns.insert(column.id) {
            return Err(PolicyError::DuplicateColumnPermission);
        }
    }
    let mut presets = BTreeMap::new();
    for (name, value) in raw.presets {
        let column = resource.column(&name).ok_or(PolicyError::UnknownColumn)?;
        if columns.contains(&column.id) {
            return Err(PolicyError::PresetColumnOverlap);
        }
        let operand = parse_operand(&value, resource, column.value.logical_type)?;
        if matches!(operand, PolicyOperand::Column(_)) {
            return Err(PolicyError::InvalidPredicate);
        }
        presets.insert(column.id, (column.value.logical_type, operand));
    }
    Ok(InsertPolicy {
        id: PolicyId::new(policy_id).map_err(|_| PolicyError::TooManyPolicies)?,
        columns,
        presets,
        check: parse_predicate(&raw.check, resource)?,
        returning: activate_returning(raw.returning, resource)?,
    })
}

fn activate_update(
    raw: RawUpdate,
    resource: &ResourceDescriptor,
    policy_id: u64,
) -> Result<UpdatePolicy, PolicyError> {
    if raw.columns.is_empty() {
        return Err(PolicyError::UnsupportedCapability);
    }
    let mut columns = BTreeSet::new();
    for name in raw.columns {
        let column = resource.column(&name).ok_or(PolicyError::UnknownColumn)?;
        if !columns.insert(column.id) {
            return Err(PolicyError::DuplicateColumnPermission);
        }
    }
    let mut presets = BTreeMap::new();
    for (name, value) in raw.presets {
        let column = resource.column(&name).ok_or(PolicyError::UnknownColumn)?;
        if columns.contains(&column.id) {
            return Err(PolicyError::PresetColumnOverlap);
        }
        let operand = parse_operand(&value, resource, column.value.logical_type)?;
        if matches!(operand, PolicyOperand::Column(_)) {
            return Err(PolicyError::InvalidPredicate);
        }
        presets.insert(column.id, (column.value.logical_type, operand));
    }
    Ok(UpdatePolicy {
        id: PolicyId::new(policy_id).map_err(|_| PolicyError::TooManyPolicies)?,
        columns,
        presets,
        filter: parse_predicate(&raw.filter, resource)?,
        check: parse_predicate(&raw.check, resource)?,
        returning: activate_returning(raw.returning, resource)?,
    })
}

fn activate_delete(
    raw: RawDelete,
    resource: &ResourceDescriptor,
    policy_id: u64,
) -> Result<DeletePolicy, PolicyError> {
    Ok(DeletePolicy {
        id: PolicyId::new(policy_id).map_err(|_| PolicyError::TooManyPolicies)?,
        filter: parse_predicate(&raw.filter, resource)?,
        returning: activate_returning(raw.returning, resource)?,
    })
}

fn activate_returning(
    raw: Option<RawReturning>,
    resource: &ResourceDescriptor,
) -> Result<BTreeSet<ColumnId>, PolicyError> {
    let Some(raw) = raw else {
        return Ok(BTreeSet::new());
    };
    if raw.columns.is_empty() {
        return Err(PolicyError::InvalidBundle);
    }
    let mut columns = BTreeSet::new();
    for name in raw.columns {
        let column = resource.column(&name).ok_or(PolicyError::UnknownColumn)?;
        if !columns.insert(column.id) {
            return Err(PolicyError::DuplicateColumnPermission);
        }
    }
    Ok(columns)
}

fn validate_returning(
    returning: &[BoundProjection],
    allowed: &BTreeSet<ColumnId>,
) -> Result<(), PolicyError> {
    for projection in returning {
        let BoundExpr::Column(column) = &projection.expression else {
            return Err(PolicyError::ForbiddenColumnContext);
        };
        if !allowed.contains(&column.id) {
            return Err(PolicyError::ForbiddenColumn);
        }
    }
    Ok(())
}

fn parse_predicate(
    value: &Value,
    resource: &ResourceDescriptor,
) -> Result<PolicyPredicate, PolicyError> {
    let mapping = value.as_mapping().ok_or(PolicyError::InvalidPredicate)?;
    if mapping.len() != 1 {
        return Err(PolicyError::InvalidPredicate);
    }
    let (key, body) = mapping.iter().next().ok_or(PolicyError::InvalidPredicate)?;
    let key = key.as_str().ok_or(PolicyError::InvalidPredicate)?;
    match key {
        "and" | "or" => {
            let values = body.as_sequence().ok_or(PolicyError::InvalidPredicate)?;
            if values.is_empty() {
                return Err(PolicyError::InvalidPredicate);
            }
            let predicates = values
                .iter()
                .map(|value| parse_predicate(value, resource))
                .collect::<Result<Vec<_>, _>>()?;
            if key == "and" {
                Ok(PolicyPredicate::And(predicates))
            } else {
                Ok(PolicyPredicate::Or(predicates))
            }
        }
        "not" => Ok(PolicyPredicate::Not(Box::new(parse_predicate(
            body, resource,
        )?))),
        column_name => parse_comparison(column_name, body, resource),
    }
}

fn parse_comparison(
    column_name: &str,
    value: &Value,
    resource: &ResourceDescriptor,
) -> Result<PolicyPredicate, PolicyError> {
    let column = policy_column(resource, column_name, ColumnUsage::PolicyFilter)?;
    let mapping = value.as_mapping().ok_or(PolicyError::InvalidPredicate)?;
    if mapping.len() != 1 {
        return Err(PolicyError::InvalidPredicate);
    }
    let (operator, operand) = mapping.iter().next().ok_or(PolicyError::InvalidPredicate)?;
    let operator = operator.as_str().ok_or(PolicyError::InvalidPredicate)?;
    match operator {
        "is_null" => Ok(PolicyPredicate::IsNull {
            column,
            is_null: operand.as_bool().ok_or(PolicyError::InvalidPredicate)?,
        }),
        "in" | "not_in" => {
            let values = operand.as_sequence().ok_or(PolicyError::InvalidPredicate)?;
            if values.is_empty() {
                return Err(PolicyError::InvalidPredicate);
            }
            let values = values
                .iter()
                .map(|value| literal_for_type(value, column.logical_type))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(PolicyPredicate::In {
                column,
                values,
                negated: operator == "not_in",
            })
        }
        _ => {
            let operator = match operator {
                "eq" => ComparisonOperator::Equal,
                "neq" => ComparisonOperator::NotEqual,
                "lt" => ComparisonOperator::Less,
                "lte" => ComparisonOperator::LessEqual,
                "gt" => ComparisonOperator::Greater,
                "gte" => ComparisonOperator::GreaterEqual,
                "like" => ComparisonOperator::Like,
                _ => return Err(PolicyError::UnknownOperator),
            };
            if operator == ComparisonOperator::Like && column.logical_type != LogicalType::String {
                return Err(PolicyError::IncompatibleOperand);
            }
            Ok(PolicyPredicate::Comparison {
                operand: parse_operand(operand, resource, column.logical_type)?,
                column,
                operator,
            })
        }
    }
}

fn parse_operand(
    value: &Value,
    resource: &ResourceDescriptor,
    expected: LogicalType,
) -> Result<PolicyOperand, PolicyError> {
    if let Some(mapping) = value.as_mapping() {
        if mapping.len() != 1 {
            return Err(PolicyError::InvalidPredicate);
        }
        if let Some(session) = mapping_value(mapping, "session") {
            if expected != LogicalType::String {
                return Err(PolicyError::IncompatibleOperand);
            }
            return Ok(PolicyOperand::Session(
                SessionKey::new(session.as_str().ok_or(PolicyError::InvalidPredicate)?)
                    .map_err(|_| PolicyError::InvalidPredicate)?,
            ));
        }
        if let Some(column_name) = mapping_value(mapping, "column") {
            let column_name = column_name.as_str().ok_or(PolicyError::InvalidPredicate)?;
            let column = policy_column(resource, column_name, ColumnUsage::PolicyFilter)?;
            if column.logical_type != expected {
                return Err(PolicyError::IncompatibleOperand);
            }
            return Ok(PolicyOperand::Column(column));
        }
        if let Some(literal) = mapping_value(mapping, "literal") {
            return Ok(PolicyOperand::Literal(literal_for_type(literal, expected)?));
        }
        return Err(PolicyError::InvalidPredicate);
    }
    Ok(PolicyOperand::Literal(literal_for_type(value, expected)?))
}

fn mapping_value<'a>(mapping: &'a Mapping, key: &str) -> Option<&'a Value> {
    mapping.get(Value::String(key.to_owned()))
}

fn literal_for_type(value: &Value, expected: LogicalType) -> Result<LogicalValue, PolicyError> {
    if value.is_null() {
        return Err(PolicyError::NullComparison);
    }
    match expected {
        LogicalType::String | LogicalType::Date | LogicalType::DateTime | LogicalType::Instant => {
            value
                .as_str()
                .map(|value| LogicalValue::String(value.to_owned()))
                .ok_or(PolicyError::IncompatibleOperand)
        }
        LogicalType::Boolean => value
            .as_bool()
            .map(LogicalValue::Boolean)
            .ok_or(PolicyError::IncompatibleOperand),
        LogicalType::Integer | LogicalType::Int64 => value
            .as_i64()
            .map(LogicalValue::Int64)
            .ok_or(PolicyError::IncompatibleOperand),
        LogicalType::Number => value
            .as_f64()
            .map(LogicalValue::Number)
            .ok_or(PolicyError::IncompatibleOperand),
        LogicalType::Bytes | LogicalType::Json => Err(PolicyError::UnsupportedCapability),
    }
}

fn policy_column(
    resource: &ResourceDescriptor,
    name: &str,
    usage: ColumnUsage,
) -> Result<BoundColumn, PolicyError> {
    let column = resource.column(name).ok_or(PolicyError::UnknownColumn)?;
    Ok(bound_policy_column(column, usage))
}

fn bound_policy_column(column: &ColumnDescriptor, usage: ColumnUsage) -> BoundColumn {
    BoundColumn {
        id: column.id,
        logical_type: column.value.logical_type,
        usage,
    }
}

fn apply_projection_permissions(
    projections: &mut [BoundProjection],
    policies: &BTreeMap<policysql_core::ResourceId, &SelectPolicy>,
    session: &TrustedSession,
    server_values: &mut BTreeMap<ServerParameterName, LogicalValue>,
) -> Result<(), PolicyError> {
    for projection in projections {
        let column = match &projection.expression {
            BoundExpr::Column(column) => column,
            BoundExpr::CountAll(_)
            | BoundExpr::RowNumber { .. }
            | BoundExpr::ScalarFunction { .. }
            | BoundExpr::Concat(_, _)
            | BoundExpr::CastText(_)
            | BoundExpr::Case { .. } => continue,
            _ => return Err(PolicyError::ForbiddenColumnContext),
        };
        let policy = policies
            .get(&column.id.resource())
            .ok_or(PolicyError::MissingPolicy)?;
        if policy.regular_columns.contains(&column.id) {
            continue;
        }
        let visible_if = policy
            .conditional_columns
            .get(&column.id)
            .ok_or(PolicyError::ForbiddenColumn)?;
        projection.expression = BoundExpr::ConditionalOutput {
            value: Box::new(projection.expression.clone()),
            visible_if: Box::new(instantiate_predicate(visible_if, session, server_values)?),
        };
    }
    Ok(())
}

fn and_optional(current: Option<BoundExpr>, required: BoundExpr) -> BoundExpr {
    match current {
        Some(current) => BoundExpr::And(Box::new(current), Box::new(required)),
        None => required,
    }
}

fn validate_client_expression(
    expression: &BoundExpr,
    allowed: &BTreeSet<ColumnId>,
) -> Result<(), PolicyError> {
    match expression {
        BoundExpr::Column(column) => {
            if allowed.contains(&column.id) {
                Ok(())
            } else {
                Err(PolicyError::ForbiddenColumn)
            }
        }
        BoundExpr::ClientParameter { .. }
        | BoundExpr::ServerParameter { .. }
        | BoundExpr::Literal(_)
        | BoundExpr::CountAll(_) => Ok(()),
        BoundExpr::RowNumber {
            partition_by,
            order_by,
            ..
        } => {
            for column in partition_by {
                validate_client_expression(&BoundExpr::Column(column.clone()), allowed)?;
            }
            for order in order_by {
                validate_client_expression(&order.expression, allowed)?;
            }
            Ok(())
        }
        BoundExpr::ScalarFunction { arguments, .. } => {
            for argument in arguments {
                validate_client_expression(argument, allowed)?;
            }
            Ok(())
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
        | BoundExpr::Concat(left, right) => {
            validate_client_expression(left, allowed)?;
            validate_client_expression(right, allowed)
        }
        BoundExpr::Not(inner) | BoundExpr::IsNull(inner) | BoundExpr::CastText(inner) => {
            validate_client_expression(inner, allowed)
        }
        BoundExpr::In {
            expression, values, ..
        } => {
            validate_client_expression(expression, allowed)?;
            for value in values {
                validate_client_expression(value, allowed)?;
            }
            Ok(())
        }
        BoundExpr::ConditionalOutput { .. } => Err(PolicyError::ForbiddenColumnContext),
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => {
            for (condition, value) in branches {
                validate_client_expression(condition, allowed)?;
                validate_client_expression(value, allowed)?;
            }
            if let Some(value) = else_expression {
                validate_client_expression(value, allowed)?;
            }
            Ok(())
        }
        BoundExpr::Exists(select) => {
            for projection in &select.projections {
                validate_client_expression(&projection.expression, allowed)?;
            }
            if let Some(predicate) = &select.predicate {
                validate_client_expression(predicate, allowed)?;
            }
            Ok(())
        }
    }
}

fn collect_expression_resources(
    expression: &BoundExpr,
    resources: &mut Vec<policysql_core::ResourceId>,
) {
    match expression {
        BoundExpr::Exists(select) => {
            resources.push(select.resource);
            for projection in &select.projections {
                collect_expression_resources(&projection.expression, resources);
            }
            if let Some(predicate) = &select.predicate {
                collect_expression_resources(predicate, resources);
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
            collect_expression_resources(left, resources);
            collect_expression_resources(right, resources);
        }
        BoundExpr::Not(inner) | BoundExpr::IsNull(inner) | BoundExpr::CastText(inner) => {
            collect_expression_resources(inner, resources);
        }
        BoundExpr::ScalarFunction { arguments, .. } => {
            for argument in arguments {
                collect_expression_resources(argument, resources);
            }
        }
        BoundExpr::In {
            expression, values, ..
        } => {
            collect_expression_resources(expression, resources);
            for value in values {
                collect_expression_resources(value, resources);
            }
        }
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => {
            for (condition, value) in branches {
                collect_expression_resources(condition, resources);
                collect_expression_resources(value, resources);
            }
            if let Some(value) = else_expression {
                collect_expression_resources(value, resources);
            }
        }
        BoundExpr::Column(_)
        | BoundExpr::ClientParameter { .. }
        | BoundExpr::ServerParameter { .. }
        | BoundExpr::Literal(_)
        | BoundExpr::CountAll(_) => {}
        BoundExpr::RowNumber { resource, .. } => resources.push(*resource),
    }
}

fn protect_nested_selects(
    expression: &mut BoundExpr,
    policies: &BTreeMap<policysql_core::ResourceId, &SelectPolicy>,
    session: &TrustedSession,
    server_values: &mut BTreeMap<ServerParameterName, LogicalValue>,
) -> Result<(), PolicyError> {
    match expression {
        BoundExpr::Exists(select) => {
            if let Some(predicate) = &mut select.predicate {
                protect_nested_selects(predicate, policies, session, server_values)?;
            }
            let policy = policies
                .get(&select.resource)
                .ok_or(PolicyError::MissingPolicy)?;
            let filter = instantiate_predicate(&policy.filter, session, server_values)?;
            select.predicate = Some(and_optional(select.predicate.take(), filter));
            apply_policy_limit(select, policy.limit);
            Ok(())
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
            protect_nested_selects(left, policies, session, server_values)?;
            protect_nested_selects(right, policies, session, server_values)
        }
        BoundExpr::Not(inner) | BoundExpr::IsNull(inner) | BoundExpr::CastText(inner) => {
            protect_nested_selects(inner, policies, session, server_values)
        }
        BoundExpr::ScalarFunction { arguments, .. } => {
            for argument in arguments {
                protect_nested_selects(argument, policies, session, server_values)?;
            }
            Ok(())
        }
        BoundExpr::In {
            expression, values, ..
        } => {
            protect_nested_selects(expression, policies, session, server_values)?;
            for value in values {
                protect_nested_selects(value, policies, session, server_values)?;
            }
            Ok(())
        }
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => {
            for (condition, value) in branches {
                protect_nested_selects(condition, policies, session, server_values)?;
                protect_nested_selects(value, policies, session, server_values)?;
            }
            if let Some(value) = else_expression {
                protect_nested_selects(value, policies, session, server_values)?;
            }
            Ok(())
        }
        BoundExpr::Column(_)
        | BoundExpr::ClientParameter { .. }
        | BoundExpr::ServerParameter { .. }
        | BoundExpr::Literal(_)
        | BoundExpr::CountAll(_)
        | BoundExpr::RowNumber { .. } => Ok(()),
    }
}

fn instantiate_predicate(
    predicate: &PolicyPredicate,
    session: &TrustedSession,
    server_values: &mut BTreeMap<ServerParameterName, LogicalValue>,
) -> Result<BoundExpr, PolicyError> {
    match predicate {
        PolicyPredicate::Comparison {
            column,
            operator,
            operand,
        } => {
            let left = BoundExpr::Column(column.clone());
            let right = instantiate_operand(operand, column.logical_type, session, server_values)?;
            Ok(match operator {
                ComparisonOperator::Equal => BoundExpr::Equal(Box::new(left), Box::new(right)),
                ComparisonOperator::NotEqual => {
                    BoundExpr::NotEqual(Box::new(left), Box::new(right))
                }
                ComparisonOperator::Less => BoundExpr::Less(Box::new(left), Box::new(right)),
                ComparisonOperator::LessEqual => {
                    BoundExpr::LessEqual(Box::new(left), Box::new(right))
                }
                ComparisonOperator::Greater => BoundExpr::Greater(Box::new(left), Box::new(right)),
                ComparisonOperator::GreaterEqual => {
                    BoundExpr::GreaterEqual(Box::new(left), Box::new(right))
                }
                ComparisonOperator::Like => BoundExpr::Like(Box::new(left), Box::new(right)),
            })
        }
        PolicyPredicate::In {
            column,
            values,
            negated,
        } => Ok(BoundExpr::In {
            expression: Box::new(BoundExpr::Column(column.clone())),
            values: values.iter().cloned().map(BoundExpr::Literal).collect(),
            negated: *negated,
        }),
        PolicyPredicate::IsNull { column, is_null } => {
            let expression = BoundExpr::IsNull(Box::new(BoundExpr::Column(column.clone())));
            if *is_null {
                Ok(expression)
            } else {
                Ok(BoundExpr::Not(Box::new(expression)))
            }
        }
        PolicyPredicate::And(values) => fold_logical(values, session, server_values, true),
        PolicyPredicate::Or(values) => fold_logical(values, session, server_values, false),
        PolicyPredicate::Not(value) => Ok(BoundExpr::Not(Box::new(instantiate_predicate(
            value,
            session,
            server_values,
        )?))),
    }
}

fn fold_logical(
    values: &[PolicyPredicate],
    session: &TrustedSession,
    server_values: &mut BTreeMap<ServerParameterName, LogicalValue>,
    and: bool,
) -> Result<BoundExpr, PolicyError> {
    let mut values = values.iter();
    let first = values.next().ok_or(PolicyError::InvalidPredicate)?;
    let mut output = instantiate_predicate(first, session, server_values)?;
    for value in values {
        let next = instantiate_predicate(value, session, server_values)?;
        output = if and {
            BoundExpr::And(Box::new(output), Box::new(next))
        } else {
            BoundExpr::Or(Box::new(output), Box::new(next))
        };
    }
    Ok(output)
}

fn instantiate_operand(
    operand: &PolicyOperand,
    expected: LogicalType,
    session: &TrustedSession,
    server_values: &mut BTreeMap<ServerParameterName, LogicalValue>,
) -> Result<BoundExpr, PolicyError> {
    match operand {
        PolicyOperand::Session(key) => {
            if expected != LogicalType::String {
                return Err(PolicyError::IncompatibleOperand);
            }
            let value = session.get(key).ok_or(PolicyError::MissingSessionValue)?;
            let name =
                ServerParameterName::from_trusted_suffix(&format!("session_{}", key.as_str()))
                    .map_err(|_| PolicyError::InvalidSessionKey)?;
            server_values.insert(name.clone(), LogicalValue::String(value.to_owned()));
            Ok(BoundExpr::ServerParameter {
                name,
                logical_type: LogicalType::String,
            })
        }
        PolicyOperand::Literal(value) => Ok(BoundExpr::Literal(value.clone())),
        PolicyOperand::Column(column) => Ok(BoundExpr::Column(column.clone())),
    }
}

fn apply_policy_limit(select: &mut BoundSelect, policy_limit: Option<u64>) {
    let Some(policy_limit) = policy_limit else {
        return;
    };
    let policy_value = i64::try_from(policy_limit).unwrap_or(i64::MAX);
    let policy = BoundExpr::Literal(LogicalValue::Int64(policy_value));
    select.limit = Some(match select.limit.take() {
        Some(BoundExpr::Literal(LogicalValue::Int64(client))) => {
            BoundExpr::Literal(LogicalValue::Int64(client.min(policy_value)))
        }
        Some(client) => BoundExpr::Least(Box::new(client), Box::new(policy)),
        None => policy,
    });
}

fn referenced_columns(
    statement: &BoundStatement,
) -> BTreeMap<policysql_core::ResourceId, BTreeSet<ColumnId>> {
    let mut columns = BTreeMap::new();
    match statement {
        BoundStatement::Select(select) => collect_select_columns(select, &mut columns),
        BoundStatement::ConstantSelect(_) => {}
        BoundStatement::JsonCollectionSelect(select) => {
            add_column(select.document.id, &mut columns);
            collect_expression_columns(&select.path, &mut columns);
            if let Some(predicate) = &select.predicate {
                collect_expression_columns(predicate, &mut columns);
            }
        }
        BoundStatement::Insert(insert) => {
            for assignment in insert.rows.iter().flatten() {
                add_column(assignment.column.id, &mut columns);
                collect_expression_columns(&assignment.value, &mut columns);
            }
            collect_projection_columns(&insert.returning, &mut columns);
        }
        BoundStatement::Update(update) => {
            for assignment in &update.assignments {
                add_column(assignment.column.id, &mut columns);
                collect_expression_columns(&assignment.value, &mut columns);
            }
            if let Some(predicate) = &update.predicate {
                collect_expression_columns(predicate, &mut columns);
            }
            collect_projection_columns(&update.returning, &mut columns);
        }
        BoundStatement::Delete(delete) => {
            if let Some(predicate) = &delete.predicate {
                collect_expression_columns(predicate, &mut columns);
            }
            collect_projection_columns(&delete.returning, &mut columns);
        }
    }
    columns
}

fn collect_select_columns(
    select: &BoundSelect,
    columns: &mut BTreeMap<policysql_core::ResourceId, BTreeSet<ColumnId>>,
) {
    collect_projection_columns(&select.projections, columns);
    for join in &select.joins {
        collect_expression_columns(&join.on, columns);
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
        collect_expression_columns(expression, columns);
    }
    for column in &select.group_by {
        add_column(column.id, columns);
    }
    for order in &select.order_by {
        collect_expression_columns(&order.expression, columns);
    }
}

fn collect_projection_columns(
    projections: &[BoundProjection],
    columns: &mut BTreeMap<policysql_core::ResourceId, BTreeSet<ColumnId>>,
) {
    for projection in projections {
        collect_expression_columns(&projection.expression, columns);
    }
}

fn add_column(
    column: ColumnId,
    columns: &mut BTreeMap<policysql_core::ResourceId, BTreeSet<ColumnId>>,
) {
    columns.entry(column.resource()).or_default().insert(column);
}

fn collect_expression_columns(
    expression: &BoundExpr,
    columns: &mut BTreeMap<policysql_core::ResourceId, BTreeSet<ColumnId>>,
) {
    match expression {
        BoundExpr::Column(column) => add_column(column.id, columns),
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
            collect_expression_columns(left, columns);
            collect_expression_columns(right, columns);
        }
        BoundExpr::Not(inner) | BoundExpr::IsNull(inner) | BoundExpr::CastText(inner) => {
            collect_expression_columns(inner, columns);
        }
        BoundExpr::In {
            expression, values, ..
        } => {
            collect_expression_columns(expression, columns);
            for value in values {
                collect_expression_columns(value, columns);
            }
        }
        BoundExpr::ScalarFunction { arguments, .. } => {
            for argument in arguments {
                collect_expression_columns(argument, columns);
            }
        }
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => {
            for (condition, value) in branches {
                collect_expression_columns(condition, columns);
                collect_expression_columns(value, columns);
            }
            if let Some(value) = else_expression {
                collect_expression_columns(value, columns);
            }
        }
        BoundExpr::Exists(select) => collect_select_columns(select, columns),
        BoundExpr::RowNumber {
            partition_by,
            order_by,
            ..
        } => {
            for column in partition_by {
                add_column(column.id, columns);
            }
            for order in order_by {
                collect_expression_columns(&order.expression, columns);
            }
        }
        BoundExpr::ClientParameter { .. }
        | BoundExpr::ServerParameter { .. }
        | BoundExpr::Literal(_)
        | BoundExpr::CountAll(_) => {}
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompileOutput {
    pub plan: ProtectedPlan,
    pub explain: Explain,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Explain {
    pub operation: OperationKind,
    pub resource: Option<policysql_core::ResourceId>,
    pub resources: Vec<policysql_core::ResourceId>,
    pub referenced_columns: BTreeMap<policysql_core::ResourceId, BTreeSet<ColumnId>>,
    pub applied_policies: Vec<PolicyId>,
    pub policy_limit: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PolicyError {
    InvalidBundle,
    InvalidRole,
    UnknownResource,
    UnknownColumn,
    UnknownOperator,
    InvalidPredicate,
    IncompatibleOperand,
    NullComparison,
    UnsupportedCapability,
    UnsupportedRedaction,
    DuplicateColumnPermission,
    PresetColumnOverlap,
    DuplicatePolicy,
    TooManyPolicies,
    MissingPolicy,
    ForbiddenColumn,
    ForbiddenColumnContext,
    MissingSessionValue,
    InvalidSessionKey,
    InvariantViolation(String),
}

impl fmt::Display for PolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBundle => formatter.write_str("policy bundle is invalid"),
            Self::InvalidRole => formatter.write_str("policy role is invalid"),
            Self::UnknownResource => {
                formatter.write_str("policy references an unavailable resource")
            }
            Self::UnknownColumn => formatter.write_str("policy references an unavailable column"),
            Self::UnknownOperator => formatter.write_str("policy operator is unsupported"),
            Self::InvalidPredicate => formatter.write_str("policy predicate is invalid"),
            Self::IncompatibleOperand => formatter.write_str("policy operands are incompatible"),
            Self::NullComparison => formatter.write_str("policy NULL requires is_null"),
            Self::UnsupportedCapability => formatter.write_str("policy capability is unsupported"),
            Self::UnsupportedRedaction => {
                formatter.write_str("policy redaction action is unsupported")
            }
            Self::DuplicateColumnPermission => {
                formatter.write_str("policy column permission is duplicated")
            }
            Self::PresetColumnOverlap => formatter.write_str("preset and caller columns overlap"),
            Self::DuplicatePolicy => formatter.write_str("policy is duplicated"),
            Self::TooManyPolicies => formatter.write_str("policy bundle is too large"),
            Self::MissingPolicy => formatter.write_str("no applicable policy exists"),
            Self::ForbiddenColumn => formatter.write_str("statement references a forbidden column"),
            Self::ForbiddenColumnContext => {
                formatter.write_str("column is forbidden in this context")
            }
            Self::MissingSessionValue => {
                formatter.write_str("required trusted-session value is unavailable")
            }
            Self::InvalidSessionKey => formatter.write_str("trusted-session key is invalid"),
            Self::InvariantViolation(message) => {
                write!(formatter, "policy invariant failed: {message}")
            }
        }
    }
}

impl std::error::Error for PolicyError {}

impl From<CoreError> for PolicyError {
    fn from(_: CoreError) -> Self {
        Self::InvalidBundle
    }
}

#[cfg(test)]
mod tests {
    use super::{PolicyBundle, PolicyError};
    use policysql_catalog::{Catalog, ResourceDescriptor};
    use policysql_core::{
        ColumnName, LogicalType, ResourceId, ResourceName, RoleName, SessionKey, SnapshotId,
        TrustedSession, ValueDescriptor, ValueRepresentation,
    };
    use policysql_ir::{BoundExpr, BoundStatement};
    use policysql_parser::SqliteFrontend;
    use policysql_testkit::{
        OracleRow, OracleSession, OracleValue, TruthValue, evaluate_select_filter,
    };
    use std::collections::BTreeMap;

    fn descriptor() -> ValueDescriptor {
        ValueDescriptor {
            logical_type: LogicalType::String,
            representation: ValueRepresentation::String,
            nullable: false,
            format: None,
            storage: None,
            constraints: None,
            json_schema: None,
        }
    }

    fn catalog() -> Catalog {
        let resource = ResourceDescriptor::new(
            ResourceId::new(1).unwrap_or_else(|error| unreachable!("valid ID: {error}")),
            ResourceName::new("projects")
                .unwrap_or_else(|error| unreachable!("valid name: {error}")),
            [
                "id",
                "tenant_id",
                "name",
                "status",
                "created_by",
                "private_note",
            ]
            .map(|name| {
                (
                    ColumnName::new(name)
                        .unwrap_or_else(|error| unreachable!("valid column: {error}")),
                    descriptor(),
                )
            }),
        )
        .unwrap_or_else(|error| unreachable!("valid resource: {error}"));
        Catalog::new(
            SnapshotId::new("schema_1")
                .unwrap_or_else(|error| unreachable!("valid snapshot: {error}")),
            [resource],
        )
        .unwrap_or_else(|error| unreachable!("valid Catalog: {error}"))
    }

    fn session(role: &str) -> TrustedSession {
        TrustedSession::new(
            RoleName::new(role).unwrap_or_else(|error| unreachable!("valid role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("valid session: {error}"))
    }

    fn activate(yaml: &str) -> PolicyBundle {
        PolicyBundle::activate(
            yaml,
            &catalog(),
            SnapshotId::new("policy_1")
                .unwrap_or_else(|error| unreachable!("valid snapshot: {error}")),
        )
        .unwrap_or_else(|error| unreachable!("valid policy: {error}"))
    }

    #[test]
    fn composes_fixture_policy_with_caller_predicate_and_limit() {
        let policy = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/select/basic-row-policy/policy.yaml"
        );
        let sql = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/select/basic-row-policy/input.sql"
        );
        let statement = SqliteFrontend::default()
            .bind(sql, &catalog())
            .unwrap_or_else(|error| unreachable!("fixture binds: {error}"));
        let output = activate(policy)
            .compile_select(&statement, &session("member"))
            .unwrap_or_else(|error| unreachable!("fixture is authorized: {error}"));
        let BoundStatement::Select(select) = output.plan.statement else {
            unreachable!("compiled SELECT remains SELECT")
        };
        assert!(matches!(select.predicate, Some(BoundExpr::And(_, _))));
        assert!(matches!(select.limit, Some(BoundExpr::Least(_, _))));
        assert_eq!(output.plan.server_values.len(), 1);
        assert_eq!(output.plan.policy_limit, Some(100));
        assert_eq!(output.explain.applied_policies.len(), 1);
        assert_eq!(
            output
                .explain
                .referenced_columns
                .values()
                .map(std::collections::BTreeSet::len)
                .sum::<usize>(),
            3
        );
    }

    #[test]
    fn denies_forbidden_filter_column_and_missing_policy() {
        let policy = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/security/forbidden-filter-column/policy.yaml"
        );
        let sql = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/security/forbidden-filter-column/input.sql"
        );
        let statement = SqliteFrontend::default()
            .bind(sql, &catalog())
            .unwrap_or_else(|error| unreachable!("attack binds before policy: {error}"));
        assert_eq!(
            activate(policy).compile_select(&statement, &session("member")),
            Err(PolicyError::ForbiddenColumn)
        );
        assert_eq!(
            activate(policy).compile_select(&statement, &session("guest")),
            Err(PolicyError::MissingPolicy)
        );
    }

    #[test]
    fn conditional_column_is_projection_only_and_uses_real_session() {
        let yaml = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns:
            - id
            - name: private_note
              visible_if: { created_by: { eq: { session: subject_id } } }
              on_deny: null
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 10
";
        let statement = SqliteFrontend::default()
            .bind("SELECT id, private_note FROM projects", &catalog())
            .unwrap_or_else(|error| unreachable!("conditional projection binds: {error}"));
        let output = activate(yaml)
            .compile_select(&statement, &session("member"))
            .unwrap_or_else(|error| unreachable!("conditional projection allowed: {error}"));
        let BoundStatement::Select(select) = output.plan.statement else {
            unreachable!("compiled SELECT remains SELECT")
        };
        assert!(matches!(
            select.projections[1].expression,
            BoundExpr::ConditionalOutput { .. }
        ));
        let subject = SessionKey::new("subject_id")
            .unwrap_or_else(|error| unreachable!("valid key: {error}"));
        assert_eq!(session("member").get(&subject), Some("user_1"));
        assert_eq!(output.plan.server_values.len(), 2);
    }

    #[test]
    fn policy_activation_fails_closed_on_unknown_operator() {
        let yaml = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id]
          filter: { tenant_id: { execute_sql: true } }
";
        let result = PolicyBundle::activate(
            yaml,
            &catalog(),
            SnapshotId::new("policy_1")
                .unwrap_or_else(|error| unreachable!("valid snapshot: {error}")),
        );
        assert!(matches!(result, Err(PolicyError::UnknownOperator)));
    }

    #[test]
    fn commit_checks_are_resolved_sorted_and_fail_closed() {
        let bundle = activate(
            r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id]
          filter: { tenant_id: { eq: { session: tenant_id } } }
commit_checks:
  project_consistency:
    triggered_by: [projects]
    role: member
    hook:
      url_env: PROJECT_CHECK_URL
      timeout_ms: 1500
      hmac_secret_env: PROJECT_CHECK_SECRET
",
        );
        assert_eq!(bundle.commit_checks().len(), 1);
        assert_eq!(bundle.commit_checks()[0].id, "project_consistency");
        assert_eq!(bundle.commit_checks()[0].triggered_by.len(), 1);
        assert!(
            PolicyBundle::activate(
                r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id]
          filter: { tenant_id: { eq: { session: tenant_id } } }
commit_checks:
  bad:
    triggered_by: [missing]
    hook: { url_env: bad, timeout_ms: 0, hmac_secret_env: SECRET }
",
                &catalog(),
                SnapshotId::new("policy_2")
                    .unwrap_or_else(|error| unreachable!("valid snapshot: {error}")),
            )
            .is_err()
        );
    }

    #[test]
    fn activation_rejects_unknown_columns_mutations_and_incompatible_values() {
        for yaml in [
            r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [does_not_exist]
          filter: { tenant_id: { eq: x } }
",
            r"
version: 1
resources:
  projects:
    roles:
      member:
        insert: { columns: [id] }
",
            r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id]
          filter: { id: { eq: true } }
",
        ] {
            assert!(
                PolicyBundle::activate(
                    yaml,
                    &catalog(),
                    SnapshotId::new("policy_1")
                        .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"))
                )
                .is_err()
            );
        }
    }

    #[test]
    fn compiler_row_policy_agrees_with_independent_fixture_oracle() {
        let policy = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/select/basic-row-policy/policy.yaml"
        );
        let statement = SqliteFrontend::default()
            .bind("SELECT id FROM projects", &catalog())
            .unwrap_or_else(|error| unreachable!("fixture binds: {error}"));
        let compiled = activate(policy)
            .compile_select(&statement, &session("member"))
            .unwrap_or_else(|error| unreachable!("fixture compiles: {error}"));
        let BoundStatement::Select(select) = &compiled.plan.statement else {
            unreachable!("compiled SELECT remains SELECT")
        };
        assert!(select.predicate.is_some());

        let oracle_session = OracleSession::from([("tenant_id".to_owned(), "tenant_1".to_owned())]);
        for (tenant, expected) in [
            ("tenant_1", TruthValue::True),
            ("tenant_2", TruthValue::False),
        ] {
            let row = OracleRow::from([(
                "tenant_id".to_owned(),
                OracleValue::String(tenant.to_owned()),
            )]);
            assert_eq!(
                evaluate_select_filter(policy, "projects", "member", &row, &oracle_session),
                Ok(expected)
            );
        }
    }

    #[test]
    fn order_by_requires_regular_column_permission() {
        let policy = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id]
          filter: { tenant_id: { eq: { session: tenant_id } } }
";
        let statement = SqliteFrontend::default()
            .bind("SELECT id FROM projects ORDER BY private_note", &catalog())
            .unwrap_or_else(|error| unreachable!("ORDER BY binds before policy: {error}"));
        assert_eq!(
            activate(policy).compile_select(&statement, &session("member")),
            Err(PolicyError::ForbiddenColumn)
        );
    }
}
