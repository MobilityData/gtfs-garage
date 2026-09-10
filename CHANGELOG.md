# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- Installable package with a `gtfs-garage` console script.
- Test suite with branch coverage, flake8/black linting, and CI covering lint,
  tests, the frontend build and a clean-environment install of the wheel.
- Architecture and code-sharing documentation.

### Changed

- Python source moved to `src/gtfs_garage/`, split into a framework-free `core`
  and a thin `server` layer. SQL moved out of the request handlers.
- The frontend moved out of the Python package to `web/` and was rewritten as
  TypeScript modules; its build output is committed to `src/gtfs_garage/web/`.
- `related` is now always present on a column, as an empty list when the column
  is not a table's primary id. It was previously omitted entirely.

### Fixed

- The packaged schema document is read through `importlib.resources`, so it
  resolves from an installed wheel instead of only from a source checkout.
