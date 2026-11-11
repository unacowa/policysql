//! Layer 2: pairwise / three-way coverage of a table of factors and levels.
//!
//! A *factor* is a place in a statement where a predicate goes (projection `CASE`, JOIN `ON`,
//! `WHERE`, `HAVING`); a *level* is the shape of the predicate put there. A *cell* assigns levels
//! to up to `t` factors. One *round* generates every cell with every root resource exactly once,
//! in a shuffled order, with the remaining choices (columns, literals, join partner, ...) drawn
//! from a generator seeded by `(seed, round, index)` so a single statement can be reproduced.
//!
//! The two tables below are the only place factor and level names appear. Issue #129 replaces them
//! with tables derived from the slot and node kinds of #128.

use super::alphabet::{Alphabet, ColumnClass, ColumnIdx, Lit, ResourceIdx, ValueType};
use super::ast::{
    CmpOp, ColRef, ExistsProjection, ExistsQuery, Join, JoinKind, Limit, OrderBy, OrderTarget,
    Pred, Projection, Qualifier, Scalar, Select, Source, Statement, Value,
};
use super::rng::{XorShift64, mix};

/// Where a factor puts its predicate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FactorSlot {
    /// `CASE WHEN <pred> THEN a ELSE b END AS o0` in front of the projection.
    ProjectionCase,
    /// `JOIN ... ON <pred>`.
    JoinOn,
    /// `WHERE <pred>`.
    Where,
    /// `GROUP BY g HAVING <pred>`.
    Having,
}

#[derive(Clone, Copy, Debug)]
pub struct Factor {
    pub name: &'static str,
    pub slot: FactorSlot,
}

pub const FACTORS: &[Factor] = &[
    Factor {
        name: "proj",
        slot: FactorSlot::ProjectionCase,
    },
    Factor {
        name: "on",
        slot: FactorSlot::JoinOn,
    },
    Factor {
        name: "where",
        slot: FactorSlot::Where,
    },
    Factor {
        name: "having",
        slot: FactorSlot::Having,
    },
];

/// The shape of the predicate a level puts into a slot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PredicateShape {
    /// An atomic predicate on a regular column in scope.
    Plain,
    /// `EXISTS (SELECT .. FROM T e1 WHERE e1.<key> = <outer>.<key> [AND <atom on T>])`.
    ExistsCorrelated,
    /// `EXISTS (SELECT .. FROM T e1 WHERE <atom on T>)`.
    ExistsUncorrelated,
    /// `EXISTS (SELECT .. FROM T e1 WHERE <atom on an outer column>)`: never reads an inner column.
    ExistsOuterOnly,
    /// `NOT (<correlated EXISTS>)`.
    NotExistsCorrelated,
    /// `COUNT(*) > n`.
    Count,
    /// An atomic predicate on a forbidden column in scope.
    Forbidden,
    /// An atomic predicate on a conditional column in scope.
    Conditional,
}

#[derive(Clone, Copy, Debug)]
pub struct Level {
    pub name: &'static str,
    pub shape: PredicateShape,
}

pub const LEVELS: &[Level] = &[
    Level {
        name: "plain",
        shape: PredicateShape::Plain,
    },
    Level {
        name: "exists_corr",
        shape: PredicateShape::ExistsCorrelated,
    },
    Level {
        name: "exists_uncorr",
        shape: PredicateShape::ExistsUncorrelated,
    },
    Level {
        name: "exists_outer_only",
        shape: PredicateShape::ExistsOuterOnly,
    },
    Level {
        name: "not_exists_corr",
        shape: PredicateShape::NotExistsCorrelated,
    },
    Level {
        name: "count",
        shape: PredicateShape::Count,
    },
    Level {
        name: "forbidden",
        shape: PredicateShape::Forbidden,
    },
    Level {
        name: "conditional",
        shape: PredicateShape::Conditional,
    },
];

/// Levels assigned to a set of factors. `(factor index, level index)`, factor indices ascending.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cell {
    pub assignments: Vec<(usize, usize)>,
}

/// Every cell of strength `t`: all non-empty factor subsets of size at most `t`, each with every
/// assignment of levels. Order: subset size, then factor indices lexicographically, then level
/// indices lexicographically.
#[must_use]
pub fn cells(t: usize) -> Vec<Cell> {
    let mut out = Vec::new();
    for size in 1..=t.min(FACTORS.len()) {
        let mut subset = Vec::new();
        subsets(0, size, &mut subset, &mut |factors| {
            let mut levels = vec![0_usize; factors.len()];
            loop {
                out.push(Cell {
                    assignments: factors
                        .iter()
                        .copied()
                        .zip(levels.iter().copied())
                        .collect(),
                });
                // Advance the level counter (last position fastest).
                let mut position = levels.len();
                loop {
                    if position == 0 {
                        return;
                    }
                    position -= 1;
                    levels[position] += 1;
                    if levels[position] < LEVELS.len() {
                        break;
                    }
                    levels[position] = 0;
                }
            }
        });
    }
    out
}

fn subsets(start: usize, size: usize, current: &mut Vec<usize>, visit: &mut dyn FnMut(&[usize])) {
    if current.len() == size {
        visit(current);
        return;
    }
    for factor in start..FACTORS.len() {
        current.push(factor);
        subsets(factor + 1, size, current, visit);
        current.pop();
    }
}

/// `where=exists_corr,having=count`
#[must_use]
pub fn cell_name(cell: &Cell) -> String {
    cell.assignments
        .iter()
        .map(|(factor, level)| {
            format!(
                "{}={}",
                FACTORS.get(*factor).map_or("?", |f| f.name),
                LEVELS.get(*level).map_or("?", |l| l.name)
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// One round: every `(cell index, root)` pair exactly once, in an order fixed by `(seed, round)`.
#[must_use]
pub fn round(
    cells: &[Cell],
    roots: &[ResourceIdx],
    seed: u64,
    round: u32,
) -> Vec<(usize, ResourceIdx)> {
    let mut pairs: Vec<(usize, ResourceIdx)> = (0..cells.len())
        .flat_map(|cell| roots.iter().map(move |root| (cell, *root)))
        .collect();
    let mut rng = XorShift64::new(mix(&[seed, u64::from(round)]));
    rng.shuffle(&mut pairs);
    pairs
}

/// The generator seed of the `index`-th statement of a round.
#[must_use]
pub fn statement_seed(seed: u64, round: u32, index: usize) -> u64 {
    mix(&[
        seed,
        u64::from(round),
        u64::try_from(index).unwrap_or(u64::MAX),
    ])
}

struct Builder<'a> {
    alphabet: &'a Alphabet,
    rng: &'a mut XorShift64,
    root: ResourceIdx,
    partner: Option<ResourceIdx>,
    /// The EXISTS target chosen first in this statement, reused with probability 0.75.
    first_target: Option<ResourceIdx>,
}

impl Builder<'_> {
    fn scope(&self) -> Vec<ResourceIdx> {
        let mut scope = vec![self.root];
        scope.extend(self.partner);
        scope
    }

    fn outer(resource: ResourceIdx, column: ColumnIdx) -> ColRef {
        ColRef {
            qualifier: Qualifier::Outer(resource),
            resource,
            column,
        }
    }

    fn inner(resource: ResourceIdx, column: ColumnIdx) -> ColRef {
        ColRef {
            qualifier: Qualifier::Exists { depth: 1 },
            resource,
            column,
        }
    }

    /// A column of the given class from the resources in `scope`, uniformly over all such columns.
    fn column_of(
        &mut self,
        scope: &[ResourceIdx],
        class: ColumnClass,
    ) -> Option<(ResourceIdx, ColumnIdx)> {
        let all: Vec<(ResourceIdx, ColumnIdx)> = scope
            .iter()
            .flat_map(|resource| {
                self.alphabet
                    .columns_of(*resource, class)
                    .into_iter()
                    .map(|column| (*resource, column))
            })
            .collect();
        self.rng.pick(&all).copied()
    }

    /// One of the six atomic predicates on a column.
    fn atom(&mut self, column: ColRef) -> Pred {
        let ty = self
            .alphabet
            .column(column.resource, column.column)
            .map_or(ValueType::Text, |c| c.ty);
        let literals = self.alphabet.literals(ty);
        let literal = self.rng.pick(&literals).copied().unwrap_or(Lit::Int(0));
        let value = Scalar::Value(Value::Lit(literal));
        let left = Scalar::Column(column);
        match self.rng.below(6) {
            0 => Pred::Cmp {
                op: CmpOp::Eq,
                left,
                right: value,
            },
            1 => Pred::Cmp {
                op: CmpOp::Ne,
                left,
                right: value,
            },
            2 => Pred::Cmp {
                op: CmpOp::Lt,
                left,
                right: value,
            },
            3 => Pred::IsNotNull(left),
            4 => match ty {
                ValueType::Text => Pred::Like(left),
                ValueType::Int => Pred::Cmp {
                    op: CmpOp::Ge,
                    left,
                    right: value,
                },
            },
            _ => Pred::In {
                expr: left,
                negated: false,
                ty,
            },
        }
    }

    fn atom_on_class(&mut self, scope: &[ResourceIdx], class: ColumnClass) -> Pred {
        match self.column_of(scope, class) {
            Some((resource, column)) => self.atom(Self::outer(resource, column)),
            // A silent fallback would let a cell stop meaning what its name says.
            None => unreachable!("no column of class {class:?} in scope {scope:?}"),
        }
    }

    fn exists_target(&mut self, scope: &[ResourceIdx]) -> ResourceIdx {
        if let Some(first) = self.first_target {
            if self.rng.percent(75) {
                return first;
            }
        }
        let free: Vec<ResourceIdx> = (0..self.alphabet.resources.len())
            .filter(|resource| !scope.contains(resource))
            .collect();
        let target = self
            .rng
            .pick(&free)
            .copied()
            .unwrap_or_else(|| unreachable!("every resource is in scope {scope:?}"));
        if self.first_target.is_none() {
            self.first_target = Some(target);
        }
        target
    }

    fn exists(&mut self, resource: ResourceIdx, predicate: Pred) -> Pred {
        let projection = if self.rng.coin() {
            ExistsProjection::One
        } else {
            ExistsProjection::Key
        };
        Pred::Exists(Box::new(ExistsQuery {
            resource,
            depth: 1,
            projection,
            predicate,
        }))
    }

    fn key_of(&self, resource: ResourceIdx) -> ColumnIdx {
        self.alphabet.resource(resource).map_or(0, |r| r.key)
    }

    fn correlated(&mut self, scope: &[ResourceIdx]) -> Pred {
        let target = self.exists_target(scope);
        let outer = self.rng.pick(scope).copied().unwrap_or(self.root);
        let mut predicate = Pred::Cmp {
            op: CmpOp::Eq,
            left: Scalar::Column(Self::inner(target, self.key_of(target))),
            right: Scalar::Column(Self::outer(outer, self.key_of(outer))),
        };
        if self.rng.percent(40) {
            let regular = self.alphabet.columns_of(target, ColumnClass::Regular);
            if let Some(column) = self.rng.pick(&regular).copied() {
                let extra = self.atom(Self::inner(target, column));
                predicate = Pred::And(Box::new(predicate), Box::new(extra));
            }
        }
        self.exists(target, predicate)
    }

    fn predicate(&mut self, shape: PredicateShape, scope: &[ResourceIdx]) -> Pred {
        match shape {
            PredicateShape::Plain => self.atom_on_class(scope, ColumnClass::Regular),
            PredicateShape::Forbidden => self.atom_on_class(scope, ColumnClass::Forbidden),
            PredicateShape::Conditional => self.atom_on_class(scope, ColumnClass::Conditional),
            PredicateShape::Count => Pred::CountGt(u8::try_from(self.rng.below(3)).unwrap_or(0)),
            PredicateShape::ExistsCorrelated => self.correlated(scope),
            PredicateShape::NotExistsCorrelated => Pred::Not(Box::new(self.correlated(scope))),
            PredicateShape::ExistsUncorrelated => {
                let target = self.exists_target(scope);
                let regular = self.alphabet.columns_of(target, ColumnClass::Regular);
                let column = self.rng.pick(&regular).copied().unwrap_or(0);
                let predicate = self.atom(Self::inner(target, column));
                self.exists(target, predicate)
            }
            PredicateShape::ExistsOuterOnly => {
                let target = self.exists_target(scope);
                let predicate = self.atom_on_class(scope, ColumnClass::Regular);
                self.exists(target, predicate)
            }
        }
    }

    fn regular_column(&mut self, scope: &[ResourceIdx]) -> ColRef {
        let (resource, column) = self
            .column_of(scope, ColumnClass::Regular)
            .unwrap_or_else(|| unreachable!("no regular column in scope {scope:?}"));
        Self::outer(resource, column)
    }

    /// ORDER BY with probability 0.2 (half of them on `o0`, half DESC); LIMIT 1..=3 with 0.1.
    fn order_and_limit(&mut self, scope: &[ResourceIdx]) -> (Option<OrderBy>, Option<Limit>) {
        let order_by = if self.rng.percent(20) {
            let target = if self.rng.coin() {
                OrderTarget::Output(0)
            } else {
                OrderTarget::Column(self.regular_column(scope))
            };
            Some(OrderBy {
                target,
                desc: self.rng.coin(),
            })
        } else {
            None
        };
        let limit = if self.rng.percent(10) {
            let count = i64::try_from(self.rng.below(3) + 1).unwrap_or(1);
            Some(Limit {
                count: Value::Lit(Lit::Int(count)),
                offset: false,
            })
        } else {
            None
        };
        (order_by, limit)
    }

    fn text_regular_column(&mut self, scope: &[ResourceIdx]) -> ColRef {
        let all: Vec<(ResourceIdx, ColumnIdx)> = scope
            .iter()
            .flat_map(|resource| {
                self.alphabet
                    .columns_of(*resource, ColumnClass::Regular)
                    .into_iter()
                    .filter(|column| {
                        self.alphabet
                            .column(*resource, *column)
                            .is_some_and(|c| c.ty == ValueType::Text)
                    })
                    .map(|column| (*resource, column))
            })
            .collect();
        let (resource, column) = self
            .rng
            .pick(&all)
            .copied()
            .unwrap_or_else(|| unreachable!("no text column in scope {scope:?}"));
        Self::outer(resource, column)
    }
}

/// Turns a cell into a statement. Every random choice comes from `rng`.
#[must_use]
pub fn instantiate(
    cell: &Cell,
    root: ResourceIdx,
    alphabet: &Alphabet,
    rng: &mut XorShift64,
) -> Statement {
    let level_of = |slot: FactorSlot| {
        cell.assignments
            .iter()
            .find(|(factor, _)| FACTORS.get(*factor).is_some_and(|f| f.slot == slot))
            .and_then(|(_, level)| LEVELS.get(*level))
            .map(|level| level.shape)
    };
    let mut builder = Builder {
        alphabet,
        rng,
        root,
        partner: None,
        first_target: None,
    };
    // 1. JOIN: required when `on` is assigned, otherwise with probability 0.15.
    let on_shape = level_of(FactorSlot::JoinOn);
    let join_kind = if on_shape.is_some() || builder.rng.percent(15) {
        let others: Vec<ResourceIdx> = (0..alphabet.resources.len())
            .filter(|resource| *resource != root)
            .collect();
        builder.partner = Some(
            builder
                .rng
                .pick(&others)
                .copied()
                .unwrap_or_else(|| unreachable!("a JOIN needs a second resource")),
        );
        Some(if builder.rng.coin() {
            JoinKind::Inner
        } else {
            JoinKind::Left
        })
    } else {
        None
    };
    let scope = builder.scope();
    // 3. ON.
    let join = match (builder.partner, join_kind) {
        (Some(partner), Some(kind)) => {
            let key = Pred::Cmp {
                op: CmpOp::Eq,
                left: Scalar::Column(Builder::outer(partner, builder.key_of(partner))),
                right: Scalar::Column(Builder::outer(root, builder.key_of(root))),
            };
            let on = match on_shape {
                None => key,
                Some(shape) => {
                    let predicate = builder.predicate(shape, &scope);
                    if builder.rng.coin() {
                        predicate
                    } else {
                        Pred::And(Box::new(key), Box::new(predicate))
                    }
                }
            };
            Some(Join {
                kind,
                resource: partner,
                on,
            })
        }
        (None, None) => None,
        (partner, kind) => unreachable!("partner {partner:?} without kind {kind:?} or vice versa"),
    };
    // 4. GROUP BY / HAVING.
    let having_shape = level_of(FactorSlot::Having);
    let (group_by, having) = match having_shape {
        Some(shape) => {
            let group = builder.regular_column(&scope);
            let predicate = builder.predicate(shape, &scope);
            (Some(group), Some(predicate))
        }
        None if builder.rng.percent(10) => (Some(builder.regular_column(&scope)), None),
        None => (None, None),
    };
    // 5. Projection.
    let mut projections = Vec::new();
    if let Some(shape) = level_of(FactorSlot::ProjectionCase) {
        let when = builder.predicate(shape, &scope);
        let then = builder.text_regular_column(&scope);
        let otherwise = builder.text_regular_column(&scope);
        projections.push(Projection::Expr(Scalar::Case {
            when: Box::new(when),
            then: Box::new(Scalar::Column(then)),
            otherwise: Box::new(Scalar::Column(otherwise)),
        }));
    }
    let column = group_by.unwrap_or_else(|| builder.regular_column(&scope));
    projections.push(Projection::Expr(Scalar::Column(column)));
    // 6. WHERE.
    let predicate = level_of(FactorSlot::Where).map(|shape| builder.predicate(shape, &scope));
    // 7. ORDER BY / LIMIT.
    let (order_by, limit) = builder.order_and_limit(&scope);
    Statement::Select(Box::new(Select {
        source: Source::Table(root),
        join,
        projections,
        predicate,
        group_by,
        having,
        order_by,
        limit,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_counts_match_the_spec() {
        assert_eq!(cells(1).len(), 32);
        assert_eq!(cells(2).len(), 416);
        assert_eq!(cells(3).len(), 2_464);
    }

    #[test]
    fn cells_are_distinct_and_named() {
        let all = cells(2);
        let names: std::collections::BTreeSet<String> = all.iter().map(cell_name).collect();
        assert_eq!(names.len(), all.len());
        assert_eq!(cell_name(&all[0]), "proj=plain");
    }

    #[test]
    fn a_round_is_a_permutation_fixed_by_the_seed() {
        let all = cells(1);
        let a = round(&all, &[0, 1, 2], 7, 0);
        assert_eq!(a, round(&all, &[0, 1, 2], 7, 0));
        assert_ne!(a, round(&all, &[0, 1, 2], 7, 1));
        let mut sorted = a.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 96);
    }
}
