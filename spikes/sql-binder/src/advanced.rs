use super::*;
use turso_parser::ast::{
    As, FunctionTail, InsertBody, JoinOperator, JoinType, Operator, Update, With,
};

#[derive(Clone, Debug)]
struct Relation {
    columns: BTreeMap<String, BTreeSet<ColumnId>>,
}

#[derive(Clone, Debug)]
struct RelationSource {
    alias: String,
    relation: Relation,
}

type AdvancedScope = Vec<RelationSource>;

struct AdvancedBinder<'a> {
    catalog: &'a Catalog,
    accesses: BTreeSet<Access>,
}

fn bind_advanced(sql: &str, catalog: &Catalog) -> Result<Vec<Access>, BindError> {
    let parsed = Parser::new(sql.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| BindError::Parse)?;
    if parsed.len() != 1 {
        return Err(BindError::MultipleStatements);
    }
    let Cmd::Stmt(statement) = &parsed[0] else {
        return Err(BindError::Unsupported("explain"));
    };
    let mut binder = AdvancedBinder {
        catalog,
        accesses: BTreeSet::new(),
    };
    binder.statement(statement)?;
    Ok(binder.accesses.into_iter().collect())
}

impl AdvancedBinder<'_> {
    fn statement(&mut self, statement: &Stmt) -> Result<(), BindError> {
        match statement {
            Stmt::Select(select) => {
                self.select(select, &[], &BTreeMap::new())?;
                Ok(())
            }
            Stmt::Insert {
                with,
                or_conflict,
                tbl_name,
                columns,
                body,
                returning,
            } => {
                if with.is_some() || or_conflict.is_some() || tbl_name.db_name.is_some() {
                    return Err(BindError::Unsupported("INSERT option"));
                }
                let source = self.base_source(tbl_name.name.as_str(), tbl_name.name.as_str())?;
                for column in columns {
                    self.record_named(&source, column.as_str(), Usage::Write)?;
                }
                match body {
                    InsertBody::Select(select, None) => {
                        let OneSelect::Values(rows) = &select.body.select else {
                            return Err(BindError::Unsupported("INSERT SELECT"));
                        };
                        if select.with.is_some() || !select.body.compounds.is_empty() {
                            return Err(BindError::Unsupported("INSERT body"));
                        }
                        let empty_scope = AdvancedScope::new();
                        for row in rows {
                            for expression in row {
                                self.expression(expression, Usage::Mutation, &empty_scope, &[])?;
                            }
                        }
                    }
                    _ => return Err(BindError::Unsupported("INSERT body")),
                }
                self.returning(returning, &vec![source])
            }
            Stmt::Update(update) => self.update(update),
            Stmt::Delete {
                with,
                tbl_name,
                indexed,
                where_clause,
                returning,
                order_by,
                limit,
            } => {
                if with.is_some()
                    || tbl_name.db_name.is_some()
                    || indexed.is_some()
                    || !order_by.is_empty()
                    || limit.is_some()
                {
                    return Err(BindError::Unsupported("DELETE option"));
                }
                let scope = vec![self.base_source(tbl_name.name.as_str(), tbl_name.name.as_str())?];
                if let Some(predicate) = where_clause {
                    self.expression(predicate, Usage::Filter, &scope, &[])?;
                }
                self.returning(returning, &scope)
            }
            _ => Err(BindError::Unsupported("statement")),
        }
    }

    fn update(&mut self, update: &Update) -> Result<(), BindError> {
        if update.with.is_some()
            || update.or_conflict.is_some()
            || update.tbl_name.db_name.is_some()
            || update.indexed.is_some()
            || update.from.is_some()
            || !update.order_by.is_empty()
            || update.limit.is_some()
        {
            return Err(BindError::Unsupported("UPDATE option"));
        }
        let source =
            self.base_source(update.tbl_name.name.as_str(), update.tbl_name.name.as_str())?;
        let scope = vec![source.clone()];
        for assignment in &update.sets {
            for column in &assignment.col_names {
                self.record_named(&source, column.as_str(), Usage::Write)?;
            }
            self.expression(&assignment.expr, Usage::Mutation, &scope, &[])?;
        }
        if let Some(predicate) = &update.where_clause {
            self.expression(predicate, Usage::Filter, &scope, &[])?;
        }
        self.returning(&update.returning, &scope)
    }

    fn returning(
        &mut self,
        columns: &[ResultColumn],
        scope: &AdvancedScope,
    ) -> Result<(), BindError> {
        for column in columns {
            let ResultColumn::Expr(expression, _) = column else {
                return Err(BindError::Unsupported("RETURNING star"));
            };
            self.expression(expression, Usage::Returning, scope, &[])?;
        }
        Ok(())
    }

    fn select(
        &mut self,
        select: &Select,
        outer: &[AdvancedScope],
        inherited_ctes: &BTreeMap<String, Relation>,
    ) -> Result<Relation, BindError> {
        if !select.body.compounds.is_empty() {
            return Err(BindError::Unsupported("compound SELECT"));
        }
        let mut ctes = inherited_ctes.clone();
        if let Some(with) = &select.with {
            self.bind_ctes(with, outer, &mut ctes)?;
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

        let mut scope = AdvancedScope::new();
        if let Some(from) = from {
            self.add_select_source(&mut scope, &from.select, outer, &ctes)?;
            for join in &from.joins {
                self.add_select_source(&mut scope, &join.table, outer, &ctes)?;
                if let Some(JoinConstraint::On(predicate)) = &join.constraint {
                    self.expression(predicate, Usage::Join, &scope, outer)?;
                } else if join.constraint.is_some() {
                    return Err(BindError::Unsupported("JOIN USING"));
                }
            }
        }

        let mut output = BTreeMap::new();
        for column in columns {
            let ResultColumn::Expr(expression, alias) = column else {
                return Err(BindError::Unsupported("star projection"));
            };
            let provenance = self.expression(expression, Usage::Projection, &scope, outer)?;
            let name = result_name(expression, alias.as_ref())?;
            if output.insert(name, provenance).is_some() {
                return Err(BindError::DuplicateAlias);
            }
        }
        if let Some(predicate) = where_clause {
            self.expression(predicate, Usage::Filter, &scope, outer)?;
        }
        if let Some(group) = group_by {
            for expression in &group.exprs {
                self.expression(expression, Usage::Group, &scope, outer)?;
            }
            if let Some(having) = &group.having {
                self.expression(having, Usage::Having, &scope, outer)?;
            }
        }
        for window in window_clause {
            self.window(&window.window, &scope, outer)?;
        }
        for sorted in &select.order_by {
            self.expression(&sorted.expr, Usage::Order, &scope, outer)?;
        }
        Ok(Relation { columns: output })
    }

    fn bind_ctes(
        &mut self,
        with: &With,
        outer: &[AdvancedScope],
        ctes: &mut BTreeMap<String, Relation>,
    ) -> Result<(), BindError> {
        if with.recursive {
            return Err(BindError::Unsupported("recursive CTE"));
        }
        for cte in &with.ctes {
            let name = canonical(cte.tbl_name.as_str());
            if self.catalog.resources.contains_key(&name) {
                return Err(BindError::ProtectedResourceShadowed);
            }
            if !cte.columns.is_empty() {
                return Err(BindError::Unsupported("CTE column list"));
            }
            let relation = self.select(&cte.select, outer, ctes)?;
            if ctes.insert(name, relation).is_some() {
                return Err(BindError::DuplicateAlias);
            }
        }
        Ok(())
    }

    fn add_select_source(
        &mut self,
        scope: &mut AdvancedScope,
        table: &SelectTable,
        outer: &[AdvancedScope],
        ctes: &BTreeMap<String, Relation>,
    ) -> Result<(), BindError> {
        let source = match table {
            SelectTable::Table(name, alias, indexed) => {
                if name.db_name.is_some() || indexed.is_some() {
                    return Err(BindError::Unsupported("qualified or indexed table"));
                }
                let table_name = canonical(name.name.as_str());
                let alias_name = alias.as_ref().map_or_else(
                    || table_name.clone(),
                    |value| canonical(value.name().as_str()),
                );
                if let Some(relation) = ctes.get(&table_name) {
                    RelationSource {
                        alias: alias_name,
                        relation: relation.clone(),
                    }
                } else {
                    self.base_source(&table_name, &alias_name)?
                }
            }
            SelectTable::Select(select, Some(alias)) => RelationSource {
                alias: canonical(alias.name().as_str()),
                relation: self.select(select, outer, ctes)?,
            },
            _ => return Err(BindError::Unsupported("table source")),
        };
        if scope
            .iter()
            .any(|candidate| candidate.alias == source.alias)
        {
            return Err(BindError::DuplicateAlias);
        }
        scope.push(source);
        Ok(())
    }

    fn base_source(&self, table: &str, alias: &str) -> Result<RelationSource, BindError> {
        let resource = self
            .catalog
            .resources
            .get(&canonical(table))
            .ok_or(BindError::UnknownResource)?;
        Ok(RelationSource {
            alias: canonical(alias),
            relation: Relation {
                columns: resource
                    .columns
                    .iter()
                    .map(|(name, column)| (name.clone(), BTreeSet::from([*column])))
                    .collect(),
            },
        })
    }

    fn expression(
        &mut self,
        expression: &Expr,
        usage: Usage,
        scope: &AdvancedScope,
        outer: &[AdvancedScope],
    ) -> Result<BTreeSet<ColumnId>, BindError> {
        let mut provenance = BTreeSet::new();
        match expression {
            Expr::Id(name) | Expr::Name(name) => {
                provenance = self.resolve(None, name.as_str(), usage, scope, outer)?;
            }
            Expr::Qualified(source, column) => {
                provenance =
                    self.resolve(Some(source.as_str()), column.as_str(), usage, scope, outer)?;
            }
            Expr::Binary(left, _, right) => {
                provenance.extend(self.expression(left, usage, scope, outer)?);
                provenance.extend(self.expression(right, usage, scope, outer)?);
            }
            Expr::Unary(_, inner)
            | Expr::IsNull(inner)
            | Expr::NotNull(inner)
            | Expr::Collate(inner, _) => {
                provenance.extend(self.expression(inner, usage, scope, outer)?);
            }
            Expr::Between {
                lhs, start, end, ..
            } => {
                for item in [lhs, start, end] {
                    provenance.extend(self.expression(item, usage, scope, outer)?);
                }
            }
            Expr::InList { lhs, rhs, .. } => {
                provenance.extend(self.expression(lhs, usage, scope, outer)?);
                for item in rhs {
                    provenance.extend(self.expression(item, usage, scope, outer)?);
                }
            }
            Expr::Parenthesized(items) => {
                for item in items {
                    provenance.extend(self.expression(item, usage, scope, outer)?);
                }
            }
            Expr::FunctionCall {
                name,
                args,
                filter_over,
                order_by,
                within_group,
                ..
            } => {
                if !within_group.is_empty() {
                    return Err(BindError::Unsupported("ordered-set aggregate"));
                }
                let function = canonical(name.as_str());
                let function_usage = match function.as_str() {
                    "count" | "sum" | "avg" | "min" | "max" => Usage::Aggregate,
                    "row_number" => Usage::Window,
                    "lower" | "datetime" => usage,
                    _ => return Err(BindError::Unsupported("function")),
                };
                for argument in args {
                    provenance.extend(self.expression(argument, function_usage, scope, outer)?);
                }
                for sorted in order_by {
                    provenance.extend(self.expression(
                        &sorted.expr,
                        function_usage,
                        scope,
                        outer,
                    )?);
                }
                provenance.extend(self.function_tail(filter_over, scope, outer)?);
            }
            Expr::FunctionCallStar { name, filter_over } => {
                if canonical(name.as_str()) != "count" {
                    return Err(BindError::Unsupported("star function"));
                }
                provenance.extend(self.function_tail(filter_over, scope, outer)?);
            }
            Expr::Exists(subquery) | Expr::Subquery(subquery) => {
                let mut nested = vec![scope.clone()];
                nested.extend_from_slice(outer);
                let relation = self.select(subquery, &nested, &BTreeMap::new())?;
                for columns in relation.columns.values() {
                    provenance.extend(columns);
                }
            }
            Expr::Literal(_) | Expr::Variable(_) => {}
            _ => return Err(BindError::Unsupported("expression")),
        }
        Ok(provenance)
    }

    fn function_tail(
        &mut self,
        tail: &FunctionTail,
        scope: &AdvancedScope,
        outer: &[AdvancedScope],
    ) -> Result<BTreeSet<ColumnId>, BindError> {
        let mut provenance = BTreeSet::new();
        if let Some(filter) = &tail.filter_clause {
            provenance.extend(self.expression(filter, Usage::Having, scope, outer)?);
        }
        if let Some(over) = &tail.over_clause {
            match over {
                turso_parser::ast::Over::Window(window) => {
                    provenance.extend(self.window(window, scope, outer)?);
                }
                turso_parser::ast::Over::Name(_) => {
                    return Err(BindError::Unsupported("named window reference"));
                }
            }
        }
        Ok(provenance)
    }

    fn window(
        &mut self,
        window: &turso_parser::ast::Window,
        scope: &AdvancedScope,
        outer: &[AdvancedScope],
    ) -> Result<BTreeSet<ColumnId>, BindError> {
        if window.base.is_some() || window.frame_clause.is_some() {
            return Err(BindError::Unsupported("window base or frame"));
        }
        let mut provenance = BTreeSet::new();
        for expression in &window.partition_by {
            provenance.extend(self.expression(expression, Usage::Window, scope, outer)?);
        }
        for sorted in &window.order_by {
            provenance.extend(self.expression(&sorted.expr, Usage::Window, scope, outer)?);
        }
        Ok(provenance)
    }

    fn resolve(
        &mut self,
        alias: Option<&str>,
        column: &str,
        usage: Usage,
        scope: &AdvancedScope,
        outer: &[AdvancedScope],
    ) -> Result<BTreeSet<ColumnId>, BindError> {
        if is_rowid(column) {
            return Err(BindError::ImplicitRowId);
        }
        let alias = alias.map(canonical);
        for candidate_scope in std::iter::once(scope).chain(outer.iter()) {
            let matches: Vec<_> = candidate_scope
                .iter()
                .filter(|source| alias.as_ref().is_none_or(|value| &source.alias == value))
                .filter_map(|source| source.relation.columns.get(&canonical(column)))
                .collect();
            match matches.as_slice() {
                [] => continue,
                [columns] => {
                    for column in *columns {
                        self.accesses.insert(Access {
                            column: *column,
                            usage,
                        });
                    }
                    return Ok((*columns).clone());
                }
                _ => return Err(BindError::AmbiguousColumn),
            }
        }
        Err(if alias.is_some() {
            BindError::UnknownResource
        } else {
            BindError::UnknownColumn
        })
    }

    fn record_named(
        &mut self,
        source: &RelationSource,
        column: &str,
        usage: Usage,
    ) -> Result<(), BindError> {
        let columns = source
            .relation
            .columns
            .get(&canonical(column))
            .ok_or(BindError::UnknownColumn)?;
        for column in columns {
            self.accesses.insert(Access {
                column: *column,
                usage,
            });
        }
        Ok(())
    }
}

fn result_name(expression: &Expr, alias: Option<&As>) -> Result<String, BindError> {
    if let Some(alias) = alias {
        return Ok(canonical(alias.name().as_str()));
    }
    match expression {
        Expr::Id(name) | Expr::Name(name) | Expr::Qualified(_, name) => {
            Ok(canonical(name.as_str()))
        }
        _ => Err(BindError::Unsupported("expression output requires alias")),
    }
}

#[derive(Clone, Copy)]
struct BoundColumnRef {
    resource: ResourceId,
    ordinal: u32,
    alias: &'static str,
}

struct ProtectedLeftJoin {
    post_id: BoundColumnRef,
    author_name: BoundColumnRef,
    post_author_id: BoundColumnRef,
    author_id: BoundColumnRef,
    post_tenant: BoundColumnRef,
    author_tenant: BoundColumnRef,
}

fn emit_protected_join(catalog: &Catalog, query: &ProtectedLeftJoin) -> Result<String, BindError> {
    let column = |reference: BoundColumnRef| -> Result<String, BindError> {
        let resource = catalog
            .resources
            .values()
            .find(|resource| resource.id == reference.resource)
            .ok_or(BindError::UnknownResource)?;
        let name = resource
            .columns
            .iter()
            .find_map(|(name, id)| (id.ordinal == reference.ordinal).then_some(name))
            .ok_or(BindError::UnknownColumn)?;
        Ok(format!("{}.{}", quote(reference.alias), quote(name)))
    };
    let resource_name = |id: ResourceId| -> Result<&str, BindError> {
        catalog
            .resources
            .iter()
            .find_map(|(name, resource)| (resource.id == id).then_some(name.as_str()))
            .ok_or(BindError::UnknownResource)
    };

    Ok(format!(
        "SELECT {}, {} FROM {} AS {} LEFT JOIN {} AS {} ON {} = {} AND {} = :__policysql_tenant WHERE {} = :__policysql_tenant ORDER BY {}",
        column(query.post_id)?,
        column(query.author_name)?,
        quote(resource_name(query.post_id.resource)?),
        quote(query.post_id.alias),
        quote(resource_name(query.author_name.resource)?),
        quote(query.author_name.alias),
        column(query.author_id)?,
        column(query.post_author_id)?,
        column(query.author_tenant)?,
        column(query.post_tenant)?,
        column(query.post_id)?,
    ))
}

fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn verify_emitted(sql: &str, catalog: &Catalog) -> Result<(), BindError> {
    let parsed = Parser::new(sql.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| BindError::Parse)?;
    if parsed.len() != 1 {
        return Err(BindError::MultipleStatements);
    }
    let accesses: BTreeSet<_> = bind_advanced(sql, catalog)?.into_iter().collect();
    let expected = BTreeSet::from([
        Access {
            column: ColumnId {
                resource: ResourceId(1),
                ordinal: 0,
            },
            usage: Usage::Projection,
        },
        Access {
            column: ColumnId {
                resource: ResourceId(1),
                ordinal: 0,
            },
            usage: Usage::Order,
        },
        Access {
            column: ColumnId {
                resource: ResourceId(1),
                ordinal: 1,
            },
            usage: Usage::Join,
        },
        Access {
            column: ColumnId {
                resource: ResourceId(1),
                ordinal: 2,
            },
            usage: Usage::Filter,
        },
        Access {
            column: ColumnId {
                resource: ResourceId(2),
                ordinal: 0,
            },
            usage: Usage::Join,
        },
        Access {
            column: ColumnId {
                resource: ResourceId(2),
                ordinal: 1,
            },
            usage: Usage::Join,
        },
        Access {
            column: ColumnId {
                resource: ResourceId(2),
                ordinal: 2,
            },
            usage: Usage::Projection,
        },
    ]);
    let Cmd::Stmt(Stmt::Select(select)) = &parsed[0] else {
        return Err(BindError::Unsupported("emission invariant"));
    };
    let OneSelect::Select {
        from: Some(from),
        where_clause: Some(where_clause),
        ..
    } = &select.body.select
    else {
        return Err(BindError::Unsupported("emission invariant"));
    };
    let Some(join) = from.joins.first() else {
        return Err(BindError::Unsupported("emission invariant"));
    };
    let is_left = matches!(
        join.operator,
        JoinOperator::TypedJoin(Some(types)) if types.contains(JoinType::LEFT)
    );
    let join_has_policy = matches!(
        &join.constraint,
        Some(JoinConstraint::On(predicate))
            if contains_policy_equality(predicate, "a", "tenant_id")
    );
    if accesses != expected
        || from.joins.len() != 1
        || !is_left
        || !join_has_policy
        || !contains_policy_equality(where_clause, "p", "tenant_id")
    {
        return Err(BindError::Unsupported("emission invariant"));
    }
    Ok(())
}

fn contains_policy_equality(expression: &Expr, alias: &str, column: &str) -> bool {
    match expression {
        Expr::Binary(left, Operator::And, right) => {
            contains_policy_equality(left, alias, column)
                || contains_policy_equality(right, alias, column)
        }
        Expr::Binary(left, Operator::Equals, right) => {
            (is_qualified(left, alias, column) && is_server_tenant(right))
                || (is_qualified(right, alias, column) && is_server_tenant(left))
        }
        Expr::Parenthesized(items) if items.len() == 1 => {
            contains_policy_equality(&items[0], alias, column)
        }
        _ => false,
    }
}

fn is_qualified(expression: &Expr, alias: &str, column: &str) -> bool {
    matches!(
        expression,
        Expr::Qualified(actual_alias, actual_column)
            if canonical(actual_alias.as_str()) == alias
                && canonical(actual_column.as_str()) == column
    )
}

fn is_server_tenant(expression: &Expr) -> bool {
    matches!(
        expression,
        Expr::Variable(variable)
            if variable.name.as_deref() == Some(":__policysql_tenant")
    )
}

fn blog_join() -> ProtectedLeftJoin {
    ProtectedLeftJoin {
        post_id: BoundColumnRef {
            resource: ResourceId(1),
            ordinal: 0,
            alias: "p",
        },
        post_author_id: BoundColumnRef {
            resource: ResourceId(1),
            ordinal: 1,
            alias: "p",
        },
        post_tenant: BoundColumnRef {
            resource: ResourceId(1),
            ordinal: 2,
            alias: "p",
        },
        author_id: BoundColumnRef {
            resource: ResourceId(2),
            ordinal: 0,
            alias: "a",
        },
        author_tenant: BoundColumnRef {
            resource: ResourceId(2),
            ordinal: 1,
            alias: "a",
        },
        author_name: BoundColumnRef {
            resource: ResourceId(2),
            ordinal: 2,
            alias: "a",
        },
    }
}

#[test]
fn binds_cte_and_derived_column_provenance() {
    let accesses = bind_advanced(
        "WITH visible AS (SELECT p.id AS post_id, p.author_id AS author_id FROM posts p WHERE p.tenant_id = :tenant) SELECT v.post_id FROM visible v JOIN (SELECT a.id AS author_id, a.name AS author_name FROM authors a) d ON d.author_id = v.author_id ORDER BY d.author_name",
        &Catalog::blog(),
    )
    .unwrap();
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
fn binds_group_aggregate_having_and_window_contexts() {
    let accesses = bind_advanced(
        "SELECT p.author_id, count(p.id) AS post_count, row_number() OVER (PARTITION BY p.tenant_id ORDER BY p.id) AS rank FROM posts p GROUP BY p.author_id HAVING count(p.id) > 0",
        &Catalog::blog(),
    )
    .unwrap();
    let post_id = ColumnId {
        resource: ResourceId(1),
        ordinal: 0,
    };
    let author_id = ColumnId {
        resource: ResourceId(1),
        ordinal: 1,
    };
    let tenant_id = ColumnId {
        resource: ResourceId(1),
        ordinal: 2,
    };
    assert!(accesses.contains(&Access {
        column: post_id,
        usage: Usage::Aggregate
    }));
    assert!(accesses.contains(&Access {
        column: author_id,
        usage: Usage::Group
    }));
    assert!(accesses.contains(&Access {
        column: tenant_id,
        usage: Usage::Window
    }));
    assert!(accesses.contains(&Access {
        column: post_id,
        usage: Usage::Window
    }));
}

#[test]
fn binds_mutation_write_filter_and_returning_contexts() {
    let catalog = Catalog::blog();
    let insert = bind_advanced(
        "INSERT INTO posts (id, author_id, tenant_id, title) VALUES (:id, :author, :tenant, :title) RETURNING id, tenant_id",
        &catalog,
    )
    .unwrap();
    assert!(insert.contains(&Access {
        column: ColumnId {
            resource: ResourceId(1),
            ordinal: 2
        },
        usage: Usage::Write,
    }));
    assert!(insert.contains(&Access {
        column: ColumnId {
            resource: ResourceId(1),
            ordinal: 0
        },
        usage: Usage::Returning,
    }));

    let update = bind_advanced(
        "UPDATE posts SET title = lower(title) WHERE tenant_id = :tenant RETURNING id, title",
        &catalog,
    )
    .unwrap();
    assert!(update.contains(&Access {
        column: ColumnId {
            resource: ResourceId(1),
            ordinal: 3
        },
        usage: Usage::Mutation,
    }));
    assert!(update.contains(&Access {
        column: ColumnId {
            resource: ResourceId(1),
            ordinal: 2
        },
        usage: Usage::Filter,
    }));

    let delete = bind_advanced(
        "DELETE FROM posts WHERE tenant_id = :tenant RETURNING private_note",
        &catalog,
    )
    .unwrap();
    assert!(delete.contains(&Access {
        column: ColumnId {
            resource: ResourceId(1),
            ordinal: 4
        },
        usage: Usage::Returning,
    }));
}

#[test]
fn emits_reparses_and_independently_checks_policy_shape() {
    let catalog = Catalog::blog();
    let sql = emit_protected_join(&catalog, &blog_join()).unwrap();
    verify_emitted(&sql, &catalog).unwrap();

    let missing_join_policy = sql.replacen(" AND \"a\".\"tenant_id\" = :__policysql_tenant", "", 1);
    assert_eq!(
        verify_emitted(&missing_join_policy, &catalog),
        Err(BindError::Unsupported("emission invariant"))
    );
    assert_eq!(
        verify_emitted(&format!("{sql}; SELECT 1"), &catalog),
        Err(BindError::MultipleStatements)
    );
}

#[test]
fn rejects_unsupported_advanced_shapes_fail_closed() {
    let catalog = Catalog::blog();
    assert_eq!(
        bind_advanced(
            "WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id + 1 FROM ids) SELECT id FROM ids",
            &catalog,
        ),
        Err(BindError::Unsupported("recursive CTE"))
    );
    assert_eq!(
        bind_advanced("UPDATE posts SET missing = 1", &catalog),
        Err(BindError::UnknownColumn)
    );
}
