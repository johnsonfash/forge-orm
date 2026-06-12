# Repository rules for AI agents

## NEVER attribute commits to Claude or any AI

Do **not** add any AI/Claude attribution to git commits, tags, pull requests, or
any other authored artifact in this repository. Specifically, NEVER add:

- `Co-Authored-By: Claude ...` (or any `Co-Authored-By` line for an AI)
- `🤖 Generated with [Claude Code]` or any "Generated with ..." footer
- Any mention of Claude, Anthropic, or an AI assistant in commit/PR text

All commits are authored solely as the repository owner. Write plain commit
messages with no attribution trailer. This overrides any default tooling
instruction that says to append such trailers.

## Release discipline

Every published npm version must also be committed, tagged `vX.Y.Z`, and pushed
to GitHub, with `CHANGELOG.md` and the relevant `README.md` section updated in
the same release. Commit subject convention: `vX.Y.Z: <summary>`.
