# mend

One command-line tool that applies the edits AI models write — unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls — to a tree of text files, exactly as `SPEC.md` in this repository specifies. Node 22, standard library only, run as `node main.ts [options] [PATCH]`.

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jinglue25/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jinglue25/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`runner.ts` beside it serves make.fun trials (when `MAKEFUN_ENV_URL` is set); `check.ts` runs the public practice set locally.
