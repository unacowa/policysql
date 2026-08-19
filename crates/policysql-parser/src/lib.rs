#![forbid(unsafe_code)]

use policysql_catalog::{Catalog, ColumnDescriptor, ResourceDescriptor};
use policysql_core::{ClientParameterName, LogicalType, LogicalValue, ResultName};
use policysql_ir::{
    BoundAssignment, BoundColumn, BoundConstantSelect, BoundDelete, BoundExpr, BoundInsert,
    BoundJoin, BoundJsonCollectionSelect, BoundOrder, BoundProjection, BoundSelect, BoundStatement,
    BoundUpdate, ColumnUsage, JoinKind, ScalarFunction, SortDirection,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use turso_parser::ast::{
    As, Cmd, Expr, InsertBody, JoinConstraint, JoinOperator, JoinType, LikeOperator, Literal,
    OneSelect, Operator, Over, ResultColumn, Select, SelectTable, Stmt, Type, UnaryOperator,
};
use turso_parser::parser::Parser;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BindingLimits {
    pub max_expression_depth: usize,
    pub max_parameters: usize,
    pub max_projections: usize,
    pub max_joins: usize,
}

impl Default for BindingLimits {
    fn default() -> Self {
        Self {
            max_expression_depth: 32,
            max_parameters: 128,
            max_projections: 128,
            max_joins: 8,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SqliteFrontend {
    limits: BindingLimits,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourceSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundDocument {
    pub statement: BoundStatement,
    pub source_span: SourceSpan,
    pub parameters: BTreeSet<ClientParameterName>,
}

impl SqliteFrontend {
    #[must_use]
    pub const fn new(limits: BindingLimits) -> Self {
        Self { limits }
    }

    /// Parses exactly one statement and binds the initial `SQLite` SELECT subset.
    ///
    /// # Errors
    ///
    /// Rejects malformed, multiple, unsupported, ambiguous, or unprovable SQL.
    pub fn bind(&self, sql: &str, catalog: &Catalog) -> Result<BoundStatement, BindError> {
        self.bind_document(sql, catalog)
            .map(|document| document.statement)
    }

    /// Binds a statement while preserving its source range and named parameters.
    ///
    /// # Errors
    ///
    /// Returns the same fail-closed errors as [`Self::bind`].
    pub fn bind_document(&self, sql: &str, catalog: &Catalog) -> Result<BoundDocument, BindError> {
        if sql.trim().is_empty() {
            return Err(BindError::Empty);
        }
        let parsed = Parser::new(sql.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| BindError::InvalidSql)?;
        if parsed.len() != 1 {
            return Err(BindError::MultipleStatements);
        }
        let Cmd::Stmt(statement) = &parsed[0] else {
            return Err(BindError::Unsupported("EXPLAIN"));
        };
        let (statement, parameters) = match statement {
            Stmt::Select(select) => {
                if has_json_table_call(select) {
                    let (select, parameters) = self.bind_json_collection_select(select, catalog)?;
                    (BoundStatement::JsonCollectionSelect(select), parameters)
                } else if matches!(&select.body.select, OneSelect::Select { from: None, .. }) {
                    let select = self.bind_constant_select(select)?;
                    (BoundStatement::ConstantSelect(select), BTreeSet::new())
                } else {
                    let (select, parameters) = self.bind_select(select, catalog)?;
                    (BoundStatement::Select(Box::new(select)), parameters)
                }
            }
            Stmt::Insert {
                with,
                or_conflict,
                tbl_name,
                columns,
                body,
                returning,
            } => self.bind_insert(
                with.as_ref(),
                *or_conflict,
                tbl_name,
                columns,
                body,
                returning,
                catalog,
            )?,
            Stmt::Delete {
                with,
                tbl_name,
                indexed,
                where_clause,
                returning,
                order_by,
                limit,
            } => self.bind_delete(
                with.as_ref(),
                tbl_name,
                indexed.as_ref(),
                where_clause.as_deref(),
                returning,
                order_by,
                limit.as_ref(),
                catalog,
            )?,
            Stmt::Update(update) => self.bind_update(update, catalog)?,
            _ => return Err(BindError::Unsupported("statement")),
        };
        let start = sql
            .find(|character: char| !character.is_whitespace())
            .unwrap_or(0);
        let end = sql.trim_end().len();
        Ok(BoundDocument {
            statement,
            source_span: SourceSpan { start, end },
            parameters,
        })
    }

    fn bind_constant_select(&self, select: &Select) -> Result<BoundConstantSelect, BindError> {
        if select.with.is_some()
            || !select.body.compounds.is_empty()
            || !select.order_by.is_empty()
            || select.limit.is_some()
        {
            return Err(BindError::Unsupported("constant SELECT option"));
        }
        let OneSelect::Select {
            distinctness,
            columns,
            from: None,
            where_clause,
            group_by,
            window_clause,
        } = &select.body.select
        else {
            return Err(BindError::Unsupported("constant SELECT"));
        };
        if distinctness.is_some()
            || where_clause.is_some()
            || group_by.is_some()
            || !window_clause.is_empty()
            || columns.is_empty()
            || columns.len() > self.limits.max_projections
        {
            return Err(BindError::Unsupported("constant SELECT option"));
        }
        let projections = columns
            .iter()
            .map(|column| {
                let ResultColumn::Expr(expression, alias) = column else {
                    return Err(BindError::Unsupported("constant star"));
                };
                let Expr::Literal(Literal::Numeric(raw)) = expression.as_ref() else {
                    return Err(BindError::Unsupported("constant expression"));
                };
                let (expression, _) = bind_literal(&Literal::Numeric(raw.clone()), None)?;
                let output_name = explicit_alias(alias.as_ref()).unwrap_or(raw);
                Ok(BoundProjection {
                    expression,
                    output_name: ResultName::new(output_name)
                        .map_err(|_| BindError::InvalidResultName)?,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        ensure_unique_result_names(&projections)?;
        Ok(BoundConstantSelect { projections })
    }

    #[allow(clippy::too_many_lines)]
    fn bind_json_collection_select(
        &self,
        select: &Select,
        catalog: &Catalog,
    ) -> Result<(BoundJsonCollectionSelect, BTreeSet<ClientParameterName>), BindError> {
        if select.with.is_some()
            || !select.body.compounds.is_empty()
            || !select.order_by.is_empty()
            || select.limit.is_some()
        {
            return Err(BindError::Unsupported("JSON collection option"));
        }
        let OneSelect::Select {
            distinctness,
            columns,
            from: Some(from),
            where_clause,
            group_by,
            window_clause,
        } = &select.body.select
        else {
            return Err(BindError::Unsupported("JSON collection"));
        };
        if distinctness.is_some()
            || group_by.is_some()
            || !window_clause.is_empty()
            || columns.len() != 1
            || from.joins.len() != 1
        {
            return Err(BindError::Unsupported("JSON collection shape"));
        }
        let root = bind_source(&from.select, catalog)?;
        let resource = root.resource.id;
        let alias = root.alias.clone();
        let join = &from.joins[0];
        if !matches!(
            join.operator,
            JoinOperator::Comma | JoinOperator::TypedJoin(None)
        ) || join.constraint.is_some()
        {
            return Err(BindError::Unsupported("JSON table join"));
        }
        let SelectTable::TableCall(name, arguments, table_alias) = join.table.as_ref() else {
            return Err(BindError::Unsupported("JSON table source"));
        };
        if name.db_name.is_some() || arguments.len() != 2 {
            return Err(BindError::Unsupported("JSON table arguments"));
        }
        let recursive = match canonical(name.name.as_str()).as_str() {
            "json_each" => false,
            "json_tree" => true,
            _ => return Err(BindError::Unsupported("table function")),
        };
        let table_alias = explicit_alias(table_alias.as_ref())
            .ok_or(BindError::Unsupported("JSON table alias"))?;
        let mut state = BindState {
            scopes: vec![root],
            parameters: BTreeSet::new(),
            limits: self.limits,
            catalog,
        };
        let (document, document_type) = state.bind_scalar(
            &arguments[0],
            ColumnUsage::Aggregate,
            Some(LogicalType::Json),
            0,
        )?;
        let BoundExpr::Column(document) = document else {
            return Err(BindError::Unsupported("JSON document provenance"));
        };
        if document_type != LogicalType::Json {
            return Err(BindError::IncompatibleTypes);
        }
        let (path, path_type) = state.bind_scalar(
            &arguments[1],
            ColumnUsage::Aggregate,
            Some(LogicalType::String),
            0,
        )?;
        if path_type != LogicalType::String {
            return Err(BindError::IncompatibleTypes);
        }
        let ResultColumn::Expr(expression, output_alias) = &columns[0] else {
            return Err(BindError::Unsupported("JSON collection projection"));
        };
        let Expr::FunctionCall {
            name,
            distinctness: None,
            args,
            order_by,
            within_group,
            filter_over,
        } = expression.as_ref()
        else {
            return Err(BindError::Unsupported("JSON collection aggregate"));
        };
        if !name.as_str().eq_ignore_ascii_case("json_group_array")
            || args.len() != 1
            || !order_by.is_empty()
            || !within_group.is_empty()
            || filter_over.filter_clause.is_some()
            || filter_over.over_clause.is_some()
            || !matches!(
                args[0].as_ref(),
                Expr::Qualified(source, column)
                    if source.as_str().eq_ignore_ascii_case(table_alias)
                        && column.as_str().eq_ignore_ascii_case("value")
            )
        {
            return Err(BindError::Unsupported("JSON collection aggregate"));
        }
        let output_name = explicit_alias(output_alias.as_ref())
            .ok_or(BindError::InvalidResultName)
            .and_then(|name| ResultName::new(name).map_err(|_| BindError::InvalidResultName))?;
        let predicate = where_clause
            .as_deref()
            .map(|expression| state.bind_boolean(expression, ColumnUsage::Filter, 0))
            .transpose()?;
        Ok((
            BoundJsonCollectionSelect {
                resource,
                alias,
                document,
                path,
                recursive,
                output_name,
                predicate,
            },
            state.parameters,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn bind_delete(
        &self,
        with: Option<&turso_parser::ast::With>,
        table: &turso_parser::ast::QualifiedName,
        indexed: Option<&turso_parser::ast::Indexed>,
        predicate: Option<&Expr>,
        returning: &[ResultColumn],
        order_by: &[turso_parser::ast::SortedColumn],
        limit: Option<&turso_parser::ast::Limit>,
        catalog: &Catalog,
    ) -> Result<(BoundStatement, BTreeSet<ClientParameterName>), BindError> {
        if with.is_some()
            || table.db_name.is_some()
            || indexed.is_some()
            || !order_by.is_empty()
            || limit.is_some()
        {
            return Err(BindError::Unsupported("DELETE option"));
        }
        let resource = catalog
            .resource(table.name.as_str())
            .ok_or(BindError::UnknownResource)?;
        let root = bind_source(&SelectTable::Table(table.clone(), None, None), catalog)?;
        let mut state = BindState {
            scopes: vec![root],
            parameters: BTreeSet::new(),
            limits: self.limits,
            catalog,
        };
        let predicate = predicate
            .map(|expression| state.bind_boolean(expression, ColumnUsage::Mutation, 0))
            .transpose()?;
        let returning = state.bind_returning(returning)?;
        Ok((
            BoundStatement::Delete(BoundDelete {
                resource: resource.id,
                predicate,
                returning,
            }),
            state.parameters,
        ))
    }

    fn bind_update(
        &self,
        update: &turso_parser::ast::Update,
        catalog: &Catalog,
    ) -> Result<(BoundStatement, BTreeSet<ClientParameterName>), BindError> {
        if update.with.is_some()
            || update.or_conflict.is_some()
            || update.tbl_name.db_name.is_some()
            || update.indexed.is_some()
            || update.from.is_some()
            || !update.order_by.is_empty()
            || update.limit.is_some()
            || update.sets.is_empty()
        {
            return Err(BindError::Unsupported("UPDATE option"));
        }
        let resource = catalog
            .resource(update.tbl_name.name.as_str())
            .ok_or(BindError::UnknownResource)?;
        let root = bind_source(
            &SelectTable::Table(update.tbl_name.clone(), None, None),
            catalog,
        )?;
        let mut state = BindState {
            scopes: vec![root],
            parameters: BTreeSet::new(),
            limits: self.limits,
            catalog,
        };
        let mut seen = BTreeSet::new();
        let mut assignments = Vec::with_capacity(update.sets.len());
        for set in &update.sets {
            if set.col_names.len() != 1 {
                return Err(BindError::Unsupported("row-value UPDATE"));
            }
            let column = resource
                .column(set.col_names[0].as_str())
                .ok_or(BindError::UnknownColumn)?;
            if !seen.insert(column.id) {
                return Err(BindError::DuplicateWriteColumn);
            }
            let (value, logical_type) = state.bind_scalar(
                &set.expr,
                ColumnUsage::Write,
                Some(column.value.logical_type),
                0,
            )?;
            if logical_type != column.value.logical_type {
                return Err(BindError::IncompatibleTypes);
            }
            if !matches!(
                &value,
                BoundExpr::ClientParameter { .. } | BoundExpr::Literal(_)
            ) {
                return Err(BindError::Unsupported("UPDATE assignment expression"));
            }
            assignments.push(BoundAssignment {
                column: bound_column(column, ColumnUsage::Write),
                value,
            });
        }
        let predicate = update
            .where_clause
            .as_deref()
            .map(|expression| state.bind_boolean(expression, ColumnUsage::Mutation, 0))
            .transpose()?;
        let returning = state.bind_returning(&update.returning)?;
        Ok((
            BoundStatement::Update(BoundUpdate {
                resource: resource.id,
                assignments,
                predicate,
                returning,
            }),
            state.parameters,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn bind_insert(
        &self,
        with: Option<&turso_parser::ast::With>,
        or_conflict: Option<turso_parser::ast::ResolveType>,
        table: &turso_parser::ast::QualifiedName,
        columns: &[turso_parser::ast::Name],
        body: &InsertBody,
        returning: &[ResultColumn],
        catalog: &Catalog,
    ) -> Result<(BoundStatement, BTreeSet<ClientParameterName>), BindError> {
        if with.is_some() || or_conflict.is_some() || table.db_name.is_some() {
            return Err(BindError::Unsupported("INSERT option"));
        }
        if columns.is_empty() {
            return Err(BindError::Unsupported("INSERT columns"));
        }
        let resource = catalog
            .resource(table.name.as_str())
            .ok_or(BindError::UnknownResource)?;
        let mut seen = BTreeSet::new();
        let mut descriptors = Vec::with_capacity(columns.len());
        for name in columns {
            let column = resource
                .column(name.as_str())
                .ok_or(BindError::UnknownColumn)?;
            if !seen.insert(column.id) {
                return Err(BindError::DuplicateWriteColumn);
            }
            descriptors.push(column.clone());
        }
        let InsertBody::Select(select, None) = body else {
            return Err(BindError::Unsupported("INSERT body"));
        };
        if select.with.is_some()
            || !select.body.compounds.is_empty()
            || !select.order_by.is_empty()
            || select.limit.is_some()
        {
            return Err(BindError::Unsupported("INSERT SELECT"));
        }
        let OneSelect::Values(values) = &select.body.select else {
            return Err(BindError::Unsupported("INSERT SELECT"));
        };
        if values.is_empty() {
            return Err(BindError::Unsupported("empty VALUES"));
        }
        let root = bind_source(&SelectTable::Table(table.clone(), None, None), catalog)?;
        let mut state = BindState {
            scopes: vec![root],
            parameters: BTreeSet::new(),
            limits: self.limits,
            catalog,
        };
        let mut rows = Vec::with_capacity(values.len());
        for values in values {
            if values.len() != descriptors.len() {
                return Err(BindError::InsertArity);
            }
            let mut row = Vec::with_capacity(values.len());
            for (value, column) in values.iter().zip(&descriptors) {
                let (value, logical_type) = state.bind_scalar(
                    value,
                    ColumnUsage::Write,
                    Some(column.value.logical_type),
                    0,
                )?;
                if logical_type != column.value.logical_type {
                    return Err(BindError::IncompatibleTypes);
                }
                if !matches!(
                    &value,
                    BoundExpr::ClientParameter { .. } | BoundExpr::Literal(_)
                ) {
                    return Err(BindError::Unsupported("INSERT value expression"));
                }
                row.push(BoundAssignment {
                    column: bound_column(column, ColumnUsage::Write),
                    value,
                });
            }
            rows.push(row);
        }
        let returning = state.bind_returning(returning)?;
        Ok((
            BoundStatement::Insert(BoundInsert {
                resource: resource.id,
                rows,
                returning,
            }),
            state.parameters,
        ))
    }

    #[allow(clippy::too_many_lines)]
    fn bind_select(
        &self,
        select: &Select,
        catalog: &Catalog,
    ) -> Result<(BoundSelect, BTreeSet<ClientParameterName>), BindError> {
        if !select.body.compounds.is_empty() {
            return Err(BindError::Unsupported("compound SELECT"));
        }
        let OneSelect::Select {
            distinctness,
            columns,
            from,
            where_clause,
            group_by,
            window_clause,
        } = &select.body.select
        else {
            return Err(BindError::Unsupported("VALUES"));
        };
        if distinctness.is_some() {
            return Err(BindError::Unsupported("DISTINCT or ALL"));
        }
        if !window_clause.is_empty() {
            return Err(BindError::Unsupported("WINDOW"));
        }
        let from = from.as_ref().ok_or(BindError::MissingFrom)?;
        if from.joins.len() > self.limits.max_joins {
            return Err(BindError::JoinLimit);
        }
        let (root, inherited_predicate, inherited_parameters) =
            self.bind_root_source(select, from, catalog)?;
        let resource = root.resource;
        let alias = root.alias.clone();
        if columns.is_empty() || columns.len() > self.limits.max_projections {
            return Err(BindError::ProjectionLimit);
        }

        let mut state = BindState {
            scopes: vec![root],
            parameters: inherited_parameters,
            limits: self.limits,
            catalog,
        };
        let joins = bind_joins(from, catalog, &mut state)?;
        let mut projections = Vec::with_capacity(columns.len());
        for column in columns {
            projections.push(state.bind_projection(column)?);
        }
        ensure_unique_result_names(&projections)?;

        let predicate = where_clause
            .as_deref()
            .map(|expression| state.bind_boolean(expression, ColumnUsage::Filter, 0))
            .transpose()?;
        let predicate = match (inherited_predicate, predicate) {
            (Some(inherited), Some(outer)) => {
                Some(BoundExpr::And(Box::new(inherited), Box::new(outer)))
            }
            (Some(inherited), None) => Some(inherited),
            (None, outer) => outer,
        };
        let (group_by, having) = if let Some(group) = group_by {
            if group.exprs.is_empty() {
                return Err(BindError::Unsupported("empty GROUP BY"));
            }
            let columns = group
                .exprs
                .iter()
                .map(|expression| {
                    state
                        .resolve_direct_column(expression)
                        .map(|column| bound_column(&column, ColumnUsage::Group))
                })
                .collect::<Result<Vec<_>, _>>()?;
            let having = group
                .having
                .as_deref()
                .map(|expression| state.bind_boolean(expression, ColumnUsage::Having, 0))
                .transpose()?;
            (columns, having)
        } else {
            (Vec::new(), None)
        };
        let order_by = select
            .order_by
            .iter()
            .map(|order| {
                if order.nulls.is_some() {
                    return Err(BindError::Unsupported("NULLS ordering"));
                }
                let expression = match state.resolve_direct_column(&order.expr) {
                    Ok(column) => BoundExpr::Column(bound_column(&column, ColumnUsage::Order)),
                    Err(BindError::UnknownColumn) => {
                        let name = match order.expr.as_ref() {
                            Expr::Id(name) | Expr::Name(name) => name.as_str(),
                            _ => return Err(BindError::UnknownColumn),
                        };
                        let projection = projections
                            .iter()
                            .find(|projection| {
                                projection.output_name.as_str().eq_ignore_ascii_case(name)
                            })
                            .ok_or(BindError::UnknownColumn)?;
                        projection.expression.clone()
                    }
                    Err(error) => return Err(error),
                };
                Ok(BoundOrder {
                    expression,
                    direction: match order.order {
                        Some(turso_parser::ast::SortOrder::Desc) => SortDirection::Descending,
                        None | Some(turso_parser::ast::SortOrder::Asc) => SortDirection::Ascending,
                    },
                })
            })
            .collect::<Result<Vec<_>, BindError>>()?;
        let limit = select
            .limit
            .as_ref()
            .map(|limit| state.bind_limit(&limit.expr))
            .transpose()?;
        let offset = select
            .limit
            .as_ref()
            .and_then(|limit| limit.offset.as_ref())
            .map(|offset| state.bind_limit(offset))
            .transpose()?;
        let parameters = std::mem::take(&mut state.parameters);
        drop(state);

        Ok((
            BoundSelect {
                resource: resource.id,
                alias,
                joins,
                projections,
                predicate,
                group_by,
                having,
                order_by,
                limit,
                offset,
            },
            parameters,
        ))
    }

    fn bind_root_source<'a>(
        &self,
        select: &Select,
        from: &turso_parser::ast::FromClause,
        catalog: &'a Catalog,
    ) -> Result<
        (
            SourceScope<'a>,
            Option<BoundExpr>,
            BTreeSet<ClientParameterName>,
        ),
        BindError,
    > {
        match from.select.as_ref() {
            SelectTable::Table(name, alias, indexed)
                if select.with.as_ref().is_some_and(|with| {
                    with.ctes.len() == 1
                        && with.ctes[0]
                            .tbl_name
                            .as_str()
                            .eq_ignore_ascii_case(name.name.as_str())
                }) =>
            {
                if name.db_name.is_some() || indexed.is_some() {
                    return Err(BindError::Unsupported("CTE qualifier"));
                }
                let with = select.with.as_ref().ok_or(BindError::Unsupported("CTE"))?;
                let cte = &with.ctes[0];
                if catalog.resource(cte.tbl_name.as_str()).is_some() {
                    return Err(BindError::Unsupported("CTE shadows protected resource"));
                }
                if with.recursive
                    || !cte.columns.is_empty()
                    || !matches!(cte.materialized, turso_parser::ast::Materialized::Any)
                {
                    return Err(BindError::Unsupported("CTE options"));
                }
                let qualifier = explicit_alias(alias.as_ref()).unwrap_or(cte.tbl_name.as_str());
                self.bind_derived_source(&cte.select, qualifier, catalog)
            }
            SelectTable::Table(..) if select.with.is_none() => {
                Ok((bind_source(&from.select, catalog)?, None, BTreeSet::new()))
            }
            SelectTable::Select(inner, alias) if select.with.is_none() => {
                let alias = explicit_alias(alias.as_ref())
                    .ok_or(BindError::Unsupported("derived table without alias"))?;
                self.bind_derived_source(inner, alias, catalog)
            }
            _ => Err(BindError::Unsupported("table source")),
        }
    }

    fn bind_derived_source<'a>(
        &self,
        inner: &Select,
        alias: &str,
        catalog: &'a Catalog,
    ) -> Result<
        (
            SourceScope<'a>,
            Option<BoundExpr>,
            BTreeSet<ClientParameterName>,
        ),
        BindError,
    > {
        let (inner, parameters) = self.bind_select(inner, catalog)?;
        if !inner.joins.is_empty()
            || !inner.order_by.is_empty()
            || inner.limit.is_some()
            || inner.offset.is_some()
            || !inner.group_by.is_empty()
            || inner.having.is_some()
        {
            return Err(BindError::Unsupported("non-transparent derived table"));
        }
        let resource = catalog
            .resource_by_id(inner.resource)
            .ok_or(BindError::UnknownResource)?;
        let mut columns = BTreeMap::new();
        for projection in inner.projections {
            let BoundExpr::Column(column) = projection.expression else {
                return Err(BindError::Unsupported("derived expression"));
            };
            let descriptor = resource
                .column_by_id(column.id)
                .cloned()
                .ok_or(BindError::UnknownColumn)?;
            if columns
                .insert(canonical(projection.output_name.as_str()), descriptor)
                .is_some()
            {
                return Err(BindError::DuplicateResultName);
            }
        }
        Ok((
            SourceScope {
                resource,
                alias: Some(canonical(alias)),
                qualifier: canonical(alias),
                columns,
            },
            inner.predicate,
            parameters,
        ))
    }
}

fn bind_source<'a>(
    table: &SelectTable,
    catalog: &'a Catalog,
) -> Result<SourceScope<'a>, BindError> {
    let SelectTable::Table(name, alias, indexed) = table else {
        return Err(BindError::Unsupported("table source"));
    };
    if name.db_name.is_some() {
        return Err(BindError::Unsupported("database qualifier"));
    }
    if indexed.is_some() {
        return Err(BindError::Unsupported("INDEXED BY"));
    }
    let resource = catalog
        .resource(name.name.as_str())
        .ok_or(BindError::UnknownResource)?;
    let alias = alias
        .as_ref()
        .filter(|alias| alias.is_explicit())
        .map(|alias| canonical(alias.name().as_str()));
    let qualifier = alias
        .clone()
        .unwrap_or_else(|| canonical(resource.name.as_str()));
    let columns = resource
        .columns()
        .map(|column| (canonical(column.name.as_str()), column.clone()))
        .collect();
    Ok(SourceScope {
        resource,
        alias,
        qualifier,
        columns,
    })
}

#[derive(Clone)]
struct SourceScope<'a> {
    resource: &'a ResourceDescriptor,
    alias: Option<String>,
    qualifier: String,
    columns: std::collections::BTreeMap<String, ColumnDescriptor>,
}

fn bind_joins<'a>(
    from: &turso_parser::ast::FromClause,
    catalog: &'a Catalog,
    state: &mut BindState<'a>,
) -> Result<Vec<BoundJoin>, BindError> {
    let mut output = Vec::with_capacity(from.joins.len());
    for join in &from.joins {
        let kind = match join.operator {
            JoinOperator::TypedJoin(None) => JoinKind::Inner,
            JoinOperator::TypedJoin(Some(kind)) if kind == JoinType::INNER => JoinKind::Inner,
            JoinOperator::TypedJoin(Some(kind))
                if kind == (JoinType::LEFT | JoinType::OUTER) || kind == JoinType::LEFT =>
            {
                JoinKind::Left
            }
            _ => return Err(BindError::Unsupported("JOIN type")),
        };
        let joined = bind_source(&join.table, catalog)?;
        if state
            .scopes
            .iter()
            .any(|scope| scope.resource.id == joined.resource.id)
        {
            return Err(BindError::Unsupported("self JOIN"));
        }
        if state
            .scopes
            .iter()
            .any(|scope| scope.qualifier.eq_ignore_ascii_case(&joined.qualifier))
        {
            return Err(BindError::DuplicateAlias);
        }
        let joined_resource = joined.resource.id;
        let joined_alias = joined.alias.clone();
        state.scopes.push(joined);
        let JoinConstraint::On(on) = join
            .constraint
            .as_ref()
            .ok_or(BindError::Unsupported("JOIN without ON"))?
        else {
            return Err(BindError::Unsupported("JOIN constraint"));
        };
        output.push(BoundJoin {
            resource: joined_resource,
            alias: joined_alias,
            kind,
            on: state.bind_boolean(on, ColumnUsage::Join, 0)?,
        });
    }
    Ok(output)
}

struct BindState<'a> {
    scopes: Vec<SourceScope<'a>>,
    parameters: BTreeSet<ClientParameterName>,
    limits: BindingLimits,
    catalog: &'a Catalog,
}

impl BindState<'_> {
    fn bind_returning(
        &self,
        returning: &[ResultColumn],
    ) -> Result<Vec<BoundProjection>, BindError> {
        let mut output = Vec::with_capacity(returning.len());
        for result in returning {
            let ResultColumn::Expr(expression, alias) = result else {
                return Err(BindError::Unsupported("RETURNING star"));
            };
            let column = self.resolve_direct_column(expression)?;
            let output_name = explicit_alias(alias.as_ref())
                .map_or_else(|| column.name.as_str().to_owned(), str::to_owned);
            output.push(BoundProjection {
                expression: BoundExpr::Column(bound_column(&column, ColumnUsage::Returning)),
                output_name: ResultName::new(output_name)
                    .map_err(|_| BindError::InvalidResultName)?,
            });
        }
        ensure_unique_result_names(&output)?;
        Ok(output)
    }

    fn bind_projection(&mut self, result: &ResultColumn) -> Result<BoundProjection, BindError> {
        let ResultColumn::Expr(expression, alias) = result else {
            return Err(BindError::Unsupported("star projection"));
        };
        let (expression, default_name) = match expression.as_ref() {
            Expr::FunctionCallStar { name, filter_over }
                if name.as_str().eq_ignore_ascii_case("count")
                    && filter_over.filter_clause.is_none()
                    && filter_over.over_clause.is_none() =>
            {
                let resource = self
                    .scopes
                    .last()
                    .ok_or(BindError::MissingFrom)?
                    .resource
                    .id;
                (BoundExpr::CountAll(resource), "count".to_owned())
            }
            Expr::FunctionCall {
                name,
                distinctness,
                args,
                order_by,
                within_group,
                filter_over,
            } if name.as_str().eq_ignore_ascii_case("row_number") => (
                self.bind_row_number(
                    distinctness.as_ref(),
                    args,
                    order_by,
                    within_group,
                    filter_over,
                )?,
                "row_number".to_owned(),
            ),
            Expr::FunctionCall { name, .. }
                if matches!(
                    canonical(name.as_str()).as_str(),
                    "lower" | "upper" | "json_extract"
                ) =>
            {
                let (expression, _) =
                    self.bind_scalar(expression, ColumnUsage::Projection, None, 0)?;
                (expression, canonical(name.as_str()))
            }
            Expr::Case { .. } | Expr::Cast { .. } | Expr::Binary(_, Operator::Concat, _) => {
                let output_name = explicit_alias(alias.as_ref())
                    .ok_or(BindError::InvalidResultName)?
                    .to_owned();
                let (expression, _) =
                    self.bind_scalar(expression, ColumnUsage::Projection, None, 0)?;
                (expression, output_name)
            }
            _ => {
                let column = self.resolve_direct_column(expression)?;
                (
                    BoundExpr::Column(bound_column(&column, ColumnUsage::Projection)),
                    column.name.as_str().to_owned(),
                )
            }
        };
        let output_name = explicit_alias(alias.as_ref()).map_or(default_name, str::to_owned);
        Ok(BoundProjection {
            expression,
            output_name: ResultName::new(output_name).map_err(|_| BindError::InvalidResultName)?,
        })
    }

    fn bind_row_number(
        &self,
        distinctness: Option<&turso_parser::ast::Distinctness>,
        args: &[Box<Expr>],
        argument_order: &[turso_parser::ast::SortedColumn],
        within_group: &[turso_parser::ast::SortedColumn],
        tail: &turso_parser::ast::FunctionTail,
    ) -> Result<BoundExpr, BindError> {
        if distinctness.is_some()
            || !args.is_empty()
            || !argument_order.is_empty()
            || !within_group.is_empty()
            || tail.filter_clause.is_some()
        {
            return Err(BindError::Unsupported("ROW_NUMBER option"));
        }
        let Some(Over::Window(window)) = &tail.over_clause else {
            return Err(BindError::Unsupported("ROW_NUMBER without inline window"));
        };
        if window.base.is_some() || window.frame_clause.is_some() || window.order_by.is_empty() {
            return Err(BindError::Unsupported("window shape"));
        }
        let partition_by = window
            .partition_by
            .iter()
            .map(|expression| {
                self.resolve_direct_column(expression)
                    .map(|column| bound_column(&column, ColumnUsage::Window))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let order_by = window
            .order_by
            .iter()
            .map(|order| {
                if order.nulls.is_some() {
                    return Err(BindError::Unsupported("window NULLS ordering"));
                }
                let column = self.resolve_direct_column(&order.expr)?;
                Ok(BoundOrder {
                    expression: BoundExpr::Column(bound_column(&column, ColumnUsage::Window)),
                    direction: match order.order {
                        Some(turso_parser::ast::SortOrder::Desc) => SortDirection::Descending,
                        None | Some(turso_parser::ast::SortOrder::Asc) => SortDirection::Ascending,
                    },
                })
            })
            .collect::<Result<Vec<_>, BindError>>()?;
        let resource = order_by
            .first()
            .ok_or(BindError::Unsupported("window without order"))?
            .expression
            .direct_column()
            .ok_or(BindError::Unsupported("window order expression"))?
            .id
            .resource();
        if partition_by
            .iter()
            .any(|column| column.id.resource() != resource)
            || order_by.iter().any(|order| {
                order
                    .expression
                    .direct_column()
                    .is_none_or(|column| column.id.resource() != resource)
            })
        {
            return Err(BindError::Unsupported("multi-resource window"));
        }
        Ok(BoundExpr::RowNumber {
            resource,
            partition_by,
            order_by,
        })
    }

    fn bind_boolean(
        &mut self,
        expression: &Expr,
        usage: ColumnUsage,
        depth: usize,
    ) -> Result<BoundExpr, BindError> {
        self.check_depth(depth)?;
        match expression {
            Expr::Binary(left, operator, right)
                if matches!(operator, Operator::Is | Operator::IsNot)
                    && matches!(right.as_ref(), Expr::Literal(Literal::Null)) =>
            {
                let (left, _) = self.bind_scalar(left, usage, None, depth + 1)?;
                let is_null = BoundExpr::IsNull(Box::new(left));
                Ok(if *operator == Operator::IsNot {
                    BoundExpr::Not(Box::new(is_null))
                } else {
                    is_null
                })
            }
            Expr::Binary(left, Operator::Equals, right) => {
                let (left, right) = self.bind_comparison(left, right, usage, depth + 1)?;
                Ok(BoundExpr::Equal(Box::new(left), Box::new(right)))
            }
            Expr::Binary(left, operator, right)
                if matches!(
                    operator,
                    Operator::NotEquals
                        | Operator::Less
                        | Operator::LessEquals
                        | Operator::Greater
                        | Operator::GreaterEquals
                ) =>
            {
                let (left, right) = self.bind_comparison(left, right, usage, depth + 1)?;
                Ok(match operator {
                    Operator::NotEquals => BoundExpr::NotEqual(Box::new(left), Box::new(right)),
                    Operator::Less => BoundExpr::Less(Box::new(left), Box::new(right)),
                    Operator::LessEquals => BoundExpr::LessEqual(Box::new(left), Box::new(right)),
                    Operator::Greater => BoundExpr::Greater(Box::new(left), Box::new(right)),
                    Operator::GreaterEquals => {
                        BoundExpr::GreaterEqual(Box::new(left), Box::new(right))
                    }
                    _ => unreachable!("guarded comparison operator"),
                })
            }
            Expr::Binary(left, Operator::And, right) => Ok(BoundExpr::And(
                Box::new(self.bind_boolean(left, usage, depth + 1)?),
                Box::new(self.bind_boolean(right, usage, depth + 1)?),
            )),
            Expr::Binary(left, Operator::Or, right) => Ok(BoundExpr::Or(
                Box::new(self.bind_boolean(left, usage, depth + 1)?),
                Box::new(self.bind_boolean(right, usage, depth + 1)?),
            )),
            Expr::Unary(UnaryOperator::Not, inner) => Ok(BoundExpr::Not(Box::new(
                self.bind_boolean(inner, usage, depth + 1)?,
            ))),
            Expr::IsNull(inner) => {
                let (inner, _) = self.bind_scalar(inner, usage, None, depth + 1)?;
                Ok(BoundExpr::IsNull(Box::new(inner)))
            }
            Expr::NotNull(inner) => {
                let (inner, _) = self.bind_scalar(inner, usage, None, depth + 1)?;
                Ok(BoundExpr::Not(Box::new(BoundExpr::IsNull(Box::new(inner)))))
            }
            Expr::InList { lhs, not, rhs } if !rhs.is_empty() => {
                self.bind_in_list(lhs, *not, rhs, usage, depth + 1)
            }
            Expr::Like {
                lhs,
                not,
                op,
                rhs,
                escape: None,
            } if matches!(op, LikeOperator::Like | LikeOperator::Glob) => {
                let (left, right) = self.bind_comparison(lhs, rhs, usage, depth + 1)?;
                let expression = match op {
                    LikeOperator::Like => BoundExpr::Like(Box::new(left), Box::new(right)),
                    LikeOperator::Glob => BoundExpr::Glob(Box::new(left), Box::new(right)),
                    _ => unreachable!("guarded LIKE operator"),
                };
                Ok(if *not {
                    BoundExpr::Not(Box::new(expression))
                } else {
                    expression
                })
            }
            Expr::Parenthesized(items) if items.len() == 1 => {
                self.bind_boolean(&items[0], usage, depth + 1)
            }
            Expr::Exists(select) => self.bind_exists(select, depth + 1),
            _ => Err(BindError::Unsupported("boolean expression")),
        }
    }

    fn bind_in_list(
        &mut self,
        lhs: &Expr,
        negated: bool,
        rhs: &[Box<Expr>],
        usage: ColumnUsage,
        depth: usize,
    ) -> Result<BoundExpr, BindError> {
        let (expression, logical_type) = if matches!(lhs, Expr::Variable(_)) {
            let first = rhs
                .iter()
                .find(|value| !matches!(value.as_ref(), Expr::Variable(_)))
                .ok_or(BindError::UnprovableParameterType)?;
            let (_, logical_type) = self.bind_scalar(first, usage, None, depth)?;
            self.bind_scalar(lhs, usage, Some(logical_type), depth)?
        } else {
            self.bind_scalar(lhs, usage, None, depth)?
        };
        let values = rhs
            .iter()
            .map(|value| {
                self.bind_scalar(value, usage, Some(logical_type), depth)
                    .map(|(value, _)| value)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(BoundExpr::In {
            expression: Box::new(expression),
            values,
            negated,
        })
    }

    fn bind_exists(&mut self, select: &Select, depth: usize) -> Result<BoundExpr, BindError> {
        self.check_depth(depth)?;
        if select.with.is_some()
            || !select.body.compounds.is_empty()
            || !select.order_by.is_empty()
            || select.limit.is_some()
        {
            return Err(BindError::Unsupported("subquery option"));
        }
        let OneSelect::Select {
            distinctness,
            columns,
            from,
            where_clause,
            group_by,
            window_clause,
        } = &select.body.select
        else {
            return Err(BindError::Unsupported("subquery VALUES"));
        };
        if distinctness.is_some() || group_by.is_some() || !window_clause.is_empty() {
            return Err(BindError::Unsupported("subquery shape"));
        }
        let from = from.as_ref().ok_or(BindError::MissingFrom)?;
        if !from.joins.is_empty() {
            return Err(BindError::Unsupported("subquery JOIN"));
        }
        let source = bind_source(&from.select, self.catalog)?;
        if self
            .scopes
            .iter()
            .any(|scope| scope.resource.id == source.resource.id)
        {
            return Err(BindError::Unsupported("same-resource correlation"));
        }
        let resource = source.resource.id;
        let alias = source.alias.clone();
        let mut nested = BindState {
            scopes: self.scopes.clone(),
            parameters: self.parameters.clone(),
            limits: self.limits,
            catalog: self.catalog,
        };
        nested.scopes.push(source);
        let mut projections = Vec::with_capacity(columns.len());
        for column in columns {
            let constant_exists_projection = if columns.len() == 1 {
                let ResultColumn::Expr(expression, alias) = column else {
                    return Err(BindError::Unsupported("subquery projection"));
                };
                match expression.as_ref() {
                    Expr::Literal(Literal::Numeric(raw))
                        if raw == "1" && explicit_alias(alias.as_ref()).is_none() =>
                    {
                        Some(BoundProjection {
                            expression: BoundExpr::Literal(LogicalValue::Int64(1)),
                            output_name: ResultName::new("exists_value")
                                .map_err(|_| BindError::InvalidResultName)?,
                        })
                    }
                    _ => None,
                }
            } else {
                None
            };
            projections.push(match constant_exists_projection {
                Some(projection) => projection,
                None => nested.bind_projection(column)?,
            });
        }
        ensure_unique_result_names(&projections)?;
        let predicate = where_clause
            .as_deref()
            .map(|expression| nested.bind_boolean(expression, ColumnUsage::Filter, depth + 1))
            .transpose()?;
        self.parameters = nested.parameters;
        Ok(BoundExpr::Exists(Box::new(BoundSelect {
            resource,
            alias,
            joins: Vec::new(),
            projections,
            predicate,
            group_by: Vec::new(),
            having: None,
            order_by: Vec::new(),
            limit: None,
            offset: None,
        })))
    }

    fn bind_comparison(
        &mut self,
        left: &Expr,
        right: &Expr,
        usage: ColumnUsage,
        depth: usize,
    ) -> Result<(BoundExpr, BoundExpr), BindError> {
        if matches!(left, Expr::Variable(_)) && matches!(right, Expr::Variable(_)) {
            return Err(BindError::UnprovableParameterType);
        }
        if matches!(left, Expr::Variable(_)) {
            let (right, right_type) = self.bind_scalar(right, usage, None, depth)?;
            let (left, _) = self.bind_scalar(left, usage, Some(right_type), depth)?;
            return Ok((left, right));
        }
        let (left, left_type) = self.bind_scalar(left, usage, None, depth)?;
        let (right, right_type) = self.bind_scalar(right, usage, Some(left_type), depth)?;
        if left_type != right_type {
            return Err(BindError::IncompatibleTypes);
        }
        Ok((left, right))
    }

    fn bind_scalar(
        &mut self,
        expression: &Expr,
        usage: ColumnUsage,
        expected: Option<LogicalType>,
        depth: usize,
    ) -> Result<(BoundExpr, LogicalType), BindError> {
        self.check_depth(depth)?;
        match expression {
            Expr::Id(_) | Expr::Name(_) | Expr::Qualified(_, _) => {
                let column = self.resolve_direct_column(expression)?;
                let logical_type = column.value.logical_type;
                if expected.is_some_and(|expected| expected != logical_type) {
                    return Err(BindError::IncompatibleTypes);
                }
                Ok((
                    BoundExpr::Column(bound_column(&column, usage)),
                    logical_type,
                ))
            }
            Expr::Variable(variable) => {
                let name = variable
                    .name
                    .as_deref()
                    .ok_or(BindError::PositionalParameter)?;
                let name = name
                    .strip_prefix(':')
                    .ok_or(BindError::UnsupportedParameterPrefix)?;
                let name = ClientParameterName::new(name).map_err(|error| match error {
                    policysql_core::CoreError::ReservedParameterNamespace => {
                        BindError::ReservedParameterNamespace
                    }
                    _ => BindError::InvalidParameterName,
                })?;
                let logical_type = expected.ok_or(BindError::UnprovableParameterType)?;
                self.parameters.insert(name.clone());
                if self.parameters.len() > self.limits.max_parameters {
                    return Err(BindError::ParameterLimit);
                }
                Ok((
                    BoundExpr::ClientParameter { name, logical_type },
                    logical_type,
                ))
            }
            Expr::Literal(literal) => bind_literal(literal, expected),
            Expr::FunctionCallStar { name, filter_over }
                if name.as_str().eq_ignore_ascii_case("count")
                    && filter_over.filter_clause.is_none()
                    && filter_over.over_clause.is_none() =>
            {
                let resource = self
                    .scopes
                    .last()
                    .ok_or(BindError::MissingFrom)?
                    .resource
                    .id;
                Ok((BoundExpr::CountAll(resource), LogicalType::Int64))
            }
            Expr::FunctionCall {
                name,
                distinctness,
                args,
                order_by,
                within_group,
                filter_over,
            } if distinctness.is_none()
                && order_by.is_empty()
                && within_group.is_empty()
                && filter_over.filter_clause.is_none()
                && filter_over.over_clause.is_none() =>
            {
                self.bind_registered_scalar(name.as_str(), args, usage, expected, depth)
            }
            Expr::Parenthesized(items) if items.len() == 1 => {
                self.bind_scalar(&items[0], usage, expected, depth + 1)
            }
            Expr::Binary(left, Operator::Concat, right) => {
                self.bind_concat(left, right, usage, expected, depth)
            }
            Expr::Cast { expr, type_name } => {
                self.bind_cast_text(expr, type_name.as_ref(), usage, expected, depth)
            }
            Expr::Case {
                base: None,
                when_then_pairs,
                else_expr,
            } if !when_then_pairs.is_empty() => self.bind_case(
                when_then_pairs,
                else_expr.as_deref(),
                usage,
                expected,
                depth,
            ),
            _ => Err(BindError::Unsupported("scalar expression")),
        }
    }

    fn bind_concat(
        &mut self,
        left: &Expr,
        right: &Expr,
        usage: ColumnUsage,
        expected: Option<LogicalType>,
        depth: usize,
    ) -> Result<(BoundExpr, LogicalType), BindError> {
        if expected.is_some_and(|expected| expected != LogicalType::String) {
            return Err(BindError::IncompatibleTypes);
        }
        let (left, _) = self.bind_scalar(left, usage, Some(LogicalType::String), depth + 1)?;
        let (right, _) = self.bind_scalar(right, usage, Some(LogicalType::String), depth + 1)?;
        Ok((
            BoundExpr::Concat(Box::new(left), Box::new(right)),
            LogicalType::String,
        ))
    }

    fn bind_cast_text(
        &mut self,
        expression: &Expr,
        type_name: Option<&Type>,
        usage: ColumnUsage,
        expected: Option<LogicalType>,
        depth: usize,
    ) -> Result<(BoundExpr, LogicalType), BindError> {
        let Some(type_name) = type_name else {
            return Err(BindError::Unsupported("CAST type"));
        };
        if type_name.array_dimensions != 0
            || type_name.size.is_some()
            || !type_name.name.eq_ignore_ascii_case("text")
            || expected.is_some_and(|expected| expected != LogicalType::String)
        {
            return Err(BindError::Unsupported("CAST type"));
        }
        let (inner, _) = self.bind_scalar(expression, usage, None, depth + 1)?;
        Ok((BoundExpr::CastText(Box::new(inner)), LogicalType::String))
    }

    fn bind_case(
        &mut self,
        when_then_pairs: &[(Box<Expr>, Box<Expr>)],
        else_expression: Option<&Expr>,
        usage: ColumnUsage,
        expected: Option<LogicalType>,
        depth: usize,
    ) -> Result<(BoundExpr, LogicalType), BindError> {
        let mut branches = Vec::with_capacity(when_then_pairs.len());
        let mut result_type = expected;
        for (condition, result) in when_then_pairs {
            let condition = self.bind_boolean(condition, usage, depth + 1)?;
            let (result, branch_type) = self.bind_scalar(result, usage, result_type, depth + 1)?;
            result_type = Some(branch_type);
            branches.push((condition, result));
        }
        let result_type = result_type.ok_or(BindError::UnprovableParameterType)?;
        let else_expression = else_expression
            .map(|expression| {
                self.bind_scalar(expression, usage, Some(result_type), depth + 1)
                    .map(|(expression, _)| Box::new(expression))
            })
            .transpose()?;
        Ok((
            BoundExpr::Case {
                branches,
                else_expression,
                logical_type: result_type,
            },
            result_type,
        ))
    }

    fn bind_registered_scalar(
        &mut self,
        name: &str,
        arguments: &[Box<Expr>],
        usage: ColumnUsage,
        expected: Option<LogicalType>,
        depth: usize,
    ) -> Result<(BoundExpr, LogicalType), BindError> {
        let (function, signature, return_type) = match canonical(name).as_str() {
            "lower" => (
                ScalarFunction::Lower,
                vec![LogicalType::String],
                LogicalType::String,
            ),
            "upper" => (
                ScalarFunction::Upper,
                vec![LogicalType::String],
                LogicalType::String,
            ),
            "json_extract" => (
                ScalarFunction::JsonExtract,
                vec![LogicalType::Json, LogicalType::String],
                LogicalType::Json,
            ),
            _ => return Err(BindError::Unsupported("scalar function")),
        };
        if arguments.len() != signature.len()
            || expected.is_some_and(|expected| expected != return_type)
        {
            return Err(BindError::IncompatibleTypes);
        }
        let arguments = arguments
            .iter()
            .zip(signature)
            .map(|(argument, expected)| {
                self.bind_scalar(argument, usage, Some(expected), depth + 1)
                    .map(|(argument, _)| argument)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok((
            BoundExpr::ScalarFunction {
                function,
                arguments,
                logical_type: return_type,
            },
            return_type,
        ))
    }

    fn bind_limit(&mut self, expression: &Expr) -> Result<BoundExpr, BindError> {
        match expression {
            Expr::Literal(Literal::Numeric(value)) => {
                let value = value.parse::<i64>().map_err(|_| BindError::InvalidLimit)?;
                if value < 0 {
                    return Err(BindError::InvalidLimit);
                }
                Ok(BoundExpr::Literal(LogicalValue::Int64(value)))
            }
            Expr::Variable(_) => self
                .bind_scalar(expression, ColumnUsage::Filter, Some(LogicalType::Int64), 0)
                .map(|(bound, _)| bound),
            _ => Err(BindError::InvalidLimit),
        }
    }

    fn resolve_direct_column(&self, expression: &Expr) -> Result<ColumnDescriptor, BindError> {
        let (qualifier, name) = match expression {
            Expr::Id(name) | Expr::Name(name) => (None, name.as_str()),
            Expr::Qualified(source, name) => (Some(source.as_str()), name.as_str()),
            _ => return Err(BindError::Unsupported("derived projection")),
        };
        if matches!(canonical(name).as_str(), "rowid" | "_rowid_" | "oid") {
            return Err(BindError::ImplicitRowId);
        }
        if let Some(qualifier) = qualifier {
            let scope = self
                .scopes
                .iter()
                .find(|scope| scope.qualifier.eq_ignore_ascii_case(qualifier))
                .ok_or(BindError::UnknownResource)?;
            return scope
                .columns
                .get(&canonical(name))
                .cloned()
                .ok_or(BindError::UnknownColumn);
        }
        let mut matches = self
            .scopes
            .iter()
            .filter_map(|scope| scope.columns.get(&canonical(name)));
        let column = matches.next().ok_or(BindError::UnknownColumn)?;
        if matches.next().is_some() {
            return Err(BindError::AmbiguousColumn);
        }
        Ok(column.clone())
    }

    fn check_depth(&self, depth: usize) -> Result<(), BindError> {
        if depth > self.limits.max_expression_depth {
            Err(BindError::ExpressionDepth)
        } else {
            Ok(())
        }
    }
}

fn bound_column(column: &ColumnDescriptor, usage: ColumnUsage) -> BoundColumn {
    BoundColumn {
        id: column.id,
        logical_type: column.value.logical_type,
        usage,
    }
}

fn explicit_alias(alias: Option<&As>) -> Option<&str> {
    alias
        .filter(|alias| alias.is_explicit())
        .map(|alias| alias.name().as_str())
}

fn ensure_unique_result_names(projections: &[BoundProjection]) -> Result<(), BindError> {
    let mut names = std::collections::BTreeSet::new();
    for projection in projections {
        if canonical(projection.output_name.as_str()).starts_with("__policysql_") {
            return Err(BindError::InvalidResultName);
        }
        if !names.insert(canonical(projection.output_name.as_str())) {
            return Err(BindError::DuplicateResultName);
        }
    }
    Ok(())
}

fn bind_literal(
    literal: &Literal,
    expected: Option<LogicalType>,
) -> Result<(BoundExpr, LogicalType), BindError> {
    let (value, logical_type) = match literal {
        Literal::String(value) => (LogicalValue::String(value.clone()), LogicalType::String),
        Literal::Numeric(value) if value.parse::<i64>().is_ok() => (
            LogicalValue::Int64(value.parse().map_err(|_| BindError::InvalidLiteral)?),
            LogicalType::Int64,
        ),
        Literal::Numeric(value) => (
            LogicalValue::Number(value.parse().map_err(|_| BindError::InvalidLiteral)?),
            LogicalType::Number,
        ),
        Literal::True => (LogicalValue::Boolean(true), LogicalType::Boolean),
        Literal::False => (LogicalValue::Boolean(false), LogicalType::Boolean),
        Literal::Null => return Err(BindError::NullComparison),
        _ => return Err(BindError::Unsupported("literal")),
    };
    if expected.is_some_and(|expected| expected != logical_type) {
        return Err(BindError::IncompatibleTypes);
    }
    Ok((BoundExpr::Literal(value), logical_type))
}

fn canonical(name: &str) -> String {
    name.to_ascii_lowercase()
}

fn has_json_table_call(select: &Select) -> bool {
    matches!(
        &select.body.select,
        OneSelect::Select { from: Some(from), .. }
            if from.joins.iter().any(|join| {
                matches!(
                    join.table.as_ref(),
                    SelectTable::TableCall(name, _, _)
                        if matches!(canonical(name.name.as_str()).as_str(), "json_each" | "json_tree")
                )
            })
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BindError {
    Empty,
    InvalidSql,
    MultipleStatements,
    Unsupported(&'static str),
    MissingFrom,
    UnknownResource,
    UnknownColumn,
    AmbiguousColumn,
    DuplicateAlias,
    ImplicitRowId,
    ProjectionLimit,
    JoinLimit,
    ParameterLimit,
    ExpressionDepth,
    PositionalParameter,
    UnsupportedParameterPrefix,
    InvalidParameterName,
    ReservedParameterNamespace,
    UnprovableParameterType,
    IncompatibleTypes,
    InvalidLiteral,
    NullComparison,
    InvalidLimit,
    InvalidResultName,
    DuplicateResultName,
    DuplicateWriteColumn,
    InsertArity,
}

impl fmt::Display for BindError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("SQL statement is empty"),
            Self::InvalidSql => formatter.write_str("SQL statement is invalid"),
            Self::MultipleStatements => {
                formatter.write_str("exactly one SQL statement is required")
            }
            Self::Unsupported(shape) => write!(formatter, "unsupported SQL shape: {shape}"),
            Self::MissingFrom => formatter.write_str("SELECT requires one base resource"),
            Self::UnknownResource => {
                formatter.write_str("statement references an unavailable resource")
            }
            Self::UnknownColumn => {
                formatter.write_str("statement references an unavailable column")
            }
            Self::AmbiguousColumn => formatter.write_str("column reference is ambiguous"),
            Self::DuplicateAlias => formatter.write_str("source alias is duplicated"),
            Self::ImplicitRowId => formatter.write_str("implicit row identity is unavailable"),
            Self::ProjectionLimit => formatter.write_str("projection count is invalid"),
            Self::JoinLimit => formatter.write_str("join limit exceeded"),
            Self::ParameterLimit => formatter.write_str("parameter limit exceeded"),
            Self::ExpressionDepth => formatter.write_str("expression depth limit exceeded"),
            Self::PositionalParameter => {
                formatter.write_str("positional parameters are unsupported")
            }
            Self::UnsupportedParameterPrefix => {
                formatter.write_str("parameter prefix is unsupported")
            }
            Self::InvalidParameterName => formatter.write_str("parameter name is invalid"),
            Self::ReservedParameterNamespace => {
                formatter.write_str("parameter uses the reserved namespace")
            }
            Self::UnprovableParameterType => formatter.write_str("parameter type cannot be proven"),
            Self::IncompatibleTypes => {
                formatter.write_str("expression operand types are incompatible")
            }
            Self::InvalidLiteral => formatter.write_str("literal is invalid"),
            Self::NullComparison => formatter.write_str("NULL requires IS NULL"),
            Self::InvalidLimit => formatter.write_str("LIMIT must be non-negative"),
            Self::InvalidResultName => formatter.write_str("result name is invalid"),
            Self::DuplicateResultName => formatter.write_str("result names must be unique"),
            Self::DuplicateWriteColumn => formatter.write_str("write column is duplicated"),
            Self::InsertArity => formatter.write_str("VALUES arity does not match columns"),
        }
    }
}

impl std::error::Error for BindError {}

#[cfg(test)]
mod tests {
    use super::{BindError, SqliteFrontend};
    use policysql_catalog::{Catalog, ResourceDescriptor};
    use policysql_core::{
        ColumnName, LogicalType, ResourceId, ResourceName, SnapshotId, ValueDescriptor,
        ValueRepresentation,
    };
    use policysql_ir::{BoundExpr, BoundStatement, ColumnUsage};

    fn descriptor() -> ValueDescriptor {
        ValueDescriptor {
            logical_type: LogicalType::String,
            representation: ValueRepresentation::String,
            nullable: false,
            format: None,
            storage: None,
            constraints: None,
            json_schema: None,
        }
    }

    fn catalog() -> Catalog {
        let resource = ResourceDescriptor::new(
            ResourceId::new(1).unwrap_or_else(|error| unreachable!("valid ID: {error}")),
            ResourceName::new("projects")
                .unwrap_or_else(|error| unreachable!("valid name: {error}")),
            [
                "id",
                "tenant_id",
                "name",
                "status",
                "created_by",
                "metadata",
            ]
            .map(|name| {
                (
                    ColumnName::new(name)
                        .unwrap_or_else(|error| unreachable!("valid column: {error}")),
                    if name == "metadata" {
                        ValueDescriptor {
                            logical_type: LogicalType::Json,
                            representation: ValueRepresentation::Json,
                            nullable: false,
                            format: None,
                            storage: None,
                            constraints: None,
                            json_schema: None,
                        }
                    } else {
                        descriptor()
                    },
                )
            }),
        )
        .unwrap_or_else(|error| unreachable!("valid resource: {error}"));
        let tasks = ResourceDescriptor::new(
            ResourceId::new(2).unwrap_or_else(|error| unreachable!("valid ID: {error}")),
            ResourceName::new("tasks").unwrap_or_else(|error| unreachable!("valid name: {error}")),
            ["id", "project_id", "tenant_id", "title"].map(|name| {
                (
                    ColumnName::new(name)
                        .unwrap_or_else(|error| unreachable!("valid column: {error}")),
                    descriptor(),
                )
            }),
        )
        .unwrap_or_else(|error| unreachable!("valid resource: {error}"));
        Catalog::new(
            SnapshotId::new("schema_1")
                .unwrap_or_else(|error| unreachable!("valid snapshot: {error}")),
            [resource, tasks],
        )
        .unwrap_or_else(|error| unreachable!("valid Catalog: {error}"))
    }

    #[test]
    fn binds_initial_select_to_stable_ids() {
        let document = SqliteFrontend::default().bind_document(
            "SELECT p.id, p.name AS project_name FROM projects AS p WHERE p.status = :status LIMIT :limit",
            &catalog(),
        );
        assert!(document.is_ok());
        let document = document.unwrap_or_else(|error| unreachable!("valid SELECT: {error}"));
        assert_eq!(document.source_span.start, 0);
        assert_eq!(document.parameters.len(), 2);
        let BoundStatement::Select(select) = document.statement else {
            unreachable!("bound statement is SELECT")
        };
        assert_eq!(select.resource.get(), 1);
        assert_eq!(select.projections.len(), 2);
        assert_eq!(select.projections[0].output_name.as_str(), "id");
        assert_eq!(select.projections[1].output_name.as_str(), "project_name");
        assert!(matches!(select.predicate, Some(BoundExpr::Equal(_, _))));
        let BoundExpr::Column(column) = &select.projections[0].expression else {
            unreachable!("projection is a bound column")
        };
        assert_eq!(column.usage, ColumnUsage::Projection);
    }

    #[test]
    fn binds_only_the_documented_json_collection_shape() {
        for sql in [
            "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.metadata, :path) AS j WHERE p.id = :id",
            "SELECT json_group_array(j.value) AS items FROM projects AS p, json_tree(p.metadata, '$') AS j WHERE p.id = :id",
        ] {
            let statement = SqliteFrontend::default()
                .bind(sql, &catalog())
                .unwrap_or_else(|error| unreachable!("documented JSON collection: {error}"));
            assert!(matches!(statement, BoundStatement::JsonCollectionSelect(_)));
        }
        for sql in [
            "SELECT j.value FROM projects AS p, json_each(p.metadata, '$') AS j",
            "SELECT json_group_array(j.key) AS items FROM projects AS p, json_each(p.metadata, '$') AS j",
            "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.metadata) AS j",
            "SELECT json_group_array(j.value) AS items FROM projects AS p, custom_each(p.metadata, '$') AS j",
            "SELECT json_group_array(j.value) AS items FROM projects AS p, json_each(p.name, '$') AS j",
        ] {
            assert!(
                SqliteFrontend::default().bind(sql, &catalog()).is_err(),
                "unsupported JSON collection was accepted: {sql}"
            );
        }
    }

    #[test]
    fn binds_closed_typed_projection_expressions() {
        for sql in [
            "SELECT CASE WHEN status = :status THEN name ELSE id END AS label FROM projects",
            "SELECT name || id AS label FROM projects",
            "SELECT CAST(id AS TEXT) AS label FROM projects",
        ] {
            assert!(
                SqliteFrontend::default().bind(sql, &catalog()).is_ok(),
                "documented projection expression was rejected: {sql}"
            );
        }
        for sql in [
            "SELECT CASE WHEN status = :status THEN name ELSE 1 END AS label FROM projects",
            "SELECT name || id FROM projects",
            "SELECT CAST(id AS INTEGER) AS label FROM projects",
            "SELECT id + 1 AS label FROM projects",
            "SELECT CASE id WHEN 'x' THEN name ELSE id END AS label FROM projects",
        ] {
            assert!(
                SqliteFrontend::default().bind(sql, &catalog()).is_err(),
                "untyped projection expression was accepted: {sql}"
            );
        }
    }

    #[test]
    fn rejects_multiple_statements_and_reserved_parameter() {
        assert_eq!(
            SqliteFrontend::default().bind(
                "SELECT id FROM projects; SELECT created_by FROM projects",
                &catalog()
            ),
            Err(BindError::MultipleStatements)
        );
        assert_eq!(
            SqliteFrontend::default().bind(
                "SELECT id FROM projects WHERE tenant_id = :__policysql_session_tenant_id",
                &catalog()
            ),
            Err(BindError::ReservedParameterNamespace)
        );
    }

    #[test]
    fn rejects_unadvertised_shapes_and_implicit_rowid() {
        for (sql, expected) in [
            (
                "SELECT * FROM projects",
                BindError::Unsupported("star projection"),
            ),
            ("SELECT rowid FROM projects", BindError::ImplicitRowId),
            (
                "SELECT id FROM projects JOIN projects p ON p.id = projects.id",
                BindError::Unsupported("self JOIN"),
            ),
        ] {
            assert_eq!(
                SqliteFrontend::default().bind(sql, &catalog()),
                Err(expected)
            );
        }
    }

    #[test]
    fn binds_direct_order_columns_and_rejects_unproved_ordering() {
        let statement = SqliteFrontend::default()
            .bind("SELECT id FROM projects ORDER BY name DESC, id", &catalog())
            .unwrap_or_else(|error| unreachable!("valid ORDER BY: {error}"));
        let BoundStatement::Select(select) = statement else {
            unreachable!("bound statement is SELECT")
        };
        assert_eq!(select.order_by.len(), 2);
        assert_eq!(
            select.order_by[0]
                .expression
                .direct_column()
                .unwrap_or_else(|| unreachable!("direct order column"))
                .usage,
            ColumnUsage::Order
        );
        for sql in [
            "SELECT id FROM projects ORDER BY missing",
            "SELECT id FROM projects ORDER BY name || id",
            "SELECT id FROM projects ORDER BY name NULLS FIRST",
        ] {
            assert!(
                SqliteFrontend::default().bind(sql, &catalog()).is_err(),
                "unexpectedly accepted: {sql}"
            );
        }
    }

    #[test]
    fn binds_inner_join_with_source_provenance() {
        let statement = SqliteFrontend::default()
            .bind(
                "SELECT p.id, t.title FROM projects p INNER JOIN tasks t ON t.project_id = p.id WHERE t.tenant_id = :tenant_id",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("valid INNER JOIN: {error}"));
        let BoundStatement::Select(select) = statement else {
            unreachable!("bound statement is SELECT")
        };
        assert_eq!(select.joins.len(), 1);
        assert_eq!(select.joins[0].resource.get(), 2);
        let BoundExpr::Column(joined_projection) = &select.projections[1].expression else {
            unreachable!("joined projection is bound")
        };
        assert_eq!(joined_projection.id.resource().get(), 2);
        assert_eq!(joined_projection.usage, ColumnUsage::Projection);
    }

    #[test]
    fn flattens_only_transparent_derived_tables_with_stable_provenance() {
        let statement = SqliteFrontend::default()
            .bind(
                "SELECT d.id FROM (SELECT id, name FROM projects) AS d WHERE d.name = :name",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("transparent derived table: {error}"));
        let BoundStatement::Select(select) = statement else {
            unreachable!("bound statement is SELECT")
        };
        let BoundExpr::Column(column) = &select.projections[0].expression else {
            unreachable!("derived output is rebound to a base column")
        };
        assert_eq!(column.id.resource().get(), 1);
        for sql in [
            "SELECT d.id FROM (SELECT id, COUNT(*) FROM projects GROUP BY id) d",
            "SELECT d.id FROM (SELECT id FROM projects LIMIT 1) d",
        ] {
            assert!(
                SqliteFrontend::default().bind(sql, &catalog()).is_err(),
                "unexpectedly accepted: {sql}"
            );
        }
    }

    #[test]
    fn flattens_only_one_non_recursive_transparent_cte() {
        let statement = SqliteFrontend::default()
            .bind(
                "WITH visible AS (SELECT id, name FROM projects) SELECT visible.id FROM visible WHERE visible.name = :name",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("transparent CTE: {error}"));
        let BoundStatement::Select(select) = statement else {
            unreachable!("bound statement is SELECT")
        };
        assert_eq!(select.resource.get(), 1);
        assert!(select.predicate.is_some());
        for sql in [
            "WITH RECURSIVE visible AS (SELECT id FROM projects) SELECT id FROM visible",
            "WITH visible AS (SELECT id FROM projects ORDER BY id) SELECT id FROM visible",
            "WITH one AS (SELECT id FROM projects), two AS (SELECT id FROM projects) SELECT id FROM one",
        ] {
            assert!(SqliteFrontend::default().bind(sql, &catalog()).is_err());
        }
    }

    #[test]
    fn flattens_documented_filtered_cte_before_outer_join() {
        let statement = SqliteFrontend::default()
            .bind(
                "WITH visible AS (SELECT id, name, status FROM projects WHERE status = :status) SELECT p.id, t.title FROM visible AS p JOIN tasks AS t ON t.project_id = p.id",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("documented filtered CTE: {error}"));
        let BoundStatement::Select(select) = statement else {
            unreachable!("bound statement is SELECT")
        };
        assert_eq!(select.joins.len(), 1);
        assert!(select.predicate.is_some());
    }

    #[test]
    fn binds_insert_values_with_explicit_unique_columns() {
        let document = SqliteFrontend::default()
            .bind_document(
                "INSERT INTO projects (id, tenant_id, name) VALUES (:id, :tenant, :name)",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("valid INSERT VALUES: {error}"));
        let BoundStatement::Insert(insert) = document.statement else {
            unreachable!("bound statement is INSERT")
        };
        assert_eq!(insert.rows.len(), 1);
        assert_eq!(insert.rows[0].len(), 3);
        assert_eq!(document.parameters.len(), 3);
        let returning = SqliteFrontend::default()
            .bind(
                "INSERT INTO projects (id) VALUES ('1') RETURNING id",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("direct RETURNING binds: {error}"));
        let BoundStatement::Insert(returning) = returning else {
            unreachable!("statement remains INSERT")
        };
        assert_eq!(returning.returning.len(), 1);
        for sql in [
            "INSERT INTO projects (id, id) VALUES ('1', '2')",
            "INSERT INTO projects (id, name) VALUES ('1')",
            "INSERT INTO projects DEFAULT VALUES",
            "INSERT INTO projects (id) SELECT id FROM projects",
            "INSERT INTO projects (id) VALUES ('1') RETURNING id || name",
        ] {
            assert!(SqliteFrontend::default().bind(sql, &catalog()).is_err());
        }
    }

    #[test]
    fn binds_closed_update_and_delete_surface() {
        let update = SqliteFrontend::default()
            .bind(
                "UPDATE projects SET name = :name WHERE id = :id RETURNING id",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("valid UPDATE: {error}"));
        let BoundStatement::Update(update) = update else {
            unreachable!("statement is UPDATE")
        };
        assert_eq!(update.assignments.len(), 1);
        assert_eq!(update.returning.len(), 1);
        let delete = SqliteFrontend::default()
            .bind(
                "DELETE FROM projects WHERE id = :id RETURNING id",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("valid DELETE: {error}"));
        let BoundStatement::Delete(delete) = delete else {
            unreachable!("statement is DELETE")
        };
        assert!(delete.predicate.is_some());
        assert_eq!(delete.returning.len(), 1);
        for sql in [
            "UPDATE projects SET (name, status) = ('a', 'b')",
            "UPDATE projects SET name = 'a' FROM tasks",
            "UPDATE projects SET name = tenant_id WHERE id = 'p1'",
            "DELETE FROM projects ORDER BY id LIMIT 1",
            "DELETE FROM projects RETURNING id || name",
            "INSERT INTO projects (name) VALUES (tenant_id)",
        ] {
            assert!(SqliteFrontend::default().bind(sql, &catalog()).is_err());
        }
    }

    #[test]
    fn binds_correlated_exists_with_inner_and_outer_provenance() {
        let statement = SqliteFrontend::default()
            .bind(
                "SELECT p.id FROM projects p WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id)",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("valid correlated EXISTS: {error}"));
        let BoundStatement::Select(select) = statement else {
            unreachable!("bound statement is SELECT")
        };
        assert!(matches!(select.predicate, Some(BoundExpr::Exists(_))));
        for sql in [
            "SELECT p.id FROM projects p WHERE EXISTS (SELECT q.id FROM projects q WHERE q.id = p.id)",
            "SELECT p.id FROM projects p WHERE EXISTS (SELECT p.id FROM tasks p WHERE p.project_id = p.id)",
            "SELECT p.id FROM projects p WHERE EXISTS (SELECT t.id FROM tasks t LIMIT 1)",
            "SELECT p.id FROM projects p WHERE EXISTS (SELECT 0 FROM tasks t WHERE t.project_id = p.id)",
            "SELECT p.id FROM projects p WHERE EXISTS (SELECT 1 AS value FROM tasks t WHERE t.project_id = p.id)",
        ] {
            assert!(SqliteFrontend::default().bind(sql, &catalog()).is_err());
        }
    }

    #[test]
    fn binds_count_group_and_having_as_closed_aggregate_surface() {
        let document = SqliteFrontend::default()
            .bind_document(
                "SELECT tenant_id, COUNT(*) AS item_count FROM projects GROUP BY tenant_id HAVING COUNT(*) > :minimum",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("valid aggregate: {error}"));
        let BoundStatement::Select(select) = document.statement else {
            unreachable!("bound statement is SELECT")
        };
        assert_eq!(select.group_by.len(), 1);
        assert!(select.having.is_some());
        assert!(matches!(
            select.projections[1].expression,
            BoundExpr::CountAll(_)
        ));
        assert_eq!(document.parameters.len(), 1);
        for sql in [
            "SELECT SUM(id) FROM projects",
            "SELECT COUNT(id) FROM projects",
            "SELECT COUNT(DISTINCT id) FROM projects",
        ] {
            assert!(SqliteFrontend::default().bind(sql, &catalog()).is_err());
        }
    }

    #[test]
    fn binds_gated_row_number_inline_window() {
        let statement = SqliteFrontend::default()
            .bind(
                "SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY name DESC) AS row_number FROM projects",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("valid ROW_NUMBER window: {error}"));
        let BoundStatement::Select(select) = statement else {
            unreachable!("bound statement is SELECT")
        };
        assert!(matches!(
            select.projections[1].expression,
            BoundExpr::RowNumber { .. }
        ));
        for sql in [
            "SELECT RANK() OVER (ORDER BY name) FROM projects",
            "SELECT ROW_NUMBER() OVER () FROM projects",
            "SELECT ROW_NUMBER() OVER named FROM projects WINDOW named AS (ORDER BY name)",
        ] {
            assert!(SqliteFrontend::default().bind(sql, &catalog()).is_err());
        }
    }

    #[test]
    fn rejects_unknown_columns_and_duplicate_results() {
        assert_eq!(
            SqliteFrontend::default().bind("SELECT missing FROM projects", &catalog()),
            Err(BindError::UnknownColumn)
        );
        assert_eq!(
            SqliteFrontend::default().bind(
                "SELECT id AS value, name AS VALUE FROM projects",
                &catalog()
            ),
            Err(BindError::DuplicateResultName)
        );
    }

    #[test]
    fn enforces_parameter_type_and_limit_boundaries() {
        for (sql, expected) in [
            (
                "SELECT id FROM projects WHERE :left = :right",
                BindError::UnprovableParameterType,
            ),
            (
                "SELECT id FROM projects WHERE status = NULL",
                BindError::NullComparison,
            ),
            ("SELECT id FROM projects LIMIT -1", BindError::InvalidLimit),
            (
                "SELECT id FROM projects LIMIT 1 OFFSET -1",
                BindError::InvalidLimit,
            ),
            (
                "SELECT id FROM projects WHERE status = ?1",
                BindError::PositionalParameter,
            ),
        ] {
            assert_eq!(
                SqliteFrontend::default().bind(sql, &catalog()),
                Err(expected)
            );
        }
    }

    #[test]
    fn binds_offset_glob_like_and_direct_projection_order_alias() {
        let statement = SqliteFrontend::default()
            .bind(
                "SELECT id AS project_id, name FROM projects WHERE name GLOB :pattern AND name LIKE :prefix ORDER BY project_id LIMIT :limit OFFSET :offset",
                &catalog(),
            )
            .unwrap_or_else(|error| unreachable!("documented SELECT surface: {error}"));
        let BoundStatement::Select(select) = statement else {
            unreachable!("bound statement is SELECT")
        };
        assert!(matches!(select.predicate, Some(BoundExpr::And(_, _))));
        assert!(select.limit.is_some());
        assert!(select.offset.is_some());
        let BoundExpr::Column(projected) = &select.projections[0].expression else {
            unreachable!("direct projection")
        };
        assert_eq!(
            select.order_by[0]
                .expression
                .direct_column()
                .unwrap_or_else(|| unreachable!("direct order alias"))
                .id,
            projected.id
        );
        for sql in [
            "SELECT LOWER() FROM projects",
            "SELECT LOWER(name, name) FROM projects",
            "SELECT JSON_EXTRACT(name, '$') FROM projects",
            "SELECT custom_function(name) FROM projects",
            "SELECT id FROM projects WHERE name LIKE :prefix ESCAPE '\\'",
        ] {
            assert!(
                SqliteFrontend::default().bind(sql, &catalog()).is_err(),
                "unexpectedly accepted: {sql}"
            );
        }
    }

    #[test]
    fn binds_closed_in_and_is_not_null_predicates() {
        for sql in [
            "SELECT id FROM projects WHERE status IN (:first, :second)",
            "SELECT id FROM projects WHERE status NOT IN ('archived', :status)",
            "SELECT id FROM projects WHERE name IS NOT NULL",
        ] {
            assert!(
                SqliteFrontend::default().bind(sql, &catalog()).is_ok(),
                "documented predicate was rejected: {sql}"
            );
        }

        for sql in [
            "SELECT id FROM projects WHERE status IN ()",
            "SELECT id FROM projects WHERE status IN (NULL)",
            "SELECT id FROM projects WHERE status IN (SELECT status FROM tasks)",
            "SELECT id FROM projects WHERE :left IN (:right)",
        ] {
            assert!(
                SqliteFrontend::default().bind(sql, &catalog()).is_err(),
                "unsupported predicate was accepted: {sql}"
            );
        }
    }

    #[test]
    fn production_binder_consumes_security_fixture_sql() {
        let basic = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/select/basic-row-policy/input.sql"
        );
        assert!(SqliteFrontend::default().bind(basic, &catalog()).is_ok());

        let smuggling = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/security/statement-smuggling/input.sql"
        );
        assert_eq!(
            SqliteFrontend::default().bind(smuggling, &catalog()),
            Err(BindError::MultipleStatements)
        );

        let collision = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/security/server-parameter-collision/input.sql"
        );
        assert_eq!(
            SqliteFrontend::default().bind(collision, &catalog()),
            Err(BindError::ReservedParameterNamespace)
        );

        let forbidden = include_str!(
            "../../../tests/fixtures/sqlite-turso-v1/security/forbidden-filter-column/input.sql"
        );
        assert!(
            SqliteFrontend::default()
                .bind(forbidden, &catalog())
                .is_ok()
        );
    }

    #[test]
    fn rejects_client_result_alias_in_compiler_owned_namespace() {
        let error = SqliteFrontend::default().bind(
            "SELECT id AS __policysql_visibility_0 FROM projects",
            &catalog(),
        );
        assert_eq!(error, Err(BindError::InvalidResultName));
    }
}
