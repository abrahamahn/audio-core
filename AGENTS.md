# Repository Agent Contract

This repository is maintained for a solo-developer, AI-assisted workflow. Every task must leave the repository easier to understand and operate than it found it.

## Git/worktree lifecycle

- `main` is the only persistent working branch; keep one normal `main` checkout/worktree.
- Temporary branches/worktrees/folders are allowed only when real isolation is useful for the current task, not by default.
- The agent that creates temporary state owns its full lifecycle. Before DONE: integrate the finished task into `main`, run the repository's established completion/pre-push gate, push `main`, remove temporary worktrees/folders, delete temporary local branches, delete temporary remote branches if pushed, prune stale worktree metadata, and verify a clean tree.
- Never leave branch/worktree/temp-folder cleanup debt for another agent.

## Scope discipline

- One task = one repository + one semantic capability/domain + one primary objective.
- Be comprehensive inside that narrow scope. Do not partially advance several domains at once.
- Dependencies may be inspected; unrelated domains are read-only unless a minimal coordinated change is necessary.
- No drive-by refactors, speculative follow-ups, or "while here" cleanup.
- Finish implementation/specification, focused validation, canonical docs/evidence update, integration, and cleanup before starting another domain.

## Artifact discipline

Use **edit existing owner > consolidate duplicates > delete superseded material > create a new artifact**.

- New governance objects have a default budget of zero. Do not create new handoffs, plans, TODO files, progress logs, checklists, matrices, registries, review memos, architecture summaries, or templates unless explicitly requested or no existing canonical owner can represent the information.
- If a handoff is needed, prefer one root `HANDOFF.md` updated in place; do not create dated/domain/agent-specific handoffs.
- Track progress with a small number of comprehensive checkmark lists, not scattered status prose.
- Git history is the archive. Current docs should continuously replace/delete stale or conflicting material after valid information is consolidated.
- Documentation/governance cleanup should normally keep artifact count flat or reduce it.

## Validation cadence

- Use the repository's existing README/package/Cargo metadata as the source for build and test commands; do not invent a new command surface merely for the task.
- Run the narrowest affected checks during development.
- Run the established completion/pre-push gate once when the slice is ready, plus risk-specific checks required by the change.
- Do not repeatedly run expensive full validation after every small edit merely to produce evidence.

## Definition of done

DONE means the selected capability is complete, relevant validation passes, the result is integrated and pushed to `main`, all temporary state created by the task is removed, and repository cognitive overhead is less than or equal to where it started.
