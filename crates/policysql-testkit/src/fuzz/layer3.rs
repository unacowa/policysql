//! Layer 3: naive random generation over the full alphabet (nightly, millions of statements).
//!
//! No structure is assumed beyond the grammar. Each statement draws a `bad` rate (0, 3, 8 or 15
//! percent) and, for every column reference, picks a forbidden or conditional column with that
//! probability, so the same run covers statements that are almost always acceptable and statements
//! that touch protected columns everywhere. Types are respected, except with probability 0.02, to
//! reach the binder's rejection path. The statement `i` of a seed is reproduced from
//! `XorShift64::new(mix(&[seed, LAYER3_TAG, i]))`.

use super::alphabet::{Alphabet, ColumnClass, ColumnIdx, Lit, ResourceIdx, ValueType};
use super::ast::{
    CmpOp, ColRef, Delete, ExistsProjection, ExistsQuery, Join, JoinKind, Limit, OrderBy,
    OrderTarget, Pred, Projection, Qualifier, Returning, Scalar, Select, Source, Statement, Update,
    Value,
};
use super::rng::XorShift64;

/// Mixed into the seed of every layer-3 statement so layers never share a stream.
pub const LAYER3_TAG: u64 = 0x1a73_0003;

#[derive(Clone, Debug)]
pub struct Layer3Config {
    /// Depth bound of scalar and predicate trees (default 3).
    pub max_depth: u8,
    /// Chance, per thousand, that a literal becomes a client parameter (default 200).
    pub param_probability_per_mille: u16,
    /// Columns a client is normally allowed to write (and have returned): UPDATE assignments and
    /// RETURNING lists draw from these except with the `bad` probability. The generator knows no
    /// schema, so the caller says which they are.
    pub preferred_writes: Vec<(ResourceIdx, ColumnIdx)>,
}

impl Default for Layer3Config {
    fn default() -> Self {
        Self {
            max_depth: 3,
            param_probability_per_mille: 200,
            preferred_writes: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
struct Entry {
    resource: ResourceIdx,
    qualifier: Qualifier,
    /// Columns that may be referenced (a derived table exposes only what its inner SELECT chose).
    columns: Vec<ColumnIdx>,
}

struct Gen<'a> {
    alphabet: &'a Alphabet,
    rng: &'a mut XorShift64,
    config: &'a Layer3Config,
    /// Percent chance that a column reference is forbidden or conditional.
    bad: u16,
    next_param: u16,
}

impl Gen<'_> {
    fn new_entry(&self, resource: ResourceIdx, qualifier: Qualifier) -> Entry {
        Entry {
            resource,
            qualifier,
            columns: self.alphabet.all_columns(resource),
        }
    }

    fn literal(&mut self, ty: ValueType) -> Lit {
        let literals = self.alphabet.literals(ty);
        self.rng.pick(&literals).copied().unwrap_or(match ty {
            ValueType::Text => Lit::Text("a"),
            ValueType::Int => Lit::Int(0),
        })
    }

    fn value(&mut self, lit: Lit) -> Value {
        if self.rng.chance(self.config.param_probability_per_mille) {
            let index = self.next_param;
            self.next_param += 1;
            Value::Param { index, value: lit }
        } else {
            Value::Lit(lit)
        }
    }

    fn typed_value(&mut self, ty: ValueType) -> Scalar {
        let lit = self.literal(ty);
        Scalar::Value(self.value(lit))
    }

    fn has_int(&self, scope: &[Entry]) -> bool {
        scope.iter().any(|entry| {
            entry.columns.iter().any(|column| {
                self.alphabet
                    .column(entry.resource, *column)
                    .is_some_and(|c| c.ty == ValueType::Int)
            })
        })
    }

    /// A column reference from `scope`, of type `ty` (unless the 2% type-ignoring roll hits).
    fn column(&mut self, scope: &[Entry], ty: ValueType) -> Option<ColRef> {
        let entry = self.rng.pick(scope)?.clone();
        let class = if self.rng.percent(self.bad) {
            if self.rng.coin() {
                ColumnClass::Forbidden
            } else {
                ColumnClass::Conditional
            }
        } else {
            ColumnClass::Regular
        };
        let ignore_types = self.rng.percent(2);
        let candidates = |class: Option<ColumnClass>, typed: bool| -> Vec<ColumnIdx> {
            entry
                .columns
                .iter()
                .copied()
                .filter(|column| {
                    self.alphabet
                        .column(entry.resource, *column)
                        .is_some_and(|c| {
                            class.is_none_or(|wanted| c.class == wanted) && (!typed || c.ty == ty)
                        })
                })
                .collect()
        };
        let mut pool = candidates(Some(class), !ignore_types);
        if pool.is_empty() {
            pool = candidates(None, !ignore_types);
        }
        if pool.is_empty() {
            pool = candidates(None, false);
        }
        let column = self.rng.pick(&pool).copied()?;
        Some(ColRef {
            qualifier: entry.qualifier,
            resource: entry.resource,
            column,
        })
    }

    fn leaf(&mut self, scope: &[Entry], ty: ValueType) -> Scalar {
        if self.rng.percent(60) {
            if let Some(column) = self.column(scope, ty) {
                return Scalar::Column(column);
            }
        }
        self.typed_value(ty)
    }

    fn scalar(&mut self, scope: &[Entry], depth: u8, ty: ValueType, agg: bool) -> Scalar {
        if depth == 0 || ty == ValueType::Int || self.rng.percent(45) {
            return self.leaf(scope, ty);
        }
        let child =
            |builder: &mut Self| Box::new(builder.scalar(scope, depth - 1, ValueType::Text, agg));
        match self.rng.below(if agg { 6 } else { 5 }) {
            0 => Scalar::Lower(child(self)),
            1 => Scalar::Upper(child(self)),
            2 => Scalar::CastText(child(self)),
            3 => Scalar::Concat(child(self), child(self)),
            4 => Scalar::Case {
                when: Box::new(self.pred(scope, depth - 1, agg, 0)),
                then: child(self),
                otherwise: child(self),
            },
            _ => Scalar::CountText,
        }
    }

    fn pred(&mut self, scope: &[Entry], depth: u8, agg: bool, exists_depth: u8) -> Pred {
        if depth > 0 && self.rng.percent(35) {
            return self.compound(scope, depth, agg, exists_depth);
        }
        let ty = if self.has_int(scope) && self.rng.percent(15) {
            ValueType::Int
        } else {
            ValueType::Text
        };
        let operand_depth = depth.min(1);
        let slots = if agg { 10 } else { 9 };
        match self.rng.below(slots) {
            0..=2 => {
                let op = *self
                    .rng
                    .pick(&[
                        CmpOp::Eq,
                        CmpOp::Ne,
                        CmpOp::Lt,
                        CmpOp::Le,
                        CmpOp::Gt,
                        CmpOp::Ge,
                    ])
                    .unwrap_or(&CmpOp::Eq);
                let left = self.scalar(scope, operand_depth, ty, agg);
                let right = if self.rng.coin() {
                    self.scalar(scope, operand_depth, ty, agg)
                } else {
                    self.typed_value(ty)
                };
                Pred::Cmp { op, left, right }
            }
            3 => Pred::Like(self.scalar(scope, operand_depth, ValueType::Text, agg)),
            4 => Pred::Glob(self.scalar(scope, operand_depth, ValueType::Text, agg)),
            5 | 6 => Pred::In {
                expr: self.scalar(scope, operand_depth, ty, agg),
                negated: self.rng.coin(),
                ty,
            },
            7 => Pred::IsNull(self.scalar(scope, operand_depth, ty, agg)),
            8 => Pred::IsNotNull(self.scalar(scope, operand_depth, ty, agg)),
            _ => Pred::CountGt(u8::try_from(self.rng.below(3)).unwrap_or(0)),
        }
    }

    fn compound(&mut self, scope: &[Entry], depth: u8, agg: bool, exists_depth: u8) -> Pred {
        let exists_allowed = exists_depth < 2;
        match self.rng.below(if exists_allowed { 5 } else { 3 }) {
            0 => Pred::Not(Box::new(self.pred(scope, depth - 1, agg, exists_depth))),
            1 => Pred::And(
                Box::new(self.pred(scope, depth - 1, agg, exists_depth)),
                Box::new(self.pred(scope, depth - 1, agg, exists_depth)),
            ),
            2 => Pred::Or(
                Box::new(self.pred(scope, depth - 1, agg, exists_depth)),
                Box::new(self.pred(scope, depth - 1, agg, exists_depth)),
            ),
            _ => self.exists(scope, depth, exists_depth),
        }
    }

    fn exists(&mut self, scope: &[Entry], depth: u8, exists_depth: u8) -> Pred {
        let free: Vec<ResourceIdx> = (0..self.alphabet.resources.len())
            .filter(|resource| scope.iter().all(|entry| entry.resource != *resource))
            .collect();
        let any: Vec<ResourceIdx> = (0..self.alphabet.resources.len()).collect();
        let pool = if !free.is_empty() && self.rng.percent(90) {
            free
        } else {
            any
        };
        let resource = self.rng.pick(&pool).copied().unwrap_or(0);
        let inner_depth = exists_depth + 1;
        let mut inner_scope = scope.to_vec();
        inner_scope.push(self.new_entry(resource, Qualifier::Exists { depth: inner_depth }));
        let predicate = self.pred(&inner_scope, depth.saturating_sub(1), false, inner_depth);
        Pred::Exists(Box::new(ExistsQuery {
            resource,
            depth: inner_depth,
            projection: if self.rng.coin() {
                ExistsProjection::One
            } else {
                ExistsProjection::Key
            },
            predicate,
        }))
    }

    fn any_column(&mut self, scope: &[Entry]) -> Option<ColRef> {
        self.column(scope, ValueType::Text)
    }

    fn projection(&mut self, scope: &[Entry], agg: bool) -> Projection {
        let depth = self.config.max_depth;
        match self.rng.below(12) {
            0 => Projection::CountAll,
            1 | 2 => {
                let order_by = self.any_column(scope);
                let partition_by = if self.rng.coin() {
                    self.any_column(scope)
                } else {
                    None
                };
                match order_by {
                    Some(order_by) => Projection::RowNumber {
                        partition_by,
                        order_by,
                        desc: self.rng.coin(),
                    },
                    None => Projection::CountAll,
                }
            }
            _ => Projection::Expr(self.scalar(scope, depth, ValueType::Text, agg)),
        }
    }

    fn derived_source(&mut self, root: ResourceIdx, as_cte: bool) -> (Source, Entry) {
        let count = self.rng.below(3) + 1;
        let mut columns: Vec<ColumnIdx> = Vec::new();
        for _ in 0..count {
            let class = if self.rng.percent(self.bad) {
                ColumnClass::Forbidden
            } else {
                ColumnClass::Regular
            };
            let mut pool = self.alphabet.columns_of(root, class);
            if pool.is_empty() {
                pool = self.alphabet.all_columns(root);
            }
            if let Some(column) = self.rng.pick(&pool).copied() {
                if !columns.contains(&column) {
                    columns.push(column);
                }
            }
        }
        let inner_entry = self.new_entry(root, Qualifier::Derived);
        let predicate = if self.rng.coin() {
            Some(self.pred(&[inner_entry], 1, false, 2))
        } else {
            None
        };
        let outer = Entry {
            resource: root,
            qualifier: Qualifier::Outer(root),
            columns: columns.clone(),
        };
        (
            Source::Derived {
                resource: root,
                columns,
                predicate,
                as_cte,
            },
            outer,
        )
    }

    fn select(&mut self) -> Select {
        let root = self.rng.below(self.alphabet.resources.len());
        let (source, root_entry) = if self.rng.percent(10) {
            self.derived_source(root, false)
        } else if self.rng.percent(5) {
            self.derived_source(root, true)
        } else {
            (
                Source::Table(root),
                self.new_entry(root, Qualifier::Outer(root)),
            )
        };
        let mut scope = vec![root_entry];
        let join = if self.rng.percent(30) && self.alphabet.resources.len() > 1 {
            let others: Vec<ResourceIdx> = (0..self.alphabet.resources.len())
                .filter(|resource| *resource != root)
                .collect();
            let partner = self.rng.pick(&others).copied().unwrap_or(0);
            scope.push(self.new_entry(partner, Qualifier::Outer(partner)));
            Some(self.join(root, partner, &scope))
        } else {
            None
        };
        let group_by = if self.rng.percent(20) {
            self.any_column(&scope)
        } else {
            None
        };
        let having = if group_by.is_some() && self.rng.coin() {
            Some(self.pred(&scope, self.config.max_depth, true, 0))
        } else {
            None
        };
        let agg = group_by.is_some() || self.rng.percent(15);
        let projection_count = self.rng.below(3) + 1;
        let projections: Vec<Projection> = (0..projection_count)
            .map(|_| self.projection(&scope, agg))
            .collect();
        let predicate = if self.rng.percent(60) {
            Some(self.pred(&scope, self.config.max_depth, false, 0))
        } else {
            None
        };
        let order_by = if self.rng.percent(30) {
            let target = if self.rng.coin() {
                OrderTarget::Output(self.rng.below(projections.len()))
            } else {
                self.any_column(&scope)
                    .map_or(OrderTarget::Output(0), OrderTarget::Column)
            };
            Some(OrderBy {
                target,
                desc: self.rng.coin(),
            })
        } else {
            None
        };
        let limit = if self.rng.percent(15) {
            let count = i64::try_from(self.rng.below(3) + 1).unwrap_or(1);
            Some(Limit {
                count: self.value(Lit::Int(count)),
                offset: self.rng.percent(30),
            })
        } else {
            None
        };
        Select {
            source,
            join,
            projections,
            predicate,
            group_by,
            having,
            order_by,
            limit,
        }
    }

    fn join(&mut self, root: ResourceIdx, partner: ResourceIdx, scope: &[Entry]) -> Join {
        let key_of = |builder: &Self, resource: ResourceIdx, entry: &Entry| -> Option<ColRef> {
            let key = builder.alphabet.resource(resource)?.key;
            entry.columns.contains(&key).then_some(ColRef {
                qualifier: entry.qualifier,
                resource,
                column: key,
            })
        };
        let equality = match (
            scope.get(1).and_then(|entry| key_of(self, partner, entry)),
            scope.first().and_then(|entry| key_of(self, root, entry)),
        ) {
            (Some(left), Some(right)) => Some(Pred::Cmp {
                op: CmpOp::Eq,
                left: Scalar::Column(left),
                right: Scalar::Column(right),
            }),
            _ => None,
        };
        let on = match equality {
            Some(key) if self.rng.percent(70) => {
                if self.rng.percent(30) {
                    let extra = self.pred(scope, self.config.max_depth, false, 0);
                    Pred::And(Box::new(key), Box::new(extra))
                } else {
                    key
                }
            }
            _ => self.pred(scope, self.config.max_depth, false, 0),
        };
        Join {
            kind: if self.rng.coin() {
                JoinKind::Inner
            } else {
                JoinKind::Left
            },
            resource: partner,
            on,
        }
    }

    fn mutation_target(&mut self) -> ResourceIdx {
        let last = self.alphabet.resources.len().saturating_sub(1);
        match self.rng.below(100) {
            0..=44 => 0,
            45..=89 => 1.min(last),
            _ => last,
        }
    }

    fn preferred(&self, resource: ResourceIdx) -> Vec<ColumnIdx> {
        self.config
            .preferred_writes
            .iter()
            .filter(|(r, _)| *r == resource)
            .map(|(_, column)| *column)
            .collect()
    }

    fn writable_column(&mut self, resource: ResourceIdx) -> Option<ColumnIdx> {
        let mut pool = self.preferred(resource);
        if pool.is_empty() || self.rng.percent(self.bad) {
            pool = self.alphabet.all_columns(resource);
        }
        self.rng.pick(&pool).copied()
    }

    fn returning(&mut self, resource: ResourceIdx) -> Returning {
        if self.rng.coin() {
            return Returning::None;
        }
        if self.rng.coin() {
            return Returning::Id;
        }
        let count = self.rng.below(2) + 1;
        let mut columns = Vec::new();
        for _ in 0..count {
            if let Some(column) = self.writable_column(resource) {
                if !columns.contains(&column) {
                    columns.push(column);
                }
            }
        }
        Returning::Columns(columns)
    }

    fn mutation(&mut self) -> Statement {
        let resource = self.mutation_target();
        let scope = vec![self.new_entry(resource, Qualifier::Table(resource))];
        let update = self.rng.coin();
        let assignments = if update {
            let count = self.rng.below(2) + 1;
            let mut out: Vec<(ColumnIdx, Value)> = Vec::new();
            for _ in 0..count {
                if let Some(column) = self.writable_column(resource) {
                    if out.iter().any(|(existing, _)| *existing == column) {
                        continue;
                    }
                    let mut ty = self
                        .alphabet
                        .column(resource, column)
                        .map_or(ValueType::Text, |c| c.ty);
                    if self.rng.percent(2) {
                        ty = if ty == ValueType::Text {
                            ValueType::Int
                        } else {
                            ValueType::Text
                        };
                    }
                    let lit = self.literal(ty);
                    out.push((column, self.value(lit)));
                }
            }
            out
        } else {
            Vec::new()
        };
        let predicate = if self.rng.percent(80) {
            Some(self.pred(&scope, self.config.max_depth.min(3), false, 0))
        } else {
            None
        };
        let returning = self.returning(resource);
        if update {
            Statement::Update(Update {
                resource,
                assignments,
                predicate,
                returning,
            })
        } else {
            Statement::Delete(Delete {
                resource,
                predicate,
                returning,
            })
        }
    }
}

fn generator<'a>(
    alphabet: &'a Alphabet,
    rng: &'a mut XorShift64,
    config: &'a Layer3Config,
) -> Gen<'a> {
    let bad = *[0_u16, 3, 8, 15].get(rng.below(4)).unwrap_or(&0);
    Gen {
        alphabet,
        rng,
        config,
        bad,
        next_param: 0,
    }
}

/// A random SELECT.
#[must_use]
pub fn random_select(
    alphabet: &Alphabet,
    rng: &mut XorShift64,
    config: &Layer3Config,
) -> Statement {
    let mut builder = generator(alphabet, rng, config);
    Statement::Select(Box::new(builder.select()))
}

/// A random UPDATE or DELETE.
#[must_use]
pub fn random_mutation(
    alphabet: &Alphabet,
    rng: &mut XorShift64,
    config: &Layer3Config,
) -> Statement {
    let mut builder = generator(alphabet, rng, config);
    builder.mutation()
}
