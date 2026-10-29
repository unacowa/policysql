//! Conservative byte-parameter nullability from bound column uses. Unknown
//! contexts remain non-nullable; a shared parameter must satisfy every use.
use policysql_catalog::Catalog;
use policysql_core::{ClientParameterName, LogicalType};
use policysql_ir::{BoundColumn, BoundExpr, BoundSelect, BoundStatement};
use std::collections::BTreeMap;

pub(super) fn bytes(
    statement: &BoundStatement,
    catalog: &Catalog,
) -> BTreeMap<ClientParameterName, bool> {
    let mut visitor = Visitor {
        catalog,
        output: BTreeMap::new(),
    };
    match statement {
        BoundStatement::Select(select) => visitor.select(select),
        BoundStatement::ConstantSelect(select) => {
            for projection in &select.projections {
                visitor.expr(&projection.expression, false);
            }
        }
        BoundStatement::JsonCollectionSelect(select) => {
            visitor.expr(&select.path, false);
            if let Some(predicate) = &select.predicate {
                visitor.expr(predicate, false);
            }
        }
        BoundStatement::Insert(insert) => {
            for assignment in insert.rows.iter().flatten() {
                visitor.expr(&assignment.value, visitor.nullable(&assignment.column));
            }
        }
        BoundStatement::Update(update) => {
            for assignment in &update.assignments {
                visitor.expr(&assignment.value, visitor.nullable(&assignment.column));
            }
            if let Some(predicate) = &update.predicate {
                visitor.expr(predicate, false);
            }
        }
        BoundStatement::Delete(delete) => {
            if let Some(predicate) = &delete.predicate {
                visitor.expr(predicate, false);
            }
        }
    }
    visitor.output
}

struct Visitor<'a> {
    catalog: &'a Catalog,
    output: BTreeMap<ClientParameterName, bool>,
}

impl Visitor<'_> {
    fn nullable(&self, column: &BoundColumn) -> bool {
        self.catalog
            .resource_by_id(column.id.resource())
            .and_then(|resource| resource.column_by_id(column.id))
            .is_some_and(|column| column.value.nullable)
    }

    fn column_nullable(&self, expression: &BoundExpr) -> bool {
        matches!(expression, BoundExpr::Column(column) if self.nullable(column))
    }

    fn select(&mut self, select: &BoundSelect) {
        for projection in &select.projections {
            self.expr(&projection.expression, false);
        }
        for join in &select.joins {
            self.expr(&join.on, false);
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
            self.expr(expression, false);
        }
        for order in &select.order_by {
            self.expr(&order.expression, false);
        }
    }

    fn expr(&mut self, expression: &BoundExpr, nullable: bool) {
        match expression {
            BoundExpr::ClientParameter { name, logical_type } => {
                if *logical_type == LogicalType::Bytes {
                    self.output
                        .entry(name.clone())
                        .and_modify(|allowed| *allowed &= nullable)
                        .or_insert(nullable);
                }
            }
            BoundExpr::Equal(left, right)
            | BoundExpr::NotEqual(left, right)
            | BoundExpr::Less(left, right)
            | BoundExpr::LessEqual(left, right)
            | BoundExpr::Greater(left, right)
            | BoundExpr::GreaterEqual(left, right) => {
                self.expr(left, self.column_nullable(right));
                self.expr(right, self.column_nullable(left));
            }
            BoundExpr::And(left, right)
            | BoundExpr::Or(left, right)
            | BoundExpr::Like(left, right)
            | BoundExpr::Glob(left, right)
            | BoundExpr::Least(left, right)
            | BoundExpr::Concat(left, right)
            | BoundExpr::ConditionalOutput {
                value: left,
                visible_if: right,
            } => {
                self.expr(left, false);
                self.expr(right, false);
            }
            BoundExpr::Not(inner) | BoundExpr::IsNull(inner) | BoundExpr::CastText(inner) => {
                self.expr(inner, false);
            }
            BoundExpr::In {
                expression, values, ..
            } => {
                self.expr(expression, false);
                for value in values {
                    self.expr(value, self.column_nullable(expression));
                }
            }
            BoundExpr::ScalarFunction { arguments, .. } => {
                for argument in arguments {
                    self.expr(argument, false);
                }
            }
            BoundExpr::Exists(select) => self.select(select),
            BoundExpr::Case {
                branches,
                else_expression,
                ..
            } => {
                for (condition, value) in branches {
                    self.expr(condition, false);
                    self.expr(value, false);
                }
                if let Some(value) = else_expression {
                    self.expr(value, false);
                }
            }
            BoundExpr::RowNumber { order_by, .. } => {
                for order in order_by {
                    self.expr(&order.expression, false);
                }
            }
            BoundExpr::Column(_)
            | BoundExpr::ServerParameter { .. }
            | BoundExpr::Literal(_)
            | BoundExpr::CountAll(_) => {}
        }
    }
}
