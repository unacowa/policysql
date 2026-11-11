//! The policy cases: select / update / delete policies as data, rendered to YAML, each with a
//! hand-written SQL twin of every predicate (used to compute the visible view without the
//! compiler) and the description of the low-equivalent database variants.

use std::fmt::Write as _;

pub const RESOURCES: [&str; 3] = ["posts", "comments", "tags"];

/// The shape shared by every case: which columns are regular / conditional and what mutation
/// policies look like.
struct Shape {
    regular: &'static [&'static str],
    conditional: &'static str,
    update_columns: &'static str,
    update_returning: &'static str,
}

const SHAPES: [Shape; 3] = [
    Shape {
        regular: &["id", "title", "status"],
        conditional: "note",
        update_columns: "[title, status]",
        update_returning: "[id, title]",
    },
    Shape {
        regular: &["id", "post_id", "body"],
        conditional: "memo",
        update_columns: "[body]",
        update_returning: "[id, body]",
    },
    Shape {
        regular: &["id", "post_id", "label", "rank"],
        conditional: "memo",
        update_columns: "[]",
        update_returning: "[]",
    },
];

/// Regular columns of a resource (spec 4.5 order).
pub fn regular_columns(resource: usize) -> &'static [&'static str] {
    SHAPES.get(resource).map_or(&[], |shape| shape.regular)
}

/// The conditional column of a resource.
pub fn conditional_column(resource: usize) -> &'static str {
    SHAPES.get(resource).map_or("", |shape| shape.conditional)
}

#[derive(Clone, Debug)]
pub struct ResourcePolicy {
    pub resource: &'static str,
    pub filter_yaml: &'static str,
    pub filter_sql: &'static str,
    pub visible_if_yaml: &'static str,
    pub visible_if_sql: &'static str,
    pub limit: Option<u64>,
    /// Has update / delete policies.
    pub mutation: bool,
    /// `(yaml, sql)` of a mutation filter that differs from the select filter (the #118 case).
    pub mutation_filter: Option<(&'static str, &'static str)>,
}

impl ResourcePolicy {
    pub fn mutation_filter_yaml(&self) -> &'static str {
        self.mutation_filter
            .map_or(self.filter_yaml, |(yaml, _)| yaml)
    }

    pub fn mutation_filter_sql(&self) -> &'static str {
        self.mutation_filter.map_or(self.filter_sql, |(_, sql)| sql)
    }
}

/// How the low-equivalent variants are built (spec 6.2).
#[derive(Clone, Debug)]
pub struct VariantSpec {
    /// Columns no predicate of the case reads, per resource: the `row` variant perturbs them in
    /// invisible rows.
    pub free: [&'static [&'static str]; 3],
    /// Extra statements for the `col` variant: change the forbidden columns predicates read, while
    /// keeping every predicate's value.
    pub col_extra: &'static str,
    /// Statements for the `row` variant that add invisible rows.
    pub row_insert: &'static str,
}

#[derive(Clone, Debug)]
pub struct PolicyCase {
    pub name: &'static str,
    pub resources: [ResourcePolicy; 3],
    pub variant: VariantSpec,
    /// Every mutation filter equals the select filter (so #118 is out of scope for the case).
    pub mutation_filter_is_select_filter: bool,
}

const TENANT_YAML: &str = "{ tenant_id: { eq: { session: tenant_id } } }";
const TENANT_SQL: &str = "tenant_id = 'tenant_1'";
const OWNER_YAML: &str = "{ owner_id: { eq: { session: subject_id } } }";
const OWNER_SQL: &str = "owner_id = 'user_1'";
const AUTHOR_YAML: &str = "{ author_id: { eq: { session: subject_id } } }";
const AUTHOR_SQL: &str = "author_id = 'user_1'";

const BASE_VARIANT: VariantSpec = VariantSpec {
    free: [
        &["title", "status", "note", "secret"],
        &["body", "memo", "secret"],
        &["post_id", "label", "rank", "memo", "secret"],
    ],
    col_extra: "
UPDATE posts SET owner_id = 'x' WHERE owner_id = 'user_2';
UPDATE comments SET author_id = 'x' WHERE author_id = 'user_2';
UPDATE tags SET flag = 'x' WHERE flag = 'priv';
",
    row_insert: "
INSERT INTO posts VALUES ('h2','tenant_2','user_1','x','open','a','y'), ('a0','tenant_2','user_2','a','closed','x','x');
INSERT INTO comments VALUES ('c7','p1','user_1','x','a','yes','x'), ('c8','p3','user_2','a','x','yes','y'), ('c9',NULL,'user_1','a','a','yes','x'), ('c10','p3','user_1','b','x','maybe','y');
INSERT INTO tags VALUES ('t7','p1','x',1,'hide','a','x'), ('t8','p3','a',2,'hide','x','y'), ('t9',NULL,'a',0,'hide','a','x'), ('t10','p2','b',1,'hide','b','y');
UPDATE comments SET hidden = 'maybe' WHERE id = 'c4';
",
};

const LOGIC_VARIANT: VariantSpec = VariantSpec {
    free: [
        &["title", "note", "secret"],
        &["memo", "secret"],
        &["memo", "secret"],
    ],
    col_extra: "
UPDATE comments SET author_id = 'x' WHERE author_id = 'user_2';
",
    row_insert: "
INSERT INTO posts VALUES ('h2','tenant_2','user_1','x','open','a','y'), ('a0','tenant_1','user_2','a','closed','x','x');
INSERT INTO comments VALUES ('c7','p1','user_1','x','a','yes','x'), ('c8','p3','user_2','a','x','yes','y'), ('c9',NULL,'user_1','a','a','gone','x');
INSERT INTO tags VALUES ('t7','p1','x',2,'pub','a','x'), ('t8',NULL,'a',0,'pub','x','y'), ('t9','p2','a',2,'priv','a','x');
",
};

const PARENT_VARIANT: VariantSpec = VariantSpec {
    free: [
        &["title", "note", "secret"],
        &["body", "memo", "hidden", "secret"],
        &["label", "rank", "memo", "secret"],
    ],
    col_extra: "
UPDATE posts SET owner_id = 'x' WHERE owner_id = 'user_2';
UPDATE comments SET hidden = 'x' WHERE hidden = 'no';
",
    row_insert: "
INSERT INTO posts VALUES ('h2','tenant_2','user_1','x','open','a','y');
INSERT INTO comments VALUES ('c7','h1','user_1','x','a','no','x'), ('c8','h2','user_2','a','x','no','y'), ('c9',NULL,'user_1','a','a','no','x'), ('c10','zz','user_1','b','x','no','y');
INSERT INTO tags VALUES ('t7','p3','x',1,'pub','a','x');
",
};

const LIMITED_VARIANT: VariantSpec = VariantSpec {
    free: [
        &["owner_id", "title", "note", "secret"],
        &["author_id", "body", "memo", "secret"],
        &["rank", "flag", "memo", "secret"],
    ],
    col_extra: "
UPDATE posts SET owner_id = 'x' WHERE owner_id = 'user_2';
UPDATE tags SET flag = 'x' WHERE flag = 'priv';
",
    row_insert: "
INSERT INTO posts VALUES ('h2','tenant_2','user_1','x','open','a','y');
INSERT INTO comments VALUES ('c7','p1','user_1','x','a','yes','x'), ('c9',NULL,'user_1','a','a','no','x');
INSERT INTO tags VALUES ('t7','p1','b',1,'pub','a','x'), ('t8','t8','a',2,'pub','x','y');
",
};

#[allow(clippy::too_many_arguments)]
const fn resource(
    resource: &'static str,
    filter_yaml: &'static str,
    filter_sql: &'static str,
    visible_if_yaml: &'static str,
    visible_if_sql: &'static str,
    limit: Option<u64>,
    mutation: bool,
) -> ResourcePolicy {
    ResourcePolicy {
        resource,
        filter_yaml,
        filter_sql,
        visible_if_yaml,
        visible_if_sql,
        limit,
        mutation,
        mutation_filter: None,
    }
}

pub fn base_case() -> PolicyCase {
    PolicyCase {
        name: "base",
        resources: [
            resource(
                "posts",
                TENANT_YAML,
                TENANT_SQL,
                OWNER_YAML,
                OWNER_SQL,
                None,
                true,
            ),
            resource(
                "comments",
                "{ hidden: { eq: 'no' } }",
                "hidden = 'no'",
                AUTHOR_YAML,
                AUTHOR_SQL,
                None,
                true,
            ),
            resource(
                "tags",
                "{ flag: { neq: hide } }",
                "flag <> 'hide'",
                "{ flag: { eq: pub } }",
                "flag = 'pub'",
                None,
                false,
            ),
        ],
        variant: BASE_VARIANT,
        mutation_filter_is_select_filter: true,
    }
}

fn logic_case() -> PolicyCase {
    PolicyCase {
        name: "logic",
        resources: [
            resource(
                "posts",
                "{ and: [ { tenant_id: { eq: { session: tenant_id } } }, { or: [ { status: { eq: open } }, { owner_id: { eq: { session: subject_id } } } ] } ] }",
                "tenant_id = 'tenant_1' AND (status = 'open' OR owner_id = 'user_1')",
                "{ not: { owner_id: { eq: user_2 } } }",
                "NOT (owner_id = 'user_2')",
                None,
                true,
            ),
            resource(
                "comments",
                "{ hidden: { in: ['no', maybe] } }",
                "hidden IN ('no', 'maybe')",
                "{ or: [ { author_id: { eq: { session: subject_id } } }, { body: { eq: a } } ] }",
                "author_id = 'user_1' OR body = 'a'",
                None,
                true,
            ),
            resource(
                "tags",
                "{ and: [ { post_id: { is_null: false } }, { rank: { lt: 2 } } ] }",
                "post_id IS NOT NULL AND rank < 2",
                "{ rank: { lt: 1 } }",
                "rank < 1",
                None,
                false,
            ),
        ],
        variant: LOGIC_VARIANT,
        mutation_filter_is_select_filter: true,
    }
}

fn parent_case() -> PolicyCase {
    PolicyCase {
        name: "parent",
        resources: [
            resource(
                "posts",
                TENANT_YAML,
                TENANT_SQL,
                OWNER_YAML,
                OWNER_SQL,
                None,
                true,
            ),
            resource(
                "comments",
                "{ exists: { resource: posts, on: { id: post_id }, where: { tenant_id: { eq: { session: tenant_id } } } } }",
                "EXISTS (SELECT 1 FROM posts AS pp WHERE pp.id = comments.post_id AND pp.tenant_id = 'tenant_1')",
                AUTHOR_YAML,
                AUTHOR_SQL,
                None,
                false,
            ),
            resource(
                "tags",
                "{ not: { exists: { resource: posts, on: { id: post_id }, where: { status: { eq: closed } } } } }",
                "NOT EXISTS (SELECT 1 FROM posts AS pp WHERE pp.id = tags.post_id AND pp.status = 'closed')",
                "{ flag: { eq: pub } }",
                "flag = 'pub'",
                None,
                false,
            ),
        ],
        variant: PARENT_VARIANT,
        mutation_filter_is_select_filter: true,
    }
}

fn limited_case() -> PolicyCase {
    PolicyCase {
        name: "limited",
        resources: [
            resource(
                "posts",
                TENANT_YAML,
                TENANT_SQL,
                "{ status: { eq: open } }",
                "status = 'open'",
                Some(2),
                true,
            ),
            resource(
                "comments",
                "{ and: [ { hidden: { eq: 'no' } }, { post_id: { is_null: false } } ] }",
                "hidden = 'no' AND post_id IS NOT NULL",
                AUTHOR_YAML,
                AUTHOR_SQL,
                Some(3),
                true,
            ),
            resource(
                "tags",
                "{ and: [ { label: { in: [a, x] } }, { id: { neq: { column: post_id } } } ] }",
                "label IN ('a', 'x') AND id <> post_id",
                "{ rank: { gte: 1 } }",
                "rank >= 1",
                None,
                false,
            ),
        ],
        variant: LIMITED_VARIANT,
        mutation_filter_is_select_filter: true,
    }
}

/// The four standing policy cases.
pub fn all_cases() -> Vec<PolicyCase> {
    vec![base_case(), logic_case(), parent_case(), limited_case()]
}

/// The standing case with the given name.
pub fn case_named(name: &str) -> PolicyCase {
    all_cases()
        .into_iter()
        .find(|case| case.name == name)
        .unwrap_or_else(|| unreachable!("no policy case named {name}"))
}

/// The case behind `known_gap_118_wider_mutation_filter`: posts' update / delete filter covers all
/// rows while the select filter still hides some (issue #118, outside P3).
pub fn wider_mutation_filter_case() -> PolicyCase {
    let mut case = base_case();
    case.resources[0].mutation_filter = Some(("{ id: { neq: none } }", "id <> 'none'"));
    case.mutation_filter_is_select_filter = false;
    case
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GateFlag {
    Aggregations,
    Windows,
}

/// Which gate a bundle has switched off.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GateOff {
    /// Both flags of every resource.
    All,
    /// One flag of one resource, named as in [`RESOURCES`].
    One {
        resource: &'static str,
        flag: GateFlag,
    },
}

impl GateOff {
    pub fn name(self) -> String {
        match self {
            Self::All => "all".to_owned(),
            Self::One { resource, flag } => format!(
                "{resource}/{}",
                match flag {
                    GateFlag::Aggregations => "aggregations",
                    GateFlag::Windows => "windows",
                }
            ),
        }
    }

    pub fn flags(self) -> GateFlags {
        match self {
            Self::All => GateFlags::uniform(false),
            Self::One { resource, flag } => {
                let mut flags = GateFlags::uniform(true);
                let index = RESOURCES
                    .iter()
                    .position(|name| *name == resource)
                    .unwrap_or_else(|| unreachable!("unknown resource {resource}"));
                match flag {
                    GateFlag::Aggregations => flags.aggregations[index] = false,
                    GateFlag::Windows => flags.windows[index] = false,
                }
                flags
            }
        }
    }
}

/// The seven gate variants besides `main` (spec 5.3).
pub fn gate_variants() -> Vec<GateOff> {
    let mut out = vec![GateOff::All];
    for resource in RESOURCES {
        for flag in [GateFlag::Aggregations, GateFlag::Windows] {
            out.push(GateOff::One { resource, flag });
        }
    }
    out
}

#[derive(Clone, Copy, Debug)]
pub struct GateFlags {
    pub aggregations: [bool; 3],
    pub windows: [bool; 3],
}

impl GateFlags {
    pub fn uniform(value: bool) -> Self {
        Self {
            aggregations: [value; 3],
            windows: [value; 3],
        }
    }
}

/// Renders the policy YAML. `extra_regular` adds `(resource, column)` to the plain `columns` list;
/// only the planted-defect test uses it.
pub fn render_yaml(case: &PolicyCase, gates: GateFlags, extra_regular: &[(&str, &str)]) -> String {
    let mut out = String::from("version: 1\nresources:\n");
    for (index, policy) in case.resources.iter().enumerate() {
        let shape = &SHAPES[index];
        let _ = write!(
            out,
            "  {}:\n    roles:\n      member:\n        select:\n          columns:\n",
            policy.resource
        );
        for column in shape.regular {
            let _ = writeln!(out, "            - {column}");
        }
        for (resource, column) in extra_regular {
            if *resource == policy.resource {
                let _ = writeln!(out, "            - {column}");
            }
        }
        let _ = writeln!(
            out,
            "            - {{ name: {}, visible_if: {}, on_deny: null }}",
            shape.conditional, policy.visible_if_yaml
        );
        let _ = writeln!(out, "          filter: {}", policy.filter_yaml);
        if let Some(limit) = policy.limit {
            let _ = writeln!(out, "          limit: {limit}");
        }
        let _ = writeln!(
            out,
            "          allow_aggregations: {}\n          allow_windows: {}",
            gates.aggregations[index], gates.windows[index]
        );
        if policy.mutation {
            let filter = policy.mutation_filter_yaml();
            let _ = writeln!(
                out,
                "        update: {{ columns: {}, filter: {filter}, check: {filter}, returning: {{ columns: {} }} }}",
                shape.update_columns, shape.update_returning
            );
            let _ = writeln!(
                out,
                "        delete: {{ filter: {filter}, returning: {{ columns: [id] }} }}"
            );
        }
    }
    out
}
