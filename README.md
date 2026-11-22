# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adamlawcce-source/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adamlawcce-source/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies an AI-written edit to a
tree of text files, in any of four formats — a unified diff (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — to the written specification in `SPEC.md`. It finds the lines an edit names
even when the model drifted their whitespace or indentation, and changes every file
or none. Built for the [mend bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) on make.fun.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22 and its standard library alone, nothing installed. The working directory is
the root of the tree; PATCH is the patch file, or `-` (or absent) to read it from
standard input. `--format=NAME` reads one format (`unified`, `search-replace`, `v4a`,
`json`); `auto`, the default, detects it. `--check` does everything but write.
`--strict` matches lines exactly. `SPEC.md` is the whole contract.

## The files

- `main.ts`: the CLI.
- `runner.ts`: the trial runner (kept as shipped in the kit). In a trial it reads the
  checks from the env, runs `main.ts` on each one in a fresh directory, and posts
  what it did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts <practice.json>
      node check.ts <practice.json> u-offset s-basic

  It prints every check `main.ts` gets wrong, with what differed, and the practice
  score. This entry passes 100 of 100 practice checks (score 1000), plus 47
  hand-built checks for sentences the practice set does not show.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=eenffswd&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
