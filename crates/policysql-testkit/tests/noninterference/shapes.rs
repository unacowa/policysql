//! Regression test for the renderer: every SQL shape the generators rely on (measured to reach
//! execution on `main`, spec 7.3) is built from the AST, rendered, compared with the expected text
//! and bound. If the binder starts rejecting a shape, the generators would silently stop reaching
//! the policy stage; this test fails first.

use policysql_testkit::fuzz::ast::{
    CmpOp, ColRef, Delete, ExistsProjection, ExistsQuery, Join, JoinKind, Limit, Lit, OrderBy,
    OrderTarget, Pred, Projection, Qualifier, Returning, Scalar, Select, Source, Statement, Update,
    Value,
};

pub const POSTS: usize = 0;
pub const COMMENTS: usize = 1;
pub const TAGS: usize = 2;

pub fn outer(resource: usize, column: usize) -> ColRef {
    ColRef {
        qualifier: Qualifier::Outer(resource),
        resource,
        column,
    }
}

pub fn col(resource: usize, column: usize) -> Scalar {
    Scalar::Column(outer(resource, column))
}

pub fn text(value: &'static str) -> Scalar {
    Scalar::Value(Value::Lit(Lit::Text(value)))
}

pub fn int(value: i64) -> Scalar {
    Scalar::Value(Value::Lit(Lit::Int(value)))
}

pub fn param(index: u16, value: Lit) -> Scalar {
    Scalar::Value(Value::Param { index, value })
}

pub fn cmp(op: CmpOp, left: Scalar, right: Scalar) -> Pred {
    Pred::Cmp { op, left, right }
}

pub fn select(source: Source, projections: Vec<Projection>) -> Select {
    Select {
        source,
        join: None,
        projections,
        predicate: None,
        group_by: None,
        having: None,
        order_by: None,
        limit: None,
    }
}

pub fn posts_where(predicate: Pred) -> Statement {
    Statement::Select(Box::new(Select {
        predicate: Some(predicate),
        ..select(Source::Table(POSTS), vec![Projection::Expr(col(POSTS, 0))])
    }))
}

pub fn projecting(projection: Projection) -> Statement {
    Statement::Select(Box::new(select(Source::Table(POSTS), vec![projection])))
}

pub fn exists(resource: usize, projection: ExistsProjection, predicate: Pred) -> Pred {
    Pred::Exists(Box::new(ExistsQuery {
        resource,
        depth: 1,
        projection,
        predicate,
    }))
}

pub fn inner(resource: usize, column: usize) -> Scalar {
    Scalar::Column(ColRef {
        qualifier: Qualifier::Exists { depth: 1 },
        resource,
        column,
    })
}

pub fn table(resource: usize, column: usize) -> Scalar {
    Scalar::Column(ColRef {
        qualifier: Qualifier::Table(resource),
        resource,
        column,
    })
}

/// `(statement, expected SQL)` for every shape.
#[allow(clippy::too_many_lines)]
pub fn shapes() -> Vec<(Statement, &'static str)> {
    let derived_col = |column| ColRef {
        qualifier: Qualifier::Derived,
        resource: POSTS,
        column,
    };
    vec![
        (
            projecting(Projection::Expr(Scalar::Concat(
                Box::new(col(POSTS, 0)),
                Box::new(col(POSTS, 1)),
            ))),
            "SELECT p.id || p.title AS o0 FROM posts p",
        ),
        (
            projecting(Projection::Expr(Scalar::CastText(Box::new(col(POSTS, 1))))),
            "SELECT CAST(p.title AS TEXT) AS o0 FROM posts p",
        ),
        (
            projecting(Projection::Expr(Scalar::Lower(Box::new(col(POSTS, 1))))),
            "SELECT lower(p.title) AS o0 FROM posts p",
        ),
        (
            projecting(Projection::Expr(Scalar::Case {
                when: Box::new(Pred::CountGt(0)),
                then: Box::new(text("a")),
                otherwise: Box::new(text("x")),
            })),
            "SELECT CASE WHEN COUNT(*) > 0 THEN 'a' ELSE 'x' END AS o0 FROM posts p",
        ),
        (
            projecting(Projection::RowNumber {
                partition_by: Some(outer(POSTS, 1)),
                order_by: outer(POSTS, 0),
                desc: true,
            }),
            "SELECT ROW_NUMBER() OVER (PARTITION BY p.title ORDER BY p.id DESC) AS o0 FROM posts p",
        ),
        (
            projecting(Projection::Expr(col(POSTS, 3))),
            "SELECT p.note AS o0 FROM posts p",
        ),
        (
            projecting(Projection::CountAll),
            "SELECT COUNT(*) AS o0 FROM posts p",
        ),
        (
            posts_where(Pred::And(
                Box::new(cmp(CmpOp::Eq, col(POSTS, 1), text("a"))),
                Box::new(cmp(CmpOp::Ne, col(POSTS, 2), text("x"))),
            )),
            "SELECT p.id AS o0 FROM posts p WHERE (p.title = 'a') AND (p.status <> 'x')",
        ),
        (
            posts_where(Pred::Not(Box::new(cmp(
                CmpOp::Eq,
                col(POSTS, 1),
                text("a"),
            )))),
            "SELECT p.id AS o0 FROM posts p WHERE NOT (p.title = 'a')",
        ),
        (
            posts_where(Pred::Like(col(POSTS, 1))),
            "SELECT p.id AS o0 FROM posts p WHERE p.title LIKE 'a%'",
        ),
        (
            posts_where(Pred::Glob(col(POSTS, 1))),
            "SELECT p.id AS o0 FROM posts p WHERE p.title GLOB 'a*'",
        ),
        (
            posts_where(Pred::In {
                expr: col(POSTS, 1),
                negated: false,
                ty: policysql_testkit::fuzz::ValueType::Text,
            }),
            "SELECT p.id AS o0 FROM posts p WHERE p.title IN ('a', 'x', 'open')",
        ),
        (
            posts_where(Pred::IsNull(col(POSTS, 1))),
            "SELECT p.id AS o0 FROM posts p WHERE p.title IS NULL",
        ),
        (
            posts_where(cmp(CmpOp::Eq, text("a"), text("x"))),
            "SELECT p.id AS o0 FROM posts p WHERE 'a' = 'x'",
        ),
        (
            Statement::Select(Box::new(Select {
                predicate: Some(Pred::In {
                    expr: col(TAGS, 3),
                    negated: false,
                    ty: policysql_testkit::fuzz::ValueType::Int,
                }),
                ..select(Source::Table(TAGS), vec![Projection::Expr(col(TAGS, 0))])
            })),
            "SELECT g.id AS o0 FROM tags g WHERE g.rank IN (0, 1, 2)",
        ),
        (
            Statement::Select(Box::new(Select {
                predicate: Some(cmp(CmpOp::Lt, col(TAGS, 3), int(2))),
                ..select(Source::Table(TAGS), vec![Projection::Expr(col(TAGS, 0))])
            })),
            "SELECT g.id AS o0 FROM tags g WHERE g.rank < 2",
        ),
        (
            posts_where(exists(
                COMMENTS,
                ExistsProjection::One,
                cmp(CmpOp::Eq, inner(COMMENTS, 1), col(POSTS, 0)),
            )),
            "SELECT p.id AS o0 FROM posts p WHERE EXISTS (SELECT 1 FROM comments e1 WHERE e1.post_id = p.id)",
        ),
        (
            posts_where(exists(
                COMMENTS,
                ExistsProjection::Key,
                cmp(CmpOp::Eq, col(POSTS, 1), text("a")),
            )),
            "SELECT p.id AS o0 FROM posts p WHERE EXISTS (SELECT e1.post_id FROM comments e1 WHERE p.title = 'a')",
        ),
        (
            Statement::Select(Box::new(Select {
                join: Some(Join {
                    kind: JoinKind::Left,
                    resource: COMMENTS,
                    on: cmp(CmpOp::Eq, col(COMMENTS, 1), col(POSTS, 0)),
                }),
                ..select(
                    Source::Table(POSTS),
                    vec![
                        Projection::Expr(col(POSTS, 0)),
                        Projection::Expr(col(COMMENTS, 2)),
                    ],
                )
            })),
            "SELECT p.id AS o0, c.body AS o1 FROM posts p LEFT JOIN comments c ON c.post_id = p.id",
        ),
        (
            Statement::Select(Box::new(Select {
                join: Some(Join {
                    kind: JoinKind::Inner,
                    resource: TAGS,
                    on: cmp(CmpOp::Eq, col(TAGS, 1), col(COMMENTS, 1)),
                }),
                ..select(
                    Source::Table(COMMENTS),
                    vec![Projection::Expr(col(COMMENTS, 0))],
                )
            })),
            "SELECT c.id AS o0 FROM comments c JOIN tags g ON g.post_id = c.post_id",
        ),
        (
            Statement::Select(Box::new(select(
                Source::Derived {
                    resource: POSTS,
                    columns: vec![0, 1],
                    predicate: Some(cmp(CmpOp::Eq, Scalar::Column(derived_col(1)), text("a"))),
                    as_cte: true,
                },
                vec![Projection::Expr(col(POSTS, 0))],
            ))),
            "WITH d AS (SELECT s.id, s.title FROM posts s WHERE s.title = 'a') SELECT p.id AS o0 FROM d p",
        ),
        (
            Statement::Select(Box::new(select(
                Source::Derived {
                    resource: POSTS,
                    columns: vec![0, 1],
                    predicate: None,
                    as_cte: false,
                },
                vec![Projection::Expr(col(POSTS, 0))],
            ))),
            "SELECT p.id AS o0 FROM (SELECT s.id, s.title FROM posts s) p",
        ),
        (
            posts_where(cmp(CmpOp::Eq, col(POSTS, 1), param(0, Lit::Text("a")))),
            "SELECT p.id AS o0 FROM posts p WHERE p.title = :p0",
        ),
        (
            Statement::Select(Box::new(Select {
                predicate: Some(cmp(CmpOp::Lt, col(TAGS, 3), param(0, Lit::Int(2)))),
                ..select(Source::Table(TAGS), vec![Projection::Expr(col(TAGS, 0))])
            })),
            "SELECT g.id AS o0 FROM tags g WHERE g.rank < :p0",
        ),
        (
            posts_where(cmp(
                CmpOp::Eq,
                Scalar::Lower(Box::new(param(0, Lit::Text("a")))),
                col(POSTS, 1),
            )),
            "SELECT p.id AS o0 FROM posts p WHERE lower(:p0) = p.title",
        ),
        (
            Statement::Select(Box::new(Select {
                group_by: Some(outer(POSTS, 0)),
                having: Some(Pred::CountGt(0)),
                ..select(Source::Table(POSTS), vec![Projection::Expr(col(POSTS, 0))])
            })),
            "SELECT p.id AS o0 FROM posts p GROUP BY p.id HAVING COUNT(*) > 0",
        ),
        (
            Statement::Select(Box::new(Select {
                order_by: Some(OrderBy {
                    target: OrderTarget::Output(0),
                    desc: true,
                }),
                limit: Some(Limit {
                    count: Value::Lit(Lit::Int(2)),
                    offset: true,
                }),
                ..select(Source::Table(POSTS), vec![Projection::Expr(col(POSTS, 0))])
            })),
            "SELECT p.id AS o0 FROM posts p ORDER BY o0 DESC LIMIT 2 OFFSET 1",
        ),
        (
            Statement::Update(Update {
                resource: POSTS,
                assignments: vec![(1, Value::Lit(Lit::Text("a")))],
                predicate: Some(cmp(CmpOp::Eq, table(POSTS, 1), text("b"))),
                returning: Returning::Columns(vec![1]),
            }),
            "UPDATE posts SET title = 'a' WHERE posts.title = 'b' RETURNING posts.title",
        ),
        (
            Statement::Delete(Delete {
                resource: POSTS,
                predicate: Some(cmp(CmpOp::Lt, table(POSTS, 2), text("open"))),
                returning: Returning::Id,
            }),
            "DELETE FROM posts WHERE posts.status < 'open' RETURNING posts.id",
        ),
    ]
}
