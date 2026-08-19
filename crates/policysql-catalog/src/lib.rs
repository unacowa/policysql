#![forbid(unsafe_code)]

use policysql_core::{ColumnId, ColumnName, ResourceId, ResourceName, SnapshotId, ValueDescriptor};
use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ColumnDescriptor {
    pub id: ColumnId,
    pub name: ColumnName,
    pub value: ValueDescriptor,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceDescriptor {
    pub id: ResourceId,
    pub name: ResourceName,
    pub source: ResourceName,
    columns: BTreeMap<String, ColumnDescriptor>,
}

impl ResourceDescriptor {
    /// Creates a resource and rejects case-colliding columns.
    ///
    /// # Errors
    ///
    /// Returns [`CatalogError::DuplicateColumn`] for duplicate canonical names.
    pub fn new(
        id: ResourceId,
        name: ResourceName,
        columns: impl IntoIterator<Item = (ColumnName, ValueDescriptor)>,
    ) -> Result<Self, CatalogError> {
        Self::new_with_source(id, name.clone(), name, columns)
    }

    /// Creates a resource whose logical name differs from its physical table.
    ///
    /// # Errors
    ///
    /// Returns the same closed Catalog errors as [`Self::new`].
    pub fn new_with_source(
        id: ResourceId,
        name: ResourceName,
        source: ResourceName,
        columns: impl IntoIterator<Item = (ColumnName, ValueDescriptor)>,
    ) -> Result<Self, CatalogError> {
        let mut resolved = BTreeMap::new();
        for (ordinal, (column_name, value)) in columns.into_iter().enumerate() {
            let key = canonical(column_name.as_str());
            let ordinal = u32::try_from(ordinal).map_err(|_| CatalogError::TooManyColumns)?;
            let descriptor = ColumnDescriptor {
                id: ColumnId::new(id, ordinal),
                name: column_name,
                value,
            };
            if resolved.insert(key.clone(), descriptor).is_some() {
                return Err(CatalogError::DuplicateColumn(key));
            }
        }
        if resolved.is_empty() {
            return Err(CatalogError::EmptyResource);
        }
        Ok(Self {
            id,
            name,
            source,
            columns: resolved,
        })
    }

    #[must_use]
    pub fn column(&self, name: &str) -> Option<&ColumnDescriptor> {
        self.columns.get(&canonical(name))
    }

    pub fn columns(&self) -> impl Iterator<Item = &ColumnDescriptor> {
        self.columns.values()
    }

    #[must_use]
    pub fn column_by_id(&self, id: ColumnId) -> Option<&ColumnDescriptor> {
        (id.resource() == self.id)
            .then(|| self.columns.values().find(|column| column.id == id))
            .flatten()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Catalog {
    snapshot: SnapshotId,
    resources: BTreeMap<String, ResourceDescriptor>,
}

impl Catalog {
    /// Creates an immutable Catalog and rejects case-colliding resource names.
    ///
    /// # Errors
    ///
    /// Returns [`CatalogError::DuplicateResource`] or [`CatalogError::EmptyCatalog`].
    pub fn new(
        snapshot: SnapshotId,
        resources: impl IntoIterator<Item = ResourceDescriptor>,
    ) -> Result<Self, CatalogError> {
        let mut resolved = BTreeMap::new();
        for resource in resources {
            let key = canonical(resource.name.as_str());
            if resolved.insert(key.clone(), resource).is_some() {
                return Err(CatalogError::DuplicateResource(key));
            }
        }
        if resolved.is_empty() {
            return Err(CatalogError::EmptyCatalog);
        }
        Ok(Self {
            snapshot,
            resources: resolved,
        })
    }

    #[must_use]
    pub fn snapshot(&self) -> &SnapshotId {
        &self.snapshot
    }

    #[must_use]
    pub fn resource(&self, name: &str) -> Option<&ResourceDescriptor> {
        self.resources.get(&canonical(name))
    }

    pub fn resources(&self) -> impl Iterator<Item = &ResourceDescriptor> {
        self.resources.values()
    }

    #[must_use]
    pub fn resource_by_id(&self, id: ResourceId) -> Option<&ResourceDescriptor> {
        self.resources.values().find(|resource| resource.id == id)
    }
}

fn canonical(value: &str) -> String {
    value.to_ascii_lowercase()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogError {
    EmptyCatalog,
    EmptyResource,
    TooManyColumns,
    DuplicateResource(String),
    DuplicateColumn(String),
}

impl fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyCatalog => formatter.write_str("Catalog must contain a resource"),
            Self::EmptyResource => formatter.write_str("resource must contain a column"),
            Self::TooManyColumns => formatter.write_str("resource has too many columns"),
            Self::DuplicateResource(name) => write!(formatter, "duplicate resource: {name}"),
            Self::DuplicateColumn(name) => write!(formatter, "duplicate column: {name}"),
        }
    }
}

impl std::error::Error for CatalogError {}

#[cfg(test)]
mod tests {
    use super::{Catalog, CatalogError, ResourceDescriptor};
    use policysql_core::{
        LogicalType, ResourceId, ResourceName, SnapshotId, ValueDescriptor, ValueRepresentation,
    };

    fn string_descriptor() -> ValueDescriptor {
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

    #[test]
    fn rejects_case_colliding_resources() {
        let first = ResourceDescriptor::new(
            ResourceId::new(1).unwrap_or_else(|error| unreachable!("valid ID: {error}")),
            ResourceName::new("Projects")
                .unwrap_or_else(|error| unreachable!("valid name: {error}")),
            [(
                policysql_core::ColumnName::new("id")
                    .unwrap_or_else(|error| unreachable!("valid name: {error}")),
                string_descriptor(),
            )],
        );
        assert!(first.is_ok());
        let second = ResourceDescriptor::new(
            ResourceId::new(2).unwrap_or_else(|error| unreachable!("valid ID: {error}")),
            ResourceName::new("projects")
                .unwrap_or_else(|error| unreachable!("valid name: {error}")),
            [(
                policysql_core::ColumnName::new("id")
                    .unwrap_or_else(|error| unreachable!("valid name: {error}")),
                string_descriptor(),
            )],
        );
        assert!(second.is_ok());
        let catalog = Catalog::new(
            SnapshotId::new("schema_1")
                .unwrap_or_else(|error| unreachable!("valid snapshot: {error}")),
            [
                first.unwrap_or_else(|error| unreachable!("valid resource: {error}")),
                second.unwrap_or_else(|error| unreachable!("valid resource: {error}")),
            ],
        );
        assert!(matches!(catalog, Err(CatalogError::DuplicateResource(_))));
    }
}
