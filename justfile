set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

fmt:
    cargo fmt --all -- --check

lint:
    cargo clippy --workspace --all-targets --all-features -- -D warnings

test:
    cargo test --workspace --all-targets

coverage:
    cargo run -p policysql-testkit --bin coverage-check

check: fmt lint test coverage

list-fixtures:
    find tests/fixtures -type f | sort
