use std::collections::{BTreeMap, BTreeSet};
use turso_parser::ast::{
    Cmd, Expr, JoinConstraint, OneSelect, ResultColumn, Select, SelectTable, Stmt,
};
use turso_parser::parser::Parser;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ResourceId(u32);

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ColumnId {
    resource: ResourceId,
    ordinal: u32,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Usage {
    Projection,
    Join,
    Filter,
    Order,
    Group,
    Having,
    Aggregate,
    Window,
    Mutation,
    Write,
    Returning,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Access {
    pub column: ColumnId,
    pub usage: Usage,
}

#[derive(Clone, Debug)]
struct Resource {
    id: ResourceId,
    columns: BTreeMap<String, ColumnId>,
}

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    resources: BTreeMap<String, Resource>,
}

impl Catalog {
    pub fn blog() -> Self {
        let mut catalog = Self::default();
        catalog.add(
            1,
            "posts",
            &["id", "author_id", "tenant_id", "title", "private_note"],
        );
        catalog.add(2, "authors", &["id", "tenant_id", "name"]);
        catalog
    }

    fn add(&mut self, id: u32, name: &str, columns: &[&str]) {
        let resource = Resource {
            id: ResourceId(id),
            columns: columns
                .iter()
                .enumerate()
                .map(|(ordinal, column)| {
                    (
                        canonical(column),
                        ColumnId {
                            resource: ResourceId(id),
                            ordinal: ordinal as u32,
                        },
                    )
                })
                .collect(),
        };
        self.resources.insert(canonical(name), resource);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BindError {
    Parse,
    MultipleStatements,
    Unsupported(&'static str),
    UnknownResource,
    UnknownColumn,
    AmbiguousColumn,
    DuplicateAlias,
    ProtectedResourceShadowed,
    ImplicitRowId,
}

#[derive(Clone, Debug)]
struct Source {
    alias: String,
    resource: Resource,
}

type Scope = Vec<Source>;

pub fn bind(sql: &str, catalog: &Catalog) -> Result<Vec<Access>, BindError> {
    let parsed = Parser::new(sql.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| BindError::Parse)?;
    if parsed.len() != 1 {
        return Err(BindError::MultipleStatements);
    }
    let Cmd::Stmt(Stmt::Select(select)) = &parsed[0] else {
        return Err(BindError::Unsupported("statement"));
    };
    let mut binder = Binder {
        catalog,
        accesses: BTreeSet::new(),
    };
    binder.select(select, &[])?;
    Ok(binder.accesses.into_iter().collect())
}

struct Binder<'a> {
    catalog: &'a Catalog,
    accesses: BTreeSet<Access>,
}

impl Binder<'_> {
    fn select(&mut self, select: &Select, outer: &[Scope]) -> Result<(), BindError> {
        if let Some(with) = &select.with {
            if with.recursive {
                return Err(BindError::Unsupported("recursive CTE"));
            }
            if with.ctes.iter().any(|cte| {
                self.catalog
                    .resources
                    .contains_key(&canonical(cte.tbl_name.as_str()))
            }) {
                return Err(BindError::ProtectedResourceShadowed);
            }
            return Err(BindError::Unsupported("CTE"));
        }
        if !select.body.compounds.is_empty() {
            return Err(BindError::Unsupported("compound SELECT"));
        }
        let OneSelect::Select {
            columns,
            from,
            where_clause,
            group_by,
            window_clause,
            ..
        } = &select.body.select
        else {
            return Err(BindError::Unsupported("VALUES"));
        };
        if group_by.is_some() || !window_clause.is_empty() {
            return Err(BindError::Unsupported("group or window"));
        }

        let mut scope = Scope::new();
        if let Some(from) = from {
            self.add_source(&mut scope, &from.select)?;
            for join in &from.joins {
                self.add_source(&mut scope, &join.table)?;
                match &join.constraint {
                    Some(JoinConstraint::On(expression)) => {
                        self.expression(expression, Usage::Join, &scope, outer)?;
                    }
                    Some(JoinConstraint::Using(_)) => {
                        return Err(BindError::Unsupported("JOIN USING"));
                    }
                    None => {}
                }
            }
        }

        for column in columns {
            match column {
                ResultColumn::Expr(expression, _) => {
                    self.expression(expression, Usage::Projection, &scope, outer)?;
                }
                ResultColumn::Star | ResultColumn::TableStar(_) => {
                    return Err(BindError::Unsupported("star projection"));
                }
            }
        }
        if let Some(expression) = where_clause {
            self.expression(expression, Usage::Filter, &scope, outer)?;
        }
        for sorted in &select.order_by {
            self.expression(&sorted.expr, Usage::Order, &scope, outer)?;
        }
        if let Some(limit) = &select.limit {
            self.expression(&limit.expr, Usage::Filter, &scope, outer)?;
            if let Some(offset) = &limit.offset {
                self.expression(offset, Usage::Filter, &scope, outer)?;
            }
        }
        Ok(())
    }

    fn add_source(&self, scope: &mut Scope, table: &SelectTable) -> Result<(), BindError> {
        let SelectTable::Table(name, alias, indexed) = table else {
            return Err(BindError::Unsupported("derived table or table function"));
        };
        if indexed.is_some() || name.db_name.is_some() {
            return Err(BindError::Unsupported("qualified or indexed table"));
        }
        let resource = self
            .catalog
            .resources
            .get(&canonical(name.name.as_str()))
            .cloned()
            .ok_or(BindError::UnknownResource)?;
        let alias = alias.as_ref().map_or_else(
            || canonical(name.name.as_str()),
            |alias| canonical(alias.name().as_str()),
        );
        if scope.iter().any(|source| source.alias == alias) {
            return Err(BindError::DuplicateAlias);
        }
        scope.push(Source { alias, resource });
        Ok(())
    }

    fn expression(
        &mut self,
        expression: &Expr,
        usage: Usage,
        scope: &Scope,
        outer: &[Scope],
    ) -> Result<(), BindError> {
        match expression {
            Expr::Id(name) | Expr::Name(name) => {
                self.resolve_unqualified(name.as_str(), usage, scope, outer)
            }
            Expr::Qualified(source, column) => {
                self.resolve_qualified(source.as_str(), column.as_str(), usage, scope, outer)
            }
            Expr::DoublyQualified(_, _, _) => Err(BindError::Unsupported("database qualifier")),
            Expr::Binary(left, _, right) => {
                self.expression(left, usage, scope, outer)?;
                self.expression(right, usage, scope, outer)
            }
            Expr::Unary(_, inner)
            | Expr::IsNull(inner)
            | Expr::NotNull(inner)
            | Expr::Collate(inner, _) => self.expression(inner, usage, scope, outer),
            Expr::Between {
                lhs, start, end, ..
            } => {
                self.expression(lhs, usage, scope, outer)?;
                self.expression(start, usage, scope, outer)?;
                self.expression(end, usage, scope, outer)
            }
            Expr::InList { lhs, rhs, .. } => {
                self.expression(lhs, usage, scope, outer)?;
                for item in rhs {
                    self.expression(item, usage, scope, outer)?;
                }
                Ok(())
            }
            Expr::Parenthesized(items) => {
                for item in items {
                    self.expression(item, usage, scope, outer)?;
                }
                Ok(())
            }
            Expr::Exists(subquery) | Expr::Subquery(subquery) => {
                let mut nested_outer = Vec::with_capacity(outer.len() + 1);
                nested_outer.push(scope.clone());
                nested_outer.extend_from_slice(outer);
                self.select(subquery, &nested_outer)
            }
            Expr::Literal(_) | Expr::Variable(_) => Ok(()),
            Expr::FunctionCall {
                name,
                args,
                filter_over,
                ..
            } => {
                let allowed = matches!(canonical(name.as_str()).as_str(), "datetime" | "lower");
                if !allowed
                    || filter_over.filter_clause.is_some()
                    || filter_over.over_clause.is_some()
                {
                    return Err(BindError::Unsupported("function"));
                }
                for argument in args {
                    self.expression(argument, usage, scope, outer)?;
                }
                Ok(())
            }
            _ => Err(BindError::Unsupported("expression")),
        }
    }

    fn resolve_unqualified(
        &mut self,
        column: &str,
        usage: Usage,
        scope: &Scope,
        outer: &[Scope],
    ) -> Result<(), BindError> {
        if is_rowid(column) {
            return Err(BindError::ImplicitRowId);
        }
        for candidate_scope in std::iter::once(scope).chain(outer.iter()) {
            let matches: Vec<_> = candidate_scope
                .iter()
                .filter_map(|source| source.resource.columns.get(&canonical(column)).copied())
                .collect();
            match matches.as_slice() {
                [] => continue,
                [column] => {
                    self.accesses.insert(Access {
                        column: *column,
                        usage,
                    });
                    return Ok(());
                }
                _ => return Err(BindError::AmbiguousColumn),
            }
        }
        Err(BindError::UnknownColumn)
    }

    fn resolve_qualified(
        &mut self,
        alias: &str,
        column: &str,
        usage: Usage,
        scope: &Scope,
        outer: &[Scope],
    ) -> Result<(), BindError> {
        if is_rowid(column) {
            return Err(BindError::ImplicitRowId);
        }
        let alias = canonical(alias);
        for candidate_scope in std::iter::once(scope).chain(outer.iter()) {
            if let Some(source) = candidate_scope.iter().find(|source| source.alias == alias) {
                let column = source
                    .resource
                    .columns
                    .get(&canonical(column))
                    .copied()
                    .ok_or(BindError::UnknownColumn)?;
                debug_assert_eq!(column.resource, source.resource.id);
                self.accesses.insert(Access { column, usage });
                return Ok(());
            }
        }
        Err(BindError::UnknownResource)
    }
}

fn canonical(name: &str) -> String {
    name.to_ascii_lowercase()
}

fn is_rowid(name: &str) -> bool {
    matches!(canonical(name).as_str(), "rowid" | "_rowid_" | "oid")
}

#[cfg(test)]
mod advanced;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_join_columns_to_stable_catalog_ids() {
        let accesses = bind(
            "SELECT p.id, a.name FROM posts AS p LEFT JOIN authors AS a ON a.id = p.author_id WHERE p.tenant_id = :tenant ORDER BY a.name",
            &Catalog::blog(),
        )
        .unwrap();
        assert_eq!(accesses.len(), 6);
        assert!(accesses.contains(&Access {
            column: ColumnId {
                resource: ResourceId(1),
                ordinal: 0
            },
            usage: Usage::Projection,
        }));
        assert!(accesses.contains(&Access {
            column: ColumnId {
                resource: ResourceId(2),
                ordinal: 2
            },
            usage: Usage::Order,
        }));
    }

    #[test]
    fn resolves_a_provable_correlated_reference() {
        let accesses = bind(
            "SELECT p.id FROM posts p WHERE EXISTS (SELECT 1 FROM authors a WHERE a.id = p.author_id)",
            &Catalog::blog(),
        )
        .unwrap();
        assert!(accesses.contains(&Access {
            column: ColumnId {
                resource: ResourceId(1),
                ordinal: 1
            },
            usage: Usage::Filter,
        }));
    }

    #[test]
    fn rejects_ambiguous_unknown_and_implicit_columns() {
        let catalog = Catalog::blog();
        assert_eq!(
            bind(
                "SELECT id FROM posts p JOIN authors a ON a.id = p.author_id",
                &catalog
            ),
            Err(BindError::AmbiguousColumn)
        );
        assert_eq!(
            bind("SELECT p.missing FROM posts p", &catalog),
            Err(BindError::UnknownColumn)
        );
        assert_eq!(
            bind("SELECT p.rowid FROM posts p", &catalog),
            Err(BindError::ImplicitRowId)
        );
    }

    #[test]
    fn rejects_shadowing_star_and_multiple_statements() {
        let catalog = Catalog::blog();
        assert_eq!(
            bind(
                "WITH posts AS (SELECT id FROM authors) SELECT id FROM posts",
                &catalog
            ),
            Err(BindError::ProtectedResourceShadowed)
        );
        assert_eq!(
            bind("SELECT * FROM posts", &catalog),
            Err(BindError::Unsupported("star projection"))
        );
        assert_eq!(
            bind("SELECT id FROM posts; SELECT id FROM authors", &catalog),
            Err(BindError::MultipleStatements)
        );
    }

    #[test]
    fn tracks_forbidden_columns_outside_projection() {
        let accesses = bind(
            "SELECT p.id FROM posts p WHERE p.private_note = 'secret' ORDER BY p.private_note",
            &Catalog::blog(),
        )
        .unwrap();
        let private_note = ColumnId {
            resource: ResourceId(1),
            ordinal: 4,
        };
        assert!(accesses.contains(&Access {
            column: private_note,
            usage: Usage::Filter
        }));
        assert!(accesses.contains(&Access {
            column: private_note,
            usage: Usage::Order
        }));
    }
}
