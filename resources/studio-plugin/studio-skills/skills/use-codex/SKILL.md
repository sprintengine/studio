---
name: use-codex
description: Delegate suitable work from this session to the local OpenAI Codex CLI — non-UI implementation from a written brief, second-opinion code reviews, image generation, and mechanical chores — while Claude keeps design, all front-end UI/UX work, final review, and commits. Use when the user asks to delegate work to Codex or GPT, wants a second opinion from another model, asks to generate an image, or wants to conserve Claude tokens on low-stakes work.
---

# Use Codex

You can delegate parts of your work to the **Codex CLI** (`codex`), OpenAI's
coding agent, running it as a subprocess through your shell tool. You stay the
lead: you write the brief, you review the result, you own the final verdict and
every git commit. Codex is a capable executor whose usage bills the user's
OpenAI/ChatGPT plan instead of their Claude tokens.

## Preflight — run once before the first delegation

1. `command -v codex` — if missing, tell the user Codex CLI is not installed
   (they can install it with `npm install -g @openai/codex` or
   `brew install codex`), then continue the task yourself without delegation.
   Never install it unprompted.
2. `codex login status` — exits 0 when authenticated. If not authenticated,
   tell the user to run `codex login`, and continue without delegation until
   they have. Never read, write, or inject `~/.codex/auth.json` or any
   credential yourself.

If both checks pass, delegation is available for the rest of the session.

## What to delegate — and what never to

Delegate to Codex:

- Mechanical, non-UI implementation from a self-contained written brief.
- Boilerplate, scaffolding, and test authoring against a spec you wrote.
- Bulk mechanical sweeps (renames, call-site updates, format migrations).
- Docs, changelog, and comment chores.
- Second-opinion reviews of non-UI diffs.
- All image generation (icons, banners, placeholder art) via `$imagegen`.

Never delegate — this work stays with you:

- **All front-end UI/UX work: designing, implementing, or reviewing.**
  Components, styling, layout, interaction, accessibility, and UI copy are
  yours. If a brief unavoidably touches UI files, carve that portion out and
  do it yourself. (Generating an image *asset* with `$imagegen` is the one
  exception — you specify it and you vet it.)
- Architecture and design decisions.
- Anything security-sensitive (auth, credentials, sandboxing, permissions).
- Ambiguous judgment calls, and the final done/not-done verdict.
- Git commits. Codex writes files; you review, stage, and commit.

## How to run Codex

The non-interactive entrypoint is `codex exec`. Core template for work that
produces files:

```bash
codex exec -C <workspace-root> -s workspace-write \
  -o <scratchpad>/codex-result.md \
  "<self-contained brief>"
```

- `codex exec` is already non-interactive — it never stops for approval, so
  there is no approval flag to pass (docs mentioning `-a` refer to the
  interactive `codex` TUI, not `exec`).
- `-s workspace-write` only when Codex must write files; omit it for reviews
  and analysis (the default sandbox is read-only).
- `-o <file>` captures the final message; read that file for the result.
- A non-zero exit code means the run failed — report that plainly, never
  paper over it.
- Iterate with `codex exec resume --last "<specific feedback>"` instead of
  restarting from scratch.
- Do not pass a model flag; the user's configured Codex default is correct.
  Only reach for `-m` if the user explicitly names a model.
- **Never** use `--yolo`, `--dangerously-bypass-approvals-and-sandbox`, or
  `-s danger-full-access`.
- For long briefs, run the command in the background and keep working;
  collect the output file when it finishes.

## Playbook: delegated implementation

1. Write a self-contained brief: goal, exact files/areas, constraints and
   conventions to follow, and acceptance criteria. Codex sees none of your
   conversation — the brief must stand alone.
2. Delegate only from a clean slice: no uncommitted edits of your own in the
   files the brief touches.
3. Run the core template above.
4. Verify like a reviewer: read the result file, `git diff` the tree, run the
   project's tests and typecheck. Fix-or-feedback: small issues you fix
   yourself; larger misses go back via `codex exec resume --last`.
5. Only report the work done after your own verification passes.

## Playbook: second-opinion review

Codex has a purpose-built review mode — prefer it when reviewing the working
tree or a branch:

```bash
codex exec review --uncommitted -o <scratchpad>/codex-review.md "<focus, e.g. correctness of the X change; skip UI files>"
codex exec review --base <branch> -o <scratchpad>/codex-review.md "<focus>"
```

For an arbitrary diff range, pipe it in; the read-only default sandbox is
exactly right:

```bash
git diff <range> -- . ':!<ui-paths>' | codex exec \
  -o <scratchpad>/codex-review.md \
  "Review this diff for <focus>. Report concrete findings as file:line — issue — why it matters. Say 'no findings' if clean."
```

Exclude UI paths from the piped range; if the diff is UI-dominant, skip
delegation — you review UI yourself. Present the output as Codex's opinion,
reconciled with your own read: state where you agree, where you disagree, and
why. Never launder Codex findings as your own review.

## Playbook: image generation

Codex has a built-in `$imagegen` skill (gpt-image-2):

```bash
mkdir -p <asset-dir>
codex exec -C <workspace-root> -s workspace-write --skip-git-repo-check \
  "Use \$imagegen to generate: <precise visual description>. Save it as <relative-path>.png"
```

Afterwards verify the file exists and view it with your file-reading tool
before reporting done — you vet the asset against what was asked. Image turns
consume the user's Codex quota noticeably faster than text turns; mention that
when generating batches.

## Ground rules

- Report Codex output truthfully — failures, partial work, and disagreements
  included.
- If Codex reports a usage-limit error ("You've hit your usage limit"), the
  user's Codex quota is exhausted: tell them, including any reset time in the
  message, and continue the task yourself without delegation.
- The user's quota: delegation spends their OpenAI/ChatGPT allowance. Flag it
  before kicking off large batches.
- If Codex proposes something that conflicts with this project's conventions
  or your design, your judgment wins.
