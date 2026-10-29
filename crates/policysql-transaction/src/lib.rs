#![forbid(unsafe_code)]
//! Pure transaction rules (ADR 0024).
//!
//! This crate has no I/O, no clock, and no randomness, and no `wasm-bindgen`;
//! `policysql-wasm` exposes it. Pull request 2 of the ADR 0024 migration moves canonical JSON,
//! SHA-256, the idempotency key syntax, the request identities (`keyHash`, fingerprints), and
//! the command digests here. The `step` machine follows in later pull requests.

pub mod canonical;
pub mod identity;

pub use canonical::{Json, ParseError, stable_json};
pub use identity::{IdentityError, identity_json, sha256_hex, valid_idempotency_key};

#[cfg(test)]
mod purity_tests {
    // ADR 0024 "Determinism and purity": core reads no clock and no random source.
    #[test]
    fn names_no_clock_or_random_source() {
        let manifest = include_str!("../Cargo.toml");
        let dependencies = manifest
            .split("[dependencies]")
            .nth(1)
            .and_then(|rest| rest.split("\n[").next())
            .unwrap_or_default();
        let names: Vec<&str> = dependencies
            .lines()
            .filter_map(|line| line.split('=').next())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        assert_eq!(names, ["sha2"]);
        for source in [
            include_str!("lib.rs"),
            include_str!("canonical.rs"),
            include_str!("identity.rs"),
        ] {
            for forbidden in [
                ["System", "Time"].concat(),
                ["Inst", "ant"].concat(),
                ["get", "random"].concat(),
                ["js", "_sys"].concat(),
            ] {
                assert!(!source.contains(&forbidden), "{forbidden}");
            }
        }
    }
}
