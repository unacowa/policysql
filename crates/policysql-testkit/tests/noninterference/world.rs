//! The schema, the base data, the catalog, the session, the limits and the two alphabets.

use policysql_catalog::{Catalog, ResourceDescriptor};
use policysql_core::{
    ColumnName, LogicalType, ResourceId, ResourceName, RoleName, SnapshotId, TrustedSession,
    ValueDescriptor, ValueRepresentation,
};
use policysql_execution::ExecutionLimits;
use policysql_testkit::fuzz::layer3::Layer3Config;
use policysql_testkit::fuzz::{Alphabet, ColumnClass, ColumnSpec, ResourceSpec, ValueType};
use std::collections::BTreeMap;

pub const SCHEMA: &str = "
CREATE TABLE posts (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, secret TEXT NOT NULL) STRICT;
CREATE TABLE comments (id TEXT NOT NULL, post_id TEXT, author_id TEXT NOT NULL, body TEXT NOT NULL, memo TEXT NOT NULL, hidden TEXT NOT NULL, secret TEXT NOT NULL) STRICT;
CREATE TABLE tags (id TEXT NOT NULL, post_id TEXT, label TEXT NOT NULL, rank INTEGER NOT NULL, flag TEXT NOT NULL, memo TEXT NOT NULL, secret TEXT NOT NULL) STRICT;
";

pub const BASE: &str = "
INSERT INTO posts VALUES
  ('p1','tenant_1','user_1','a','open','n1','x'),
  ('p2','tenant_1','user_2','b','open','n2','y'),
  ('p3','tenant_1','user_2','a','closed','n3','x'),
  ('h1','tenant_2','user_1','a','open','n4','x');
INSERT INTO comments VALUES
  ('c1','p1','user_1','a','m1','no','x'),
  ('c2','p1','user_2','b','m2','no','y'),
  ('c3','p2','user_1','a','m3','no','x'),
  ('c5',NULL,'user_2','a','m5','no','y'),
  ('c6','h1','user_1','x','m6','no','x'),
  ('c4','p2','user_2','b','m4','yes','x');
INSERT INTO tags VALUES
  ('t1','p1','a',1,'pub','g1','x'),
  ('t2','p2','b',2,'priv','g2','y'),
  ('t3','h1','a',0,'pub','g3','x'),
  ('t4',NULL,'x',1,'pub','g4','y'),
  ('t5','p3','a',0,'priv','g5','x'),
  ('t6','zz','b',1,'priv','g6','x');
";

/// Everything the pipeline needs that does not depend on the policy case.
#[derive(Debug)]
pub struct World {
    pub catalog: Catalog,
    pub snapshot: SnapshotId,
    pub session: TrustedSession,
    pub limits: ExecutionLimits,
}

impl World {
    pub fn new() -> Self {
        let snapshot = SnapshotId::new("noninterference")
            .unwrap_or_else(|error| unreachable!("snapshot id: {error}"));
        let session = TrustedSession::new(
            RoleName::new("member").unwrap_or_else(|error| unreachable!("role: {error}")),
            "user_1",
            BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
        )
        .unwrap_or_else(|error| unreachable!("session: {error}"));
        Self {
            catalog: catalog(&snapshot),
            snapshot,
            session,
            limits: ExecutionLimits {
                max_rows: 1000,
                max_result_bytes: 1_000_000,
                timeout_ms: 1000,
                max_bytes_per_value: policysql_core::bytes::DEFAULT_MAX_BYTES_PER_VALUE,
            },
        }
    }
}

fn catalog(snapshot: &SnapshotId) -> Catalog {
    use LogicalType::{Int64, String as S};
    let value = |logical_type: LogicalType, nullable: bool| ValueDescriptor {
        logical_type,
        representation: if logical_type == LogicalType::Int64 {
            ValueRepresentation::Number
        } else {
            ValueRepresentation::String
        },
        nullable,
        format: None,
        storage: None,
        constraints: None,
        json_schema: None,
    };
    let resource = |id: u64, name: &str, columns: &[(&str, LogicalType, bool)]| {
        ResourceDescriptor::new(
            ResourceId::new(id).unwrap_or_else(|error| unreachable!("resource id: {error}")),
            ResourceName::new(name).unwrap_or_else(|error| unreachable!("resource name: {error}")),
            columns.iter().map(|(column, logical_type, nullable)| {
                (
                    ColumnName::new(*column)
                        .unwrap_or_else(|error| unreachable!("column name: {error}")),
                    value(*logical_type, *nullable),
                )
            }),
        )
        .unwrap_or_else(|error| unreachable!("resource descriptor: {error}"))
    };
    Catalog::new(
        snapshot.clone(),
        [
            resource(
                1,
                "posts",
                &[
                    ("id", S, false),
                    ("tenant_id", S, false),
                    ("owner_id", S, false),
                    ("title", S, false),
                    ("status", S, false),
                    ("note", S, false),
                    ("secret", S, false),
                ],
            ),
            resource(
                2,
                "comments",
                &[
                    ("id", S, false),
                    ("post_id", S, true),
                    ("author_id", S, false),
                    ("body", S, false),
                    ("memo", S, false),
                    ("hidden", S, false),
                    ("secret", S, false),
                ],
            ),
            resource(
                3,
                "tags",
                &[
                    ("id", S, false),
                    ("post_id", S, true),
                    ("label", S, false),
                    ("rank", Int64, false),
                    ("flag", S, false),
                    ("memo", S, false),
                    ("secret", S, false),
                ],
            ),
        ],
    )
    .unwrap_or_else(|error| unreachable!("catalog: {error:?}"))
}

fn column(name: &'static str, class: ColumnClass, ty: ValueType) -> ColumnSpec {
    ColumnSpec { name, class, ty }
}

fn text(name: &'static str, class: ColumnClass) -> ColumnSpec {
    column(name, class, ValueType::Text)
}

/// The full alphabet (layers 2 and 3): every column of every resource, 13 text literals that all
/// occur in the data, and three integers.
pub fn full_alphabet() -> Alphabet {
    use ColumnClass::{Conditional, Forbidden, Regular};
    Alphabet {
        resources: vec![
            ResourceSpec {
                name: "posts",
                alias: "p",
                key: 0,
                columns: vec![
                    text("id", Regular),
                    text("title", Regular),
                    text("status", Regular),
                    text("note", Conditional),
                    text("tenant_id", Forbidden),
                    text("owner_id", Forbidden),
                    text("secret", Forbidden),
                ],
            },
            ResourceSpec {
                name: "comments",
                alias: "c",
                key: 1,
                columns: vec![
                    text("id", Regular),
                    text("post_id", Regular),
                    text("body", Regular),
                    text("memo", Conditional),
                    text("author_id", Forbidden),
                    text("hidden", Forbidden),
                    text("secret", Forbidden),
                ],
            },
            ResourceSpec {
                name: "tags",
                alias: "g",
                key: 1,
                columns: vec![
                    text("id", Regular),
                    text("post_id", Regular),
                    text("label", Regular),
                    column("rank", Regular, ValueType::Int),
                    text("memo", Conditional),
                    text("flag", Forbidden),
                    text("secret", Forbidden),
                ],
            },
        ],
        text_literals: vec![
            "a", "b", "x", "y", "open", "closed", "p1", "n2", "m2", "no", "pub", "user_2",
            "tenant_2",
        ],
        int_literals: vec![0, 1, 2],
    }
}

/// The reduced alphabet (layer 1): posts and comments with four columns each, two literals.
pub fn reduced_alphabet() -> Alphabet {
    use ColumnClass::{Conditional, Forbidden, Regular};
    Alphabet {
        resources: vec![
            ResourceSpec {
                name: "posts",
                alias: "p",
                key: 0,
                columns: vec![
                    text("id", Regular),
                    text("title", Regular),
                    text("note", Conditional),
                    text("secret", Forbidden),
                ],
            },
            ResourceSpec {
                name: "comments",
                alias: "c",
                key: 0,
                columns: vec![
                    text("post_id", Regular),
                    text("body", Regular),
                    text("memo", Conditional),
                    text("secret", Forbidden),
                ],
            },
        ],
        text_literals: vec!["a", "x"],
        int_literals: vec![],
    }
}

/// Layer-3 settings: depth 3, one literal in five becomes a parameter, and the columns the case
/// policies let a client write (`posts.title`, `posts.status`, `comments.body`).
pub fn layer3_config() -> Layer3Config {
    Layer3Config {
        preferred_writes: vec![(0, 1), (0, 2), (1, 2)],
        ..Layer3Config::default()
    }
}
