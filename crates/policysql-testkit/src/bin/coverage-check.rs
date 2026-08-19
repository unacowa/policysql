#![forbid(unsafe_code)]

use policysql_testkit::{check_coverage, write_report};
use std::path::PathBuf;

fn main() {
    if let Err(error) = run() {
        eprintln!("coverage-check failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let report = check_coverage(
        &root.join("tests/sql-surface"),
        &root.join("tests/fixtures"),
    )?;
    let output = root.join("target/policysql-test-coverage/sqlite-turso-v1");
    write_report(&report, &output)?;
    print!("{}", report.to_markdown());
    if report.is_success() {
        Ok(())
    } else {
        Err("SQL surface coverage has errors".into())
    }
}
