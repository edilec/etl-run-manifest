# etl-run-manifest documentation

The README is the reference: it carries the schemas, the rule table, the exit
codes, the limits and the non-goals. These notes record the decisions behind
them.

## Why a manifest entry is never omitted

A manifest with a gap where an input should be reads as *this run had no such
input*. That is a different claim from *this run could not read that input*, and
it is a false one. So a file that could not be hashed is recorded with
`"digest": null` and an `"unresolved"` reason, the run exits `2`, and every
later command treats the entry as evidence-free rather than as absent.

## Why `compare` checks absence before equality

`null === null` is true in JavaScript. If the comparison asked "are the digests
equal?" first, two entries that neither run could read would compare equal, and
two runs could be reported as reproductions of each other on the strength of a
file neither of them ever hashed. Absence is therefore checked first, the pair
is reported, and the whole comparison becomes `incomplete`.

The same reasoning governs the positive verdicts. `runs-reproduced` and
`output-nondeterministic` are both positive claims about the world, and neither
is emitted unless every field it rests on is known on both sides.

## Why credentials are structural rather than filtered

Filtering credentials out of a recorded value means the tool held the value at
some point, and every filter has a gap. Instead the schema has no field that can
hold one: `secretRefs` carries a name and a source kind, the tool never resolves
the reference, and any key the schema does not name causes the document to be
refused. There is nothing to filter because there is nothing to hold.

## Why there is no clock

A timestamp minted while recording would make two recordings of one run differ,
and the manifest exists to make identical runs identical. `recordedAt` is
therefore whatever the run description declares — an opaque label, copied
verbatim, never parsed. The tool reads no clock anywhere, which also means it
cannot and does not judge freshness.

## Why `--out` is not confined

A confinement root for the output would mean writing the manifest inside the
data tree it describes, where the next run would find it. `--out` is an ordinary
path: the destination is checked for a symbolic link and for sharing an inode
with anything the run resolved, and a symbolically linked parent directory is
followed exactly as `cp` follows one. Documenting a confinement the code does
not perform would read as coverage, which is worse than saying nothing.
