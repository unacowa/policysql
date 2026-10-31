#![forbid(unsafe_code)]
//! Pure transaction rules (ADR 0024).
//!
//! This crate has no I/O, no clock, and no randomness, and no `wasm-bindgen`;
//! `policysql-wasm` exposes it. Pull request 2 of the ADR 0024 migration moved canonical JSON,
//! SHA-256, the idempotency key syntax, the request identities (`keyHash`, fingerprints), and
//! the command digests here; ADR 0025 makes core's canonical form the only definition. Pull
//! request 4 adds the `step` machine ([`machine`]) for interactive transactions, pull request 5
//! its commit checks and callbacks, and pull request 6 atomic execution and the cost evaluation
//! ([`cost`]). Production owners run interactive transactions on the machine since pull request
//! 7, and the engine and owners atomic execution since pull request 8.

pub mod bounds;
pub mod canonical;
pub mod cost;
pub mod identity;
pub mod machine;

pub use canonical::{Json, ParseError, canonical_json};
pub use cost::cost_estimate_json;
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
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .filter_map(|line| line.split('=').next())
            .map(str::trim)
            .collect();
        assert_eq!(names, ["serde", "serde_json", "sha2"]);
        for source in [
            include_str!("lib.rs"),
            include_str!("canonical.rs"),
            include_str!("cost.rs"),
            include_str!("identity.rs"),
            include_str!("machine/mod.rs"),
            include_str!("machine/compiler.rs"),
            include_str!("machine/io.rs"),
            include_str!("machine/state.rs"),
            include_str!("machine/step.rs"),
            include_str!("machine/step/checks.rs"),
            include_str!("machine/step/atomic.rs"),
            include_str!("machine/time.rs"),
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
