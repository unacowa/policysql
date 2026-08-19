#![forbid(unsafe_code)]

use policysql_catalog::{Catalog, ResourceDescriptor};
use policysql_core::{
    ClientParameterName, ColumnName, LogicalType, LogicalValue, ResourceId, ResourceName, RoleName,
    SnapshotId, TrustedSession, ValueDescriptor, ValueRepresentation,
};
use policysql_execution::ExecutionLimits;
use policysql_parser::SqliteFrontend;
use policysql_policy::PolicyBundle;
use policysql_sqlite::{compile_verified_select, compile_verified_update};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

const POLICY: &str = r"
version: 1
resources:
  projects:
    roles:
      member:
        select:
          columns: [id, tenant_id, name, status]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
          allow_aggregations: true
          allow_windows: true
        update:
          columns: [name, status]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          check: { tenant_id: { eq: { session: tenant_id } } }
          returning: { columns: [id, name] }
  tasks:
    roles:
      member:
        select:
          columns: [id, project_id, tenant_id, title]
          filter: { tenant_id: { eq: { session: tenant_id } } }
          limit: 100
";

fn descriptor() -> ValueDescriptor {
    ValueDescriptor {
        logical_type: LogicalType::String,
        representation: ValueRepresentation::String,
        nullable: false,
        format: None,
    }
}

fn resource(id: u64, name: &str, columns: &[&str]) -> Result<ResourceDescriptor, String> {
    let id = ResourceId::new(id).map_err(|error| error.to_string())?;
    let name = ResourceName::new(name).map_err(|error| error.to_string())?;
    let columns = columns
        .iter()
        .map(|name| {
            ColumnName::new(*name)
                .map(|name| (name, descriptor()))
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    ResourceDescriptor::new(id, name, columns).map_err(|error| error.to_string())
}

fn parameters(case: &str) -> Result<BTreeMap<ClientParameterName, LogicalValue>, String> {
    let mut values = BTreeMap::new();
    let mut insert = |name: &str, value: LogicalValue| -> Result<(), String> {
        values.insert(
            ClientParameterName::new(name).map_err(|error| error.to_string())?,
            value,
        );
        Ok(())
    };
    match case {
        "simple" => {
            insert("status", LogicalValue::String("active".to_owned()))?;
            insert("limit", LogicalValue::Int64(50))?;
        }
        "aggregate" => insert("minimum", LogicalValue::Int64(1))?,
        "update" => {
            insert("id", LogicalValue::String("p1".to_owned()))?;
            insert("name", LogicalValue::String("renamed".to_owned()))?;
        }
        "join" | "exists" | "window" => {}
        _ => return Err("unknown benchmark case".to_owned()),
    }
    Ok(values)
}

fn sql(case: &str) -> Result<&'static str, String> {
    match case {
        "simple" => Ok("SELECT id, name FROM projects WHERE status = :status LIMIT :limit"),
        "join" => Ok(
            "SELECT p.id, t.title FROM projects p LEFT JOIN tasks t ON t.project_id = p.id ORDER BY p.id",
        ),
        "exists" => Ok(
            "SELECT p.id FROM projects p WHERE EXISTS (SELECT t.id FROM tasks t WHERE t.project_id = p.id)",
        ),
        "aggregate" => Ok(
            "SELECT tenant_id, COUNT(*) AS item_count FROM projects GROUP BY tenant_id HAVING COUNT(*) > :minimum",
        ),
        "window" => Ok(
            "SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY id) AS row_number FROM projects ORDER BY id",
        ),
        "update" => Ok("UPDATE projects SET name = :name WHERE id = :id RETURNING id, name"),
        _ => Err("unknown benchmark case".to_owned()),
    }
}

fn run(case: &str, iterations: u32) -> Result<usize, String> {
    if iterations == 0 || iterations > 1_000 {
        return Err("iterations must be between 1 and 1000".to_owned());
    }
    let snapshot = SnapshotId::new("cloudflare_bench_1").map_err(|error| error.to_string())?;
    let catalog = Catalog::new(
        snapshot.clone(),
        [
            resource(1, "projects", &["id", "tenant_id", "name", "status"])?,
            resource(2, "tasks", &["id", "project_id", "tenant_id", "title"])?,
        ],
    )
    .map_err(|error| error.to_string())?;
    let policies = PolicyBundle::activate(POLICY, &catalog, snapshot.clone())
        .map_err(|error| error.to_string())?;
    let role = RoleName::new("member").map_err(|error| error.to_string())?;
    let session = TrustedSession::new(
        role,
        "user_1",
        BTreeMap::from([("tenant_id".to_owned(), "tenant_1".to_owned())]),
    )
    .map_err(|error| error.to_string())?;
    let frontend = SqliteFrontend::default();
    let limits = ExecutionLimits {
        max_rows: 100,
        max_result_bytes: 100_000,
        timeout_ms: 5_000,
    };
    let input = sql(case)?;
    let mut bytes = 0_usize;
    for _ in 0..iterations {
        let statement = frontend
            .bind(input, &catalog)
            .map_err(|error| error.to_string())?;
        let values = parameters(case)?;
        let verified = if case == "update" {
            let protected = policies
                .compile_update(&statement, &session)
                .map_err(|error| error.to_string())?;
            compile_verified_update(&protected.plan, &catalog, values, limits, snapshot.clone())
        } else {
            let protected = policies
                .compile_select(&statement, &session)
                .map_err(|error| error.to_string())?;
            compile_verified_select(&protected.plan, &catalog, values, limits, snapshot.clone())
        }
        .map_err(|error| error.to_string())?;
        bytes = bytes.saturating_add(verified.protected_sql().len());
    }
    Ok(bytes)
}

#[wasm_bindgen]
pub fn benchmark(case: &str, iterations: u32) -> String {
    match run(case, iterations) {
        Ok(bytes) => format!("ok:{bytes}"),
        Err(error) => format!("error:{error}"),
    }
}
