//! The statement structure shared by the three layers. Statements are built as values of these
//! types, then rendered to SQL text by [`crate::fuzz::render`]; nothing builds SQL by string
//! concatenation of user-visible fragments.

pub use super::alphabet::{ColumnIdx, Lit, ResourceIdx};

/// Which name qualifies a column in the rendered SQL.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Qualifier {
    /// The alias of the resource in the outer query (`p`, `c`, `g`).
    Outer(ResourceIdx),
    /// The alias of an EXISTS subquery at this depth (`e1`, `e2`).
    Exists { depth: u8 },
    /// The table name itself (`posts.title`), used in UPDATE / DELETE.
    Table(ResourceIdx),
    /// The inner alias of a derived table or CTE (`s`).
    Derived,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ColRef {
    pub qualifier: Qualifier,
    pub resource: ResourceIdx,
    pub column: ColumnIdx,
}

/// A literal, or a client parameter that binds the same literal.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Value {
    Lit(Lit),
    Param { index: u16, value: Lit },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Scalar {
    Column(ColRef),
    Value(Value),
    Lower(Box<Scalar>),
    Upper(Box<Scalar>),
    CastText(Box<Scalar>),
    Concat(Box<Scalar>, Box<Scalar>),
    Case {
        when: Box<Pred>,
        then: Box<Scalar>,
        otherwise: Box<Scalar>,
    },
    /// `CAST(COUNT(*) AS TEXT)`
    CountText,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CmpOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExistsProjection {
    /// `SELECT 1`
    One,
    /// `SELECT e<depth>.<key>`
    Key,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExistsQuery {
    pub resource: ResourceIdx,
    pub depth: u8,
    pub projection: ExistsProjection,
    pub predicate: Pred,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Pred {
    Cmp {
        op: CmpOp,
        left: Scalar,
        right: Scalar,
    },
    /// `x LIKE 'a%'`
    Like(Scalar),
    /// `x GLOB 'a*'`
    Glob(Scalar),
    /// `x IN ('a', 'x', 'open')` for text, `x IN (0, 1, 2)` for integers.
    In {
        expr: Scalar,
        negated: bool,
        ty: super::alphabet::ValueType,
    },
    IsNull(Scalar),
    IsNotNull(Scalar),
    Not(Box<Pred>),
    And(Box<Pred>, Box<Pred>),
    Or(Box<Pred>, Box<Pred>),
    Exists(Box<ExistsQuery>),
    /// `COUNT(*) > n`
    CountGt(u8),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Projection {
    Expr(Scalar),
    CountAll,
    RowNumber {
        partition_by: Option<ColRef>,
        order_by: ColRef,
        desc: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrderTarget {
    Column(ColRef),
    /// `o<i>`, an output alias.
    Output(usize),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OrderBy {
    pub target: OrderTarget,
    pub desc: bool,
}

/// `LIMIT <count> [OFFSET 1]`. The count is always 1..=3 (never negative: a negative count is refused before execution, #136).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limit {
    pub count: Value,
    pub offset: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JoinKind {
    Inner,
    Left,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Join {
    pub kind: JoinKind,
    pub resource: ResourceIdx,
    pub on: Pred,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Source {
    Table(ResourceIdx),
    Derived {
        resource: ResourceIdx,
        columns: Vec<ColumnIdx>,
        predicate: Option<Pred>,
        as_cte: bool,
    },
}

impl Source {
    #[must_use]
    pub fn resource(&self) -> ResourceIdx {
        match self {
            Self::Table(resource) | Self::Derived { resource, .. } => *resource,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Select {
    pub source: Source,
    pub join: Option<Join>,
    pub projections: Vec<Projection>,
    pub predicate: Option<Pred>,
    pub group_by: Option<ColRef>,
    pub having: Option<Pred>,
    pub order_by: Option<OrderBy>,
    pub limit: Option<Limit>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Returning {
    None,
    /// `RETURNING <table>.id`; the reduced alphabet has no `id` column index.
    Id,
    Columns(Vec<ColumnIdx>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Update {
    pub resource: ResourceIdx,
    pub assignments: Vec<(ColumnIdx, Value)>,
    pub predicate: Option<Pred>,
    pub returning: Returning,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Delete {
    pub resource: ResourceIdx,
    pub predicate: Option<Pred>,
    pub returning: Returning,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Statement {
    Select(Box<Select>),
    Update(Update),
    Delete(Delete),
}
