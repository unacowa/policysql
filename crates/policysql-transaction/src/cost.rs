//! The cost evaluation (ADR 0024 "Cost", pull request 6): `cost_estimate_json`.
//!
//! No request is admitted or rejected by cost: the engine runs the `EXPLAIN QUERY PLAN`
//! statements an `Observe` effect carries in the background, after the reply, and logs what this
//! function returns. The evaluation is the one `cost.ts` `evaluate` made in TypeScript: each
//! statement's bounds come from the wrapper's cost catalog (`PolicySqlConfig.costCatalog`,
//! keyed by the catalog's numeric resource id), never from the planner's prose, which SQLite does
//! not keep stable. The planner rows only count plan steps.
//!
//! Input (`statements` is every statement of the envelope in order, as `Observe.context`
//! lists them; `results` holds one result per non-insert statement, in order, as the cost
//! statements of `Observe.statements` returned it, each row an array of values):
//!
//! ```json
//! {"catalog": {"maxEstimatedRowsRead": 1000, "maxEstimatedRowsWritten": 1000,
//!              "resources": {"1": {"upperRows": 100}}} | null,
//!  "statements": [{"operation": "select", "explainResource": 1}],
//!  "results": [{"columns": ["id", "parent", "notused", "detail"], "rows": [[2, 0, 0, "SCAN t"]]}]}
//! ```
//!
//! Output: `{"estimates": [...]}`, one estimate per statement, or
//! `{"error": {"code", "message"}}` with `POLICYSQL_COST_UNKNOWN` (no catalog, a resource the
//! catalog does not bound, a plan row without a `detail` text), `POLICYSQL_USAGE_BUDGET_EXCEEDED`
//! (a bound over the catalog's budget), or `POLICYSQL_COST_ADMISSION_UNAVAILABLE` (an input
//! that is not this shape, or more results than non-insert statements).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The largest input `cost_estimate_json` reads (plan rows are small; this bounds a fault).
pub const MAX_COST_INPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    catalog: Option<Map<String, Value>>,
    statements: Vec<Statement>,
    results: Vec<PlanResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Statement {
    operation: String,
    /// The resource name `Observe.context` carries; the bounds use `explainResource` only.
    #[serde(default, rename = "resource")]
    _resource: Option<String>,
    explain_resource: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanResult {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

/// One statement's estimate, in the key order `cost.ts` logs.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Estimate {
    lower_rows_read: u64,
    expected_rows_read: u64,
    upper_rows_read: u64,
    lower_rows_written: u64,
    expected_rows_written: u64,
    upper_rows_written: u64,
    confidence: &'static str,
    access: &'static str,
    #[serde(rename = "temporaryBTree")]
    temporary_b_tree: Option<()>,
    plan_steps: usize,
    planner: &'static str,
}

#[derive(Serialize)]
struct Estimates {
    estimates: Vec<Estimate>,
}

#[derive(Serialize)]
struct ErrorOutput {
    error: ErrorBody,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CostError {
    Unknown,
    Budget,
    Unavailable,
}

impl CostError {
    const fn parts(self) -> (&'static str, &'static str) {
        match self {
            Self::Unknown => (
                "POLICYSQL_COST_UNKNOWN",
                "The query cost could not be bounded safely.",
            ),
            Self::Budget => (
                "POLICYSQL_USAGE_BUDGET_EXCEEDED",
                "The query exceeds the configured usage budget.",
            ),
            Self::Unavailable => (
                "POLICYSQL_COST_ADMISSION_UNAVAILABLE",
                "Cost admission is temporarily unavailable.",
            ),
        }
    }
}

/// Evaluates the cost of one envelope (see the module documentation for the contract).
#[must_use]
pub fn cost_estimate_json(input: &str) -> String {
    let outcome = if input.len() > MAX_COST_INPUT_BYTES {
        Err(CostError::Unavailable)
    } else {
        serde_json::from_str::<Input>(input)
            .map_err(|_| CostError::Unavailable)
            .and_then(|input| evaluate(&input))
    };
    match outcome {
        Ok(estimates) => serde_json::to_string(&Estimates { estimates })
            .unwrap_or_else(|_| error_json(CostError::Unavailable)),
        Err(error) => error_json(error),
    }
}

fn error_json(error: CostError) -> String {
    let (code, message) = error.parts();
    serde_json::to_string(&ErrorOutput {
        error: ErrorBody { code, message },
    })
    .unwrap_or_default()
}

/// A positive integer of the catalog (the shape `engine-config.ts` validates).
fn positive(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|value| *value >= 1)
}

fn evaluate(input: &Input) -> Result<Vec<Estimate>, CostError> {
    // An absent catalog means the cost cannot be bounded (`requireCatalog`).
    let catalog = input.catalog.as_ref().ok_or(CostError::Unknown)?;
    let max_read = positive(catalog.get("maxEstimatedRowsRead")).ok_or(CostError::Unavailable)?;
    let max_written =
        positive(catalog.get("maxEstimatedRowsWritten")).ok_or(CostError::Unavailable)?;
    let resources = catalog
        .get("resources")
        .and_then(Value::as_object)
        .ok_or(CostError::Unavailable)?;
    let mut output: Vec<Estimate> = input
        .statements
        .iter()
        .map(|statement| {
            let insert = u64::from(statement.operation == "insert");
            Estimate {
                lower_rows_read: 0,
                expected_rows_read: 0,
                upper_rows_read: 0,
                lower_rows_written: insert,
                expected_rows_written: insert,
                upper_rows_written: insert,
                confidence: "conservative",
                access: if insert == 1 { "none" } else { "unknown" },
                temporary_b_tree: None,
                plan_steps: 0,
                planner: "sqlite-explain-query-plan",
            }
        })
        .collect();
    let planned: Vec<usize> = input
        .statements
        .iter()
        .enumerate()
        .filter(|(_, statement)| statement.operation != "insert")
        .map(|(index, _)| index)
        .collect();
    // More results than planned statements is a fault of the caller; fewer leave the remaining
    // statements at their conservative defaults (as `cost.ts` iterates the results).
    if input.results.len() > planned.len() {
        return Err(CostError::Unavailable);
    }
    for (result, index) in input.results.iter().zip(planned) {
        let statement = &input.statements[index];
        let detail = result.columns.iter().position(|column| column == "detail");
        let mut steps = 0;
        for row in &result.rows {
            // SQLite does not guarantee the format of `detail`: only its presence is read.
            if !detail
                .and_then(|at| row.get(at))
                .is_some_and(Value::is_string)
            {
                return Err(CostError::Unknown);
            }
            steps += 1;
        }
        let Some(resource) = statement.explain_resource else {
            continue;
        };
        let upper_rows_read = resources
            .get(&resource.to_string())
            .and_then(|bounds| positive(bounds.get("upperRows")))
            .ok_or(CostError::Unknown)?;
        if upper_rows_read > max_read {
            return Err(CostError::Budget);
        }
        let upper_rows_written = if statement.operation == "select" {
            0
        } else {
            upper_rows_read
        };
        if upper_rows_written > max_written {
            return Err(CostError::Budget);
        }
        output[index] = Estimate {
            expected_rows_read: upper_rows_read,
            upper_rows_read,
            expected_rows_written: upper_rows_written,
            upper_rows_written,
            access: "unknown",
            temporary_b_tree: None,
            plan_steps: steps,
            ..output[index].clone()
        };
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::cost_estimate_json;
    use serde_json::{Value, json};

    fn run(input: &Value) -> Value {
        serde_json::from_str(&cost_estimate_json(&input.to_string())).unwrap_or(Value::Null)
    }

    fn catalog() -> Value {
        json!({"maxEstimatedRowsRead": 100, "maxEstimatedRowsWritten": 100, "resources": {"1": {"upperRows": 20, "uniqueSearchPatterns": ["u"]}}})
    }

    #[test]
    fn bounds_from_the_catalog_and_counts_plan_steps() {
        let output = run(&json!({
            "catalog": catalog(),
            "statements": [
                {"operation": "insert", "explainResource": 1},
                {"operation": "update", "resource": "projects", "explainResource": 1},
                {"operation": "select", "explainResource": 1},
            ],
            "results": [
                {"columns": ["detail"], "rows": [["SEARCH projects USING INDEX u (id=?)"]]},
                {"columns": ["id", "parent", "notused", "detail"], "rows": [[2, 0, 0, "SCAN a"], [3, 0, 0, "SCAN b"]]},
            ],
        }));
        let estimates = &output["estimates"];
        assert_eq!(estimates[0]["upperRowsWritten"], 1);
        assert_eq!(estimates[0]["access"], "none");
        assert_eq!(estimates[1]["upperRowsWritten"], 20);
        assert_eq!(estimates[1]["planSteps"], 1);
        assert_eq!(estimates[2]["upperRowsRead"], 20);
        assert_eq!(estimates[2]["upperRowsWritten"], 0);
        assert_eq!(estimates[2]["planSteps"], 2);
        assert_eq!(estimates[2]["temporaryBTree"], Value::Null);
        let keys: Vec<&String> = estimates[2]
            .as_object()
            .map(|object| object.keys().collect())
            .unwrap_or_default();
        assert_eq!(keys.len(), 11);
    }

    #[test]
    fn unknown_budget_and_malformed_inputs() {
        let select = json!([{"operation": "select", "explainResource": 1}]);
        let plan = json!([{"columns": ["detail"], "rows": [["SCAN"]]}]);
        let code = |input: Value| run(&input)["error"]["code"].as_str().map(str::to_owned);
        assert_eq!(
            code(json!({"catalog": null, "statements": select, "results": plan})).as_deref(),
            Some("POLICYSQL_COST_UNKNOWN")
        );
        assert_eq!(code(json!({"catalog": catalog(), "statements": [{"operation": "select", "explainResource": 2}], "results": plan})).as_deref(), Some("POLICYSQL_COST_UNKNOWN"));
        assert_eq!(code(json!({"catalog": catalog(), "statements": select, "results": [{"columns": ["detail"], "rows": [[1]]}]})).as_deref(), Some("POLICYSQL_COST_UNKNOWN"));
        let tight = json!({"maxEstimatedRowsRead": 10, "maxEstimatedRowsWritten": 100, "resources": {"1": {"upperRows": 20}}});
        assert_eq!(
            code(json!({"catalog": tight, "statements": select, "results": plan})).as_deref(),
            Some("POLICYSQL_USAGE_BUDGET_EXCEEDED")
        );
        let written = json!({"maxEstimatedRowsRead": 100, "maxEstimatedRowsWritten": 10, "resources": {"1": {"upperRows": 20}}});
        assert_eq!(code(json!({"catalog": written, "statements": [{"operation": "delete", "explainResource": 1}], "results": plan})).as_deref(), Some("POLICYSQL_USAGE_BUDGET_EXCEEDED"));
        assert_eq!(
            code(
                json!({"catalog": catalog(), "statements": select, "results": [plan[0], plan[0]]})
            )
            .as_deref(),
            Some("POLICYSQL_COST_ADMISSION_UNAVAILABLE")
        );
        assert_eq!(
            run(&json!({"catalog": catalog(), "statements": select, "results": []}))["estimates"]
                [0]["upperRowsRead"],
            0
        );
        assert_eq!(
            code(json!({"catalog": catalog(), "statements": select})).as_deref(),
            Some("POLICYSQL_COST_ADMISSION_UNAVAILABLE")
        );
        assert_eq!(
            run(
                &json!({"catalog": catalog(), "statements": [{"operation": "select", "explainResource": null}], "results": plan})
            )["estimates"][0]["upperRowsRead"],
            0
        );
    }
}
