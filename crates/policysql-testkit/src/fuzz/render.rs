//! Rendering statements to SQL text, and collecting the client parameters they use.
//!
//! The rules match what the binder accepts (measured on `main`, see the module docs of
//! [`crate::fuzz`]): a projection is never parenthesised at the top level, scalar expressions use
//! no parentheses, and the children of `AND` / `OR` / `NOT` always do.

use super::alphabet::{Alphabet, ValueType};
use super::ast::{
    CmpOp, ColRef, Delete, ExistsProjection, ExistsQuery, Join, JoinKind, Limit, Lit, OrderBy,
    OrderTarget, Pred, Projection, Qualifier, Returning, Scalar, Select, Source, Statement, Update,
    Value,
};
use std::fmt::Write as _;

/// SQL text of the statement.
#[must_use]
pub fn to_sql(statement: &Statement, alphabet: &Alphabet) -> String {
    render(statement, alphabet).0
}

/// Client parameters (`p<index>` and the bound literal), in order of appearance, without
/// duplicates.
#[must_use]
pub fn client_parameters(statement: &Statement, alphabet: &Alphabet) -> Vec<(String, Lit)> {
    render(statement, alphabet).1
}

/// Both at once, for callers that need the two (one traversal).
#[must_use]
pub fn render(statement: &Statement, alphabet: &Alphabet) -> (String, Vec<(String, Lit)>) {
    let mut writer = Writer {
        alphabet,
        out: String::new(),
        params: Vec::new(),
    };
    match statement {
        Statement::Select(select) => writer.select(select),
        Statement::Update(update) => writer.update(update),
        Statement::Delete(delete) => writer.delete(delete),
    }
    (writer.out, writer.params)
}

/// Renders one literal as SQL.
#[must_use]
pub fn literal_sql(lit: Lit) -> String {
    match lit {
        Lit::Text(text) => format!("'{text}'"),
        Lit::Int(value) => value.to_string(),
    }
}

struct Writer<'a> {
    alphabet: &'a Alphabet,
    out: String,
    params: Vec<(String, Lit)>,
}

impl Writer<'_> {
    fn push(&mut self, text: &str) {
        self.out.push_str(text);
    }

    fn column(&mut self, column: ColRef) {
        let qualifier = match column.qualifier {
            Qualifier::Outer(resource) => self.alphabet.resource_alias(resource).to_owned(),
            Qualifier::Exists { depth } => format!("e{depth}"),
            Qualifier::Table(resource) => self.alphabet.resource_name(resource).to_owned(),
            Qualifier::Derived => "s".to_owned(),
        };
        let name = self.alphabet.column_name(column.resource, column.column);
        let _ = write!(self.out, "{qualifier}.{name}");
    }

    fn value(&mut self, value: Value) {
        match value {
            Value::Lit(lit) => self.push(&literal_sql(lit)),
            Value::Param { index, value } => {
                let name = format!("p{index}");
                let _ = write!(self.out, ":{name}");
                if !self.params.iter().any(|(existing, _)| *existing == name) {
                    self.params.push((name, value));
                }
            }
        }
    }

    fn scalar(&mut self, scalar: &Scalar) {
        match scalar {
            Scalar::Column(column) => self.column(*column),
            Scalar::Value(value) => self.value(*value),
            Scalar::Lower(inner) => self.function("lower", inner),
            Scalar::Upper(inner) => self.function("upper", inner),
            Scalar::CastText(inner) => {
                self.push("CAST(");
                self.scalar(inner);
                self.push(" AS TEXT)");
            }
            Scalar::Concat(left, right) => {
                self.scalar(left);
                self.push(" || ");
                self.scalar(right);
            }
            Scalar::Case {
                when,
                then,
                otherwise,
            } => {
                self.push("CASE WHEN ");
                self.pred(when);
                self.push(" THEN ");
                self.scalar(then);
                self.push(" ELSE ");
                self.scalar(otherwise);
                self.push(" END");
            }
            Scalar::CountText => self.push("CAST(COUNT(*) AS TEXT)"),
        }
    }

    fn function(&mut self, name: &str, argument: &Scalar) {
        self.push(name);
        self.push("(");
        self.scalar(argument);
        self.push(")");
    }

    fn paren_pred(&mut self, pred: &Pred) {
        self.push("(");
        self.pred(pred);
        self.push(")");
    }

    fn pred(&mut self, pred: &Pred) {
        match pred {
            Pred::Cmp { op, left, right } => {
                self.scalar(left);
                self.push(match op {
                    CmpOp::Eq => " = ",
                    CmpOp::Ne => " <> ",
                    CmpOp::Lt => " < ",
                    CmpOp::Le => " <= ",
                    CmpOp::Gt => " > ",
                    CmpOp::Ge => " >= ",
                });
                self.scalar(right);
            }
            Pred::Like(expr) => {
                self.scalar(expr);
                self.push(" LIKE 'a%'");
            }
            Pred::Glob(expr) => {
                self.scalar(expr);
                self.push(" GLOB 'a*'");
            }
            Pred::In { expr, negated, ty } => {
                self.scalar(expr);
                self.push(if *negated { " NOT IN " } else { " IN " });
                self.push(match ty {
                    ValueType::Text => "('a', 'x', 'open')",
                    ValueType::Int => "(0, 1, 2)",
                });
            }
            Pred::IsNull(expr) => {
                self.scalar(expr);
                self.push(" IS NULL");
            }
            Pred::IsNotNull(expr) => {
                self.scalar(expr);
                self.push(" IS NOT NULL");
            }
            Pred::Not(inner) => {
                self.push("NOT ");
                self.paren_pred(inner);
            }
            Pred::And(left, right) => {
                self.paren_pred(left);
                self.push(" AND ");
                self.paren_pred(right);
            }
            Pred::Or(left, right) => {
                self.paren_pred(left);
                self.push(" OR ");
                self.paren_pred(right);
            }
            Pred::Exists(query) => self.exists(query),
            Pred::CountGt(n) => {
                let _ = write!(self.out, "COUNT(*) > {n}");
            }
        }
    }

    fn exists(&mut self, query: &ExistsQuery) {
        let alias = format!("e{}", query.depth);
        let table = self.alphabet.resource_name(query.resource);
        self.push("EXISTS (SELECT ");
        match query.projection {
            ExistsProjection::One => self.push("1"),
            ExistsProjection::Key => {
                let key = self
                    .alphabet
                    .resource(query.resource)
                    .map_or("?", |r| self.alphabet.column_name(query.resource, r.key));
                let _ = write!(self.out, "{alias}.{key}");
            }
        }
        let _ = write!(self.out, " FROM {table} {alias} WHERE ");
        self.pred(&query.predicate);
        self.push(")");
    }

    fn projection(&mut self, projection: &Projection) {
        match projection {
            Projection::Expr(scalar) => self.scalar(scalar),
            Projection::CountAll => self.push("COUNT(*)"),
            Projection::RowNumber {
                partition_by,
                order_by,
                desc,
            } => {
                self.push("ROW_NUMBER() OVER (");
                if let Some(partition) = partition_by {
                    self.push("PARTITION BY ");
                    self.column(*partition);
                    self.push(" ");
                }
                self.push("ORDER BY ");
                self.column(*order_by);
                if *desc {
                    self.push(" DESC");
                }
                self.push(")");
            }
        }
    }

    fn derived_inner(&mut self, resource: usize, columns: &[usize], predicate: Option<&Pred>) {
        self.push("SELECT ");
        for (index, column) in columns.iter().enumerate() {
            if index > 0 {
                self.push(", ");
            }
            self.column(ColRef {
                qualifier: Qualifier::Derived,
                resource,
                column: *column,
            });
        }
        let _ = write!(
            self.out,
            " FROM {} s",
            self.alphabet.resource_name(resource)
        );
        if let Some(predicate) = predicate {
            self.push(" WHERE ");
            self.pred(predicate);
        }
    }

    fn join(&mut self, join: &Join) {
        self.push(match join.kind {
            JoinKind::Inner => " JOIN ",
            JoinKind::Left => " LEFT JOIN ",
        });
        let _ = write!(
            self.out,
            "{} {} ON ",
            self.alphabet.resource_name(join.resource),
            self.alphabet.resource_alias(join.resource)
        );
        self.pred(&join.on);
    }

    fn order_by(&mut self, order: &OrderBy) {
        self.push(" ORDER BY ");
        match order.target {
            OrderTarget::Column(column) => self.column(column),
            OrderTarget::Output(index) => {
                let _ = write!(self.out, "o{index}");
            }
        }
        if order.desc {
            self.push(" DESC");
        }
    }

    fn limit(&mut self, limit: &Limit) {
        self.push(" LIMIT ");
        self.value(limit.count);
        if limit.offset {
            self.push(" OFFSET 1");
        }
    }

    fn select(&mut self, select: &Select) {
        let root = select.source.resource();
        let alias = self.alphabet.resource_alias(root);
        if let Source::Derived {
            resource,
            columns,
            predicate,
            as_cte: true,
        } = &select.source
        {
            self.push("WITH d AS (");
            self.derived_inner(*resource, columns, predicate.as_ref());
            self.push(") ");
        }
        self.push("SELECT ");
        for (index, projection) in select.projections.iter().enumerate() {
            if index > 0 {
                self.push(", ");
            }
            self.projection(projection);
            let _ = write!(self.out, " AS o{index}");
        }
        self.push(" FROM ");
        match &select.source {
            Source::Table(resource) => {
                let _ = write!(
                    self.out,
                    "{} {}",
                    self.alphabet.resource_name(*resource),
                    alias
                );
            }
            Source::Derived {
                resource,
                columns,
                predicate,
                as_cte,
            } => {
                if *as_cte {
                    let _ = write!(self.out, "d {alias}");
                } else {
                    self.push("(");
                    self.derived_inner(*resource, columns, predicate.as_ref());
                    let _ = write!(self.out, ") {alias}");
                }
            }
        }
        if let Some(join) = &select.join {
            self.join(join);
        }
        if let Some(predicate) = &select.predicate {
            self.push(" WHERE ");
            self.pred(predicate);
        }
        if let Some(group) = select.group_by {
            self.push(" GROUP BY ");
            self.column(group);
            if let Some(having) = &select.having {
                self.push(" HAVING ");
                self.pred(having);
            }
        }
        if let Some(order) = &select.order_by {
            self.order_by(order);
        }
        if let Some(limit) = &select.limit {
            self.limit(limit);
        }
    }

    fn returning(&mut self, resource: usize, returning: &Returning) {
        let table = self.alphabet.resource_name(resource);
        match returning {
            Returning::None => {}
            Returning::Id => {
                let _ = write!(self.out, " RETURNING {table}.id");
            }
            Returning::Columns(columns) => {
                self.push(" RETURNING ");
                for (index, column) in columns.iter().enumerate() {
                    if index > 0 {
                        self.push(", ");
                    }
                    let name = self.alphabet.column_name(resource, *column);
                    let _ = write!(self.out, "{table}.{name}");
                }
            }
        }
    }

    fn update(&mut self, update: &Update) {
        let table = self.alphabet.resource_name(update.resource);
        let _ = write!(self.out, "UPDATE {table} SET ");
        for (index, (column, value)) in update.assignments.iter().enumerate() {
            if index > 0 {
                self.push(", ");
            }
            let name = self.alphabet.column_name(update.resource, *column);
            let _ = write!(self.out, "{name} = ");
            self.value(*value);
        }
        if let Some(predicate) = &update.predicate {
            self.push(" WHERE ");
            self.pred(predicate);
        }
        self.returning(update.resource, &update.returning);
    }

    fn delete(&mut self, delete: &Delete) {
        let table = self.alphabet.resource_name(delete.resource);
        let _ = write!(self.out, "DELETE FROM {table}");
        if let Some(predicate) = &delete.predicate {
            self.push(" WHERE ");
            self.pred(predicate);
        }
        self.returning(delete.resource, &delete.returning);
    }
}

#[cfg(test)]
mod tests {
    use super::super::alphabet::{ColumnClass, ColumnSpec, ResourceSpec};
    use super::super::ast::{Qualifier, Value};
    use super::*;

    fn alphabet() -> Alphabet {
        let column = |name, class| ColumnSpec {
            name,
            class,
            ty: ValueType::Text,
        };
        Alphabet {
            resources: vec![
                ResourceSpec {
                    name: "posts",
                    alias: "p",
                    key: 0,
                    columns: vec![
                        column("id", ColumnClass::Regular),
                        column("title", ColumnClass::Regular),
                        column("secret", ColumnClass::Forbidden),
                    ],
                },
                ResourceSpec {
                    name: "comments",
                    alias: "c",
                    key: 0,
                    columns: vec![
                        column("post_id", ColumnClass::Regular),
                        column("body", ColumnClass::Regular),
                    ],
                },
            ],
            text_literals: vec!["a", "x"],
            int_literals: vec![],
        }
    }

    fn col(resource: usize, column: usize) -> ColRef {
        ColRef {
            qualifier: Qualifier::Outer(resource),
            resource,
            column,
        }
    }

    #[test]
    fn renders_a_select_with_exists_and_parameter() {
        let alphabet = alphabet();
        let inner = ColRef {
            qualifier: Qualifier::Exists { depth: 1 },
            resource: 1,
            column: 0,
        };
        let select = Select {
            source: Source::Table(0),
            join: None,
            projections: vec![
                Projection::Expr(Scalar::Concat(
                    Box::new(Scalar::Column(col(0, 0))),
                    Box::new(Scalar::Column(col(0, 1))),
                )),
                Projection::CountAll,
            ],
            predicate: Some(Pred::And(
                Box::new(Pred::Exists(Box::new(ExistsQuery {
                    resource: 1,
                    depth: 1,
                    projection: ExistsProjection::Key,
                    predicate: Pred::Cmp {
                        op: CmpOp::Eq,
                        left: Scalar::Column(inner),
                        right: Scalar::Column(col(0, 0)),
                    },
                }))),
                Box::new(Pred::Cmp {
                    op: CmpOp::Ne,
                    left: Scalar::Column(col(0, 1)),
                    right: Scalar::Value(Value::Param {
                        index: 0,
                        value: Lit::Text("a"),
                    }),
                }),
            )),
            group_by: Some(col(0, 1)),
            having: Some(Pred::CountGt(1)),
            order_by: Some(OrderBy {
                target: OrderTarget::Output(0),
                desc: true,
            }),
            limit: Some(Limit {
                count: Value::Lit(Lit::Int(2)),
                offset: true,
            }),
        };
        let statement = Statement::Select(Box::new(select));
        assert_eq!(
            to_sql(&statement, &alphabet),
            "SELECT p.id || p.title AS o0, COUNT(*) AS o1 FROM posts p WHERE \
             (EXISTS (SELECT e1.post_id FROM comments e1 WHERE e1.post_id = p.id)) AND \
             (p.title <> :p0) GROUP BY p.title HAVING COUNT(*) > 1 ORDER BY o0 DESC LIMIT 2 OFFSET 1"
        );
        assert_eq!(
            client_parameters(&statement, &alphabet),
            vec![("p0".to_owned(), Lit::Text("a"))]
        );
    }

    #[test]
    fn renders_cte_and_mutations() {
        let alphabet = alphabet();
        let cte = Statement::Select(Box::new(Select {
            source: Source::Derived {
                resource: 0,
                columns: vec![0, 1],
                predicate: Some(Pred::IsNotNull(Scalar::Column(ColRef {
                    qualifier: Qualifier::Derived,
                    resource: 0,
                    column: 1,
                }))),
                as_cte: true,
            },
            join: None,
            projections: vec![Projection::Expr(Scalar::Column(col(0, 0)))],
            predicate: None,
            group_by: None,
            having: None,
            order_by: None,
            limit: None,
        }));
        assert_eq!(
            to_sql(&cte, &alphabet),
            "WITH d AS (SELECT s.id, s.title FROM posts s WHERE s.title IS NOT NULL) \
             SELECT p.id AS o0 FROM d p"
        );
        let table = |column| ColRef {
            qualifier: Qualifier::Table(0),
            resource: 0,
            column,
        };
        let update = Statement::Update(Update {
            resource: 0,
            assignments: vec![(1, Value::Lit(Lit::Text("a")))],
            predicate: Some(Pred::Not(Box::new(Pred::Like(Scalar::Column(table(1)))))),
            returning: Returning::Id,
        });
        assert_eq!(
            to_sql(&update, &alphabet),
            "UPDATE posts SET title = 'a' WHERE NOT (posts.title LIKE 'a%') RETURNING posts.id"
        );
        let delete = Statement::Delete(Delete {
            resource: 0,
            predicate: None,
            returning: Returning::Columns(vec![0, 1]),
        });
        assert_eq!(
            to_sql(&delete, &alphabet),
            "DELETE FROM posts RETURNING posts.id, posts.title"
        );
    }
}
