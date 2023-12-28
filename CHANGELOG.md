# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Renaming a `ruleId` is a breaking change and is recorded here.

## [0.1.0]

### Added

- `record`, `verify` and `compare` commands over one manifest schema
  (`edilec.etl-manifest/v1`) built from one run description schema
  (`edilec.etl-run/v1`).
- SHA-256 digests for every declared input, output and code file, with the real
  path resolved and asserted inside the real `--root`.
- An integrity digest over the whole manifest, checked by `verify` and required
  intact before `compare` will issue a positive verdict.
- Credentials declared by reference only: `secretRefs` records a name and a
  source kind and the value is never resolved, because the schema has no field
  for one and the tool reads no environment and no secret store.
- Unresolved evidence recorded explicitly rather than omitted, and never treated
  as a match on either side of a comparison.
- A destination guard on `--out` covering a symbolic link at the destination and
  a hard link to any file the run resolved. The destination is deliberately not
  confined to `--root`, and the help text and README say so.
- Declared bounds on document bytes, file bytes, inputs, outputs, code files,
  parameters, secret references, parent run ids, findings, identifier length,
  path length and value length, enforced before the work.
