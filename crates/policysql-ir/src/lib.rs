#![forbid(unsafe_code)]

use policysql_core::{
    ClientParameterName, ColumnId, LogicalType, LogicalValue, PolicyId, ResourceId, ResultName,
    ServerParameterName,
};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ColumnUsage {
    Projection,
    Filter,
    PolicyFilter,
    Join,
    Order,
    Group,
    Having,
    Aggregate,
    Window,
    Mutation,
    Write,
    Returning,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundColumn {
    pub id: ColumnId,
    pub logical_type: LogicalType,
    pub usage: ColumnUsage,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BoundExpr {
    Column(BoundColumn),
    ClientParameter {
        name: ClientParameterName,
        logical_type: LogicalType,
    },
    ServerParameter {
        name: ServerParameterName,
        logical_type: LogicalType,
    },
    Literal(LogicalValue),
    Equal(Box<Self>, Box<Self>),
    NotEqual(Box<Self>, Box<Self>),
    Less(Box<Self>, Box<Self>),
    LessEqual(Box<Self>, Box<Self>),
    Greater(Box<Self>, Box<Self>),
    GreaterEqual(Box<Self>, Box<Self>),
    And(Box<Self>, Box<Self>),
    Or(Box<Self>, Box<Self>),
    Not(Box<Self>),
    IsNull(Box<Self>),
    In {
        expression: Box<Self>,
        values: Vec<Self>,
        negated: bool,
    },
    Like(Box<Self>, Box<Self>),
    Glob(Box<Self>, Box<Self>),
    Least(Box<Self>, Box<Self>),
    Concat(Box<Self>, Box<Self>),
    CastText(Box<Self>),
    Case {
        branches: Vec<(Self, Self)>,
        else_expression: Option<Box<Self>>,
        logical_type: LogicalType,
    },
    ConditionalOutput {
        value: Box<Self>,
        visible_if: Box<Self>,
    },
    Exists(Box<BoundSelect>),
    CountAll(ResourceId),
    ScalarFunction {
        function: ScalarFunction,
        arguments: Vec<Self>,
        logical_type: LogicalType,
    },
    RowNumber {
        resource: ResourceId,
        partition_by: Vec<BoundColumn>,
        order_by: Vec<BoundOrder>,
    },
}

impl BoundExpr {
    #[must_use]
    pub const fn direct_column(&self) -> Option<&BoundColumn> {
        if let Self::Column(column) = self {
            Some(column)
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScalarFunction {
    Lower,
    Upper,
    JsonExtract,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundProjection {
    pub expression: BoundExpr,
    pub output_name: ResultName,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SortDirection {
    Ascending,
    Descending,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundOrder {
    pub expression: BoundExpr,
    pub direction: SortDirection,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JoinKind {
    Inner,
    Left,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundJoin {
    pub resource: ResourceId,
    pub alias: Option<String>,
    pub kind: JoinKind,
    pub on: BoundExpr,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundSelect {
    pub resource: ResourceId,
    pub alias: Option<String>,
    pub joins: Vec<BoundJoin>,
    pub projections: Vec<BoundProjection>,
    pub predicate: Option<BoundExpr>,
    pub group_by: Vec<BoundColumn>,
    pub having: Option<BoundExpr>,
    pub order_by: Vec<BoundOrder>,
    pub limit: Option<BoundExpr>,
    pub offset: Option<BoundExpr>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundAssignment {
    pub column: BoundColumn,
    pub value: BoundExpr,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundInsert {
    pub resource: ResourceId,
    pub rows: Vec<Vec<BoundAssignment>>,
    pub returning: Vec<BoundProjection>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundUpdate {
    pub resource: ResourceId,
    pub assignments: Vec<BoundAssignment>,
    pub predicate: Option<BoundExpr>,
    pub returning: Vec<BoundProjection>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundDelete {
    pub resource: ResourceId,
    pub predicate: Option<BoundExpr>,
    pub returning: Vec<BoundProjection>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundConstantSelect {
    pub projections: Vec<BoundProjection>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundJsonCollectionSelect {
    pub resource: ResourceId,
    pub alias: Option<String>,
    pub document: BoundColumn,
    pub path: BoundExpr,
    pub recursive: bool,
    pub output_name: ResultName,
    pub predicate: Option<BoundExpr>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BoundStatement {
    Select(Box<BoundSelect>),
    ConstantSelect(BoundConstantSelect),
    JsonCollectionSelect(BoundJsonCollectionSelect),
    Insert(BoundInsert),
    Update(BoundUpdate),
    Delete(BoundDelete),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProtectedPlan {
    pub statement: BoundStatement,
    pub applied_policies: Vec<PolicyId>,
    pub server_values: BTreeMap<ServerParameterName, LogicalValue>,
    pub policy_limit: Option<u64>,
    pub operation_check: Option<BoundExpr>,
    pub expected_affected_rows: Option<u64>,
    pub expected_result_rows: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::{BoundColumn, BoundExpr, ColumnUsage};
    use policysql_core::{ColumnId, LogicalType, ResourceId};

    #[test]
    fn bound_column_uses_stable_catalog_identity() {
        let resource = ResourceId::new(1);
        assert!(resource.is_ok());
        if let Ok(resource) = resource {
            let expression = BoundExpr::Column(BoundColumn {
                id: ColumnId::new(resource, 2),
                logical_type: LogicalType::String,
                usage: ColumnUsage::Filter,
            });
            assert!(matches!(expression, BoundExpr::Column(_)));
        }
    }
}
