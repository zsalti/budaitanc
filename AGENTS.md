# Temporary AI work and commit hygiene

- Put disposable drafts, experiments, generated intermediates, and throwaway code in `scratch/<task-name>/`. Use `/tmp/klear-codex/<task-name>/` only for truly transient local work that needs no review or handoff.
- Never put intended deliverables, source evidence, configuration, migrations, or reusable code in `scratch/`; move those to their canonical path before staging.
- Before every commit, review `git status --short` and `git diff --cached --name-only`; stage explicit intended paths only. Do not use `git add .` or `git add -A` in a dirty repository.
- Do not run `git clean`, broad deletion, reset, or stash against untracked or uncommitted work. Cleanup may remove only the explicitly named task directory under `scratch/`.
