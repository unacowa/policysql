#![forbid(unsafe_code)]

use policysql_catalog::{Catalog, ResourceDescriptor};
use policysql_core::{
    BackendProfileId, ClientParameterName, JsonSchemaType, JsonValueSchema, LogicalType,
    LogicalValue, OperationKind, ResultName, ServerParameterName, SnapshotId, ValueDescriptor,
    ValueRepresentation, value_satisfies_contract,
};
use policysql_execution::{
    CandidateExecutionPlan, ExecutionLimits, PlanVerifier, ResultColumnDescriptor,
    VerificationError, VerifiedExecutionPlan,
};
use policysql_ir::{
    BoundColumn, BoundDelete, BoundExpr, BoundJsonCollectionSelect, BoundOrder, BoundProjection,
    BoundSelect, BoundStatement, BoundUpdate, ProtectedPlan, ScalarFunction, SortDirection,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::num::NonZeroU32;
use turso_parser::ast::{
    As, Cmd, Expr, FromClause, FunctionTail, GroupBy, InsertBody, JoinConstraint, JoinOperator,
    JoinType, LikeOperator, Limit, Literal, Name, OneSelect, Operator, Over, QualifiedName,
    ResultColumn, Select, SelectBody, SelectTable, Set, SortOrder, SortedColumn, Stmt,
    UnaryOperator, Update, Variable, Window,
};
use turso_parser::parser::Parser;

pub const PROFILE_ID: &str = "sqlite-turso-v1";
const TABLE_ALIAS: &str = "__policysql_t0";
const CHECK_COLUMN: &str = "__policysql_check";
const VISIBILITY_COLUMN_PREFIX: &str = "__policysql_visibility_";

/// Type marker binding candidates, verifiers, and executors to the `SQLite` profile.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SqliteProfile;

#[derive(Clone, Debug, PartialEq)]
pub struct EmittedSql {
    pub sql: String,
    pub server_parameters: BTreeMap<ServerParameterName, LogicalValue>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TypedSqliteEmitter;

impl TypedSqliteEmitter {
    /// Emits a protected IR using only Catalog-resolved identifiers and typed nodes.
    ///
    /// # Errors
    ///
    /// Rejects missing Catalog identities, parameter collisions, and unsupported values.
    pub fn emit(&self, plan: &ProtectedPlan, catalog: &Catalog) -> Result<EmittedSql, EmitError> {
        let aliases = aliases_for_statement(&plan.statement);
        let mut state = AstEmitState {
            catalog,
            aliases,
            server_parameters: plan.server_values.clone(),
            next_literal: 0,
            parameter_indices: BTreeMap::new(),
            next_parameter: 0,
        };
        let statement = match &plan.statement {
            BoundStatement::Select(select) => {
                let resource = catalog
                    .resource_by_id(select.resource)
                    .ok_or(EmitError::UnknownResource)?;
                state.select(select, resource)?
            }
            BoundStatement::ConstantSelect(select) => state.constant_select(select)?,
            BoundStatement::JsonCollectionSelect(select) => state.json_collection(select)?,
            BoundStatement::Insert(insert) => {
                state.insert(insert, plan.operation_check.as_ref())?
            }
            BoundStatement::Update(update) => {
                state.update(update, plan.operation_check.as_ref())?
            }
            BoundStatement::Delete(delete) => state.delete(delete)?,
        };
        Ok(EmittedSql {
            sql: statement.to_string(),
            server_parameters: state.server_parameters,
        })
    }
}

/// Builds only syntax nodes accepted by the SQLite/Turso profile. SQL text is produced solely by
/// `turso_parser`'s `ToTokens` implementation after the complete statement has been constructed.
struct AstEmitState<'a> {
    catalog: &'a Catalog,
    aliases: BTreeMap<policysql_core::ResourceId, String>,
    server_parameters: BTreeMap<ServerParameterName, LogicalValue>,
    next_literal: u64,
    parameter_indices: BTreeMap<String, NonZeroU32>,
    next_parameter: u32,
}

impl AstEmitState<'_> {
    fn quoted_name(value: &str) -> Name {
        Name::from_string(format!("\"{}\"", value.replace('"', "\"\"")))
    }

    fn qualified_name(value: &str) -> QualifiedName {
        QualifiedName::single(Self::quoted_name(value))
    }

    fn alias(value: &str) -> As {
        As::As(Self::quoted_name(value))
    }

    fn function_tail() -> FunctionTail {
        FunctionTail {
            filter_clause: None,
            over_clause: None,
        }
    }

    fn sorted(&mut self, order: &BoundOrder) -> Result<SortedColumn, EmitError> {
        Ok(SortedColumn {
            expr: self.expression(&order.expression)?.into_boxed(),
            order: Some(match order.direction {
                SortDirection::Ascending => SortOrder::Asc,
                SortDirection::Descending => SortOrder::Desc,
            }),
            nulls: None,
        })
    }

    fn projection(
        &mut self,
        projection: &BoundProjection,
        index: usize,
    ) -> Result<Vec<ResultColumn>, EmitError> {
        let mut columns = vec![ResultColumn::Expr(
            self.expression(&projection.expression)?.into_boxed(),
            Some(Self::alias(projection.output_name.as_str())),
        )];
        if let BoundExpr::ConditionalOutput { visible_if, .. } = &projection.expression {
            columns.push(ResultColumn::Expr(
                Expr::Case {
                    base: None,
                    when_then_pairs: vec![(
                        self.expression(visible_if)?.into_boxed(),
                        Expr::Literal(Literal::True).into_boxed(),
                    )],
                    else_expr: Some(Expr::Literal(Literal::False).into_boxed()),
                }
                .into_boxed(),
                Some(Self::alias(&format!("{VISIBILITY_COLUMN_PREFIX}{index}"))),
            ));
        }
        Ok(columns)
    }

    fn projections(
        &mut self,
        projections: &[BoundProjection],
    ) -> Result<Vec<ResultColumn>, EmitError> {
        let mut columns = Vec::new();
        for (index, projection) in projections.iter().enumerate() {
            columns.extend(self.projection(projection, index)?);
        }
        Ok(columns)
    }

    fn check_column(&mut self, check: &BoundExpr) -> Result<ResultColumn, EmitError> {
        Ok(ResultColumn::Expr(
            Expr::Case {
                base: None,
                when_then_pairs: vec![(
                    self.expression(check)?.into_boxed(),
                    Expr::Literal(Literal::True).into_boxed(),
                )],
                else_expr: Some(Expr::Literal(Literal::False).into_boxed()),
            }
            .into_boxed(),
            Some(Self::alias(CHECK_COLUMN)),
        ))
    }

    fn insert(
        &mut self,
        insert: &policysql_ir::BoundInsert,
        check: Option<&BoundExpr>,
    ) -> Result<Stmt, EmitError> {
        let resource = self
            .catalog
            .resource_by_id(insert.resource)
            .ok_or(EmitError::UnknownResource)?;
        let first = insert
            .rows
            .first()
            .ok_or_else(|| EmitError::InvariantViolation("empty INSERT".to_owned()))?;
        let columns = first
            .iter()
            .map(|assignment| {
                resource
                    .column_by_id(assignment.column.id)
                    .map(|column| Self::quoted_name(column.name.as_str()))
                    .ok_or(EmitError::UnknownColumn)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut values = Vec::new();
        for row in &insert.rows {
            if row.len() != first.len()
                || row
                    .iter()
                    .zip(first)
                    .any(|(left, right)| left.column.id != right.column.id)
            {
                return Err(EmitError::InvariantViolation(
                    "INSERT rows have inconsistent columns".to_owned(),
                ));
            }
            values.push(
                row.iter()
                    .map(|assignment| self.expression(&assignment.value).map(Expr::into_boxed))
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        let mut returning = self.projections(&insert.returning)?;
        returning.push(self.check_column(check.ok_or_else(|| {
            EmitError::InvariantViolation("INSERT requires operation check".to_owned())
        })?)?);
        Ok(Stmt::Insert {
            with: None,
            or_conflict: None,
            tbl_name: Self::qualified_name(resource.source.as_str()),
            columns,
            body: InsertBody::Select(
                Select {
                    with: None,
                    body: SelectBody {
                        select: OneSelect::Values(values),
                        compounds: Vec::new(),
                    },
                    order_by: Vec::new(),
                    limit: None,
                },
                None,
            ),
            returning,
        })
    }

    fn update(
        &mut self,
        update: &BoundUpdate,
        check: Option<&BoundExpr>,
    ) -> Result<Stmt, EmitError> {
        let resource = self
            .catalog
            .resource_by_id(update.resource)
            .ok_or(EmitError::UnknownResource)?;
        if update.assignments.is_empty() {
            return Err(EmitError::InvariantViolation("empty UPDATE".to_owned()));
        }
        let sets = update
            .assignments
            .iter()
            .map(|assignment| {
                let column = resource
                    .column_by_id(assignment.column.id)
                    .ok_or(EmitError::UnknownColumn)?;
                Ok(Set {
                    col_names: vec![Self::quoted_name(column.name.as_str())],
                    expr: self.expression(&assignment.value)?.into_boxed(),
                })
            })
            .collect::<Result<Vec<_>, EmitError>>()?;
        let mut returning = self.projections(&update.returning)?;
        returning.push(self.check_column(check.ok_or_else(|| {
            EmitError::InvariantViolation("UPDATE requires operation check".to_owned())
        })?)?);
        Ok(Stmt::Update(Update {
            with: None,
            or_conflict: None,
            tbl_name: Self::qualified_name(resource.source.as_str()),
            indexed: None,
            sets,
            from: None,
            where_clause: update
                .predicate
                .as_ref()
                .map(|value| self.expression(value).map(Expr::into_boxed))
                .transpose()?,
            returning,
            order_by: Vec::new(),
            limit: None,
        }))
    }

    fn delete(&mut self, delete: &BoundDelete) -> Result<Stmt, EmitError> {
        let resource = self
            .catalog
            .resource_by_id(delete.resource)
            .ok_or(EmitError::UnknownResource)?;
        Ok(Stmt::Delete {
            with: None,
            tbl_name: Self::qualified_name(resource.source.as_str()),
            indexed: None,
            where_clause: delete
                .predicate
                .as_ref()
                .map(|value| self.expression(value).map(Expr::into_boxed))
                .transpose()?,
            returning: self.projections(&delete.returning)?,
            order_by: Vec::new(),
            limit: None,
        })
    }

    fn select(
        &mut self,
        select: &BoundSelect,
        resource: &ResourceDescriptor,
    ) -> Result<Stmt, EmitError> {
        Ok(Stmt::Select(self.select_node(select, resource)?))
    }

    fn select_node(
        &mut self,
        select: &BoundSelect,
        resource: &ResourceDescriptor,
    ) -> Result<Select, EmitError> {
        if select.projections.is_empty() {
            return Err(EmitError::InvariantViolation("empty projection".to_owned()));
        }
        let root_alias = self
            .aliases
            .get(&select.resource)
            .ok_or(EmitError::UnknownResource)?
            .clone();
        let mut joins = Vec::new();
        for join in &select.joins {
            let joined = self
                .catalog
                .resource_by_id(join.resource)
                .ok_or(EmitError::UnknownResource)?;
            let alias = self
                .aliases
                .get(&join.resource)
                .ok_or(EmitError::UnknownResource)?
                .clone();
            joins.push(turso_parser::ast::JoinedSelectTable {
                operator: JoinOperator::TypedJoin(Some(match join.kind {
                    policysql_ir::JoinKind::Inner => JoinType::INNER,
                    policysql_ir::JoinKind::Left => JoinType::LEFT,
                })),
                table: SelectTable::Table(
                    Self::qualified_name(joined.source.as_str()),
                    Some(Self::alias(&alias)),
                    None,
                )
                .into(),
                constraint: Some(JoinConstraint::On(self.expression(&join.on)?.into_boxed())),
            });
        }
        let group_by = if select.group_by.is_empty() && select.having.is_none() {
            None
        } else {
            Some(GroupBy {
                exprs: select
                    .group_by
                    .iter()
                    .map(|column| {
                        self.expression(&BoundExpr::Column(column.clone()))
                            .map(Expr::into_boxed)
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                having: select
                    .having
                    .as_ref()
                    .map(|value| self.expression(value).map(Expr::into_boxed))
                    .transpose()?,
            })
        };
        let order_by = select
            .order_by
            .iter()
            .map(|order| self.sorted(order))
            .collect::<Result<Vec<_>, _>>()?;
        let limit = match (&select.limit, &select.offset) {
            (Some(limit), offset) => Some(Limit {
                expr: self.expression(limit)?.into_boxed(),
                offset: offset
                    .as_ref()
                    .map(|value| self.expression(value).map(Expr::into_boxed))
                    .transpose()?,
            }),
            (None, None) => None,
            (None, Some(_)) => {
                return Err(EmitError::InvariantViolation(
                    "OFFSET requires LIMIT".to_owned(),
                ));
            }
        };
        Ok(Select {
            with: None,
            body: SelectBody {
                select: OneSelect::Select {
                    distinctness: None,
                    columns: self.projections(&select.projections)?,
                    from: Some(FromClause {
                        select: SelectTable::Table(
                            Self::qualified_name(resource.source.as_str()),
                            Some(Self::alias(&root_alias)),
                            None,
                        )
                        .into(),
                        joins,
                    }),
                    where_clause: select
                        .predicate
                        .as_ref()
                        .map(|value| self.expression(value).map(Expr::into_boxed))
                        .transpose()?,
                    group_by,
                    window_clause: Vec::new(),
                },
                compounds: Vec::new(),
            },
            order_by,
            limit,
        })
    }

    fn constant_select(
        &mut self,
        select: &policysql_ir::BoundConstantSelect,
    ) -> Result<Stmt, EmitError> {
        if select.projections.is_empty() {
            return Err(EmitError::InvariantViolation("empty projection".to_owned()));
        }
        Ok(Stmt::Select(Select {
            with: None,
            body: SelectBody {
                select: OneSelect::Select {
                    distinctness: None,
                    columns: self.projections(&select.projections)?,
                    from: None,
                    where_clause: None,
                    group_by: None,
                    window_clause: Vec::new(),
                },
                compounds: Vec::new(),
            },
            order_by: Vec::new(),
            limit: None,
        }))
    }

    fn json_collection(&mut self, select: &BoundJsonCollectionSelect) -> Result<Stmt, EmitError> {
        let resource = self
            .catalog
            .resource_by_id(select.resource)
            .ok_or(EmitError::UnknownResource)?;
        let column = resource
            .column_by_id(select.document.id)
            .ok_or(EmitError::UnknownColumn)?;
        let value = Expr::Qualified(
            Self::quoted_name("__policysql_json"),
            Self::quoted_name("value"),
        );
        let aggregate = Expr::FunctionCall {
            name: Name::exact("JSON_GROUP_ARRAY".to_owned()),
            distinctness: None,
            args: vec![value.into_boxed()],
            order_by: Vec::new(),
            within_group: Vec::new(),
            filter_over: Self::function_tail(),
        };
        let document = Expr::Qualified(
            Self::quoted_name(TABLE_ALIAS),
            Self::quoted_name(column.name.as_str()),
        );
        Ok(Stmt::Select(Select {
            with: None,
            body: SelectBody {
                select: OneSelect::Select {
                    distinctness: None,
                    columns: vec![ResultColumn::Expr(
                        aggregate.into_boxed(),
                        Some(Self::alias(select.output_name.as_str())),
                    )],
                    from: Some(FromClause {
                        select: SelectTable::Table(
                            Self::qualified_name(resource.source.as_str()),
                            Some(Self::alias(TABLE_ALIAS)),
                            None,
                        )
                        .into(),
                        joins: vec![turso_parser::ast::JoinedSelectTable {
                            operator: JoinOperator::Comma,
                            table: SelectTable::TableCall(
                                QualifiedName::single(Name::exact(
                                    if select.recursive {
                                        "JSON_TREE"
                                    } else {
                                        "JSON_EACH"
                                    }
                                    .to_owned(),
                                )),
                                vec![
                                    document.into_boxed(),
                                    self.expression(&select.path)?.into_boxed(),
                                ],
                                Some(Self::alias("__policysql_json")),
                            )
                            .into(),
                            constraint: None,
                        }],
                    }),
                    where_clause: select
                        .predicate
                        .as_ref()
                        .map(|value| self.expression(value).map(Expr::into_boxed))
                        .transpose()?,
                    group_by: None,
                    window_clause: Vec::new(),
                },
                compounds: Vec::new(),
            },
            order_by: Vec::new(),
            limit: None,
        }))
    }

    fn parenthesized(expr: Expr) -> Expr {
        Expr::Parenthesized(vec![expr.into_boxed()])
    }

    fn binary(
        &mut self,
        left: &BoundExpr,
        op: Operator,
        right: &BoundExpr,
    ) -> Result<Expr, EmitError> {
        Ok(Self::parenthesized(Expr::binary(
            self.expression(left)?,
            op,
            self.expression(right)?,
        )))
    }

    #[allow(clippy::too_many_lines)]
    fn expression(&mut self, expression: &BoundExpr) -> Result<Expr, EmitError> {
        Ok(match expression {
            BoundExpr::Column(column) => {
                let resource = self
                    .catalog
                    .resource_by_id(column.id.resource())
                    .ok_or(EmitError::UnknownResource)?;
                let descriptor = resource
                    .column_by_id(column.id)
                    .ok_or(EmitError::UnknownColumn)?;
                let alias = self
                    .aliases
                    .get(&column.id.resource())
                    .ok_or(EmitError::UnknownResource)?;
                if alias.is_empty() {
                    Expr::Id(Self::quoted_name(descriptor.name.as_str()))
                } else {
                    Expr::Qualified(
                        Self::quoted_name(alias),
                        Self::quoted_name(descriptor.name.as_str()),
                    )
                }
            }
            BoundExpr::ClientParameter { name, .. } => self.parameter(name.as_str())?,
            BoundExpr::ServerParameter { name, .. } => {
                if !self.server_parameters.contains_key(name) {
                    return Err(EmitError::MissingServerParameter(name.as_str().to_owned()));
                }
                self.parameter(name.as_str())?
            }
            BoundExpr::Literal(value) => self.literal(value)?,
            BoundExpr::Equal(left, right) => self.binary(left, Operator::Equals, right)?,
            BoundExpr::NotEqual(left, right) => self.binary(left, Operator::NotEquals, right)?,
            BoundExpr::Less(left, right) => self.binary(left, Operator::Less, right)?,
            BoundExpr::LessEqual(left, right) => self.binary(left, Operator::LessEquals, right)?,
            BoundExpr::Greater(left, right) => self.binary(left, Operator::Greater, right)?,
            BoundExpr::GreaterEqual(left, right) => {
                self.binary(left, Operator::GreaterEquals, right)?
            }
            BoundExpr::And(left, right) => self.binary(left, Operator::And, right)?,
            BoundExpr::Or(left, right) => self.binary(left, Operator::Or, right)?,
            BoundExpr::Like(left, right) => Self::parenthesized(Expr::like(
                self.expression(left)?,
                false,
                LikeOperator::Like,
                self.expression(right)?,
                None,
            )),
            BoundExpr::Glob(left, right) => Self::parenthesized(Expr::like(
                self.expression(left)?,
                false,
                LikeOperator::Glob,
                self.expression(right)?,
                None,
            )),
            BoundExpr::Not(inner) => {
                Self::parenthesized(Expr::unary(UnaryOperator::Not, self.expression(inner)?))
            }
            BoundExpr::IsNull(inner) => Self::parenthesized(Expr::binary(
                self.expression(inner)?,
                Operator::Is,
                Expr::Literal(Literal::Null),
            )),
            BoundExpr::In {
                expression,
                values,
                negated,
            } => {
                if values.is_empty() {
                    return Err(EmitError::InvariantViolation("empty IN list".to_owned()));
                }
                Self::parenthesized(Expr::InList {
                    lhs: self.expression(expression)?.into_boxed(),
                    not: *negated,
                    rhs: values
                        .iter()
                        .map(|value| self.expression(value).map(Expr::into_boxed))
                        .collect::<Result<Vec<_>, _>>()?,
                })
            }
            BoundExpr::Least(left, right) => Expr::FunctionCall {
                name: Name::exact("MIN".to_owned()),
                distinctness: None,
                args: vec![
                    self.expression(left)?.into_boxed(),
                    self.expression(right)?.into_boxed(),
                ],
                order_by: Vec::new(),
                within_group: Vec::new(),
                filter_over: Self::function_tail(),
            },
            BoundExpr::Concat(left, right) => self.binary(left, Operator::Concat, right)?,
            BoundExpr::CastText(inner) => Expr::cast(
                self.expression(inner)?,
                Some(turso_parser::ast::Type {
                    name: "TEXT".to_owned(),
                    size: None,
                    array_dimensions: 0,
                }),
            ),
            BoundExpr::Case {
                branches,
                else_expression,
                ..
            } => Expr::Case {
                base: None,
                when_then_pairs: branches
                    .iter()
                    .map(|(condition, value)| {
                        Ok((
                            self.expression(condition)?.into_boxed(),
                            self.expression(value)?.into_boxed(),
                        ))
                    })
                    .collect::<Result<Vec<_>, EmitError>>()?,
                else_expr: else_expression
                    .as_ref()
                    .map(|value| self.expression(value).map(Expr::into_boxed))
                    .transpose()?,
            },
            BoundExpr::ConditionalOutput { value, visible_if } => Expr::Case {
                base: None,
                when_then_pairs: vec![(
                    self.expression(visible_if)?.into_boxed(),
                    self.expression(value)?.into_boxed(),
                )],
                else_expr: Some(Expr::Literal(Literal::Null).into_boxed()),
            },
            BoundExpr::Exists(select) => {
                let resource = self
                    .catalog
                    .resource_by_id(select.resource)
                    .ok_or(EmitError::UnknownResource)?;
                Expr::Exists(self.select_node(select, resource)?)
            }
            BoundExpr::CountAll(_) => Expr::FunctionCallStar {
                name: Name::exact("COUNT".to_owned()),
                filter_over: Self::function_tail(),
            },
            BoundExpr::ScalarFunction {
                function,
                arguments,
                ..
            } => Expr::FunctionCall {
                name: Name::exact(
                    match function {
                        ScalarFunction::Lower => "LOWER",
                        ScalarFunction::Upper => "UPPER",
                        ScalarFunction::JsonExtract => "JSON_EXTRACT",
                    }
                    .to_owned(),
                ),
                distinctness: None,
                args: arguments
                    .iter()
                    .map(|argument| self.expression(argument).map(Expr::into_boxed))
                    .collect::<Result<Vec<_>, _>>()?,
                order_by: Vec::new(),
                within_group: Vec::new(),
                filter_over: Self::function_tail(),
            },
            BoundExpr::RowNumber {
                partition_by,
                order_by,
                ..
            } => Expr::FunctionCall {
                name: Name::exact("ROW_NUMBER".to_owned()),
                distinctness: None,
                args: Vec::new(),
                order_by: Vec::new(),
                within_group: Vec::new(),
                filter_over: FunctionTail {
                    filter_clause: None,
                    over_clause: Some(Over::Window(Window {
                        base: None,
                        partition_by: partition_by
                            .iter()
                            .map(|column| {
                                self.expression(&BoundExpr::Column(column.clone()))
                                    .map(Expr::into_boxed)
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                        order_by: order_by
                            .iter()
                            .map(|order| self.sorted(order))
                            .collect::<Result<Vec<_>, _>>()?,
                        frame_clause: None,
                    })),
                },
            },
        })
    }

    fn parameter(&mut self, value: &str) -> Result<Expr, EmitError> {
        let name = format!(":{value}");
        let index = if let Some(index) = self.parameter_indices.get(&name) {
            *index
        } else {
            self.next_parameter = self
                .next_parameter
                .checked_add(1)
                .ok_or(EmitError::TooManyLiterals)?;
            let index = NonZeroU32::new(self.next_parameter).ok_or(EmitError::TooManyLiterals)?;
            self.parameter_indices.insert(name.clone(), index);
            index
        };
        Ok(Expr::Variable(Variable::named(name, index)))
    }

    fn literal(&mut self, value: &LogicalValue) -> Result<Expr, EmitError> {
        Ok(match value {
            LogicalValue::Null => Expr::Literal(Literal::Null),
            LogicalValue::Boolean(true) => Expr::Literal(Literal::True),
            LogicalValue::Boolean(false) => Expr::Literal(Literal::False),
            LogicalValue::Int64(value) if *value < 0 => Expr::unary(
                UnaryOperator::Negative,
                Expr::Literal(Literal::Numeric(value.unsigned_abs().to_string())),
            ),
            LogicalValue::Int64(value) => Expr::Literal(Literal::Numeric(value.to_string())),
            LogicalValue::Number(value) if value.is_finite() && *value < 0.0 => Expr::unary(
                UnaryOperator::Negative,
                Expr::Literal(Literal::Numeric((-value).to_string())),
            ),
            LogicalValue::Number(value) if value.is_finite() => {
                Expr::Literal(Literal::Numeric(value.to_string()))
            }
            LogicalValue::Number(_) => return Err(EmitError::UnsupportedValue),
            LogicalValue::String(_) | LogicalValue::Bytes(_) | LogicalValue::Json(_) => loop {
                let suffix = format!("literal_{}", self.next_literal);
                self.next_literal = self
                    .next_literal
                    .checked_add(1)
                    .ok_or(EmitError::TooManyLiterals)?;
                let name = ServerParameterName::from_trusted_suffix(&suffix)
                    .map_err(|_| EmitError::InvariantViolation("literal name".to_owned()))?;
                if self
                    .server_parameters
                    .insert(name.clone(), value.clone())
                    .is_none()
                {
                    break self.parameter(name.as_str())?;
                }
            },
        })
    }
}

fn aliases_for_statement(
    statement: &BoundStatement,
) -> BTreeMap<policysql_core::ResourceId, String> {
    if matches!(statement, BoundStatement::ConstantSelect(_)) {
        return BTreeMap::new();
    }
    if let BoundStatement::JsonCollectionSelect(select) = statement {
        return BTreeMap::from([(select.resource, TABLE_ALIAS.to_owned())]);
    }
    let BoundStatement::Select(select) = statement else {
        let resource = match statement {
            BoundStatement::Insert(value) => value.resource,
            BoundStatement::Update(value) => value.resource,
            BoundStatement::Delete(value) => value.resource,
            BoundStatement::Select(_)
            | BoundStatement::ConstantSelect(_)
            | BoundStatement::JsonCollectionSelect(_) => {
                unreachable!("handled above")
            }
        };
        return BTreeMap::from([(resource, String::new())]);
    };
    let mut aliases = BTreeMap::from([(select.resource, TABLE_ALIAS.to_owned())]);
    let mut next_alias = 1_usize;
    for (index, join) in select.joins.iter().enumerate() {
        aliases.insert(join.resource, format!("__policysql_t{}", index + 1));
        next_alias = index + 2;
    }
    if let Some(predicate) = &select.predicate {
        allocate_nested_aliases(predicate, &mut aliases, &mut next_alias);
    }
    aliases
}

fn allocate_nested_aliases(
    expression: &BoundExpr,
    aliases: &mut BTreeMap<policysql_core::ResourceId, String>,
    next: &mut usize,
) {
    match expression {
        BoundExpr::Exists(select) => {
            if let std::collections::btree_map::Entry::Vacant(entry) =
                aliases.entry(select.resource)
            {
                entry.insert(format!("__policysql_t{next}"));
                *next += 1;
            }
            if let Some(predicate) = &select.predicate {
                allocate_nested_aliases(predicate, aliases, next);
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
            allocate_nested_aliases(left, aliases, next);
            allocate_nested_aliases(right, aliases, next);
        }
        BoundExpr::Not(inner) | BoundExpr::IsNull(inner) | BoundExpr::CastText(inner) => {
            allocate_nested_aliases(inner, aliases, next);
        }
        BoundExpr::ScalarFunction { arguments, .. } => {
            for argument in arguments {
                allocate_nested_aliases(argument, aliases, next);
            }
        }
        BoundExpr::In {
            expression, values, ..
        } => {
            allocate_nested_aliases(expression, aliases, next);
            for value in values {
                allocate_nested_aliases(value, aliases, next);
            }
        }
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => {
            for (condition, value) in branches {
                allocate_nested_aliases(condition, aliases, next);
                allocate_nested_aliases(value, aliases, next);
            }
            if let Some(value) = else_expression {
                allocate_nested_aliases(value, aliases, next);
            }
        }
        BoundExpr::Column(_)
        | BoundExpr::ClientParameter { .. }
        | BoundExpr::ServerParameter { .. }
        | BoundExpr::Literal(_)
        | BoundExpr::CountAll(_)
        | BoundExpr::RowNumber { .. } => {}
    }
}

#[derive(Clone, Debug)]
pub struct SqliteInvariantVerifier {
    profile_id: BackendProfileId,
    expected_statement: Stmt,
    expected_client_parameters: BTreeSet<ClientParameterName>,
    expected_server_parameters: BTreeSet<ServerParameterName>,
    expected_result: Vec<ResultColumnDescriptor>,
    expected_snapshot: SnapshotId,
    expected_operation: OperationKind,
    expected_affected_rows: Option<u64>,
    expects_operation_check: bool,
    expected_result_rows: Option<u64>,
}

impl SqliteInvariantVerifier {
    /// Creates a verifier bound to independently supplied compilation expectations.
    ///
    /// # Errors
    ///
    /// Rejects an invalid profile identifier.
    pub fn new(
        expected_sql: &str,
        expected_client_parameters: BTreeSet<ClientParameterName>,
        expected_server_parameters: BTreeSet<ServerParameterName>,
        expected_result: Vec<ResultColumnDescriptor>,
        expected_snapshot: SnapshotId,
    ) -> Result<Self, EmitError> {
        let expected_statement = parse_single_statement(expected_sql).map_err(|()| {
            EmitError::InvariantViolation("expected protected SQL does not parse".to_owned())
        })?;
        Ok(Self {
            profile_id: BackendProfileId::new(PROFILE_ID)
                .map_err(|_| EmitError::InvariantViolation("invalid profile ID".to_owned()))?,
            expected_statement,
            expected_client_parameters,
            expected_server_parameters,
            expected_result,
            expected_snapshot,
            expected_operation: OperationKind::Select,
            expected_affected_rows: None,
            expects_operation_check: false,
            expected_result_rows: None,
        })
    }

    fn with_operation(mut self, operation: OperationKind) -> Self {
        self.expected_operation = operation;
        self
    }

    fn with_expected_affected_rows(mut self, expected: u64) -> Self {
        self.expected_affected_rows = Some(expected);
        self
    }

    fn with_operation_check(mut self) -> Self {
        self.expects_operation_check = true;
        self
    }

    fn with_expected_result_rows(mut self, expected: u64) -> Self {
        self.expected_result_rows = Some(expected);
        self
    }
}

impl PlanVerifier<SqliteProfile> for SqliteInvariantVerifier {
    fn verify(
        &self,
        candidate: &CandidateExecutionPlan<SqliteProfile>,
    ) -> Result<(), VerificationError> {
        let statement = parse_single_statement(candidate.protected_sql())
            .map_err(|()| violation("emitted SQL does not parse as exactly one statement"))?;
        let correct_statement = match self.expected_operation {
            OperationKind::Select => matches!(&statement, Stmt::Select(_)),
            OperationKind::Insert => matches!(&statement, Stmt::Insert { .. }),
            OperationKind::Update => matches!(&statement, Stmt::Update(_)),
            OperationKind::Delete => matches!(&statement, Stmt::Delete { .. }),
        };
        if !correct_statement {
            return Err(violation(
                "emitted SQL operation or statement count mismatch",
            ));
        }
        if statement != self.expected_statement {
            return Err(violation(
                "emitted SQL syntax tree differs from the protected plan",
            ));
        }
        if candidate.operation() != self.expected_operation {
            return Err(violation("operation mismatch"));
        }
        if candidate.expected_affected_rows() != self.expected_affected_rows {
            return Err(violation("affected-row invariant mismatch"));
        }
        if candidate.expected_result_rows() != self.expected_result_rows {
            return Err(violation("result-row invariant mismatch"));
        }
        if self.expects_operation_check
            && candidate
                .operation_check_column()
                .is_none_or(|column| column.as_str() != CHECK_COLUMN)
        {
            return Err(violation("operation-check column mismatch"));
        }
        if !self.expects_operation_check && candidate.operation_check_column().is_some() {
            return Err(violation("unexpected operation-check column"));
        }
        if candidate.snapshot() != &self.expected_snapshot {
            return Err(violation("snapshot mismatch"));
        }
        let clients = candidate
            .client_parameters()
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        if clients != self.expected_client_parameters {
            return Err(violation("client parameter set mismatch"));
        }
        let servers = candidate
            .server_parameters()
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        if servers != self.expected_server_parameters {
            return Err(violation("server parameter set mismatch"));
        }
        if candidate.result() != self.expected_result {
            return Err(violation("result descriptor mismatch"));
        }
        Ok(())
    }

    fn profile_id(&self) -> &BackendProfileId {
        &self.profile_id
    }
}

fn parse_single_statement(sql: &str) -> Result<Stmt, ()> {
    let mut parsed = Parser::new(sql.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ())?;
    if parsed.len() != 1 {
        return Err(());
    }
    match parsed.pop() {
        Some(Cmd::Stmt(statement)) => Ok(statement),
        Some(Cmd::Explain(_) | Cmd::ExplainQueryPlan(_)) | None => Err(()),
    }
}

/// Constructs an `EXPLAIN QUERY PLAN` command from already sealed SQL through the `SQLite` AST.
///
/// # Errors
///
/// Rejects text that is not exactly one ordinary `SQLite` statement.
pub fn explain_query_plan_sql(protected_sql: &str) -> Result<String, EmitError> {
    let statement = parse_single_statement(protected_sql).map_err(|()| {
        EmitError::InvariantViolation("protected SQL does not parse for EXPLAIN".to_owned())
    })?;
    Ok(Cmd::ExplainQueryPlan(statement).to_string())
}

fn violation(message: &str) -> VerificationError {
    VerificationError::InvariantViolation(message.to_owned())
}

/// Emits, re-parses, verifies, and seals a `SQLite` execution candidate.
///
/// # Errors
///
/// Fails closed on emission, input binding, profile, parse, or invariant errors.
pub fn compile_verified_select(
    plan: &ProtectedPlan,
    catalog: &Catalog,
    client_parameters: BTreeMap<ClientParameterName, LogicalValue>,
    limits: ExecutionLimits,
    snapshot: SnapshotId,
) -> Result<VerifiedExecutionPlan<SqliteProfile>, CompileError> {
    let emitted = TypedSqliteEmitter.emit(plan, catalog)?;
    let expected_clients = collect_client_parameters(&plan.statement);
    if client_parameters.keys().cloned().collect::<BTreeSet<_>>() != expected_clients {
        return Err(CompileError::ClientParameterMismatch);
    }
    validate_client_parameter_types(&plan.statement, &client_parameters)?;
    validate_client_parameter_contracts(&plan.statement, catalog, &client_parameters)?;
    let expected_servers = emitted.server_parameters.keys().cloned().collect();
    let expected_result = result_descriptors(&plan.statement, catalog, &client_parameters)?;
    let mut verifier = SqliteInvariantVerifier::new(
        &emitted.sql,
        expected_clients,
        expected_servers,
        expected_result.clone(),
        snapshot.clone(),
    )?;
    if let Some(expected) = plan.expected_result_rows {
        verifier = verifier.with_expected_result_rows(expected);
    }
    let profile_id = BackendProfileId::new(PROFILE_ID)
        .map_err(|_| EmitError::InvariantViolation("invalid profile ID".to_owned()))?;
    let mut candidate = CandidateExecutionPlan::new(
        emitted.sql,
        OperationKind::Select,
        limits,
        snapshot,
        profile_id,
    )
    .with_bindings(
        client_parameters,
        emitted.server_parameters,
        expected_result,
    );
    if let Some(expected) = plan.expected_result_rows {
        candidate = candidate.with_expected_result_rows(expected);
    }
    VerifiedExecutionPlan::verify(candidate, &verifier).map_err(CompileError::Verification)
}

/// Emits, re-parses, verifies, and seals a protected `INSERT VALUES` plan.
///
/// # Errors
///
/// Fails closed unless affected-row and per-row post-state check invariants are present.
pub fn compile_verified_insert(
    plan: &ProtectedPlan,
    catalog: &Catalog,
    client_parameters: BTreeMap<ClientParameterName, LogicalValue>,
    limits: ExecutionLimits,
    snapshot: SnapshotId,
) -> Result<VerifiedExecutionPlan<SqliteProfile>, CompileError> {
    if !matches!(plan.statement, BoundStatement::Insert(_)) || plan.operation_check.is_none() {
        return Err(EmitError::UnsupportedStatement.into());
    }
    let expected_affected_rows = plan.expected_affected_rows.ok_or_else(|| {
        EmitError::InvariantViolation("INSERT affected-row invariant is missing".to_owned())
    })?;
    let emitted = TypedSqliteEmitter.emit(plan, catalog)?;
    let expected_clients = collect_client_parameters(&plan.statement);
    if client_parameters.keys().cloned().collect::<BTreeSet<_>>() != expected_clients {
        return Err(CompileError::ClientParameterMismatch);
    }
    validate_client_parameter_types(&plan.statement, &client_parameters)?;
    validate_client_parameter_contracts(&plan.statement, catalog, &client_parameters)?;
    let expected_servers = emitted.server_parameters.keys().cloned().collect();
    let expected_result = result_descriptors(&plan.statement, catalog, &client_parameters)?;
    let mut verifier = SqliteInvariantVerifier::new(
        &emitted.sql,
        expected_clients,
        expected_servers,
        expected_result.clone(),
        snapshot.clone(),
    )?
    .with_operation(OperationKind::Insert)
    .with_expected_affected_rows(expected_affected_rows)
    .with_operation_check();
    if let Some(expected) = plan.expected_result_rows {
        verifier = verifier.with_expected_result_rows(expected);
    }
    let profile_id = BackendProfileId::new(PROFILE_ID)
        .map_err(|_| EmitError::InvariantViolation("invalid profile ID".to_owned()))?;
    let check_column = policysql_core::ResultName::new(CHECK_COLUMN)
        .map_err(|_| EmitError::InvariantViolation("invalid check column".to_owned()))?;
    let mut candidate = CandidateExecutionPlan::new(
        emitted.sql,
        OperationKind::Insert,
        limits,
        snapshot,
        profile_id,
    )
    .with_bindings(
        client_parameters,
        emitted.server_parameters,
        expected_result,
    )
    .with_mutation_invariants(expected_affected_rows, check_column);
    if let Some(expected) = plan.expected_result_rows {
        candidate = candidate.with_expected_result_rows(expected);
    }
    VerifiedExecutionPlan::verify(candidate, &verifier).map_err(CompileError::Verification)
}

/// Emits, independently renders, re-parses, and seals a protected UPDATE.
///
/// # Errors
///
/// Fails closed on unsupported IR, binding mismatch, emission, parse, or invariant failure.
pub fn compile_verified_update(
    plan: &ProtectedPlan,
    catalog: &Catalog,
    client_parameters: BTreeMap<ClientParameterName, LogicalValue>,
    limits: ExecutionLimits,
    snapshot: SnapshotId,
) -> Result<VerifiedExecutionPlan<SqliteProfile>, CompileError> {
    if !matches!(plan.statement, BoundStatement::Update(_)) || plan.operation_check.is_none() {
        return Err(EmitError::UnsupportedStatement.into());
    }
    let emitted = TypedSqliteEmitter.emit(plan, catalog)?;
    let expected_clients = collect_client_parameters(&plan.statement);
    if client_parameters.keys().cloned().collect::<BTreeSet<_>>() != expected_clients {
        return Err(CompileError::ClientParameterMismatch);
    }
    validate_client_parameter_types(&plan.statement, &client_parameters)?;
    validate_client_parameter_contracts(&plan.statement, catalog, &client_parameters)?;
    let expected_servers = emitted.server_parameters.keys().cloned().collect();
    let expected_result = result_descriptors(&plan.statement, catalog, &client_parameters)?;
    let mut verifier = SqliteInvariantVerifier::new(
        &emitted.sql,
        expected_clients,
        expected_servers,
        expected_result.clone(),
        snapshot.clone(),
    )?
    .with_operation(OperationKind::Update)
    .with_operation_check();
    if let Some(expected) = plan.expected_affected_rows {
        verifier = verifier.with_expected_affected_rows(expected);
    }
    if let Some(expected) = plan.expected_result_rows {
        verifier = verifier.with_expected_result_rows(expected);
    }
    let profile_id = BackendProfileId::new(PROFILE_ID)
        .map_err(|_| EmitError::InvariantViolation("invalid profile ID".to_owned()))?;
    let check_column = policysql_core::ResultName::new(CHECK_COLUMN)
        .map_err(|_| EmitError::InvariantViolation("invalid check column".to_owned()))?;
    let mut candidate = CandidateExecutionPlan::new(
        emitted.sql,
        OperationKind::Update,
        limits,
        snapshot,
        profile_id,
    )
    .with_bindings(
        client_parameters,
        emitted.server_parameters,
        expected_result,
    )
    .with_operation_check(check_column);
    if let Some(expected) = plan.expected_affected_rows {
        candidate = candidate.with_expected_affected_rows(expected);
    }
    if let Some(expected) = plan.expected_result_rows {
        candidate = candidate.with_expected_result_rows(expected);
    }
    VerifiedExecutionPlan::verify(candidate, &verifier).map_err(CompileError::Verification)
}

/// Emits, independently renders, re-parses, and seals a protected DELETE.
///
/// # Errors
///
/// Fails closed on unsupported IR, binding mismatch, emission, parse, or invariant failure.
pub fn compile_verified_delete(
    plan: &ProtectedPlan,
    catalog: &Catalog,
    client_parameters: BTreeMap<ClientParameterName, LogicalValue>,
    limits: ExecutionLimits,
    snapshot: SnapshotId,
) -> Result<VerifiedExecutionPlan<SqliteProfile>, CompileError> {
    if !matches!(plan.statement, BoundStatement::Delete(_)) || plan.operation_check.is_some() {
        return Err(EmitError::UnsupportedStatement.into());
    }
    let emitted = TypedSqliteEmitter.emit(plan, catalog)?;
    let expected_clients = collect_client_parameters(&plan.statement);
    if client_parameters.keys().cloned().collect::<BTreeSet<_>>() != expected_clients {
        return Err(CompileError::ClientParameterMismatch);
    }
    validate_client_parameter_types(&plan.statement, &client_parameters)?;
    validate_client_parameter_contracts(&plan.statement, catalog, &client_parameters)?;
    let expected_servers = emitted.server_parameters.keys().cloned().collect();
    let expected_result = result_descriptors(&plan.statement, catalog, &client_parameters)?;
    let mut verifier = SqliteInvariantVerifier::new(
        &emitted.sql,
        expected_clients,
        expected_servers,
        expected_result.clone(),
        snapshot.clone(),
    )?
    .with_operation(OperationKind::Delete);
    if let Some(expected) = plan.expected_affected_rows {
        verifier = verifier.with_expected_affected_rows(expected);
    }
    if let Some(expected) = plan.expected_result_rows {
        verifier = verifier.with_expected_result_rows(expected);
    }
    let profile_id = BackendProfileId::new(PROFILE_ID)
        .map_err(|_| EmitError::InvariantViolation("invalid profile ID".to_owned()))?;
    let mut candidate = CandidateExecutionPlan::new(
        emitted.sql,
        OperationKind::Delete,
        limits,
        snapshot,
        profile_id,
    )
    .with_bindings(
        client_parameters,
        emitted.server_parameters,
        expected_result,
    );
    if let Some(expected) = plan.expected_affected_rows {
        candidate = candidate.with_expected_affected_rows(expected);
    }
    if let Some(expected) = plan.expected_result_rows {
        candidate = candidate.with_expected_result_rows(expected);
    }
    VerifiedExecutionPlan::verify(candidate, &verifier).map_err(CompileError::Verification)
}

#[allow(clippy::too_many_lines)]
fn result_descriptors(
    statement: &BoundStatement,
    catalog: &Catalog,
    client_parameters: &BTreeMap<ClientParameterName, LogicalValue>,
) -> Result<Vec<ResultColumnDescriptor>, EmitError> {
    if let BoundStatement::JsonCollectionSelect(select) = statement {
        let item_schema = json_collection_item_schema(select, catalog, client_parameters)?;
        return Ok(vec![ResultColumnDescriptor {
            name: select.output_name.clone(),
            value: ValueDescriptor {
                logical_type: LogicalType::Json,
                representation: ValueRepresentation::Json,
                nullable: false,
                format: None,
                storage: None,
                constraints: None,
                json_schema: Some(JsonValueSchema {
                    types: vec![JsonSchemaType::Array],
                    properties: BTreeMap::new(),
                    items: Some(Box::new(item_schema)),
                    required: Vec::new(),
                    additional_properties: false,
                    any_of: Vec::new(),
                }),
            },
            possible_types: vec![LogicalType::Json],
            redacted_on_null: false,
            visibility_column: None,
        }]);
    }
    let (resource_id, projections, select) = match statement {
        BoundStatement::Select(value) => (
            Some(value.resource),
            &value.projections[..],
            Some(value.as_ref()),
        ),
        BoundStatement::ConstantSelect(value) => (None, &value.projections[..], None),
        BoundStatement::Insert(value) => (Some(value.resource), &value.returning[..], None),
        BoundStatement::Update(value) => (Some(value.resource), &value.returning[..], None),
        BoundStatement::Delete(value) => (Some(value.resource), &value.returning[..], None),
        BoundStatement::JsonCollectionSelect(_) => unreachable!("handled above"),
    };
    if resource_id.is_some_and(|resource| catalog.resource_by_id(resource).is_none()) {
        return Err(EmitError::UnknownResource);
    }
    projections
        .iter()
        .enumerate()
        .map(|(index, projection)| {
            if let BoundExpr::Literal(value) = &projection.expression {
                let (logical_type, representation) = match value {
                    LogicalValue::Int64(_) => (LogicalType::Integer, ValueRepresentation::Number),
                    LogicalValue::Number(_) => (LogicalType::Number, ValueRepresentation::Number),
                    _ => return Err(EmitError::UnsupportedStatement),
                };
                return Ok(ResultColumnDescriptor {
                    name: projection.output_name.clone(),
                    value: ValueDescriptor {
                        logical_type,
                        representation,
                        nullable: false,
                        format: None,
                        storage: None,
                        constraints: None,
                        json_schema: None,
                    },
                    possible_types: vec![logical_type],
                    redacted_on_null: false,
                    visibility_column: None,
                });
            }
            if matches!(
                projection.expression,
                BoundExpr::CountAll(_) | BoundExpr::RowNumber { .. }
            ) {
                return Ok(ResultColumnDescriptor {
                    name: projection.output_name.clone(),
                    value: ValueDescriptor {
                        logical_type: LogicalType::Int64,
                        representation: ValueRepresentation::Number,
                        nullable: false,
                        format: None,
                        storage: None,
                        constraints: None,
                        json_schema: None,
                    },
                    possible_types: vec![LogicalType::Int64],
                    redacted_on_null: false,
                    visibility_column: None,
                });
            }
            if let Some(descriptor) =
                scalar_result_descriptor(projection, catalog, select, client_parameters)?
            {
                return Ok(descriptor);
            }
            if let Some(descriptor) = compound_result_descriptor(projection, catalog, select)? {
                return Ok(descriptor);
            }
            let (column, conditional) = match &projection.expression {
                BoundExpr::Column(column) => (column, false),
                BoundExpr::ConditionalOutput { value, .. } => {
                    let BoundExpr::Column(column) = value.as_ref() else {
                        return Err(EmitError::InvariantViolation(
                            "conditional output is not a direct column".to_owned(),
                        ));
                    };
                    (column, true)
                }
                _ => {
                    return Err(EmitError::InvariantViolation(
                        "projection is not a permitted output shape".to_owned(),
                    ));
                }
            };
            let source = catalog
                .resource_by_id(column.id.resource())
                .ok_or(EmitError::UnknownResource)?;
            let mut value = source
                .column_by_id(column.id)
                .ok_or(EmitError::UnknownColumn)?
                .value
                .clone();
            let nullable_join = select.is_some_and(|select| {
                select.joins.iter().any(|join| {
                    join.resource == column.id.resource()
                        && join.kind == policysql_ir::JoinKind::Left
                })
            });
            value.nullable |= conditional || nullable_join;
            Ok(ResultColumnDescriptor {
                name: projection.output_name.clone(),
                possible_types: vec![value.logical_type],
                value,
                redacted_on_null: conditional,
                visibility_column: conditional.then(|| {
                    ResultName::new(format!("{VISIBILITY_COLUMN_PREFIX}{index}"))
                        .unwrap_or_else(|_| unreachable!("compiler visibility name is valid"))
                }),
            })
        })
        .collect()
}

fn compound_result_descriptor(
    projection: &BoundProjection,
    catalog: &Catalog,
    select: Option<&BoundSelect>,
) -> Result<Option<ResultColumnDescriptor>, EmitError> {
    let (logical_type, nullable, format) = match &projection.expression {
        BoundExpr::Concat(left, right) => (
            LogicalType::String,
            expression_nullable(left, catalog, select)?
                || expression_nullable(right, catalog, select)?,
            None,
        ),
        BoundExpr::CastText(inner) => (
            LogicalType::String,
            expression_nullable(inner, catalog, select)?,
            None,
        ),
        BoundExpr::Case {
            branches,
            else_expression,
            logical_type,
        } => {
            let nullable = else_expression.is_none()
                || branches
                    .iter()
                    .any(|(_, value)| expression_nullable(value, catalog, select).unwrap_or(true))
                || else_expression.as_deref().is_some_and(|value| {
                    expression_nullable(value, catalog, select).unwrap_or(true)
                });
            let mut formats = branches
                .iter()
                .map(|(_, value)| direct_expression_format(value, catalog));
            let first = formats.next().flatten();
            let mut all = first.is_some() && formats.all(|value| value == first);
            if let Some(value) = else_expression {
                all &= direct_expression_format(value, catalog) == first;
            }
            (
                *logical_type,
                nullable,
                all.then(|| first.unwrap_or_default().to_owned()),
            )
        }
        _ => return Ok(None),
    };
    Ok(Some(ResultColumnDescriptor {
        name: projection.output_name.clone(),
        value: ValueDescriptor {
            logical_type,
            representation: match logical_type {
                LogicalType::String
                | LogicalType::Date
                | LogicalType::DateTime
                | LogicalType::Instant
                | LogicalType::Int64 => ValueRepresentation::String,
                LogicalType::Boolean => ValueRepresentation::Boolean,
                LogicalType::Integer | LogicalType::Number => ValueRepresentation::Number,
                LogicalType::Bytes => ValueRepresentation::Base64,
                LogicalType::Json => ValueRepresentation::Json,
            },
            nullable,
            format,
            storage: None,
            constraints: None,
            json_schema: None,
        },
        possible_types: vec![logical_type],
        redacted_on_null: false,
        visibility_column: None,
    }))
}

fn direct_expression_format<'a>(
    expression: &'a BoundExpr,
    catalog: &'a Catalog,
) -> Option<&'a str> {
    let column = expression.direct_column()?;
    catalog
        .resource_by_id(column.id.resource())
        .and_then(|resource| resource.column_by_id(column.id))
        .and_then(|column| column.value.format.as_deref())
}

fn json_collection_item_schema(
    select: &BoundJsonCollectionSelect,
    catalog: &Catalog,
    client_parameters: &BTreeMap<ClientParameterName, LogicalValue>,
) -> Result<JsonValueSchema, EmitError> {
    let schema = catalog
        .resource_by_id(select.resource)
        .and_then(|resource| resource.column_by_id(select.document.id))
        .and_then(|column| column.value.json_schema.as_ref())
        .ok_or_else(|| EmitError::InvariantViolation("JSON Schema is unavailable".to_owned()))?;
    let path = json_path_value(&select.path, client_parameters)?;
    let targets = json_schema_candidates(schema, path)?;
    let mut items = Vec::new();
    for target in targets {
        for branch in schema_branches(target) {
            if select.recursive {
                collect_json_schemas(branch, &mut items);
            } else {
                items.extend(branch.properties.values().cloned());
                if let Some(item) = &branch.items {
                    items.push(item.as_ref().clone());
                }
            }
        }
    }
    if items.is_empty() {
        return Err(EmitError::InvariantViolation(
            "JSON collection path has no finite element Schema".to_owned(),
        ));
    }
    Ok(if items.len() == 1 {
        items.remove(0)
    } else {
        JsonValueSchema {
            types: Vec::new(),
            properties: BTreeMap::new(),
            items: None,
            required: Vec::new(),
            additional_properties: false,
            any_of: items,
        }
    })
}

fn collect_json_schemas(schema: &JsonValueSchema, output: &mut Vec<JsonValueSchema>) {
    output.push(schema.clone());
    for property in schema.properties.values() {
        collect_json_schemas(property, output);
    }
    if let Some(items) = &schema.items {
        collect_json_schemas(items, output);
    }
    for branch in &schema.any_of {
        collect_json_schemas(branch, output);
    }
}

fn json_path_value<'a>(
    path: &'a BoundExpr,
    client_parameters: &'a BTreeMap<ClientParameterName, LogicalValue>,
) -> Result<&'a str, EmitError> {
    match path {
        BoundExpr::Literal(LogicalValue::String(path)) => Ok(path),
        BoundExpr::ClientParameter { name, .. } => match client_parameters.get(name) {
            Some(LogicalValue::String(path)) => Ok(path),
            _ => Err(EmitError::InvariantViolation(
                "JSON path value is invalid".to_owned(),
            )),
        },
        _ => Err(EmitError::InvariantViolation(
            "JSON path is not typed".to_owned(),
        )),
    }
}

fn json_schema_candidates<'a>(
    schema: &'a JsonValueSchema,
    path: &str,
) -> Result<Vec<&'a JsonValueSchema>, EmitError> {
    let mut candidates = vec![schema];
    for segment in parse_json_path(path)? {
        candidates = candidates
            .into_iter()
            .flat_map(schema_branches)
            .filter_map(|schema| match &segment {
                JsonPathSegment::Property(name) => schema.properties.get(name),
                JsonPathSegment::Index => schema.items.as_deref(),
            })
            .collect();
        if candidates.is_empty() {
            return Err(EmitError::InvariantViolation(
                "JSON path is outside the Catalog Schema".to_owned(),
            ));
        }
    }
    Ok(candidates)
}

fn scalar_result_descriptor(
    projection: &BoundProjection,
    catalog: &Catalog,
    select: Option<&BoundSelect>,
    client_parameters: &BTreeMap<ClientParameterName, LogicalValue>,
) -> Result<Option<ResultColumnDescriptor>, EmitError> {
    let BoundExpr::ScalarFunction {
        function,
        arguments,
        logical_type,
    } = &projection.expression
    else {
        return Ok(None);
    };
    let nullable = match function {
        ScalarFunction::Lower | ScalarFunction::Upper => arguments
            .first()
            .ok_or_else(|| EmitError::InvariantViolation("registered function arity".to_owned()))
            .and_then(|argument| expression_nullable(argument, catalog, select))?,
        ScalarFunction::JsonExtract => true,
    };
    let possible_types = if *function == ScalarFunction::JsonExtract {
        json_extract_types(arguments, catalog, client_parameters)?
    } else {
        vec![*logical_type]
    };
    let result_type = *possible_types
        .first()
        .ok_or_else(|| EmitError::InvariantViolation("empty result type union".to_owned()))?;
    Ok(Some(ResultColumnDescriptor {
        name: projection.output_name.clone(),
        value: ValueDescriptor {
            logical_type: result_type,
            representation: match result_type {
                LogicalType::String
                | LogicalType::Date
                | LogicalType::DateTime
                | LogicalType::Instant
                | LogicalType::Int64 => ValueRepresentation::String,
                LogicalType::Boolean => ValueRepresentation::Boolean,
                LogicalType::Integer | LogicalType::Number => ValueRepresentation::Number,
                LogicalType::Bytes => ValueRepresentation::Base64,
                LogicalType::Json => ValueRepresentation::Json,
            },
            nullable,
            format: None,
            storage: None,
            constraints: None,
            json_schema: None,
        },
        possible_types,
        redacted_on_null: false,
        visibility_column: None,
    }))
}

#[derive(Clone, Debug)]
enum JsonPathSegment {
    Property(String),
    Index,
}

fn json_extract_types(
    arguments: &[BoundExpr],
    catalog: &Catalog,
    client_parameters: &BTreeMap<ClientParameterName, LogicalValue>,
) -> Result<Vec<LogicalType>, EmitError> {
    let column = arguments
        .first()
        .and_then(BoundExpr::direct_column)
        .ok_or_else(|| {
            EmitError::InvariantViolation("JSON document provenance is unavailable".to_owned())
        })?;
    let schema = catalog
        .resource_by_id(column.id.resource())
        .and_then(|resource| resource.column_by_id(column.id))
        .and_then(|column| column.value.json_schema.as_ref())
        .ok_or_else(|| EmitError::InvariantViolation("JSON Schema is unavailable".to_owned()))?;
    let path = match arguments.get(1) {
        Some(BoundExpr::Literal(LogicalValue::String(path))) => path.as_str(),
        Some(BoundExpr::ClientParameter { name, .. }) => match client_parameters.get(name) {
            Some(LogicalValue::String(path)) => path.as_str(),
            _ => {
                return Err(EmitError::InvariantViolation(
                    "JSON path value is invalid".to_owned(),
                ));
            }
        },
        _ => {
            return Err(EmitError::InvariantViolation(
                "JSON path is not typed".to_owned(),
            ));
        }
    };
    let mut candidates = vec![schema];
    if !path.is_empty() {
        for segment in parse_json_path(path)? {
            candidates = candidates
                .into_iter()
                .flat_map(schema_branches)
                .filter_map(|schema| match &segment {
                    JsonPathSegment::Property(name) => schema.properties.get(name),
                    JsonPathSegment::Index => schema.items.as_deref(),
                })
                .collect();
            if candidates.is_empty() {
                return Err(EmitError::InvariantViolation(
                    "JSON path is outside the Catalog Schema".to_owned(),
                ));
            }
        }
    }
    let mut schema_types = BTreeSet::new();
    for schema in candidates {
        collect_json_types(schema, path.is_empty(), &mut schema_types);
    }
    let ordered = [
        (JsonSchemaType::Boolean, LogicalType::Boolean),
        (JsonSchemaType::Integer, LogicalType::Integer),
        (JsonSchemaType::Number, LogicalType::Number),
        (JsonSchemaType::String, LogicalType::String),
        (JsonSchemaType::Array, LogicalType::Json),
        (JsonSchemaType::Object, LogicalType::Json),
    ];
    let mut output = Vec::new();
    for (schema_type, logical_type) in ordered {
        if schema_types.contains(&schema_type) && !output.contains(&logical_type) {
            output.push(logical_type);
        }
    }
    if output.is_empty() {
        return Err(EmitError::InvariantViolation(
            "JSON path has no value type".to_owned(),
        ));
    }
    Ok(output)
}

fn schema_branches(schema: &JsonValueSchema) -> Vec<&JsonValueSchema> {
    std::iter::once(schema)
        .chain(schema.any_of.iter())
        .collect()
}

fn collect_json_types(
    schema: &JsonValueSchema,
    recursive: bool,
    output: &mut BTreeSet<JsonSchemaType>,
) {
    output.extend(schema.types.iter().copied());
    for branch in &schema.any_of {
        collect_json_types(branch, recursive, output);
    }
    if recursive {
        for property in schema.properties.values() {
            collect_json_types(property, true, output);
        }
        if let Some(items) = &schema.items {
            collect_json_types(items, true, output);
        }
    }
}

fn parse_json_path(path: &str) -> Result<Vec<JsonPathSegment>, EmitError> {
    let bytes = path.as_bytes();
    if bytes.first() != Some(&b'$') {
        return Err(EmitError::InvariantViolation(
            "invalid SQLite JSON path".to_owned(),
        ));
    }
    let mut output = Vec::new();
    let mut index = 1;
    while index < bytes.len() {
        if bytes[index] == b'.' {
            index += 1;
            let start = index;
            while index < bytes.len() && !matches!(bytes[index], b'.' | b'[') {
                index += 1;
            }
            if start == index {
                return Err(EmitError::InvariantViolation(
                    "invalid SQLite JSON path".to_owned(),
                ));
            }
            output.push(JsonPathSegment::Property(path[start..index].to_owned()));
        } else if bytes[index] == b'[' {
            index += 1;
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            if start == index || bytes.get(index) != Some(&b']') {
                return Err(EmitError::InvariantViolation(
                    "invalid SQLite JSON path".to_owned(),
                ));
            }
            index += 1;
            output.push(JsonPathSegment::Index);
        } else {
            return Err(EmitError::InvariantViolation(
                "invalid SQLite JSON path".to_owned(),
            ));
        }
    }
    Ok(output)
}

fn expression_nullable(
    expression: &BoundExpr,
    catalog: &Catalog,
    select: Option<&BoundSelect>,
) -> Result<bool, EmitError> {
    match expression {
        BoundExpr::Column(column) => catalog
            .resource_by_id(column.id.resource())
            .and_then(|resource| resource.column_by_id(column.id))
            .map(|descriptor| {
                descriptor.value.nullable
                    || select.is_some_and(|select| {
                        select.joins.iter().any(|join| {
                            join.resource == column.id.resource()
                                && join.kind == policysql_ir::JoinKind::Left
                        })
                    })
            })
            .ok_or(EmitError::UnknownColumn),
        BoundExpr::ScalarFunction {
            function,
            arguments,
            ..
        } => match function {
            ScalarFunction::Lower | ScalarFunction::Upper => arguments
                .first()
                .ok_or_else(|| {
                    EmitError::InvariantViolation("registered function arity".to_owned())
                })
                .and_then(|argument| expression_nullable(argument, catalog, select)),
            ScalarFunction::JsonExtract => Ok(true),
        },
        BoundExpr::Concat(left, right) => Ok(expression_nullable(left, catalog, select)?
            || expression_nullable(right, catalog, select)?),
        BoundExpr::CastText(inner) => expression_nullable(inner, catalog, select),
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => Ok(else_expression.is_none()
            || branches
                .iter()
                .any(|(_, value)| expression_nullable(value, catalog, select).unwrap_or(true))
            || else_expression
                .as_deref()
                .is_some_and(|value| expression_nullable(value, catalog, select).unwrap_or(true))),
        BoundExpr::ClientParameter { .. }
        | BoundExpr::ServerParameter { .. }
        | BoundExpr::Literal(_) => Ok(false),
        _ => Err(EmitError::InvariantViolation(
            "registered function argument".to_owned(),
        )),
    }
}

fn collect_client_parameters(statement: &BoundStatement) -> BTreeSet<ClientParameterName> {
    let mut output = BTreeSet::new();
    let BoundStatement::Select(select) = statement else {
        match statement {
            BoundStatement::JsonCollectionSelect(select) => {
                collect_expression_parameters(&select.path, &mut output);
                if let Some(predicate) = &select.predicate {
                    collect_expression_parameters(predicate, &mut output);
                }
            }
            BoundStatement::Insert(insert) => {
                for row in &insert.rows {
                    for assignment in row {
                        collect_expression_parameters(&assignment.value, &mut output);
                    }
                }
            }
            BoundStatement::Update(update) => {
                for assignment in &update.assignments {
                    collect_expression_parameters(&assignment.value, &mut output);
                }
                if let Some(predicate) = &update.predicate {
                    collect_expression_parameters(predicate, &mut output);
                }
            }
            BoundStatement::Delete(delete) => {
                if let Some(predicate) = &delete.predicate {
                    collect_expression_parameters(predicate, &mut output);
                }
            }
            BoundStatement::Select(_) => unreachable!("handled above"),
            BoundStatement::ConstantSelect(select) => {
                for projection in &select.projections {
                    collect_expression_parameters(&projection.expression, &mut output);
                }
            }
        }
        return output;
    };
    for projection in &select.projections {
        collect_expression_parameters(&projection.expression, &mut output);
    }
    for join in &select.joins {
        collect_expression_parameters(&join.on, &mut output);
    }
    if let Some(predicate) = &select.predicate {
        collect_expression_parameters(predicate, &mut output);
    }
    if let Some(having) = &select.having {
        collect_expression_parameters(having, &mut output);
    }
    if let Some(limit) = &select.limit {
        collect_expression_parameters(limit, &mut output);
    }
    if let Some(offset) = &select.offset {
        collect_expression_parameters(offset, &mut output);
    }
    output
}

fn collect_expression_parameters(
    expression: &BoundExpr,
    output: &mut BTreeSet<ClientParameterName>,
) {
    match expression {
        BoundExpr::ClientParameter { name, .. } => {
            output.insert(name.clone());
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
            collect_expression_parameters(left, output);
            collect_expression_parameters(right, output);
        }
        BoundExpr::Not(inner) | BoundExpr::IsNull(inner) | BoundExpr::CastText(inner) => {
            collect_expression_parameters(inner, output);
        }
        BoundExpr::ScalarFunction { arguments, .. } => {
            for argument in arguments {
                collect_expression_parameters(argument, output);
            }
        }
        BoundExpr::In {
            expression, values, ..
        } => {
            collect_expression_parameters(expression, output);
            for value in values {
                collect_expression_parameters(value, output);
            }
        }
        BoundExpr::Exists(select) => {
            for projection in &select.projections {
                collect_expression_parameters(&projection.expression, output);
            }
            if let Some(predicate) = &select.predicate {
                collect_expression_parameters(predicate, output);
            }
        }
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => {
            for (condition, value) in branches {
                collect_expression_parameters(condition, output);
                collect_expression_parameters(value, output);
            }
            if let Some(value) = else_expression {
                collect_expression_parameters(value, output);
            }
        }
        BoundExpr::Column(_)
        | BoundExpr::ServerParameter { .. }
        | BoundExpr::Literal(_)
        | BoundExpr::CountAll(_)
        | BoundExpr::RowNumber { .. } => {}
    }
}

fn validate_client_parameter_types(
    statement: &BoundStatement,
    values: &BTreeMap<ClientParameterName, LogicalValue>,
) -> Result<(), CompileError> {
    let mut expected = BTreeMap::<ClientParameterName, LogicalType>::new();
    let mut visit =
        |expression: &BoundExpr| collect_expression_parameter_types(expression, &mut expected);
    match statement {
        BoundStatement::Select(select) => {
            for projection in &select.projections {
                visit(&projection.expression)?;
            }
            for join in &select.joins {
                visit(&join.on)?;
            }
            if let Some(value) = &select.predicate {
                visit(value)?;
            }
            if let Some(value) = &select.having {
                visit(value)?;
            }
            if let Some(value) = &select.limit {
                visit(value)?;
            }
            if let Some(value) = &select.offset {
                visit(value)?;
            }
        }
        BoundStatement::ConstantSelect(select) => {
            for projection in &select.projections {
                visit(&projection.expression)?;
            }
        }
        BoundStatement::JsonCollectionSelect(select) => {
            visit(&select.path)?;
            if let Some(predicate) = &select.predicate {
                visit(predicate)?;
            }
        }
        BoundStatement::Insert(insert) => {
            for assignment in insert.rows.iter().flatten() {
                visit(&assignment.value)?;
            }
        }
        BoundStatement::Update(update) => {
            for assignment in &update.assignments {
                visit(&assignment.value)?;
            }
            if let Some(value) = &update.predicate {
                visit(value)?;
            }
        }
        BoundStatement::Delete(delete) => {
            if let Some(value) = &delete.predicate {
                visit(value)?;
            }
        }
    }
    if expected.iter().all(|(name, logical_type)| {
        values
            .get(name)
            .is_some_and(|value| logical_value_matches(value, *logical_type))
    }) {
        Ok(())
    } else {
        Err(CompileError::ClientParameterTypeMismatch)
    }
}

fn validate_client_parameter_contracts(
    statement: &BoundStatement,
    catalog: &Catalog,
    values: &BTreeMap<ClientParameterName, LogicalValue>,
) -> Result<(), CompileError> {
    let visit = |expression: &BoundExpr| validate_expression_contracts(expression, catalog, values);
    match statement {
        BoundStatement::Select(select) => {
            for projection in &select.projections {
                visit(&projection.expression)?;
            }
            for join in &select.joins {
                visit(&join.on)?;
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
                visit(expression)?;
            }
        }
        BoundStatement::ConstantSelect(select) => {
            for projection in &select.projections {
                visit(&projection.expression)?;
            }
        }
        BoundStatement::JsonCollectionSelect(select) => {
            visit(&select.path)?;
            if let Some(predicate) = &select.predicate {
                visit(predicate)?;
            }
        }
        BoundStatement::Insert(insert) => {
            for assignment in insert.rows.iter().flatten() {
                validate_assignment_contract(assignment, catalog, values)?;
            }
        }
        BoundStatement::Update(update) => {
            for assignment in &update.assignments {
                validate_assignment_contract(assignment, catalog, values)?;
            }
            if let Some(predicate) = &update.predicate {
                visit(predicate)?;
            }
        }
        BoundStatement::Delete(delete) => {
            if let Some(predicate) = &delete.predicate {
                visit(predicate)?;
            }
        }
    }
    Ok(())
}

fn validate_assignment_contract(
    assignment: &policysql_ir::BoundAssignment,
    catalog: &Catalog,
    values: &BTreeMap<ClientParameterName, LogicalValue>,
) -> Result<(), CompileError> {
    if let BoundExpr::ClientParameter { name, .. } = &assignment.value {
        validate_column_parameter_contract(&assignment.column, name, catalog, values)?;
    }
    validate_expression_contracts(&assignment.value, catalog, values)
}

fn validate_column_parameter_contract(
    column: &BoundColumn,
    parameter: &ClientParameterName,
    catalog: &Catalog,
    values: &BTreeMap<ClientParameterName, LogicalValue>,
) -> Result<(), CompileError> {
    let descriptor = catalog
        .resource_by_id(column.id.resource())
        .and_then(|resource| resource.column_by_id(column.id))
        .ok_or(CompileError::ClientParameterTypeMismatch)?;
    if values
        .get(parameter)
        .is_some_and(|value| value_satisfies_contract(value, &descriptor.value))
    {
        Ok(())
    } else {
        Err(CompileError::ClientParameterTypeMismatch)
    }
}

fn validate_expression_contracts(
    expression: &BoundExpr,
    catalog: &Catalog,
    values: &BTreeMap<ClientParameterName, LogicalValue>,
) -> Result<(), CompileError> {
    let validate_pair = |left: &BoundExpr, right: &BoundExpr| -> Result<(), CompileError> {
        if let (BoundExpr::Column(column), BoundExpr::ClientParameter { name, .. }) = (left, right)
        {
            validate_column_parameter_contract(column, name, catalog, values)?;
        }
        if let (BoundExpr::ClientParameter { name, .. }, BoundExpr::Column(column)) = (left, right)
        {
            validate_column_parameter_contract(column, name, catalog, values)?;
        }
        Ok(())
    };
    match expression {
        BoundExpr::Equal(left, right)
        | BoundExpr::NotEqual(left, right)
        | BoundExpr::Less(left, right)
        | BoundExpr::LessEqual(left, right)
        | BoundExpr::Greater(left, right)
        | BoundExpr::GreaterEqual(left, right)
        | BoundExpr::Like(left, right)
        | BoundExpr::Glob(left, right)
        | BoundExpr::Least(left, right)
        | BoundExpr::Concat(left, right) => {
            validate_pair(left, right)?;
            validate_expression_contracts(left, catalog, values)?;
            validate_expression_contracts(right, catalog, values)
        }
        BoundExpr::And(left, right) | BoundExpr::Or(left, right) => {
            validate_expression_contracts(left, catalog, values)?;
            validate_expression_contracts(right, catalog, values)
        }
        BoundExpr::Not(value) | BoundExpr::IsNull(value) | BoundExpr::CastText(value) => {
            validate_expression_contracts(value, catalog, values)
        }
        BoundExpr::In {
            expression,
            values: items,
            ..
        } => {
            if let BoundExpr::Column(column) = expression.as_ref() {
                for item in items {
                    if let BoundExpr::ClientParameter { name, .. } = item {
                        validate_column_parameter_contract(column, name, catalog, values)?;
                    }
                }
            }
            validate_expression_contracts(expression, catalog, values)?;
            for item in items {
                validate_expression_contracts(item, catalog, values)?;
            }
            Ok(())
        }
        BoundExpr::ConditionalOutput { value, visible_if } => {
            validate_expression_contracts(value, catalog, values)?;
            validate_expression_contracts(visible_if, catalog, values)
        }
        BoundExpr::Exists(select) => {
            for projection in &select.projections {
                validate_expression_contracts(&projection.expression, catalog, values)?;
            }
            if let Some(predicate) = &select.predicate {
                validate_expression_contracts(predicate, catalog, values)?;
            }
            Ok(())
        }
        BoundExpr::ScalarFunction { arguments, .. } => {
            for argument in arguments {
                validate_expression_contracts(argument, catalog, values)?;
            }
            Ok(())
        }
        BoundExpr::RowNumber { order_by, .. } => {
            for order in order_by {
                validate_expression_contracts(&order.expression, catalog, values)?;
            }
            Ok(())
        }
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => {
            for (condition, value) in branches {
                validate_expression_contracts(condition, catalog, values)?;
                validate_expression_contracts(value, catalog, values)?;
            }
            if let Some(value) = else_expression {
                validate_expression_contracts(value, catalog, values)?;
            }
            Ok(())
        }
        BoundExpr::Column(_)
        | BoundExpr::ClientParameter { .. }
        | BoundExpr::ServerParameter { .. }
        | BoundExpr::Literal(_)
        | BoundExpr::CountAll(_) => Ok(()),
    }
}

fn collect_expression_parameter_types(
    expression: &BoundExpr,
    output: &mut BTreeMap<ClientParameterName, LogicalType>,
) -> Result<(), CompileError> {
    match expression {
        BoundExpr::ClientParameter { name, logical_type } => {
            if output
                .insert(name.clone(), *logical_type)
                .is_some_and(|old| old != *logical_type)
            {
                return Err(CompileError::ClientParameterTypeMismatch);
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
            collect_expression_parameter_types(left, output)?;
            collect_expression_parameter_types(right, output)?;
        }
        BoundExpr::Not(inner) | BoundExpr::IsNull(inner) | BoundExpr::CastText(inner) => {
            collect_expression_parameter_types(inner, output)?;
        }
        BoundExpr::ScalarFunction { arguments, .. } => {
            for argument in arguments {
                collect_expression_parameter_types(argument, output)?;
            }
        }
        BoundExpr::In {
            expression, values, ..
        } => {
            collect_expression_parameter_types(expression, output)?;
            for value in values {
                collect_expression_parameter_types(value, output)?;
            }
        }
        BoundExpr::Exists(select) => {
            for projection in &select.projections {
                collect_expression_parameter_types(&projection.expression, output)?;
            }
            if let Some(predicate) = &select.predicate {
                collect_expression_parameter_types(predicate, output)?;
            }
        }
        BoundExpr::Case {
            branches,
            else_expression,
            ..
        } => {
            for (condition, value) in branches {
                collect_expression_parameter_types(condition, output)?;
                collect_expression_parameter_types(value, output)?;
            }
            if let Some(value) = else_expression {
                collect_expression_parameter_types(value, output)?;
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

const fn logical_value_matches(value: &LogicalValue, expected: LogicalType) -> bool {
    match (value, expected) {
        (
            LogicalValue::String(_),
            LogicalType::String | LogicalType::Date | LogicalType::DateTime | LogicalType::Instant,
        )
        | (LogicalValue::Boolean(_), LogicalType::Boolean)
        | (LogicalValue::Int64(_), LogicalType::Int64)
        | (LogicalValue::Number(_), LogicalType::Number)
        | (LogicalValue::Bytes(_), LogicalType::Bytes)
        | (LogicalValue::Json(_), LogicalType::Json) => true,
        (LogicalValue::Int64(value), LogicalType::Integer) => {
            *value >= -9_007_199_254_740_991 && *value <= 9_007_199_254_740_991
        }
        _ => false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EmitError {
    UnsupportedStatement,
    UnknownResource,
    UnknownColumn,
    MissingServerParameter(String),
    LiteralRequiresParameter,
    UnsupportedValue,
    TooManyLiterals,
    Formatting,
    InvariantViolation(String),
}

impl fmt::Display for EmitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedStatement => formatter.write_str("statement cannot be emitted"),
            Self::UnknownResource => formatter.write_str("protected resource is unavailable"),
            Self::UnknownColumn => formatter.write_str("protected column is unavailable"),
            Self::MissingServerParameter(name) => {
                write!(formatter, "missing server parameter: {name}")
            }
            Self::LiteralRequiresParameter => {
                formatter.write_str("non-numeric literal requires a compiler parameter")
            }
            Self::UnsupportedValue => {
                formatter.write_str("value cannot be represented safely in SQLite")
            }
            Self::TooManyLiterals => formatter.write_str("too many compiler literals"),
            Self::Formatting => formatter.write_str("SQL formatting failed"),
            Self::InvariantViolation(message) => {
                write!(formatter, "emission invariant failed: {message}")
            }
        }
    }
}

impl std::error::Error for EmitError {}

#[derive(Debug)]
pub enum CompileError {
    Emit(EmitError),
    ClientParameterMismatch,
    ClientParameterTypeMismatch,
    Verification(VerificationError),
}

impl fmt::Display for CompileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Emit(error) => error.fmt(formatter),
            Self::ClientParameterMismatch => formatter.write_str("client parameter set mismatch"),
            Self::ClientParameterTypeMismatch => {
                formatter.write_str("client parameter type mismatch")
            }
            Self::Verification(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for CompileError {}

impl From<EmitError> for CompileError {
    fn from(error: EmitError) -> Self {
        Self::Emit(error)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        PROFILE_ID, SqliteInvariantVerifier, SqliteProfile, TypedSqliteEmitter,
        compile_verified_delete, compile_verified_insert, compile_verified_select,
        compile_verified_update, explain_query_plan_sql,
    };
    use policysql_catalog::{Catalog, ResourceDescriptor};
    use policysql_core::{
        BackendProfileId, ClientParameterName, ColumnName, LogicalType, LogicalValue,
        OperationKind, ResourceId, ResourceName, RoleName, SnapshotId, TrustedSession,
        ValueDescriptor, ValueRepresentation,
    };
    use policysql_execution::{
        CandidateExecutionPlan, ExecutionLimits, PlanVerifier, VerificationError,
        VerifiedExecutionPlan,
    };
    use policysql_parser::SqliteFrontend;
    use policysql_policy::PolicyBundle;
    use std::collections::{BTreeMap, BTreeSet};
    use turso_parser::{ast::Cmd, parser::Parser};

    fn snapshot() -> SnapshotId {
        SnapshotId::new("snapshot_1")
            .unwrap_or_else(|error| unreachable!("valid snapshot: {error}"))
    }

    fn catalog() -> Catalog {
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
        .unwrap_or_else(|error| unreachable!("valid descriptor: {error}"));
        Catalog::new(snapshot(), [resource])
            .unwrap_or_else(|error| unreachable!("valid Catalog: {error}"))
    }

    fn protected() -> (policysql_ir::ProtectedPlan, Catalog) {
        let catalog = catalog();
        let sql = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/select/basic-row-policy/input.sql"
        );
        let policy = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/select/basic-row-policy/policy.yaml"
        );
        let statement = SqliteFrontend::default()
            .bind(sql, &catalog)
            .unwrap_or_else(|error| unreachable!("fixture binds: {error}"));
        let bundle = PolicyBundle::activate(policy, &catalog, snapshot())
            .unwrap_or_else(|error| unreachable!("fixture policy activates: {error}"));
        let session = TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("valid role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("valid session: {error}"));
        let output = bundle
            .compile_select(&statement, &session)
            .unwrap_or_else(|error| unreachable!("fixture compiles: {error}"));
        (output.plan, catalog)
    }

    fn limits() -> ExecutionLimits {
        ExecutionLimits {
            max_rows: 100,
            max_result_bytes: 10_000,
            timeout_ms: 1_000,
        }
    }

    fn client_parameters() -> BTreeMap<ClientParameterName, LogicalValue> {
        BTreeMap::from([
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
        ])
    }

    #[test]
    fn emits_reparses_and_seals_fixture_plan() {
        let (plan, catalog) = protected();
        let verified =
            compile_verified_select(&plan, &catalog, client_parameters(), limits(), snapshot())
                .unwrap_or_else(|error| unreachable!("protected fixture verifies: {error}"));
        assert!(verified.protected_sql().starts_with("SELECT "));
        assert!(
            verified
                .protected_sql()
                .contains("__policysql_session_tenant_id")
        );
        assert_eq!(verified.result().len(), 2);
    }

    #[test]
    fn seals_documented_offset_glob_and_scalar_function_surface() {
        let catalog = catalog();
        let statement = SqliteFrontend::default()
            .bind(
                "SELECT LOWER(name) AS normalized_name FROM projects WHERE name GLOB :pattern ORDER BY normalized_name LIMIT :limit OFFSET :offset",
                &catalog,
            )
            .unwrap_or_else(|error| unreachable!("documented SQL binds: {error}"));
        let policy = r"version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, tenant_id, name, status]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
";
        let bundle = PolicyBundle::activate(policy, &catalog, snapshot())
            .unwrap_or_else(|error| unreachable!("policy activates: {error}"));
        let session = TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("session: {error}"));
        let protected = bundle
            .compile_select(&statement, &session)
            .unwrap_or_else(|error| unreachable!("policy compilation: {error}"));
        let parameters = BTreeMap::from([
            (
                ClientParameterName::new("pattern")
                    .unwrap_or_else(|error| unreachable!("parameter: {error}")),
                LogicalValue::String("A*".to_owned()),
            ),
            (
                ClientParameterName::new("limit")
                    .unwrap_or_else(|error| unreachable!("parameter: {error}")),
                LogicalValue::Int64(10),
            ),
            (
                ClientParameterName::new("offset")
                    .unwrap_or_else(|error| unreachable!("parameter: {error}")),
                LogicalValue::Int64(2),
            ),
        ]);
        let verified =
            compile_verified_select(&protected.plan, &catalog, parameters, limits(), snapshot())
                .unwrap_or_else(|error| unreachable!("documented SQL seals: {error}"));
        assert!(verified.protected_sql().contains("LOWER ("));
        assert!(verified.protected_sql().contains(" GLOB "));
        assert!(verified.protected_sql().contains(" OFFSET :offset"));
        assert!(!verified.result()[0].value.nullable);
    }

    #[test]
    fn seals_documented_in_not_in_and_is_not_null_surface() {
        let catalog = catalog();
        let statement = SqliteFrontend::default()
            .bind(
                "SELECT id FROM projects WHERE status IN (:active, :pending) AND name IS NOT NULL AND status NOT IN ('archived')",
                &catalog,
            )
            .unwrap_or_else(|error| unreachable!("documented predicates bind: {error}"));
        let policy = r"version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, tenant_id, name, status]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
";
        let bundle = PolicyBundle::activate(policy, &catalog, snapshot())
            .unwrap_or_else(|error| unreachable!("policy activates: {error}"));
        let session = TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("session: {error}"));
        let protected = bundle
            .compile_select(&statement, &session)
            .unwrap_or_else(|error| unreachable!("policy compilation: {error}"));
        let parameters = BTreeMap::from([
            (
                ClientParameterName::new("active")
                    .unwrap_or_else(|error| unreachable!("parameter: {error}")),
                LogicalValue::String("active".to_owned()),
            ),
            (
                ClientParameterName::new("pending")
                    .unwrap_or_else(|error| unreachable!("parameter: {error}")),
                LogicalValue::String("pending".to_owned()),
            ),
        ]);
        let verified =
            compile_verified_select(&protected.plan, &catalog, parameters, limits(), snapshot())
                .unwrap_or_else(|error| unreachable!("documented predicates seal: {error}"));
        assert!(verified.protected_sql().contains(" IN ("));
        assert!(verified.protected_sql().contains(" NOT IN ("));
        assert!(verified.protected_sql().contains("IS NULL"));
    }

    #[test]
    fn structural_checker_accepts_formatting_and_rejects_ast_mutations() {
        let (plan, catalog) = protected();
        let emitted = TypedSqliteEmitter
            .emit(&plan, &catalog)
            .unwrap_or_else(|error| unreachable!("protected fixture emits: {error}"));
        let expected_clients = client_parameters().keys().cloned().collect::<BTreeSet<_>>();
        let expected_servers = emitted
            .server_parameters
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        let verifier = SqliteInvariantVerifier::new(
            &emitted.sql,
            expected_clients,
            expected_servers,
            Vec::new(),
            snapshot(),
        )
        .unwrap_or_else(|error| unreachable!("valid verifier: {error}"));
        let profile = BackendProfileId::new(PROFILE_ID)
            .unwrap_or_else(|error| unreachable!("valid profile: {error}"));
        let equivalent = CandidateExecutionPlan::<SqliteProfile>::new(
            emitted.sql.replacen("SELECT ", "  select\n", 1),
            OperationKind::Select,
            limits(),
            snapshot(),
            profile.clone(),
        )
        .with_bindings(
            client_parameters(),
            emitted.server_parameters.clone(),
            Vec::new(),
        );
        verifier
            .verify(&equivalent)
            .unwrap_or_else(|error| unreachable!("equivalent AST verifies: {error}"));
        for mutation in [
            format!("{}; SELECT 1", emitted.sql),
            emitted.sql.replacen("\"name\"", "\"tenant_id\"", 1),
            emitted.sql.replacen(":status", ":replacement", 1),
            emitted.sql.replacen(" WHERE ", " WHERE TRUE OR ", 1),
        ] {
            let candidate = CandidateExecutionPlan::<SqliteProfile>::new(
                mutation,
                OperationKind::Select,
                limits(),
                snapshot(),
                profile.clone(),
            )
            .with_bindings(
                client_parameters(),
                emitted.server_parameters.clone(),
                Vec::new(),
            );
            assert!(matches!(
                verifier.verify(&candidate),
                Err(VerificationError::InvariantViolation(_))
            ));
            assert!(VerifiedExecutionPlan::verify(candidate, &verifier).is_err());
        }
    }

    #[test]
    fn explain_query_plan_is_built_as_an_ast_command() {
        let explained = explain_query_plan_sql("SELECT '?' AS marker, :value AS value")
            .unwrap_or_else(|error| unreachable!("EXPLAIN construction: {error}"));
        let parsed = Parser::new(explained.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .unwrap_or_else(|error| unreachable!("EXPLAIN parses: {error}"));
        assert_eq!(parsed.len(), 1);
        assert!(matches!(parsed.first(), Some(Cmd::ExplainQueryPlan(_))));
        assert!(explained.contains("'?'"));
        assert!(explained.contains(":value"));
    }

    #[test]
    fn exact_client_parameter_set_is_required() {
        let (plan, catalog) = protected();
        let mut parameters = client_parameters();
        parameters.remove(
            &ClientParameterName::new("limit")
                .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
        );
        assert!(
            compile_verified_select(&plan, &catalog, parameters, limits(), snapshot()).is_err()
        );

        let mut parameters = client_parameters();
        parameters.insert(
            ClientParameterName::new("limit")
                .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
            LogicalValue::String("200".to_owned()),
        );
        assert!(matches!(
            compile_verified_select(&plan, &catalog, parameters, limits(), snapshot()),
            Err(super::CompileError::ClientParameterTypeMismatch)
        ));
    }

    #[test]
    fn wire_values_match_documented_semantic_types() {
        for logical_type in [
            LogicalType::String,
            LogicalType::Date,
            LogicalType::DateTime,
            LogicalType::Instant,
        ] {
            assert!(super::logical_value_matches(
                &LogicalValue::String("2026-08-12T00:00:00Z".to_owned()),
                logical_type
            ));
        }
        assert!(super::logical_value_matches(
            &LogicalValue::Int64(9_007_199_254_740_991),
            LogicalType::Integer
        ));
        assert!(!super::logical_value_matches(
            &LogicalValue::Int64(9_007_199_254_740_992),
            LogicalType::Integer
        ));
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn join_policies_cover_every_resource_and_left_policy_stays_in_on() {
        let descriptor = ValueDescriptor {
            logical_type: LogicalType::String,
            representation: ValueRepresentation::String,
            nullable: false,
            format: None,
            storage: None,
            constraints: None,
            json_schema: None,
        };
        let make_resource = |id, name: &str, columns: &[&str]| {
            ResourceDescriptor::new(
                ResourceId::new(id).unwrap_or_else(|error| unreachable!("valid ID: {error}")),
                ResourceName::new(name)
                    .unwrap_or_else(|error| unreachable!("valid resource: {error}")),
                columns.iter().map(|name| {
                    (
                        ColumnName::new(*name)
                            .unwrap_or_else(|error| unreachable!("valid column: {error}")),
                        descriptor.clone(),
                    )
                }),
            )
            .unwrap_or_else(|error| unreachable!("valid resource: {error}"))
        };
        let catalog = Catalog::new(
            snapshot(),
            [
                make_resource(1, "projects", &["id", "tenant_id", "name"]),
                make_resource(2, "tasks", &["id", "project_id", "tenant_id", "title"]),
            ],
        )
        .unwrap_or_else(|error| unreachable!("valid Catalog: {error}"));
        let policy = PolicyBundle::activate(
            r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, name]
          filter: { tenant_id: { eq: { session: tenant_id } } }
  tasks:
    roles:
      member:
        select:
          columns: [id, project_id, title]
          filter: { tenant_id: { eq: { session: tenant_id } } }
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
        for (join, policy_in_on) in [("INNER JOIN", false), ("LEFT JOIN", true)] {
            let sql = format!(
                "SELECT p.id, t.title FROM projects p {join} tasks t ON t.project_id = p.id"
            );
            let statement = SqliteFrontend::default()
                .bind(&sql, &catalog)
                .unwrap_or_else(|error| unreachable!("join binds: {error}"));
            let protected = policy
                .compile_select(&statement, &session)
                .unwrap_or_else(|error| unreachable!("join authorizes: {error}"));
            assert_eq!(protected.plan.applied_policies.len(), 2);
            let verified = compile_verified_select(
                &protected.plan,
                &catalog,
                BTreeMap::new(),
                limits(),
                snapshot(),
            )
            .unwrap_or_else(|error| unreachable!("join verifies: {error}"));
            let sql = verified.protected_sql();
            let on = sql
                .find(" ON ")
                .unwrap_or_else(|| unreachable!("emitted join has ON"));
            let where_clause = sql
                .find(" WHERE ")
                .unwrap_or_else(|| unreachable!("emitted join has WHERE"));
            let joined_policy = sql[on..where_clause].contains("\"__policysql_t1\".\"tenant_id\"");
            assert_eq!(joined_policy, policy_in_on);
        }
        let correlated = SqliteFrontend::default()
            .bind(
                "SELECT p.id FROM projects p WHERE EXISTS (SELECT t.id FROM tasks t WHERE t.project_id = p.id)",
                &catalog,
            )
            .unwrap_or_else(|error| unreachable!("correlated EXISTS binds: {error}"));
        let protected = policy
            .compile_select(&correlated, &session)
            .unwrap_or_else(|error| unreachable!("correlated EXISTS authorizes: {error}"));
        assert_eq!(protected.plan.applied_policies.len(), 2);
        let verified = compile_verified_select(
            &protected.plan,
            &catalog,
            BTreeMap::new(),
            limits(),
            snapshot(),
        )
        .unwrap_or_else(|error| unreachable!("correlated EXISTS verifies: {error}"));
        assert!(verified.protected_sql().contains("EXISTS (SELECT"));
        assert!(
            verified
                .protected_sql()
                .contains("\"__policysql_t1\".\"tenant_id\"")
        );
    }

    #[test]
    fn count_group_having_requires_policy_gate_and_verifies() {
        let catalog = catalog();
        let sql = "SELECT tenant_id, COUNT(*) AS item_count FROM projects GROUP BY tenant_id HAVING COUNT(*) > :minimum";
        let statement = SqliteFrontend::default()
            .bind(sql, &catalog)
            .unwrap_or_else(|error| unreachable!("aggregate binds: {error}"));
        let policy = |allowed| {
            PolicyBundle::activate(
                &format!(
                    r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [tenant_id]
          filter: {{ tenant_id: {{ eq: {{ session: tenant_id }} }} }}
          allow_aggregations: {allowed}
"
                ),
                &catalog,
                snapshot(),
            )
        };
        let session = TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("valid role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("valid session: {error}"));
        let denied = policy(false)
            .unwrap_or_else(|error| unreachable!("disabled policy activates: {error}"));
        assert!(denied.compile_select(&statement, &session).is_err());
        let allowed = policy(true)
            .unwrap_or_else(|error| unreachable!("aggregate policy activates: {error}"));
        let protected = allowed
            .compile_select(&statement, &session)
            .unwrap_or_else(|error| unreachable!("aggregate authorizes: {error}"));
        let parameters = BTreeMap::from([(
            ClientParameterName::new("minimum")
                .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
            LogicalValue::Int64(0),
        )]);
        let verified =
            compile_verified_select(&protected.plan, &catalog, parameters, limits(), snapshot())
                .unwrap_or_else(|error| unreachable!("aggregate verifies: {error}"));
        assert!(verified.protected_sql().contains("COUNT (*)"));
        assert!(verified.protected_sql().contains(" GROUP BY "));
        assert!(verified.protected_sql().contains(" HAVING "));
        assert_eq!(verified.result()[1].value.logical_type, LogicalType::Int64);
    }

    #[test]
    fn row_number_requires_window_gate_and_regular_columns() {
        let catalog = catalog();
        let statement = SqliteFrontend::default()
            .bind(
                "SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY name) AS position FROM projects",
                &catalog,
            )
            .unwrap_or_else(|error| unreachable!("window binds: {error}"));
        let yaml = |allowed| {
            format!(
                r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, tenant_id, name]
          filter: {{ tenant_id: {{ eq: {{ session: tenant_id }} }} }}
          allow_windows: {allowed}
"
            )
        };
        let session = TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("valid role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("valid session: {error}"));
        let denied = PolicyBundle::activate(&yaml(false), &catalog, snapshot())
            .unwrap_or_else(|error| unreachable!("disabled policy activates: {error}"));
        assert!(denied.compile_select(&statement, &session).is_err());
        let allowed = PolicyBundle::activate(&yaml(true), &catalog, snapshot())
            .unwrap_or_else(|error| unreachable!("enabled policy activates: {error}"));
        let protected = allowed
            .compile_select(&statement, &session)
            .unwrap_or_else(|error| unreachable!("window authorizes: {error}"));
        let verified = compile_verified_select(
            &protected.plan,
            &catalog,
            BTreeMap::new(),
            limits(),
            snapshot(),
        )
        .unwrap_or_else(|error| unreachable!("window verifies: {error}"));
        assert!(verified.protected_sql().contains("ROW_NUMBER () OVER"));
        assert_eq!(verified.result()[1].value.logical_type, LogicalType::Int64);
    }

    #[test]
    fn insert_presets_and_post_state_check_are_sealed_together() {
        let catalog = catalog();
        let policy = PolicyBundle::activate(
            include_str!(
                "../../../tests/fixtures/sqlite-turso-v1/mutation/insert-values/policy.yaml"
            ),
            &catalog,
            snapshot(),
        )
        .unwrap_or_else(|error| unreachable!("INSERT policy activates: {error}"));
        let statement = SqliteFrontend::default()
            .bind(
                include_str!(
                    "../../../tests/fixtures/sqlite-turso-v1/mutation/insert-values/input.sql"
                ),
                &catalog,
            )
            .unwrap_or_else(|error| unreachable!("INSERT binds: {error}"));
        let session = TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("valid role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("valid session: {error}"));
        let protected = policy
            .compile_insert(&statement, &session)
            .unwrap_or_else(|error| unreachable!("INSERT authorizes: {error}"));
        let parameters = BTreeMap::from([
            (
                ClientParameterName::new("id")
                    .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
                LogicalValue::String("p1".to_owned()),
            ),
            (
                ClientParameterName::new("name")
                    .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
                LogicalValue::String("Created".to_owned()),
            ),
        ]);
        let verified =
            compile_verified_insert(&protected.plan, &catalog, parameters, limits(), snapshot())
                .unwrap_or_else(|error| unreachable!("INSERT verifies: {error}"));
        assert_eq!(verified.operation(), OperationKind::Insert);
        assert_eq!(verified.expected_affected_rows(), Some(1));
        assert_eq!(
            verified.protected_sql(),
            include_str!("../../../tests/fixtures/sqlite-turso-v1/mutation/insert-values/expected/protected.sql").trim()
        );
        assert!(
            verified
                .protected_sql()
                .contains("__policysql_session_tenant_id")
        );

        let bypass = SqliteFrontend::default()
            .bind(
                "INSERT INTO projects (id, name, tenant_id) VALUES (:id, :name, :tenant_id)",
                &catalog,
            )
            .unwrap_or_else(|error| unreachable!("preset bypass binds: {error}"));
        assert!(policy.compile_insert(&bypass, &session).is_err());
    }

    #[test]
    fn update_delete_and_returning_are_policy_compiled_and_sealed() {
        let catalog = catalog();
        let bundle = PolicyBundle::activate(
            include_str!(
                "../../../tests/fixtures/sqlite-turso-v1/mutation/update-filtered/policy.yaml"
            ),
            &catalog,
            snapshot(),
        )
        .unwrap_or_else(|error| unreachable!("mutation policy activates: {error}"));
        let session = TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("valid role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("valid session: {error}"));
        let update = SqliteFrontend::default()
            .bind(
                include_str!(
                    "../../../tests/fixtures/sqlite-turso-v1/mutation/update-filtered/input.sql"
                ),
                &catalog,
            )
            .unwrap_or_else(|error| unreachable!("UPDATE binds: {error}"));
        let update = bundle
            .compile_update(&update, &session)
            .unwrap_or_else(|error| unreachable!("UPDATE policy compiles: {error}"));
        let parameters = BTreeMap::from([
            (
                ClientParameterName::new("id")
                    .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
                LogicalValue::String("project_1".to_owned()),
            ),
            (
                ClientParameterName::new("name")
                    .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
                LogicalValue::String("renamed".to_owned()),
            ),
        ]);
        let verified =
            compile_verified_update(&update.plan, &catalog, parameters, limits(), snapshot())
                .unwrap_or_else(|error| unreachable!("UPDATE verifies: {error}"));
        assert!(verified.protected_sql().contains("tenant_id"));
        assert!(verified.protected_sql().contains("__policysql_check"));
        assert_eq!(verified.result().len(), 2);
        assert_eq!(
            verified.protected_sql(),
            include_str!("../../../tests/fixtures/sqlite-turso-v1/mutation/update-filtered/expected/protected.sql").trim()
        );

        let delete_bundle = PolicyBundle::activate(
            include_str!(
                "../../../tests/fixtures/sqlite-turso-v1/mutation/delete-filtered/policy.yaml"
            ),
            &catalog,
            snapshot(),
        )
        .unwrap_or_else(|error| unreachable!("DELETE policy activates: {error}"));
        let delete = SqliteFrontend::default()
            .bind(
                include_str!(
                    "../../../tests/fixtures/sqlite-turso-v1/mutation/delete-filtered/input.sql"
                ),
                &catalog,
            )
            .unwrap_or_else(|error| unreachable!("DELETE binds: {error}"));
        let delete = delete_bundle
            .compile_delete(&delete, &session)
            .unwrap_or_else(|error| unreachable!("DELETE policy compiles: {error}"));
        let parameters = BTreeMap::from([(
            ClientParameterName::new("id")
                .unwrap_or_else(|error| unreachable!("valid parameter: {error}")),
            LogicalValue::String("project_1".to_owned()),
        )]);
        let verified =
            compile_verified_delete(&delete.plan, &catalog, parameters, limits(), snapshot())
                .unwrap_or_else(|error| unreachable!("DELETE verifies: {error}"));
        assert!(verified.protected_sql().contains("tenant_id"));
        assert!(!verified.protected_sql().contains("__policysql_check"));
        assert_eq!(verified.result().len(), 1);
        assert_eq!(
            verified.protected_sql(),
            include_str!("../../../tests/fixtures/sqlite-turso-v1/mutation/delete-filtered/expected/protected.sql").trim()
        );
    }
}
