//! The vocabulary a generator draws from. The generators never know the schema: resources,
//! columns, their roles and the literals are all passed in through an [`Alphabet`].

/// Index into [`Alphabet::resources`].
pub type ResourceIdx = usize;
/// Index into [`ResourceSpec::columns`].
pub type ColumnIdx = usize;

/// How the select policy treats a column.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ColumnClass {
    /// Listed as a plain string in `columns`.
    Regular,
    /// Listed with a `visible_if`.
    Conditional,
    /// Not listed.
    Forbidden,
}

/// The type of a column, which decides which literals and operators fit.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ValueType {
    Text,
    Int,
}

/// A literal value.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Lit {
    Text(&'static str),
    Int(i64),
}

impl Lit {
    #[must_use]
    pub fn ty(self) -> ValueType {
        match self {
            Self::Text(_) => ValueType::Text,
            Self::Int(_) => ValueType::Int,
        }
    }
}

/// One column of a resource.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ColumnSpec {
    pub name: &'static str,
    pub class: ColumnClass,
    pub ty: ValueType,
}

/// One resource (table) with the alias the generators give it in the outer query.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceSpec {
    pub name: &'static str,
    pub alias: &'static str,
    /// The column that identifies the parent row (`posts.id`, `comments.post_id`, ...).
    pub key: ColumnIdx,
    pub columns: Vec<ColumnSpec>,
}

/// Resources and literals.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Alphabet {
    pub resources: Vec<ResourceSpec>,
    pub text_literals: Vec<&'static str>,
    pub int_literals: Vec<i64>,
}

impl Alphabet {
    #[must_use]
    pub fn resource(&self, index: ResourceIdx) -> Option<&ResourceSpec> {
        self.resources.get(index)
    }

    /// Name of a resource, or `?` for an index outside the alphabet (rendering must not panic).
    #[must_use]
    pub fn resource_name(&self, index: ResourceIdx) -> &'static str {
        self.resources.get(index).map_or("?", |r| r.name)
    }

    #[must_use]
    pub fn resource_alias(&self, index: ResourceIdx) -> &'static str {
        self.resources.get(index).map_or("?", |r| r.alias)
    }

    #[must_use]
    pub fn column(&self, resource: ResourceIdx, column: ColumnIdx) -> Option<&ColumnSpec> {
        self.resources.get(resource)?.columns.get(column)
    }

    #[must_use]
    pub fn column_name(&self, resource: ResourceIdx, column: ColumnIdx) -> &'static str {
        self.column(resource, column).map_or("?", |c| c.name)
    }

    /// Columns of a resource with the given class, in declaration order.
    #[must_use]
    pub fn columns_of(&self, resource: ResourceIdx, class: ColumnClass) -> Vec<ColumnIdx> {
        self.resources.get(resource).map_or_else(Vec::new, |r| {
            r.columns
                .iter()
                .enumerate()
                .filter(|(_, c)| c.class == class)
                .map(|(i, _)| i)
                .collect()
        })
    }

    /// All columns of a resource, in declaration order.
    #[must_use]
    pub fn all_columns(&self, resource: ResourceIdx) -> Vec<ColumnIdx> {
        self.resources
            .get(resource)
            .map_or_else(Vec::new, |r| (0..r.columns.len()).collect())
    }

    /// Literals of a type, as [`Lit`].
    #[must_use]
    pub fn literals(&self, ty: ValueType) -> Vec<Lit> {
        match ty {
            ValueType::Text => self.text_literals.iter().map(|t| Lit::Text(t)).collect(),
            ValueType::Int => self.int_literals.iter().map(|i| Lit::Int(*i)).collect(),
        }
    }

    /// All literals, text first.
    #[must_use]
    pub fn all_literals(&self) -> Vec<Lit> {
        let mut out = self.literals(ValueType::Text);
        out.extend(self.literals(ValueType::Int));
        out
    }
}
