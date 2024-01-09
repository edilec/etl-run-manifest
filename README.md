# etl-run-manifest

Record what one ETL run consumed, ran and produced; verify later that the record
still holds; compare two runs that were meant to be the same run twice.

- **Repository:** [edilec/etl-run-manifest](https://github.com/edilec/etl-run-manifest)
- **Area:** Data & Analytics
- **License:** MIT

## Why it exists

"Where did this table come from?" is usually answered from memory, and memory is
not evidence. A run manifest turns the answer into something checkable: the
digest of every input the run read, the identity and digest of the code it ran,
the parameters and seed it was given, the digest of everything it produced, and
the runs it descends from.

That record is only worth having if it can be falsified. So `verify` re-hashes
what the manifest recorded and says plainly when a file has changed since, and
`compare` takes two manifests and says whether the second run really did
reproduce the first — or refuses to say, when the evidence does not support
either answer.

The tool opens no socket, resolves no host, reads no environment variable and
reads no clock. Every input is a document somebody exported and a file somebody
produced.

## Quick start

```sh
# Record a manifest for the example run.
node bin/etl-run-manifest.mjs record \
  --root examples/nightly \
  --run examples/nightly/run.json \
  --out /tmp/nightly-manifest.json

# Verify the manifest committed beside that example.
node bin/etl-run-manifest.mjs verify \
  --root examples/nightly \
  --manifest examples/nightly/manifest.json          # exit 0

# The same tree after somebody edited one raw export.
node bin/etl-run-manifest.mjs verify \
  --root examples/changed-input \
  --manifest examples/changed-input/manifest.json    # exit 1

# Two runs of one deterministic transformation.
node bin/etl-run-manifest.mjs compare \
  --baseline examples/nightly/manifest.json \
  --candidate examples/repeat/manifest.json          # exit 0

# The same transformation, the same inputs, different output bytes.
node bin/etl-run-manifest.mjs compare \
  --baseline examples/nondeterministic/a/manifest.json \
  --candidate examples/nondeterministic/b/manifest.json   # exit 1

# A run one of whose inputs could not be read, compared with itself.
node bin/etl-run-manifest.mjs compare \
  --baseline examples/unresolved/manifest.json \
  --candidate examples/unresolved/manifest.json      # exit 2, not a match
```

stdout carries the JSON report and nothing else. stderr carries a human summary;
`--quiet` turns it off.

## The run description

```json
{
  "schema": "edilec.etl-run/v1",
  "runId": "orders-nightly-2026-09-18",
  "recordedAt": "2026-09-18T02:14:03Z",
  "parentRunIds": ["orders-extract-2026-09-18"],
  "transformation": {
    "id": "orders-normalise",
    "version": "3.2.0",
    "code": [{ "path": "sql/normalise.sql" }]
  },
  "seed": 20260918,
  "parameters": [{ "name": "batch_size", "value": 500 }],
  "secretRefs": [{ "name": "WAREHOUSE_READER", "source": "env" }],
  "inputs": [{ "id": "orders_raw", "path": "data/orders.csv" }],
  "outputs": [{ "id": "orders", "path": "out/orders.tsv" }]
}
```

Every key set is an allow-list: a key this schema does not name is refused, not
ignored. Paths are relative to `--root` and are resolved to their real location
before being read, so a symbolic link cannot walk out of the tree. `recordedAt`
is an opaque label copied verbatim — this tool reads no clock and never parses
it — and `seed` may be an integer, a string or null.

## Credentials

The run description has **no field for a credential value**, and that is the
whole mechanism. A credential is declared by reference:

```json
"secretRefs": [{ "name": "WAREHOUSE_READER", "source": "env" }]
```

`source` is one of `env`, `file`, `keychain`, `parameter-store`, `vault` or
`other`. The manifest records the name and the source kind, so the lineage says
*this run used that credential* — and there is nothing else to record, because
the tool never resolves the reference. It reads no environment variable, opens
no secret store and holds no credential value at any point.

Excluding a secret is therefore not something this tool does to a value it
holds; it never holds one. Two structural rules keep it that way:

1. **Every key set is an allow-list**, checked before anything is read. No object
   from the input document is spread, merged or copied wholesale into a
   manifest; each field is read by name. A `"password"` sitting beside a
   recorded parameter causes the document to be refused outright.
2. **A parameter value must be a string, number, boolean or null**, and a
   `secretRefs` entry carrying a `value` key is refused with its pointer. The
   refusal message names the pointer, never the value.

Credential *names* are not part of the determinism verdict. A manifest pins the
bytes of every input, so a run that read the same bytes with a differently named
credential read the same data. A difference there is recorded at `info`
severity, as lineage.

## Unknown is never a pass

Every place this tool could quietly turn missing evidence into a green result,
it does the opposite instead:

- A file that could not be read is **recorded with no digest and a reason** —
  `not-found`, `unreadable`, `too-large`, `not-a-file`, `outside-root` — and is
  never left out. A gap in a manifest reads as *this run had no such input*,
  which is a different and false claim. The manifest is still written, and the
  run still exits `2`.
- **Verifying an entry that has no digest is not a verification.** It is
  reported and it makes the whole run incomplete, whether or not the file is
  readable now.
- **Two absent digests are not a match.** `compare` checks for absence *before*
  it checks for equality, because `null === null` is true in JavaScript and
  false about the world. A pair it cannot compare makes the comparison
  incomplete; it does not make it clean.
- Both positive verdicts — `runs-reproduced` and `output-nondeterministic` — are
  withheld unless every field they rest on is known on both sides. Outputs that
  differ while an input digest is missing is evidence of nothing, and is never
  reported as nondeterminism.
- **An entry dropped while indexing is not a clean comparison.** `compare`
  indexes each manifest by dataset id, code path and parameter name, and an
  index keeps one entry per key. A manifest that records two entries under one
  of those keys is refused (`manifest-invalid`, exit `2`) rather than compared
  on whichever entry the index kept and reported as agreeing about both.
  `record` refuses the same repeats in the run description, so no manifest this
  tool writes can reach that refusal.
- A manifest that does not match its own integrity digest never yields a
  positive verdict either.
- A run description naming no input, no output and no code file is reported
  rather than passed: a manifest of nothing is not a green run.

## Rules

| ruleId | severity | raised when |
| --- | --- | --- |
| `code-digest-mismatch` | error | a recorded code file now hashes to something else |
| `digest-unresolved` | warning | the manifest recorded no digest for an entry, so there is nothing to verify against |
| `evidence-unresolved` | warning | a compared pair has no digest on one or both sides |
| `file-too-large` | warning | a file is larger than `maxFileBytes`, so it was not hashed |
| `file-unreadable` | warning | a declared file could not be resolved, opened or read |
| `finding-limit-reached` | warning | more findings were observed than `maxFindings` allows to be reported |
| `input-digest-mismatch` | error | a recorded input now hashes to something else |
| `inputs-differ` | error | the two runs do not declare the same inputs, or an input digest differs |
| `manifest-integrity-mismatch` | error | the manifest does not match the integrity digest it carries |
| `manifest-invalid` | error | the manifest does not match the manifest schema |
| `manifest-recorded` | info | a manifest was written; the message carries its integrity digest |
| `manifest-unreadable` | error | the manifest could not be read, decoded or parsed |
| `no-evidence-recorded` | error | there is no input, output or code file to record, verify or compare |
| `output-digest-mismatch` | error | a recorded output now hashes to something else |
| `output-nondeterministic` | error | every input, the transformation, the seed and every parameter match, and the outputs differ |
| `outputs-differ` | error | the two runs do not declare the same outputs, or an output digest differs |
| `parameters-differ` | error | the two runs were given different parameters |
| `path-outside-root` | error | a declared path resolves outside the real root |
| `run-description-invalid` | error | the run description does not match the run schema |
| `run-description-unreadable` | error | the run description could not be read, decoded or parsed |
| `runs-reproduced` | info | every compared field is known and equal on both sides |
| `secret-refs-differ` | info | the two runs name different credentials; no value is recorded by either |
| `seed-differs` | error | the two runs were given different seeds |
| `transformation-differs` | error | the two runs ran a different transformation, version or code |
| `verification-complete` | info | every recorded file hashes to its recorded digest and the manifest is intact |

Severity is taken from one frozen table in `src/rules.mjs` and an unknown rule
id throws. Renaming a rule id is a breaking change.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | the check completed and the policy is satisfied |
| `1` | the check completed and the policy failed |
| `2` | invalid usage or an unusable destination (**empty stdout**), or evidence that could not be obtained (a report with `status: "incomplete"`) |

Exit `2` has two shapes, and a consumer piping stdout must handle both. A
configuration error means the run never had a subject, so there is nothing to
report about; an input that could not be read means the run had a subject and
failed to obtain evidence about it, which is what `incomplete` exists to say.

`incomplete` outranks `fail`: a run that could not obtain its evidence has not
established that the policy failed either.

## Limits

Every bound is enforced *before* the work: a document's size comes from `stat`
before its bytes are read, a file's size comes from `stat` before it is opened,
and every count is checked against the parsed document before any file is
opened. Exceeding one is an `incomplete` result naming the limit, never a silent
truncation and never a pass.

| Limit | Default | Flag |
| --- | ---: | --- |
| `maxDocumentBytes` | 1048576 | `--max-document-bytes` |
| `maxFileBytes` | 67108864 | `--max-file-bytes` |
| `maxInputs` | 512 | `--max-inputs` |
| `maxOutputs` | 256 | `--max-outputs` |
| `maxCodeFiles` | 128 | `--max-code-files` |
| `maxParameters` | 256 | `--max-parameters` |
| `maxSecretRefs` | 64 | `--max-secret-refs` |
| `maxParentRuns` | 64 | `--max-parent-runs` |
| `maxFindings` | 500 | `--max-findings` |
| `maxIdentifierChars` | 200 | (not overridable) |
| `maxPathChars` | 1024 | (not overridable) |
| `maxValueChars` | 512 | (not overridable) |

## Determinism

Running the tool twice over identical inputs produces byte-identical stdout and
a byte-identical manifest. Object keys are ordered by UTF-16 code unit, and so
are findings — by `(location.file, location.pointer, ruleId, message)`. Recorded
inputs, outputs, code files, parameters, secret references and parent run ids
are sorted by their comparison key, so two run descriptions that declare the
same files in a different order record the same manifest and therefore the same
integrity digest. Declaration order is not evidence.

`localeCompare` and `Intl.Collator` are not used anywhere: they read ICU data
that differs between Node builds, which would let two correct machines disagree.

## Writing the manifest

`--out` is checked before anything is written:

- a **symbolic link** at the destination is refused on sight, before anything is
  opened;
- a **hard link to any file this run resolved** — including a file it stat-ed and
  then skipped, and the run description itself — is refused, because `dev` plus
  `ino` is the only thing that sees it;
- the destination directory must already exist; this tool never creates one.

A refused destination is a configuration error: exit `2` with empty stdout.

`--out` is **not confined to `--root`.** It is an ordinary path, and a
symbolically linked parent directory is followed, exactly as it is for `cp` and
shell redirection. This tool declares no confinement root for its output and
does not pretend to: documenting a confinement the code does not perform reads
as coverage and is worse than saying nothing.

## Non-goals

- **It does not run anything.** It records what somebody else ran. It executes no
  transformation, no query and no script.
- **It connects to nothing.** No warehouse, no database, no object store, no
  network of any kind. If your inputs live in a warehouse, export them first.
- **It does not judge freshness or staleness.** It reads no clock, so it cannot
  and does not say whether a run is recent.
- **It does not resolve credentials.** A `secretRef` is a name, and it stays one.
- **It does not explain *why* two runs diverged.** It says which recorded fields
  differ. Finding the unrecorded input is your job; the manifest narrows where
  to look.
- **It does not parse SQL or infer lineage.** The run description declares what
  the run read and wrote; nothing here guesses.
- **A digest proves sameness, not correctness.** Two runs reproducing each other
  says the transformation is deterministic over those inputs, not that its
  output is right.

## Development

```sh
npm run check      # lint, tests, a runnable example, and npm pack --dry-run
```

There are no runtime dependencies and no dev dependencies. Tests are `node:test`
with `node:assert/strict`.

## License

MIT. See [LICENSE](./LICENSE).
