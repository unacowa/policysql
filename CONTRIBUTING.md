# Contributing

PolicySQL is security-sensitive compiler infrastructure. Small, reviewable changes are preferred.

## Before contributing

- Open an issue describing the SQL feature or policy behavior.
- Include examples of allowed and rejected statements.
- Describe how row, column, mutation, and validation policies interact with the feature.

## Required tests

Every accepted SQL feature should include:

- a valid transformation fixture;
- an invalid syntax or unsupported-feature fixture;
- a policy bypass attempt;
- a forbidden-column attempt;
- a nested/subquery variant when applicable;
- a differential execution test against a reference SQLite database when execution semantics matter.

## Security issues

Do not open public issues for suspected policy bypasses. Follow `SECURITY.md`.
