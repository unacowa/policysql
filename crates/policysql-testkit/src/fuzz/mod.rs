//! Generators for property-based testing of the compiler's noninterference and gating claims
//! (issue #125).
//!
//! The generators know nothing about a schema: resources, columns and literals arrive through an
//! [`alphabet::Alphabet`]. Statements are values of [`ast`] types, rendered by [`render`], and
//! described by [`meta`]. Three layers choose structures differently and share everything else:
//!
//! - [`layer1`]: bounded exhaustive enumeration over a reduced alphabet,
//! - [`layer2`]: pairwise / three-way coverage of a factor-level table,
//! - [`layer3`]: naive random generation over the full alphabet (nightly).
//!
//! Everything is deterministic. A statement is reproduced from the numbers that identify it
//! (layer, seed, round, index); [`rng`] holds the generator.
//!
//! The pipeline, the policy cases and the oracles live in `tests/noninterference/`.

pub mod alphabet;
pub mod ast;
pub mod meta;
pub mod render;
pub mod rng;

pub use alphabet::{
    Alphabet, ColumnClass, ColumnIdx, ColumnSpec, Lit, ResourceIdx, ResourceSpec, ValueType,
};
pub use meta::{StatementMeta, meta};
pub use render::{client_parameters, to_sql};
pub use rng::{XorShift64, mix, splitmix64};
