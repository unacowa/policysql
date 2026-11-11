//! The schema, the base data, the catalog, the session, the limits and the two alphabets.

use policysql_testkit::fuzz::{Alphabet, ColumnClass, ColumnSpec, ResourceSpec, ValueType};

fn column(name: &'static str, class: ColumnClass, ty: ValueType) -> ColumnSpec {
    ColumnSpec { name, class, ty }
}

fn text(name: &'static str, class: ColumnClass) -> ColumnSpec {
    column(name, class, ValueType::Text)
}

/// The full alphabet (layers 2 and 3): every column of every resource, 13 text literals that all
/// occur in the data, and three integers.
#[allow(dead_code)] // used from step 6 (layers 2 and 3)
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
