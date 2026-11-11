//! Layer 1: bounded exhaustive enumeration over a reduced alphabet.
//!
//! Every statement of the grammar below, up to a size bound, is produced exactly once, in a
//! deterministic order (size ascending, then root). Statements are streamed to a visitor; only the
//! sub-expression lists (a few thousand entries at size 4) are memoised.
//!
//! Sizes: a column or literal is 1; `lower(x)` / `upper(x)` / `CAST(x AS TEXT)` is 1 + x;
//! `x || y` is 1 + x + y; `CASE` is 1 + p + x + y; `x = y` is 1 + x + y; `x <> L`, `x < L`, `LIKE`,
//! `IN`, `IS [NOT] NULL` are 1 + x; `NOT`, `AND`, `OR` add 1; `EXISTS (...)` is 1 + the inner
//! predicate (over a resource that is not yet in scope); `COUNT(*) > k` is 1. A JOIN is 1 + its ON
//! predicate; GROUP BY is 1 (+ 1 + HAVING predicate); ORDER BY and LIMIT are 1 each.
//!
//! The counts are pinned by `layer1_counts_match_reference` against an independent counter
//! (`handoff/proto/count_l1.py`).

use super::alphabet::{Alphabet, Lit, ResourceIdx};
use super::ast::{
    CmpOp, ColRef, Delete, ExistsProjection, ExistsQuery, Join, JoinKind, Limit, OrderBy,
    OrderTarget, Pred, Projection, Qualifier, Returning, Scalar, Select, Source, Statement, Update,
    Value,
};
use std::collections::HashMap;
use std::rc::Rc;

/// One enumerated statement.
#[derive(Debug)]
pub struct Layer1Item<'a> {
    /// 0-based position in the enumeration order.
    pub ordinal: u64,
    /// The size (for mutations: the size of the WHERE predicate, 0 when there is none).
    pub size: usize,
    pub statement: &'a Statement,
}

/// Visits every SELECT of size at most `max_size`.
pub fn for_each_select(
    alphabet: &Alphabet,
    max_size: usize,
    visit: &mut dyn FnMut(Layer1Item<'_>),
) {
    let mut enumerator = Enumerator::new(alphabet);
    let mut ordinal = 0_u64;
    for size in 1..=max_size {
        for root in 0..alphabet.resources.len() {
            enumerator.selects_of_size(root, size, &mut |statement| {
                visit(Layer1Item {
                    ordinal,
                    size,
                    statement,
                });
                ordinal += 1;
            });
        }
    }
}

/// Visits every UPDATE and DELETE whose WHERE predicate has size at most `max_predicate_size`.
pub fn for_each_mutation(
    alphabet: &Alphabet,
    max_predicate_size: usize,
    visit: &mut dyn FnMut(Layer1Item<'_>),
) {
    let mut enumerator = Enumerator::new(alphabet);
    let mut ordinal = 0_u64;
    let mut emit = |size: usize, statement: &Statement| {
        visit(Layer1Item {
            ordinal,
            size,
            statement,
        });
        ordinal += 1;
    };
    for size in 0..=max_predicate_size {
        for table in 0..alphabet.resources.len() {
            let scope = Scope(vec![ScopeEntry {
                resource: table,
                qualifier: Qualifier::Table(table),
            }]);
            let predicates: Vec<Option<Pred>> = if size == 0 {
                vec![None]
            } else {
                enumerator
                    .preds(size, &scope, false)
                    .iter()
                    .cloned()
                    .map(Some)
                    .collect()
            };
            for predicate in &predicates {
                for column in alphabet.all_columns(table) {
                    for lit in alphabet.all_literals() {
                        for returning in [Returning::None, Returning::Id] {
                            emit(
                                size,
                                &Statement::Update(Update {
                                    resource: table,
                                    assignments: vec![(column, Value::Lit(lit))],
                                    predicate: predicate.clone(),
                                    returning,
                                }),
                            );
                        }
                    }
                }
                for returning in [Returning::None, Returning::Id] {
                    emit(
                        size,
                        &Statement::Delete(Delete {
                            resource: table,
                            predicate: predicate.clone(),
                            returning,
                        }),
                    );
                }
            }
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ScopeEntry {
    resource: ResourceIdx,
    qualifier: Qualifier,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Scope(Vec<ScopeEntry>);

impl Scope {
    fn contains(&self, resource: ResourceIdx) -> bool {
        self.0.iter().any(|entry| entry.resource == resource)
    }

    fn exists_depth(&self) -> u8 {
        let depth = self
            .0
            .iter()
            .filter(|entry| matches!(entry.qualifier, Qualifier::Exists { .. }))
            .count();
        u8::try_from(depth + 1).unwrap_or(u8::MAX)
    }

    fn with(&self, entry: ScopeEntry) -> Self {
        let mut entries = self.0.clone();
        entries.push(entry);
        Self(entries)
    }
}

type Key = (usize, Scope, bool);

struct Enumerator<'a> {
    alphabet: &'a Alphabet,
    scalar_cache: HashMap<Key, Rc<Vec<Scalar>>>,
    pred_cache: HashMap<Key, Rc<Vec<Pred>>>,
    item_cache: HashMap<(usize, Scope), Rc<Vec<Projection>>>,
    sequence_cache: HashMap<(usize, Scope), Rc<Vec<Vec<Projection>>>>,
}

impl<'a> Enumerator<'a> {
    fn new(alphabet: &'a Alphabet) -> Self {
        Self {
            alphabet,
            scalar_cache: HashMap::new(),
            pred_cache: HashMap::new(),
            item_cache: HashMap::new(),
            sequence_cache: HashMap::new(),
        }
    }

    fn columns(&self, scope: &Scope) -> Vec<ColRef> {
        scope
            .0
            .iter()
            .flat_map(|entry| {
                self.alphabet
                    .all_columns(entry.resource)
                    .into_iter()
                    .map(|column| ColRef {
                        qualifier: entry.qualifier,
                        resource: entry.resource,
                        column,
                    })
            })
            .collect()
    }

    fn scalars(&mut self, n: usize, scope: &Scope, agg: bool) -> Rc<Vec<Scalar>> {
        let key = (n, scope.clone(), agg);
        if let Some(cached) = self.scalar_cache.get(&key) {
            return Rc::clone(cached);
        }
        let mut out = Vec::new();
        if n == 1 {
            out.extend(self.columns(scope).into_iter().map(Scalar::Column));
            out.extend(
                self.alphabet
                    .all_literals()
                    .into_iter()
                    .map(|lit| Scalar::Value(Value::Lit(lit))),
            );
            if agg {
                out.push(Scalar::CountText);
            }
        } else if n >= 2 {
            let inner = self.scalars(n - 1, scope, agg);
            for scalar in inner.iter() {
                out.push(Scalar::Lower(Box::new(scalar.clone())));
                out.push(Scalar::Upper(Box::new(scalar.clone())));
                out.push(Scalar::CastText(Box::new(scalar.clone())));
            }
            for a in 1..n.saturating_sub(1) {
                let left = self.scalars(a, scope, agg);
                let right = self.scalars(n - 1 - a, scope, agg);
                for l in left.iter() {
                    for r in right.iter() {
                        out.push(Scalar::Concat(Box::new(l.clone()), Box::new(r.clone())));
                    }
                }
            }
            for a in 1..n.saturating_sub(1) {
                for b in 1..n.saturating_sub(1 + a) {
                    let c = n - 1 - a - b;
                    let whens = self.preds(a, scope, agg);
                    let thens = self.scalars(b, scope, agg);
                    let others = self.scalars(c, scope, agg);
                    for when in whens.iter() {
                        for then in thens.iter() {
                            for otherwise in others.iter() {
                                out.push(Scalar::Case {
                                    when: Box::new(when.clone()),
                                    then: Box::new(then.clone()),
                                    otherwise: Box::new(otherwise.clone()),
                                });
                            }
                        }
                    }
                }
            }
        }
        let out = Rc::new(out);
        self.scalar_cache.insert(key, Rc::clone(&out));
        out
    }

    fn preds(&mut self, n: usize, scope: &Scope, agg: bool) -> Rc<Vec<Pred>> {
        let key = (n, scope.clone(), agg);
        if let Some(cached) = self.pred_cache.get(&key) {
            return Rc::clone(cached);
        }
        let mut out = Vec::new();
        if n == 1 && agg {
            out.extend((0..=2).map(Pred::CountGt));
        }
        if n >= 2 {
            self.comparisons(n, scope, agg, &mut out);
            let inner = self.preds(n - 1, scope, agg);
            for pred in inner.iter() {
                out.push(Pred::Not(Box::new(pred.clone())));
            }
            for a in 1..n.saturating_sub(1) {
                let left = self.preds(a, scope, agg);
                let right = self.preds(n - 1 - a, scope, agg);
                for l in left.iter() {
                    for r in right.iter() {
                        out.push(Pred::And(Box::new(l.clone()), Box::new(r.clone())));
                        out.push(Pred::Or(Box::new(l.clone()), Box::new(r.clone())));
                    }
                }
            }
            for resource in 0..self.alphabet.resources.len() {
                if scope.contains(resource) {
                    continue;
                }
                let depth = scope.exists_depth();
                let inner_scope = scope.with(ScopeEntry {
                    resource,
                    qualifier: Qualifier::Exists { depth },
                });
                let inner = self.preds(n - 1, &inner_scope, false);
                for projection in [ExistsProjection::One, ExistsProjection::Key] {
                    for predicate in inner.iter() {
                        out.push(Pred::Exists(Box::new(ExistsQuery {
                            resource,
                            depth,
                            projection,
                            predicate: predicate.clone(),
                        })));
                    }
                }
            }
        }
        let out = Rc::new(out);
        self.pred_cache.insert(key, Rc::clone(&out));
        out
    }

    fn comparisons(&mut self, n: usize, scope: &Scope, agg: bool, out: &mut Vec<Pred>) {
        for a in 1..n.saturating_sub(1) {
            let left = self.scalars(a, scope, agg);
            let right = self.scalars(n - 1 - a, scope, agg);
            for l in left.iter() {
                for r in right.iter() {
                    out.push(Pred::Cmp {
                        op: CmpOp::Eq,
                        left: l.clone(),
                        right: r.clone(),
                    });
                }
            }
        }
        let operands = self.scalars(n - 1, scope, agg);
        let literals: Vec<Lit> = self.alphabet.all_literals();
        for op in [CmpOp::Ne, CmpOp::Lt] {
            for lit in &literals {
                for operand in operands.iter() {
                    out.push(Pred::Cmp {
                        op,
                        left: operand.clone(),
                        right: Scalar::Value(Value::Lit(*lit)),
                    });
                }
            }
        }
        for operand in operands.iter() {
            out.push(Pred::Like(operand.clone()));
            out.push(Pred::In {
                expr: operand.clone(),
                negated: false,
                ty: super::alphabet::ValueType::Text,
            });
            out.push(Pred::IsNull(operand.clone()));
            out.push(Pred::IsNotNull(operand.clone()));
        }
    }

    fn items(&mut self, k: usize, scope: &Scope) -> Rc<Vec<Projection>> {
        let key = (k, scope.clone());
        if let Some(cached) = self.item_cache.get(&key) {
            return Rc::clone(cached);
        }
        let mut out: Vec<Projection> = self
            .scalars(k, scope, true)
            .iter()
            .cloned()
            .map(Projection::Expr)
            .collect();
        let columns = self.columns(scope);
        if k == 1 {
            out.push(Projection::CountAll);
        }
        if k == 2 {
            for order_by in &columns {
                for desc in [false, true] {
                    out.push(Projection::RowNumber {
                        partition_by: None,
                        order_by: *order_by,
                        desc,
                    });
                }
            }
        }
        if k == 3 {
            for partition in &columns {
                for order_by in &columns {
                    for desc in [false, true] {
                        out.push(Projection::RowNumber {
                            partition_by: Some(*partition),
                            order_by: *order_by,
                            desc,
                        });
                    }
                }
            }
        }
        let out = Rc::new(out);
        self.item_cache.insert(key, Rc::clone(&out));
        out
    }

    /// Ordered sequences of 1..=3 projection items whose sizes add up to `total`.
    fn sequences(&mut self, total: usize, scope: &Scope) -> Rc<Vec<Vec<Projection>>> {
        let key = (total, scope.clone());
        if let Some(cached) = self.sequence_cache.get(&key) {
            return Rc::clone(cached);
        }
        let mut out: Vec<Vec<Projection>> = Vec::new();
        out.extend(self.items(total, scope).iter().map(|p| vec![p.clone()]));
        for a in 1..total {
            let first = self.items(a, scope);
            let second = self.items(total - a, scope);
            for f in first.iter() {
                for s in second.iter() {
                    out.push(vec![f.clone(), s.clone()]);
                }
            }
        }
        for a in 1..total {
            for b in 1..total.saturating_sub(a) {
                let c = total - a - b;
                let first = self.items(a, scope);
                let second = self.items(b, scope);
                let third = self.items(c, scope);
                for f in first.iter() {
                    for s in second.iter() {
                        for t in third.iter() {
                            out.push(vec![f.clone(), s.clone(), t.clone()]);
                        }
                    }
                }
            }
        }
        let out = Rc::new(out);
        self.sequence_cache.insert(key, Rc::clone(&out));
        out
    }

    /// FROM clauses of one root by size: `(size, scope, join)`.
    fn froms(&mut self, root: ResourceIdx, max: usize) -> Vec<(usize, Scope, Option<Join>)> {
        let root_entry = ScopeEntry {
            resource: root,
            qualifier: Qualifier::Outer(root),
        };
        let mut out = vec![(0, Scope(vec![root_entry.clone()]), None)];
        for other in 0..self.alphabet.resources.len() {
            if other == root {
                continue;
            }
            let scope = Scope(vec![
                root_entry.clone(),
                ScopeEntry {
                    resource: other,
                    qualifier: Qualifier::Outer(other),
                },
            ]);
            for on_size in 1..max {
                let ons = self.preds(on_size, &scope, false);
                for kind in [JoinKind::Inner, JoinKind::Left] {
                    for on in ons.iter() {
                        out.push((
                            1 + on_size,
                            scope.clone(),
                            Some(Join {
                                kind,
                                resource: other,
                                on: on.clone(),
                            }),
                        ));
                    }
                }
            }
        }
        out
    }

    fn selects_of_size(
        &mut self,
        root: ResourceIdx,
        size: usize,
        visit: &mut dyn FnMut(&Statement),
    ) {
        let froms = self.froms(root, size);
        for (from_size, scope, join) in &froms {
            if *from_size >= size {
                continue;
            }
            let columns = self.columns(scope);
            for projection_size in 1..=(size - from_size) {
                let sequences = self.sequences(projection_size, scope);
                let rest = size - from_size - projection_size;
                self.selects_with_tail(
                    root,
                    scope,
                    join.as_ref(),
                    &columns,
                    &sequences,
                    rest,
                    visit,
                );
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn selects_with_tail(
        &mut self,
        root: ResourceIdx,
        scope: &Scope,
        join: Option<&Join>,
        columns: &[ColRef],
        sequences: &[Vec<Projection>],
        rest: usize,
        visit: &mut dyn FnMut(&Statement),
    ) {
        for where_size in 0..=rest {
            let wheres: Vec<Option<Pred>> = if where_size == 0 {
                vec![None]
            } else {
                self.preds(where_size, scope, false)
                    .iter()
                    .cloned()
                    .map(Some)
                    .collect()
            };
            for group_size in 0..=(rest - where_size) {
                let groups = self.groups(group_size, scope, columns);
                if groups.is_empty() {
                    continue;
                }
                for order_size in 0..=1_usize.min(rest - where_size - group_size) {
                    let limit_size = rest - where_size - group_size - order_size;
                    if limit_size > 1 {
                        continue;
                    }
                    let limits: Vec<Option<Limit>> = if limit_size == 0 {
                        vec![None]
                    } else {
                        let mut forms = Vec::new();
                        for count in 1..=3 {
                            for offset in [false, true] {
                                forms.push(Some(Limit {
                                    count: Value::Lit(Lit::Int(count)),
                                    offset,
                                }));
                            }
                        }
                        forms
                    };
                    for sequence in sequences {
                        let orders = order_targets(order_size, columns, sequence.len());
                        for predicate in &wheres {
                            for (group_by, having) in &groups {
                                for order_by in &orders {
                                    for limit in &limits {
                                        let statement = Statement::Select(Box::new(Select {
                                            source: Source::Table(root),
                                            join: join.cloned(),
                                            projections: sequence.clone(),
                                            predicate: predicate.clone(),
                                            group_by: *group_by,
                                            having: having.clone(),
                                            order_by: *order_by,
                                            limit: *limit,
                                        }));
                                        visit(&statement);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// GROUP BY forms of an exact size: none (0), `GROUP BY c` (1), `GROUP BY c HAVING q` (1 + q, so
    /// size 2 is `HAVING COUNT(*) > k`).
    fn groups(
        &mut self,
        size: usize,
        scope: &Scope,
        columns: &[ColRef],
    ) -> Vec<(Option<ColRef>, Option<Pred>)> {
        match size {
            0 => vec![(None, None)],
            1 => columns.iter().map(|c| (Some(*c), None)).collect(),
            _ => {
                let having = self.preds(size - 1, scope, true);
                let mut out = Vec::new();
                for column in columns {
                    for predicate in having.iter() {
                        out.push((Some(*column), Some(predicate.clone())));
                    }
                }
                out
            }
        }
    }
}

fn order_targets(size: usize, columns: &[ColRef], outputs: usize) -> Vec<Option<OrderBy>> {
    if size == 0 {
        return vec![None];
    }
    let mut out = Vec::new();
    let targets = columns
        .iter()
        .map(|c| OrderTarget::Column(*c))
        .chain((0..outputs).map(OrderTarget::Output));
    for target in targets {
        for desc in [false, true] {
            out.push(Some(OrderBy { target, desc }));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::alphabet::{ColumnClass, ColumnSpec, ResourceSpec, ValueType};
    use super::*;

    fn reduced() -> Alphabet {
        let column = |name, class| ColumnSpec {
            name,
            class,
            ty: ValueType::Text,
        };
        let resource = |name, alias, columns: [(&'static str, ColumnClass); 4]| ResourceSpec {
            name,
            alias,
            key: 0,
            columns: columns.into_iter().map(|(n, c)| column(n, c)).collect(),
        };
        Alphabet {
            resources: vec![
                resource(
                    "posts",
                    "p",
                    [
                        ("id", ColumnClass::Regular),
                        ("title", ColumnClass::Regular),
                        ("note", ColumnClass::Conditional),
                        ("secret", ColumnClass::Forbidden),
                    ],
                ),
                resource(
                    "comments",
                    "c",
                    [
                        ("post_id", ColumnClass::Regular),
                        ("body", ColumnClass::Regular),
                        ("memo", ColumnClass::Conditional),
                        ("secret", ColumnClass::Forbidden),
                    ],
                ),
            ],
            text_literals: vec!["a", "x"],
            int_literals: vec![],
        }
    }

    #[test]
    fn small_sizes_match_the_reference_counts() {
        let alphabet = reduced();
        let mut by_size = [0_u64; 4];
        let mut last = None;
        for_each_select(&alphabet, 3, &mut |item| {
            by_size[item.size] += 1;
            assert_eq!(
                Some(item.ordinal),
                last.map_or(Some(0), |l: u64| Some(l + 1))
            );
            last = Some(item.ordinal);
        });
        assert_eq!(by_size, [0, 16, 506, 9_160]);
        let mut mutations = 0_u64;
        for_each_mutation(&alphabet, 2, &mut |_| mutations += 1);
        assert_eq!(mutations, 1_764);
    }
}
