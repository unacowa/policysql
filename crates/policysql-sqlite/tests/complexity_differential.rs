//! The two-way differential test of the emit-time complexity counts (ADR 0027): on generated
//! shapes, "the emitter's count is over the parser's cap" holds exactly when the real
//! `turso_parser` refuses the printed statement. The counts copy a dependency's internal rules,
//! so this test must run, and pass, on every change of the pinned `turso_parser` version.
//!
//! The shapes include the measured worst cases of the ADR (`NOT` chains, `CASE` nestings of
//! `IS NOT NULL` and `NOT LIKE`, those nestings as the deepest leaf of an `OR` chain), the
//! recursion-heavy `EXISTS` nesting (the height restarts in a subquery, the recursion depth does
//! not), and the left-deep `AND` chain of row filters per inner join. Each is repeated at every
//! size from 1 past the caps, with 0 to 3 extra wrapping levels so every parity is hit.

use policysql_sqlite::complexity::{MAX_PARSER_DEPTH, measure};
use turso_parser::ast::{
    Expr, FromClause, LikeOperator, Literal, Name, OneSelect, Operator, QualifiedName,
    ResultColumn, Select, SelectBody, SelectTable, Stmt, UnaryOperator,
};
use turso_parser::parser::Parser;

fn name(value: &str) -> Name {
    Name::from_string(format!("\"{value}\""))
}

fn column(table: &str, value: &str) -> Expr {
    Expr::Qualified(name(table), name(value))
}

fn number(value: &str) -> Expr {
    Expr::Literal(Literal::Numeric(value.to_owned()))
}

fn paren(expression: Expr) -> Expr {
    Expr::Parenthesized(vec![expression.into_boxed()])
}

fn binary(left: Expr, operator: Operator, right: Expr) -> Expr {
    paren(Expr::binary(left, operator, right))
}

fn not(expression: Expr) -> Expr {
    paren(Expr::unary(UnaryOperator::Not, expression))
}

/// `x IS NOT NULL` as the binder emits it: `NOT` over a parenthesized `IS NULL`.
fn is_not_null(expression: Expr) -> Expr {
    not(paren(Expr::is_null(expression)))
}

/// `x NOT LIKE y` as the binder emits it: `NOT` over a parenthesized `LIKE`.
fn not_like(left: Expr, right: Expr) -> Expr {
    not(paren(Expr::like(
        left,
        false,
        LikeOperator::Like,
        right,
        None,
    )))
}

fn case(condition: Expr, value: Expr) -> Expr {
    Expr::Case {
        base: None,
        when_then_pairs: vec![(condition.into_boxed(), value.into_boxed())],
        else_expr: None,
    }
}

fn function(function_name: &str, arguments: Vec<Expr>) -> Expr {
    Expr::FunctionCall {
        name: Name::exact(function_name.to_owned()),
        distinctness: None,
        args: arguments.into_iter().map(Expr::into_boxed).collect(),
        order_by: Vec::new(),
        within_group: Vec::new(),
        filter_over: turso_parser::ast::FunctionTail {
            filter_clause: None,
            over_clause: None,
        },
    }
}

fn select_where(predicate: Expr) -> Select {
    Select {
        with: None,
        body: SelectBody {
            select: OneSelect::Select {
                distinctness: None,
                columns: vec![ResultColumn::Expr(number("1").into_boxed(), None)],
                from: Some(FromClause {
                    select: SelectTable::Table(
                        QualifiedName::single(name("t")),
                        Some(turso_parser::ast::As::As(name("a"))),
                        None,
                    )
                    .into(),
                    joins: Vec::new(),
                }),
                where_clause: Some(predicate.into_boxed()),
                group_by: None,
                window_clause: Vec::new(),
            },
            compounds: Vec::new(),
        },
        order_by: Vec::new(),
        limit: None,
    }
}

fn statement(predicate: Expr) -> Stmt {
    Stmt::Select(select_where(predicate))
}

/// A shape of size `n`: a predicate whose height or recursion grows with `n`.
type Shape = (&'static str, fn(usize) -> Expr);

fn or_chain(n: usize) -> Expr {
    (0..n).fold(number("1"), |left, _| {
        binary(left, Operator::Or, number("0"))
    })
}

fn right_or_chain(n: usize) -> Expr {
    (0..n).fold(number("1"), |right, _| {
        binary(number("0"), Operator::Or, right)
    })
}

fn not_chain(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| not(inner))
}

fn lower_chain(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| function("LOWER", vec![inner]))
}

fn cast_chain(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| Expr::cast(inner, None))
}

fn case_is_not_null(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| {
        case(is_not_null(column("a", "y")), inner)
    })
}

fn case_not_like(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| {
        case(not_like(column("a", "y"), number("1")), inner)
    })
}

fn case_not_not_like(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| {
        case(not(not_like(column("a", "y"), number("1"))), inner)
    })
}

/// The `IS NOT NULL` nesting as the deepest leaf of an `OR` chain (the measured worst shape).
fn or_with_deep_leaf(n: usize) -> Expr {
    binary(or_chain(n / 2), Operator::Or, case_is_not_null(n / 2))
}

fn exists_chain(n: usize) -> Expr {
    (0..n).fold(number("1"), |inner, _| Expr::Exists(select_where(inner)))
}

fn exists_in_or(n: usize) -> Expr {
    (0..n).fold(number("1"), |inner, _| {
        binary(Expr::Exists(select_where(inner)), Operator::Or, number("0"))
    })
}

fn in_list_chain(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| {
        paren(Expr::InList {
            lhs: inner.into_boxed(),
            not: false,
            rhs: vec![number("1").into_boxed(), number("2").into_boxed()],
        })
    })
}

fn between_chain(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| {
        paren(Expr::between(inner, false, number("1"), number("2")))
    })
}

fn like_chain(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| {
        paren(Expr::like(
            inner,
            false,
            LikeOperator::Like,
            number("1"),
            None,
        ))
    })
}

fn concat_chain(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| {
        binary(inner, Operator::Concat, column("a", "y"))
    })
}

/// A left-deep `AND` of filters, as the policy composes one filter per inner join.
fn and_filters(n: usize) -> Expr {
    (0..n).fold(
        binary(column("a", "x"), Operator::Equals, number("1")),
        |left, _| {
            binary(
                left,
                Operator::And,
                binary(column("a", "y"), Operator::Equals, number("2")),
            )
        },
    )
}

fn nested_function_arguments(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| {
        function("LEAST", vec![inner, number("1"), column("a", "y")])
    })
}

fn paren_list(n: usize) -> Expr {
    (0..n).fold(column("a", "x"), |inner, _| {
        Expr::Parenthesized(vec![inner.into_boxed(), number("1").into_boxed()])
    })
}

const SHAPES: &[Shape] = &[
    ("or chain", or_chain),
    ("right or chain", right_or_chain),
    ("not chain", not_chain),
    ("lower chain", lower_chain),
    ("cast chain", cast_chain),
    ("case is not null", case_is_not_null),
    ("case not like", case_not_like),
    ("case not not like", case_not_not_like),
    ("or with deep leaf", or_with_deep_leaf),
    ("exists chain", exists_chain),
    ("exists in or", exists_in_or),
    ("in list chain", in_list_chain),
    ("between chain", between_chain),
    ("like chain", like_chain),
    ("concat chain", concat_chain),
    ("and filters", and_filters),
    ("function arguments", nested_function_arguments),
    ("parenthesized list", paren_list),
];

/// Wraps in `extra` more parenthesized `AND` levels, so each parity of height is reached.
fn padded(shape: Expr, extra: usize) -> Expr {
    (0..extra).fold(shape, |inner, _| binary(inner, Operator::And, number("1")))
}

fn parses(statement: &Stmt) -> bool {
    let text = statement.to_string();
    match Parser::new(text.as_bytes()).collect::<Result<Vec<_>, _>>() {
        Ok(parsed) => parsed.len() == 1,
        Err(_) => false,
    }
}

/// Deeply nested statements recurse deeply when printed, parsed, and dropped: run on a large
/// stack so the test measures the counts, not the test thread's stack.
fn on_large_stack(test: fn()) {
    std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(test)
        .unwrap_or_else(|error| unreachable!("{error}"))
        .join()
        .unwrap_or_else(|_| unreachable!("the differential test failed"));
}

#[test]
fn the_count_exceeds_the_cap_exactly_when_the_parser_refuses() {
    on_large_stack(count_matches_parser);
}

#[test]
fn each_counter_is_exact_not_just_their_disjunction() {
    on_large_stack(counters_are_exact);
}

#[test]
fn the_recursion_counter_alone_refuses_an_exists_chain() {
    on_large_stack(exists_recursion);
}

#[test]
fn many_filtered_inner_joins_keep_the_height_within_the_cap_until_the_count_says_otherwise() {
    on_large_stack(filtered_joins);
}

fn count_matches_parser() {
    let mut crossings = 0_usize;
    for (label, shape) in SHAPES {
        let mut accepted_seen = false;
        let mut refused_seen = false;
        for n in 1..=130 {
            for extra in 0..4 {
                let stmt = statement(padded(shape(n), extra));
                let measured = measure(&stmt).unwrap_or_else(|_| unreachable!("{label}"));
                let over = measured.height_exceeded() || measured.recursion_exceeded();
                let refused = !parses(&stmt);
                assert_eq!(
                    over, refused,
                    "{label} n={n} extra={extra}: height {} recursion {} (cap {MAX_PARSER_DEPTH}), parser refused: {refused}",
                    measured.height, measured.recursion
                );
                accepted_seen |= !refused;
                refused_seen |= refused;
            }
        }
        assert!(
            accepted_seen && refused_seen,
            "{label} must cross the cap in both directions"
        );
        crossings += 1;
    }
    assert_eq!(crossings, SHAPES.len());
}

fn counters_are_exact() {
    // `NOT` chains and parenthesized chains grow both counters; an `EXISTS` chain grows only
    // the recursion depth, and a deep `CASE` leaf grows the height faster than the recursion.
    // Pad one counter at a time to its exact cap and check one more level crosses it.
    for (label, shape) in SHAPES {
        for extra in 0..4 {
            // The largest `n` the parser accepts.
            let mut largest = 0;
            for n in 1..=130 {
                if parses(&statement(padded(shape(n), extra))) {
                    largest = n;
                } else {
                    break;
                }
            }
            if largest == 0 || largest == 130 {
                continue;
            }
            let at = measure(&statement(padded(shape(largest), extra)))
                .unwrap_or_else(|_| unreachable!("{label}"));
            let over = measure(&statement(padded(shape(largest + 1), extra)))
                .unwrap_or_else(|_| unreachable!("{label}"));
            assert!(
                at.height <= MAX_PARSER_DEPTH && at.recursion <= MAX_PARSER_DEPTH,
                "{label} extra={extra}: the last accepted size is within both caps"
            );
            assert!(
                over.height > MAX_PARSER_DEPTH || over.recursion > MAX_PARSER_DEPTH,
                "{label} extra={extra}: the first refused size is over a cap"
            );
        }
    }
}

fn exists_recursion() {
    // The height restarts inside a subquery, so only the recursion depth reaches the cap.
    let stmt = statement(exists_chain(120));
    let measured = measure(&stmt).unwrap_or_else(|_| unreachable!("countable"));
    assert!(measured.height <= MAX_PARSER_DEPTH, "{}", measured.height);
    assert!(measured.recursion_exceeded(), "{}", measured.recursion);
    assert!(!parses(&stmt));
}

fn filtered_joins() {
    // One left-deep `AND` filter per inner join: each adds 2 to the height.
    let mut previous = 0;
    for joins in 0..=60 {
        let stmt = statement(and_filters(joins));
        let measured = measure(&stmt).unwrap_or_else(|_| unreachable!("countable"));
        assert!(measured.height >= previous);
        previous = measured.height;
        assert_eq!(measured.height_exceeded(), !parses(&stmt), "joins {joins}");
    }
}
