//! Exact complexity counts of the statement about to be printed (ADR 0027, "Emitted statement
//! complexity: measured, not predicted").
//!
//! `turso_parser` 0.7.2 refuses an expression tree whose height exceeds
//! [`MAX_PARSER_DEPTH`] and a parse whose expression recursion depth exceeds it, and reports
//! both as one untyped `ParseError(String)`. Core does not match that text. It counts both
//! quantities on the AST it is about to print, with the parser's own rules, so a statement
//! that the re-parse would refuse is recognised as too complex before it is printed:
//!
//! - **Height.** `parse_expr_inner` keeps `result_height`, the height of the expression built
//!   so far: an operand has its own height (a leaf is 1; a parenthesis, `NOT`, unary operator,
//!   or `CAST` is 1 plus its operand; a `CASE` or function call is 1 plus its tallest
//!   sub-expression; a subquery is a leaf, so the height restarts inside it), and every
//!   operator that wraps the running result (binary, `IS NULL`, `LIKE`, `IN`, `BETWEEN`,
//!   `COLLATE`) makes it `1 + max(result, right operand)`.
//! - **Recursion depth.** Every `parse_expr` call is one level, and the level is not reset by
//!   a subquery: the left spine of an operator chain is consumed by one call's loop, a right
//!   operand, a parenthesized element, a function argument, a `CASE` branch, a `CAST` operand,
//!   and the expressions inside a subquery each add one.
//!
//! The counts copy a dependency's internal rules, so `tests/complexity_differential.rs` checks
//! them in both directions against the real parser on generated shapes, and every change of the
//! `turso_parser` version must run it. An AST node this module does not know is an error, never
//! a guess: the emitter must not produce a node the counter has not been taught.

use turso_parser::ast::{
    Expr, FromClause, FunctionTail, GroupBy, InsertBody, Limit, OneSelect, Over, ResultColumn,
    Select, SelectTable, SortedColumn, Stmt, Upsert, UpsertDo,
};

/// The parser's cap on expression height and on expression recursion depth.
pub const MAX_PARSER_DEPTH: usize = turso_parser::parser::MAX_EXPR_DEPTH;
/// `SQLITE_MAX_COLUMN`: result columns of one `SELECT` or `RETURNING`.
pub const MAX_RESULT_COLUMNS: usize = 2_000;
/// `SQLITE_MAX_VARIABLE_NUMBER` of the pinned `SQLite` generation.
pub const MAX_HOST_PARAMETERS: usize = 32_766;
/// `SQLITE_MAX_LIKE_PATTERN_LENGTH`.
pub const MAX_LIKE_PATTERN_BYTES: usize = 50_000;

/// A node the counter does not know. Never contains SQL text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Uncountable;

/// What one statement measures.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Measure {
    /// The tallest expression tree.
    pub height: usize,
    /// The deepest expression recursion.
    pub recursion: usize,
    /// The most result columns of any `SELECT` or `RETURNING` in the statement.
    pub columns: usize,
    /// The names (with the leading `:`) of the variables used as a `LIKE`, `GLOB`, or `ESCAPE`
    /// pattern, in order.
    pub pattern_variables: Vec<String>,
}

impl Measure {
    /// Whether the parser would refuse the statement for its height.
    #[must_use]
    pub const fn height_exceeded(&self) -> bool {
        self.height > MAX_PARSER_DEPTH
    }

    /// Whether the parser would refuse the statement for its recursion depth.
    #[must_use]
    pub const fn recursion_exceeded(&self) -> bool {
        self.recursion > MAX_PARSER_DEPTH
    }
}

/// Measures a statement.
///
/// # Errors
///
/// Returns [`Uncountable`] for a node the emitter is not meant to produce.
pub fn measure(statement: &Stmt) -> Result<Measure, Uncountable> {
    let mut counter = Counter::default();
    counter.statement(statement)?;
    Ok(counter.measure)
}

#[derive(Default)]
struct Counter {
    measure: Measure,
}

impl Counter {
    fn statement(&mut self, statement: &Stmt) -> Result<(), Uncountable> {
        match statement {
            Stmt::Select(select) => self.select(select, 0),
            Stmt::Insert {
                with,
                body,
                returning,
                ..
            } => {
                if with.is_some() {
                    return Err(Uncountable);
                }
                match body {
                    InsertBody::Select(select, upsert) => {
                        self.select(select, 0)?;
                        if let Some(upsert) = upsert {
                            self.upsert(upsert)?;
                        }
                    }
                    InsertBody::DefaultValues => {}
                }
                self.returning(returning)
            }
            Stmt::Update(update) => {
                if update.with.is_some() || update.from.is_some() {
                    return Err(Uncountable);
                }
                for set in &update.sets {
                    self.expression(&set.expr, 0)?;
                }
                if let Some(predicate) = &update.where_clause {
                    self.expression(predicate, 0)?;
                }
                self.sorted_columns(&update.order_by, 0)?;
                self.limit(update.limit.as_ref(), 0)?;
                self.returning(&update.returning)
            }
            Stmt::Delete {
                with,
                where_clause,
                returning,
                order_by,
                limit,
                ..
            } => {
                if with.is_some() {
                    return Err(Uncountable);
                }
                if let Some(predicate) = where_clause {
                    self.expression(predicate, 0)?;
                }
                self.sorted_columns(order_by, 0)?;
                self.limit(limit.as_ref(), 0)?;
                self.returning(returning)
            }
            _ => Err(Uncountable),
        }
    }

    fn upsert(&mut self, upsert: &Upsert) -> Result<(), Uncountable> {
        if let Some(index) = &upsert.index {
            self.sorted_columns(&index.targets, 0)?;
            if let Some(predicate) = &index.where_clause {
                self.expression(predicate, 0)?;
            }
        }
        if let UpsertDo::Set { sets, where_clause } = &upsert.do_clause {
            for set in sets {
                self.expression(&set.expr, 0)?;
            }
            if let Some(predicate) = where_clause {
                self.expression(predicate, 0)?;
            }
        }
        if let Some(next) = &upsert.next {
            self.upsert(next)?;
        }
        Ok(())
    }

    fn returning(&mut self, columns: &[ResultColumn]) -> Result<(), Uncountable> {
        self.result_columns(columns, 0)
    }

    fn result_columns(&mut self, columns: &[ResultColumn], base: usize) -> Result<(), Uncountable> {
        self.measure.columns = self.measure.columns.max(columns.len());
        for column in columns {
            match column {
                ResultColumn::Expr(expression, _) => {
                    self.expression(expression, base)?;
                }
                ResultColumn::Star | ResultColumn::TableStar(_) => return Err(Uncountable),
            }
        }
        Ok(())
    }

    fn select(&mut self, select: &Select, base: usize) -> Result<(), Uncountable> {
        if let Some(with) = &select.with {
            for table in &with.ctes {
                self.select(&table.select, base)?;
            }
        }
        self.one_select(&select.body.select, base)?;
        for compound in &select.body.compounds {
            self.one_select(&compound.select, base)?;
        }
        self.sorted_columns(&select.order_by, base)?;
        self.limit(select.limit.as_ref(), base)
    }

    fn one_select(&mut self, select: &OneSelect, base: usize) -> Result<(), Uncountable> {
        match select {
            OneSelect::Select {
                columns,
                from,
                where_clause,
                group_by,
                window_clause,
                ..
            } => {
                if !window_clause.is_empty() {
                    return Err(Uncountable);
                }
                self.result_columns(columns, base)?;
                if let Some(from) = from {
                    self.from(from, base)?;
                }
                if let Some(predicate) = where_clause {
                    self.expression(predicate, base)?;
                }
                if let Some(GroupBy { exprs, having }) = group_by {
                    for expression in exprs {
                        self.expression(expression, base)?;
                    }
                    if let Some(having) = having {
                        self.expression(having, base)?;
                    }
                }
                Ok(())
            }
            OneSelect::Values(rows) => {
                for row in rows {
                    for expression in row {
                        self.expression(expression, base)?;
                    }
                }
                Ok(())
            }
        }
    }

    fn from(&mut self, from: &FromClause, base: usize) -> Result<(), Uncountable> {
        self.select_table(&from.select, base)?;
        for join in &from.joins {
            self.select_table(&join.table, base)?;
            match &join.constraint {
                None => {}
                Some(turso_parser::ast::JoinConstraint::On(expression)) => {
                    self.expression(expression, base)?;
                }
                Some(turso_parser::ast::JoinConstraint::Using(_)) => return Err(Uncountable),
            }
        }
        Ok(())
    }

    fn select_table(&mut self, table: &SelectTable, base: usize) -> Result<(), Uncountable> {
        match table {
            SelectTable::Table(..) => Ok(()),
            SelectTable::TableCall(_, arguments, _) => {
                for argument in arguments {
                    self.expression(argument, base)?;
                }
                Ok(())
            }
            SelectTable::Select(select, _) => self.select(select, base),
            SelectTable::Sub(from, _) => self.from(from, base),
        }
    }

    fn sorted_columns(&mut self, columns: &[SortedColumn], base: usize) -> Result<(), Uncountable> {
        for column in columns {
            self.expression(&column.expr, base)?;
        }
        Ok(())
    }

    fn limit(&mut self, limit: Option<&Limit>, base: usize) -> Result<(), Uncountable> {
        if let Some(limit) = limit {
            self.expression(&limit.expr, base)?;
            if let Some(offset) = &limit.offset {
                self.expression(offset, base)?;
            }
        }
        Ok(())
    }

    /// One `parse_expr` call entered at recursion depth `base`; returns its height.
    fn expression(&mut self, expression: &Expr, base: usize) -> Result<usize, Uncountable> {
        let frame = base + 1;
        self.measure.recursion = self.measure.recursion.max(frame);
        // The left spine is consumed by this call's loop, not by nested calls.
        let mut spine = Vec::new();
        let mut operand = expression;
        while let Expr::Binary(left, ..)
        | Expr::Collate(left, _)
        | Expr::IsNull(left)
        | Expr::NotNull(left)
        | Expr::Between { lhs: left, .. }
        | Expr::InList { lhs: left, .. }
        | Expr::InSelect { lhs: left, .. }
        | Expr::Like { lhs: left, .. } = operand
        {
            spine.push(operand);
            operand = left;
        }
        let mut height = self.operand(operand, frame)?;
        self.measure.height = self.measure.height.max(height);
        for node in spine.into_iter().rev() {
            let (right, leaf) = match node {
                Expr::Binary(_, _, right) => (self.expression(right, frame)?, false),
                Expr::Collate(..) | Expr::IsNull(_) | Expr::NotNull(_) => (0, false),
                Expr::Between { start, end, .. } => {
                    let start = self.expression(start, frame)?;
                    (start.max(self.expression(end, frame)?), false)
                }
                Expr::InList { rhs, .. } => {
                    let mut tallest = 0;
                    for element in rhs {
                        tallest = tallest.max(self.expression(element, frame)?);
                    }
                    // `x IN ()` is simplified to a constant leaf by the parser.
                    (tallest, rhs.is_empty())
                }
                Expr::InSelect { rhs, .. } => {
                    self.select(rhs, frame)?;
                    (1, false)
                }
                Expr::Like { rhs, escape, .. } => {
                    self.pattern(rhs);
                    let mut tallest = self.expression(rhs, frame)?;
                    if let Some(escape) = escape {
                        self.pattern(escape);
                        tallest = tallest.max(self.expression(escape, frame)?);
                    }
                    (tallest, false)
                }
                _ => return Err(Uncountable),
            };
            height = if leaf { 1 } else { 1 + height.max(right) };
            self.measure.height = self.measure.height.max(height);
        }
        Ok(height)
    }

    fn pattern(&mut self, pattern: &Expr) {
        if let Expr::Variable(variable) = pattern {
            if let Some(name) = &variable.name {
                self.measure.pattern_variables.push(name.to_string());
            }
        }
    }

    /// The height of an operand parsed inside the call at recursion depth `frame`.
    fn operand(&mut self, operand: &Expr, frame: usize) -> Result<usize, Uncountable> {
        Ok(match operand {
            Expr::Literal(_)
            | Expr::Id(_)
            | Expr::Qualified(..)
            | Expr::DoublyQualified(..)
            | Expr::Variable(_) => 1,
            Expr::Parenthesized(elements) => {
                let mut tallest = 0;
                for element in elements {
                    tallest = tallest.max(self.expression(element, frame)?);
                }
                1 + tallest
            }
            Expr::Subquery(select) | Expr::Exists(select) => {
                self.select(select, frame)?;
                1
            }
            Expr::Unary(_, inner)
            | Expr::Cast {
                expr: inner,
                type_name: _,
            } => 1 + self.expression(inner, frame)?,
            Expr::Case {
                base,
                when_then_pairs,
                else_expr,
            } => {
                let mut tallest = 0;
                if let Some(base) = base {
                    tallest = tallest.max(self.expression(base, frame)?);
                }
                for (when, then) in when_then_pairs {
                    tallest = tallest.max(self.expression(when, frame)?);
                    tallest = tallest.max(self.expression(then, frame)?);
                }
                if let Some(otherwise) = else_expr {
                    tallest = tallest.max(self.expression(otherwise, frame)?);
                }
                1 + tallest
            }
            Expr::FunctionCall {
                args,
                order_by,
                within_group,
                filter_over,
                ..
            } => {
                let mut tallest = 0;
                for argument in args {
                    tallest = tallest.max(self.expression(argument, frame)?);
                }
                tallest = tallest.max(self.sorted_heights(order_by, frame)?);
                tallest = tallest.max(self.sorted_heights(within_group, frame)?);
                tallest = tallest.max(self.tail(filter_over, frame)?);
                1 + tallest
            }
            Expr::FunctionCallStar { filter_over, .. } => 1 + self.tail(filter_over, frame)?,
            _ => return Err(Uncountable),
        })
    }

    fn sorted_heights(
        &mut self,
        columns: &[SortedColumn],
        frame: usize,
    ) -> Result<usize, Uncountable> {
        let mut tallest = 0;
        for column in columns {
            tallest = tallest.max(self.expression(&column.expr, frame)?);
        }
        Ok(tallest)
    }

    fn tail(&mut self, tail: &FunctionTail, frame: usize) -> Result<usize, Uncountable> {
        let mut tallest = 0;
        if let Some(filter) = &tail.filter_clause {
            tallest = self.expression(filter, frame)?;
        }
        match &tail.over_clause {
            None => {}
            Some(Over::Name(_)) => return Err(Uncountable),
            Some(Over::Window(window)) => {
                if window.frame_clause.is_some() {
                    return Err(Uncountable);
                }
                for expression in &window.partition_by {
                    tallest = tallest.max(self.expression(expression, frame)?);
                }
                tallest = tallest.max(self.sorted_heights(&window.order_by, frame)?);
            }
        }
        Ok(tallest)
    }
}
