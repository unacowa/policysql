//! Facts about a generated statement, computed from the AST (never from the SQL text).

use super::alphabet::{Alphabet, ColumnClass, ResourceIdx};
use super::ast::{
    CmpOp, ColRef, ExistsQuery, OrderTarget, Pred, Projection, Returning, Scalar, Select, Source,
    Statement, Value,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum StatementKind {
    Select,
    Update,
    Delete,
}

/// Where in a statement a node sits. Nodes inside an EXISTS count in the slot of the EXISTS.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Slot {
    Projection,
    JoinOn,
    Where,
    GroupBy,
    Having,
    OrderBy,
    Limit,
    DerivedWhere,
    SetValue,
    MutationWhere,
    Returning,
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum NodeKind {
    RegularColumn,
    ConditionalColumn,
    ForbiddenColumn,
    Literal,
    Parameter,
    Lower,
    Upper,
    CastText,
    Concat,
    Case,
    CountText,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Like,
    Glob,
    In,
    NotIn,
    IsNull,
    IsNotNull,
    Not,
    And,
    Or,
    Exists,
    CountGt,
    CountAll,
    RowNumber,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StatementMeta {
    pub kind: StatementKind,
    /// The root, the JOIN target, the inside of a derived table / CTE, and the target of every
    /// EXISTS in every slot at every depth.
    pub resources_read: BTreeSet<ResourceIdx>,
    /// `COUNT(*)` anywhere, or GROUP BY / HAVING.
    pub aggregation: bool,
    /// `ROW_NUMBER() OVER (...)` anywhere.
    pub window: bool,
    /// Rows must be compared in order: a top-level ORDER BY without a window function.
    pub ordered: bool,
    /// The roles of every column the statement mentions.
    pub column_classes: BTreeSet<ColumnClass>,
    /// How often each (slot, node kind) occurs; for reports, never for verdicts.
    pub slot_nodes: BTreeMap<(Slot, NodeKind), u32>,
}

/// Computes the facts about a statement.
#[must_use]
pub fn meta(statement: &Statement, alphabet: &Alphabet) -> StatementMeta {
    let mut walker = Walker {
        alphabet,
        slot: Slot::Projection,
        resources_read: BTreeSet::new(),
        aggregation: false,
        window: false,
        column_classes: BTreeSet::new(),
        slot_nodes: BTreeMap::new(),
    };
    let (kind, ordered) = match statement {
        Statement::Select(select) => {
            walker.select(select);
            (
                StatementKind::Select,
                select.order_by.is_some() && !walker.window,
            )
        }
        Statement::Update(update) => {
            walker.resources_read.insert(update.resource);
            walker.slot = Slot::SetValue;
            for (column, value) in &update.assignments {
                walker.column_class(update.resource, *column);
                walker.value(*value);
            }
            walker.slot = Slot::MutationWhere;
            if let Some(predicate) = &update.predicate {
                walker.pred(predicate);
            }
            walker.returning(update.resource, &update.returning);
            (StatementKind::Update, false)
        }
        Statement::Delete(delete) => {
            walker.resources_read.insert(delete.resource);
            walker.slot = Slot::MutationWhere;
            if let Some(predicate) = &delete.predicate {
                walker.pred(predicate);
            }
            walker.returning(delete.resource, &delete.returning);
            (StatementKind::Delete, false)
        }
    };
    StatementMeta {
        kind,
        resources_read: walker.resources_read,
        aggregation: walker.aggregation,
        window: walker.window,
        ordered,
        column_classes: walker.column_classes,
        slot_nodes: walker.slot_nodes,
    }
}

struct Walker<'a> {
    alphabet: &'a Alphabet,
    slot: Slot,
    resources_read: BTreeSet<ResourceIdx>,
    aggregation: bool,
    window: bool,
    column_classes: BTreeSet<ColumnClass>,
    slot_nodes: BTreeMap<(Slot, NodeKind), u32>,
}

impl Walker<'_> {
    fn count(&mut self, kind: NodeKind) {
        *self.slot_nodes.entry((self.slot, kind)).or_insert(0) += 1;
    }

    fn column_class(&mut self, resource: ResourceIdx, column: usize) -> Option<ColumnClass> {
        let class = self.alphabet.column(resource, column).map(|c| c.class)?;
        self.column_classes.insert(class);
        Some(class)
    }

    fn column(&mut self, column: ColRef) {
        if let Some(class) = self.column_class(column.resource, column.column) {
            self.count(match class {
                ColumnClass::Regular => NodeKind::RegularColumn,
                ColumnClass::Conditional => NodeKind::ConditionalColumn,
                ColumnClass::Forbidden => NodeKind::ForbiddenColumn,
            });
        }
    }

    fn value(&mut self, value: Value) {
        self.count(match value {
            Value::Lit(_) => NodeKind::Literal,
            Value::Param { .. } => NodeKind::Parameter,
        });
    }

    fn scalar(&mut self, scalar: &Scalar) {
        match scalar {
            Scalar::Column(column) => self.column(*column),
            Scalar::Value(value) => self.value(*value),
            Scalar::Lower(inner) => {
                self.count(NodeKind::Lower);
                self.scalar(inner);
            }
            Scalar::Upper(inner) => {
                self.count(NodeKind::Upper);
                self.scalar(inner);
            }
            Scalar::CastText(inner) => {
                self.count(NodeKind::CastText);
                self.scalar(inner);
            }
            Scalar::Concat(left, right) => {
                self.count(NodeKind::Concat);
                self.scalar(left);
                self.scalar(right);
            }
            Scalar::Case {
                when,
                then,
                otherwise,
            } => {
                self.count(NodeKind::Case);
                self.pred(when);
                self.scalar(then);
                self.scalar(otherwise);
            }
            Scalar::CountText => {
                self.aggregation = true;
                self.count(NodeKind::CountText);
            }
        }
    }

    fn pred(&mut self, pred: &Pred) {
        match pred {
            Pred::Cmp { op, left, right } => {
                self.count(match op {
                    CmpOp::Eq => NodeKind::Eq,
                    CmpOp::Ne => NodeKind::Ne,
                    CmpOp::Lt => NodeKind::Lt,
                    CmpOp::Le => NodeKind::Le,
                    CmpOp::Gt => NodeKind::Gt,
                    CmpOp::Ge => NodeKind::Ge,
                });
                self.scalar(left);
                self.scalar(right);
            }
            Pred::Like(expr) => {
                self.count(NodeKind::Like);
                self.scalar(expr);
            }
            Pred::Glob(expr) => {
                self.count(NodeKind::Glob);
                self.scalar(expr);
            }
            Pred::In { expr, negated, .. } => {
                self.count(if *negated {
                    NodeKind::NotIn
                } else {
                    NodeKind::In
                });
                self.scalar(expr);
            }
            Pred::IsNull(expr) => {
                self.count(NodeKind::IsNull);
                self.scalar(expr);
            }
            Pred::IsNotNull(expr) => {
                self.count(NodeKind::IsNotNull);
                self.scalar(expr);
            }
            Pred::Not(inner) => {
                self.count(NodeKind::Not);
                self.pred(inner);
            }
            Pred::And(left, right) => {
                self.count(NodeKind::And);
                self.pred(left);
                self.pred(right);
            }
            Pred::Or(left, right) => {
                self.count(NodeKind::Or);
                self.pred(left);
                self.pred(right);
            }
            Pred::Exists(query) => self.exists(query),
            Pred::CountGt(_) => {
                self.aggregation = true;
                self.count(NodeKind::CountGt);
            }
        }
    }

    fn exists(&mut self, query: &ExistsQuery) {
        self.count(NodeKind::Exists);
        self.resources_read.insert(query.resource);
        self.pred(&query.predicate);
    }

    fn returning(&mut self, resource: ResourceIdx, returning: &Returning) {
        self.slot = Slot::Returning;
        match returning {
            Returning::None => {}
            Returning::Id => {
                // `id` has no column index in the reduced alphabet; count it as a regular column.
                self.count(NodeKind::RegularColumn);
                self.column_classes.insert(ColumnClass::Regular);
            }
            Returning::Columns(columns) => {
                for column in columns {
                    if let Some(class) = self.column_class(resource, *column) {
                        self.count(match class {
                            ColumnClass::Regular => NodeKind::RegularColumn,
                            ColumnClass::Conditional => NodeKind::ConditionalColumn,
                            ColumnClass::Forbidden => NodeKind::ForbiddenColumn,
                        });
                    }
                }
            }
        }
    }

    fn select(&mut self, select: &Select) {
        self.resources_read.insert(select.source.resource());
        if let Source::Derived {
            resource,
            columns,
            predicate,
            ..
        } = &select.source
        {
            self.slot = Slot::DerivedWhere;
            for column in columns {
                self.column(ColRef {
                    qualifier: super::ast::Qualifier::Derived,
                    resource: *resource,
                    column: *column,
                });
            }
            if let Some(predicate) = predicate {
                self.pred(predicate);
            }
        }
        if let Some(join) = &select.join {
            self.resources_read.insert(join.resource);
            self.slot = Slot::JoinOn;
            self.pred(&join.on);
        }
        self.slot = Slot::Projection;
        for projection in &select.projections {
            match projection {
                Projection::Expr(scalar) => self.scalar(scalar),
                Projection::CountAll => {
                    self.aggregation = true;
                    self.count(NodeKind::CountAll);
                }
                Projection::RowNumber {
                    partition_by,
                    order_by,
                    ..
                } => {
                    self.window = true;
                    self.count(NodeKind::RowNumber);
                    if let Some(partition) = partition_by {
                        self.column(*partition);
                    }
                    self.column(*order_by);
                }
            }
        }
        if let Some(predicate) = &select.predicate {
            self.slot = Slot::Where;
            self.pred(predicate);
        }
        if let Some(group) = select.group_by {
            self.aggregation = true;
            self.slot = Slot::GroupBy;
            self.column(group);
            if let Some(having) = &select.having {
                self.slot = Slot::Having;
                self.pred(having);
            }
        }
        if let Some(order) = &select.order_by {
            self.slot = Slot::OrderBy;
            if let OrderTarget::Column(column) = order.target {
                self.column(column);
            }
        }
        if let Some(limit) = &select.limit {
            self.slot = Slot::Limit;
            self.value(limit.count);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::alphabet::{ColumnSpec, ResourceSpec, ValueType};
    use super::super::ast::{ExistsProjection, Qualifier};
    use super::*;

    #[test]
    fn exists_in_having_is_read_and_aggregation_is_detected() {
        let column = |name, class| ColumnSpec {
            name,
            class,
            ty: ValueType::Text,
        };
        let alphabet = Alphabet {
            resources: vec![
                ResourceSpec {
                    name: "posts",
                    alias: "p",
                    key: 0,
                    columns: vec![
                        column("id", ColumnClass::Regular),
                        column("secret", ColumnClass::Forbidden),
                    ],
                },
                ResourceSpec {
                    name: "comments",
                    alias: "c",
                    key: 0,
                    columns: vec![column("post_id", ColumnClass::Regular)],
                },
            ],
            text_literals: vec!["a"],
            int_literals: vec![],
        };
        let id = ColRef {
            qualifier: Qualifier::Outer(0),
            resource: 0,
            column: 0,
        };
        let statement = Statement::Select(Box::new(Select {
            source: Source::Table(0),
            join: None,
            projections: vec![Projection::Expr(Scalar::Column(id))],
            predicate: None,
            group_by: Some(id),
            having: Some(Pred::Exists(Box::new(ExistsQuery {
                resource: 1,
                depth: 1,
                projection: ExistsProjection::One,
                predicate: Pred::Cmp {
                    op: CmpOp::Eq,
                    left: Scalar::Column(id),
                    right: Scalar::Value(Value::Lit(super::super::ast::Lit::Text("a"))),
                },
            }))),
            order_by: None,
            limit: None,
        }));
        let facts = meta(&statement, &alphabet);
        assert_eq!(facts.kind, StatementKind::Select);
        assert!(facts.aggregation && !facts.window && !facts.ordered);
        assert_eq!(facts.resources_read, BTreeSet::from([0, 1]));
        assert_eq!(
            facts.slot_nodes.get(&(Slot::Having, NodeKind::Exists)),
            Some(&1)
        );
        assert_eq!(
            facts.slot_nodes.get(&(Slot::Having, NodeKind::Eq)),
            Some(&1)
        );
    }
}
