//! Single bound-tree pass for client parameter analysis.
//!
//! Every consumer that needs to know which client parameters a statement uses,
//! which logical type each one has, which catalog column contracts constrain
//! it, or whether SQL NULL could ever be proved safe for it reads the result of
//! [`analyze_client_parameters`]. No other walker over client parameters
//! exists, so adding a `BoundExpr` variant or a statement field forces exactly
//! one decision here (all matches and destructurings are exhaustive).
//!
//! The nullability proof is conservative and default-deny: a parameter is
//! `nullable` only when *every* occurrence is the whole value of a direct
//! `INSERT VALUES` / `UPDATE SET` assignment to a catalog column declared
//! `nullable: true`. Any other position (comparisons, `IN`, `LIKE`/`GLOB`,
//! functions, `IS NULL`, `CASE`, projections, ordering, `LIMIT`/`OFFSET`,
//! subqueries, ...) makes it non-nullable. The proof is exposed as data only;
//! request acceptance still rejects NULL for every client parameter.

use crate::CompileError;
use policysql_catalog::Catalog;
use policysql_core::{
    ClientParameterName, LogicalType, LogicalValue, ValueDescriptor, value_satisfies_contract,
};
use policysql_ir::{
    BoundAssignment, BoundColumn, BoundConstantSelect, BoundDelete, BoundExpr, BoundInsert,
    BoundJoin, BoundJsonCollectionSelect, BoundOrder, BoundProjection, BoundSelect, BoundStatement,
    BoundUpdate,
};
use std::collections::{BTreeMap, BTreeSet};

/// Everything the compiler proves about one client parameter across all uses.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientParameterContract {
    logical_type: LogicalType,
    nullable: bool,
    columns: Vec<BoundColumn>,
}

impl ClientParameterContract {
    /// The logical type shared by every occurrence.
    #[must_use]
    pub const fn logical_type(&self) -> LogicalType {
        self.logical_type
    }

    /// `true` only when every occurrence is a direct assignment to a catalog
    /// column declared `nullable: true`.
    #[must_use]
    pub const fn nullable(&self) -> bool {
        self.nullable
    }

    /// Catalog columns whose value contract every supplied value must satisfy
    /// (column-adjacent comparisons, `IN` lists, and direct assignments).
    #[must_use]
    pub fn constraining_columns(&self) -> &[BoundColumn] {
        &self.columns
    }
}

/// Two occurrences of one client parameter were bound with different types.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClientParameterTypeConflict;

/// Result of the single client-parameter pass over a bound statement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientParameterAnalysis {
    parameters: BTreeMap<ClientParameterName, ClientParameterContract>,
    type_conflict: bool,
}

impl ClientParameterAnalysis {
    /// Every client parameter name referenced by the statement.
    #[must_use]
    pub fn names(&self) -> BTreeSet<ClientParameterName> {
        self.parameters.keys().cloned().collect()
    }

    /// Per-parameter contracts.
    ///
    /// # Errors
    ///
    /// Fails when one parameter is used with more than one logical type.
    pub const fn contracts(
        &self,
    ) -> Result<&BTreeMap<ClientParameterName, ClientParameterContract>, ClientParameterTypeConflict>
    {
        if self.type_conflict {
            Err(ClientParameterTypeConflict)
        } else {
            Ok(&self.parameters)
        }
    }
}

/// Analyzes every client parameter occurrence in `statement` in one pass.
///
/// Column identities are resolved against `catalog` only for the nullability
/// proof; an unresolvable column is never nullable. Contract validation
/// resolves the same identities again and fails closed when they are missing.
#[must_use]
pub fn analyze_client_parameters(
    statement: &BoundStatement,
    catalog: &Catalog,
) -> ClientParameterAnalysis {
    let mut visitor = Visitor {
        catalog,
        analysis: ClientParameterAnalysis {
            parameters: BTreeMap::new(),
            type_conflict: false,
        },
    };
    visitor.statement(statement);
    visitor.analysis
}

/// Validates supplied client values against the analysis: exact name set,
/// logical type, and every constraining column contract.
///
/// JSON/SQL NULL never matches a logical type here, so NULL stays rejected for
/// every client parameter regardless of the nullability proof.
pub(crate) fn validate_client_parameters(
    analysis: &ClientParameterAnalysis,
    catalog: &Catalog,
    values: &BTreeMap<ClientParameterName, LogicalValue>,
) -> Result<(), CompileError> {
    if !analysis.parameters.keys().eq(values.keys()) {
        return Err(CompileError::ClientParameterMismatch);
    }
    let contracts = analysis
        .contracts()
        .map_err(|_| CompileError::ClientParameterTypeMismatch)?;
    for (name, contract) in contracts {
        let value = values
            .get(name)
            .ok_or(CompileError::ClientParameterMismatch)?;
        if !logical_value_matches(value, contract.logical_type) {
            return Err(CompileError::ClientParameterTypeMismatch);
        }
        for column in &contract.columns {
            let descriptor = column_descriptor(catalog, column)
                .ok_or(CompileError::ClientParameterTypeMismatch)?;
            if !value_satisfies_contract(value, descriptor) {
                return Err(CompileError::ClientParameterTypeMismatch);
            }
        }
    }
    Ok(())
}

pub(crate) fn logical_value_matches(value: &LogicalValue, expected: LogicalType) -> bool {
    match (value, expected) {
        (
            LogicalValue::String(_),
            LogicalType::String | LogicalType::Date | LogicalType::DateTime | LogicalType::Instant,
        )
        | (LogicalValue::Boolean(_), LogicalType::Boolean)
        | (LogicalValue::Int64(_), LogicalType::Int64)
        | (LogicalValue::Number(_), LogicalType::Number)
        | (LogicalValue::Json(_), LogicalType::Json) => true,
        (LogicalValue::Bytes(value), LogicalType::Bytes) => {
            value.len() <= policysql_core::bytes::MAX_BYTES_PER_VALUE
        }
        (LogicalValue::Int64(value), LogicalType::Integer) => {
            *value >= -9_007_199_254_740_991 && *value <= 9_007_199_254_740_991
        }
        _ => false,
    }
}

fn column_descriptor<'a>(
    catalog: &'a Catalog,
    column: &BoundColumn,
) -> Option<&'a ValueDescriptor> {
    catalog
        .resource_by_id(column.id.resource())
        .and_then(|resource| resource.column_by_id(column.id))
        .map(|column| &column.value)
}

/// Where a client parameter occurrence sits relative to a catalog column.
#[derive(Clone, Copy)]
enum Position<'a> {
    /// The whole value of an `INSERT VALUES` / `UPDATE SET` assignment.
    Assignment(&'a BoundColumn),
    /// Directly compared with a column (`=`, `<`, `LIKE`, `IN (...)`, ...).
    Compared(&'a BoundColumn),
    /// Any other position; never nullable and not column-constrained.
    Other,
}

struct Visitor<'a> {
    catalog: &'a Catalog,
    analysis: ClientParameterAnalysis,
}

impl Visitor<'_> {
    fn statement(&mut self, statement: &BoundStatement) {
        match statement {
            BoundStatement::Select(select) => self.select(select),
            BoundStatement::ConstantSelect(BoundConstantSelect { projections }) => {
                self.projections(projections);
            }
            BoundStatement::JsonCollectionSelect(BoundJsonCollectionSelect {
                resource: _,
                alias: _,
                document: _,
                path,
                recursive: _,
                output_name: _,
                predicate,
            }) => {
                self.expr(path);
                self.optional(predicate.as_ref());
            }
            BoundStatement::Insert(BoundInsert {
                resource: _,
                rows,
                returning,
            }) => {
                for assignment in rows.iter().flatten() {
                    self.assignment(assignment);
                }
                self.projections(returning);
            }
            BoundStatement::Update(BoundUpdate {
                resource: _,
                assignments,
                predicate,
                returning,
            }) => {
                for assignment in assignments {
                    self.assignment(assignment);
                }
                self.optional(predicate.as_ref());
                self.projections(returning);
            }
            BoundStatement::Delete(BoundDelete {
                resource: _,
                predicate,
                returning,
            }) => {
                self.optional(predicate.as_ref());
                self.projections(returning);
            }
        }
    }

    fn select(&mut self, select: &BoundSelect) {
        let BoundSelect {
            resource: _,
            alias: _,
            joins,
            projections,
            predicate,
            group_by: _,
            having,
            order_by,
            limit,
            offset,
        } = select;
        self.projections(projections);
        for BoundJoin {
            resource: _,
            alias: _,
            kind: _,
            on,
        } in joins
        {
            self.expr(on);
        }
        self.optional(predicate.as_ref());
        self.optional(having.as_ref());
        self.orders(order_by);
        self.optional(limit.as_ref());
        self.optional(offset.as_ref());
    }

    fn assignment(&mut self, assignment: &BoundAssignment) {
        let BoundAssignment { column, value } = assignment;
        self.expr_at(value, Position::Assignment(column));
    }

    fn projections(&mut self, projections: &[BoundProjection]) {
        for BoundProjection {
            expression,
            output_name: _,
        } in projections
        {
            self.expr(expression);
        }
    }

    fn orders(&mut self, orders: &[BoundOrder]) {
        for BoundOrder {
            expression,
            direction: _,
        } in orders
        {
            self.expr(expression);
        }
    }

    fn optional(&mut self, expression: Option<&BoundExpr>) {
        if let Some(expression) = expression {
            self.expr(expression);
        }
    }

    fn expr(&mut self, expression: &BoundExpr) {
        self.expr_at(expression, Position::Other);
    }

    /// Compared children see the opposite side's direct column, if any.
    fn compared(&mut self, left: &BoundExpr, right: &BoundExpr) {
        self.expr_at(
            left,
            right
                .direct_column()
                .map_or(Position::Other, Position::Compared),
        );
        self.expr_at(
            right,
            left.direct_column()
                .map_or(Position::Other, Position::Compared),
        );
    }

    fn expr_at(&mut self, expression: &BoundExpr, position: Position<'_>) {
        match expression {
            BoundExpr::ClientParameter { name, logical_type } => {
                self.parameter(name, *logical_type, position);
            }
            BoundExpr::Equal(left, right)
            | BoundExpr::NotEqual(left, right)
            | BoundExpr::Less(left, right)
            | BoundExpr::LessEqual(left, right)
            | BoundExpr::Greater(left, right)
            | BoundExpr::GreaterEqual(left, right)
            | BoundExpr::Like(left, right)
            | BoundExpr::Glob(left, right)
            | BoundExpr::Least(left, right)
            | BoundExpr::Concat(left, right) => self.compared(left, right),
            BoundExpr::And(left, right)
            | BoundExpr::Or(left, right)
            | BoundExpr::ConditionalOutput {
                value: left,
                visible_if: right,
            } => {
                self.expr(left);
                self.expr(right);
            }
            BoundExpr::Not(inner) | BoundExpr::IsNull(inner) | BoundExpr::CastText(inner) => {
                self.expr(inner);
            }
            BoundExpr::In {
                expression,
                values,
                negated: _,
            } => {
                self.expr(expression);
                let position = expression
                    .direct_column()
                    .map_or(Position::Other, Position::Compared);
                for value in values {
                    self.expr_at(value, position);
                }
            }
            BoundExpr::ScalarFunction {
                function: _,
                arguments,
                logical_type: _,
            } => {
                for argument in arguments {
                    self.expr(argument);
                }
            }
            BoundExpr::Exists(select) => self.select(select),
            BoundExpr::Case {
                branches,
                else_expression,
                logical_type: _,
            } => {
                for (condition, value) in branches {
                    self.expr(condition);
                    self.expr(value);
                }
                if let Some(value) = else_expression {
                    self.expr(value);
                }
            }
            BoundExpr::RowNumber {
                resource: _,
                partition_by: _,
                order_by,
            } => self.orders(order_by),
            BoundExpr::Column(_)
            | BoundExpr::ServerParameter { .. }
            | BoundExpr::Literal(_)
            | BoundExpr::CountAll(_) => {}
        }
    }

    fn parameter(
        &mut self,
        name: &ClientParameterName,
        logical_type: LogicalType,
        position: Position<'_>,
    ) {
        let (column, nullable) = match position {
            Position::Assignment(column) => (
                Some(column),
                column_descriptor(self.catalog, column).is_some_and(|value| value.nullable),
            ),
            Position::Compared(column) => (Some(column), false),
            Position::Other => (None, false),
        };
        let contract = self
            .analysis
            .parameters
            .entry(name.clone())
            .or_insert_with(|| ClientParameterContract {
                logical_type,
                nullable,
                columns: Vec::new(),
            });
        if contract.logical_type != logical_type {
            self.analysis.type_conflict = true;
        }
        contract.nullable &= nullable;
        if let Some(column) = column
            && !contract.columns.contains(column)
        {
            contract.columns.push(column.clone());
        }
    }
}
