# omp-project-rule-cache

A project-scoped cache and lookup tool for requirement documents in [omp](https://omp.sh).

Install it once at the user level. Each project points it at its own documents through a small JSON file. Advisors and agents then fetch a single rule section instead of reading whole requirement files.

## Why this exists

omp advisors run in their own long-lived session. That session survives across turns, but it resets whenever the main transcript is cleared, compacted, forked, or started fresh. Headless runs (`omp -p`) start a new session every time by design.

After every reset, an advisor that checks code against requirement documents has to read those documents again. If your requirements live in a handful of 1000-line markdown files, that's a large, repeated cost, and prompt caching at the provider doesn't help on a cold session.

This plugin doesn't try to restore the provider's prompt cache; that isn't something a plugin can do. What it does is cut the amount of text that has to be re-read. It parses your requirement documents once, splits them into individual rule sections keyed by rule ID, and stores that index on disk under the project. A lookup then returns one section instead of one or more entire files.

## What it gives you

- **`project_rule_lookup` tool**: takes a rule ID, returns that rule's text plus its `file:line-range`. For the main agent and subagents.
- **`.omp/cache/rules-digest.md`**: the same index as a flat markdown file, one `## <RULE-ID>` section per rule. For advisors, which can't call plugin tools (see below).
- **`/rule-cache-rebuild` command**: forces a rebuild of both artifacts for the current project.
- **Automatic build at session start**, so the digest exists before the first advisor turn.

### Why there are two output formats

omp builds an advisor's tool pool from built-in tool factories only. Tool names outside `BUILTIN_TOOL_NAMES` are dropped with a warning, so listing `project_rule_lookup` in an advisor's `tools:` silently does nothing. The advisor just gets `read`, `grep`, and `glob`.

Advisors can read files, though. So the index is also written as `.omp/cache/rules-digest.md`, and advisors grep that instead of calling a tool. Same index, two ways to consume it:

| Consumer | Use |
|---|---|
| Main agent, subagents | `project_rule_lookup` tool |
| Advisors | `grep` / `read` on `.omp/cache/rules-digest.md` |

In the digest, every rule is flattened to a single `## <RULE-ID>` heading regardless of its depth in the source, so there's one predictable shape to grep for. Each section carries a `source: <file>:<start>-<end>` line pointing back at the original document. That's what should be cited, not the digest path.

## Advantages

- **Survives session resets.** The index lives on disk in the project, not in any session. `/clear`, `/compact`, `/new`, restarts, and separate headless invocations all reuse it.
- **Install once, use everywhere.** The plugin code is generic and has no project paths baked in. Install it at the user scope and every project can use it.
- **Per-project configuration.** Each project declares its own document paths in `.omp/project-rule-cache.json`. Nothing about the plugin needs to change between projects.
- **Automatic invalidation.** Source files are hashed with SHA-256. Edit a requirement document and the next lookup rebuilds the index by itself. No stale rules.
- **Smaller reads.** A lookup returns one rule section, not a whole file. Less to read means less context spent and faster turns, especially for advisors that fire often.
- **Cited answers.** Every result carries `file:line-range`, so advisors can quote the source location instead of guessing.
- **Works for advisors too.** The digest file routes around omp's restriction that advisors can only use built-in tools.
- **No manual bootstrap.** The index is built at session start, so it's there before the first advisor turn without anyone running a command.
- **Configurable parsing.** The default heading pattern covers IDs like `X.10.00.2` and `BE-75`. Projects with a different convention can override the regex.

## Requirements

- omp installed and working (`omp --version`)
- Requirement documents in markdown, with rule IDs in headings (`##` or `###`)

## Quickstart

Three commands and one file.

```bash
# 1. Install the plugin (user scope)
omp plugin install github:vocweb/omp-project-rule-cache

# 2. In your project, tell the plugin where your documents live
mkdir -p .omp
cat > .omp/project-rule-cache.json << 'EOF'
{
  "sources": ["docs/project/"]
}
EOF

# 3. Verify
omp plugin list
```

Then start an omp session in that project. The index builds automatically at session start. Verify:

```bash
ls .omp/cache/
head -20 .omp/cache/rules-digest.md
```

You should see `rule-index.json` and `rules-digest.md`. If they're not there, run `/rule-cache-rebuild` inside the session: it reports how many rules were indexed. A count of 0 means the heading pattern didn't match; see Troubleshooting.

## Installation

### Option A: install from GitHub

No npm publish needed. The package lives at the repo root, so omp can install straight from git:

```bash
omp plugin install github:vocweb/omp-project-rule-cache
```

### Option B: install through a marketplace

Useful if you want in-app discovery, or if you're sharing the plugin with a team.

```bash
# Add the marketplace
omp plugin marketplace add vocweb/omp-project-rule-cache

# Install from it
omp plugin install project-rule-cache@project-rule-cache-omp-plugins
```

From inside a running session, the equivalent is:

```
/marketplace add vocweb/omp-project-rule-cache
/marketplace install project-rule-cache@project-rule-cache-omp-plugins
```

### Option C: local development

Symlinks the plugin so your edits take effect without reinstalling:

```bash
git clone https://github.com/vocweb/omp-project-rule-cache
omp plugin link ./omp-project-rule-cache
```

Use `omp plugin install ./omp-project-rule-cache` instead if you want a copy rather than a symlink.

### Verify the install

```bash
omp plugin list      # should show project-rule-cache
omp plugin doctor    # checks plugin dir, manifest, node_modules
```

If you already had a session open, reload it:

```
/reload-plugins
/extensions
```

`/extensions` lists what was loaded and from where. If `project-rule-cache` isn't there, see Troubleshooting.

## Per-project setup

Create `.omp/project-rule-cache.json` in the project root — either by hand as shown below, or by running `/rule-cache-configure` inside a session, which prompts for one path per line (relative to the project root) and writes the file for you.

Minimal: point at a directory, and every `.md` file in it gets indexed.

```json
{
  "sources": ["docs/project/"]
}
```

Explicit: list individual files.

```json
{
  "sources": [
    "docs/project/X_10_00-backend-requirements.md",
    "docs/project/X_39_00_nuxtjs_develop_requirement.md"
  ]
}
```

Custom heading pattern, if your rule IDs don't match the default:

```json
{
  "sources": ["docs/requirements/"],
  "headingPattern": "^#{1,3}\\s+(RFC-\\d+|SPEC-[A-Z]+-\\d+)\\b"
}
```

### Configuration fields

| Field | Type | Required | Description |
|---|---|---|---|
| `sources` | `string[]` | yes | Paths relative to the project root. A file is indexed directly; a directory has all its `.md` files indexed (non-recursive). |
| `headingPattern` | `string` | no | Regex with one capture group for the rule ID. Matched against each line. Defaults to `^#{1,3}\s+([A-Za-z]+[\w.\-]*)\b`. |

Add the cache directory to `.gitignore`, since it's regenerated on demand:

```
.omp/cache/
```

Commit `.omp/project-rule-cache.json` so the rest of the team gets the same setup.

## Usage

What you write depends on who's consuming the index.

**For advisors**: leave `tools:` as the read-only default and point the instructions at the digest file. Don't list `project_rule_lookup`; it'll just be dropped.

**For the main agent and subagents**: add `project_rule_lookup` to `tools:` and tell them to prefer it over `grep`. Without that line, models reach for `grep` out of habit and the index never gets used.

> **Everything below is an example, not a drop-in configuration.**
> The rule IDs, file paths, advisor names, models, and severity choices are from one specific project. They won't match yours. Read them for the shape of the integration, then rewrite the specifics (which documents you have, which rules matter, and what your team treats as a blocker) to fit your own project.

### Example: advisor scoped to specific rules

An advisor that only watches a fixed set of rules and stays silent otherwise.

```yaml
advisors:
  - name: BackendRuleCheck
    enabled: true
    model: anthropic/claude-sonnet-4-5:medium
    tools: [read, grep, glob]
    instructions: |
      Watch only these rules: X.10.00.2 (layering), X.10.00.3 (API contract),
      BE-75 (one endpoint, one kind of data). Ignore everything else in the
      requirement docs.

      To get a rule's exact wording, grep .omp/cache/rules-digest.md for the rule
      ID — headings there are "## <RULE-ID>" — and read only that section. Do not
      read the whole digest. Fall back to the original documents under
      docs/project/ only if the rule is missing from the digest. Never quote a
      rule from memory; wording changes.

      Cite the section's "source:" line (original file and line numbers), not the
      digest path.

      On a violation: report a blocker with file:line, the rule ID, and the
      specific fix. If the change does not touch these rules, stay silent.
```

The instructions carry the rule IDs; the plugin only resolves them. When the rules you care about change, just edit the instructions, no plugin change needed.

### Example: advisor that answers questions from the docs

An advisor that resolves ambiguity for an implementing agent rather than reviewing its output.

```yaml
advisors:
  - name: RequirementResolver
    enabled: true
    model: anthropic/claude-sonnet-4-5:medium
    tools: [read, grep, glob]
    instructions: |
      When the implementing agent flags something as unclear, look for an answer
      in the requirement documents.

      Search .omp/cache/rules-digest.md first: grep for the rule ID if one was
      named, otherwise grep for the relevant keywords, then read the matching
      sections. Go to the original documents under docs/project/ only if the
      digest does not cover it.

      Answer with the rule text and the file:line from the section's "source:"
      line. If the documents do not cover the question, say so plainly instead of
      inferring an answer.
```

### Example: subagent

Subagents run on the primary tool registry, so they can call the tool directly. This one implements against an already-approved plan:

```markdown
---
name: dev
description: Implements tasks that already have an approved plan.
model: "@dev"
tools: [read, edit, bash, grep, glob, project_rule_lookup]
---

Before writing code that touches a documented area, check the relevant rule with
project_rule_lookup. Cite the rule ID and file:line in your summary so the change
can be traced back to a requirement.

If a rule ID appears in the plan or in a review comment, look it up rather than
assuming what it says.
```

### Notes that apply to any integration

- **Advisors can't call the tool.** Listing `project_rule_lookup` in an advisor's `tools:` is silently dropped, since omp filters advisor tools against its built-in list. Use the digest file for advisors instead.
- **Give the tool an ID, not a question.** It matches rule IDs exactly. `project_rule_lookup("BE-75")` works; `project_rule_lookup("endpoint rules")` doesn't. For open-ended searching, `grep` first, then look up the IDs that come back.
- **Keep `grep` and `read` available.** Neither the tool nor the digest covers headings that failed to parse. Removing the fallbacks leaves the reviewer stuck when something isn't in the index.
- **Cite the source, not the digest.** `.omp/cache/rules-digest.md` is generated and gitignored. A finding that cites it can't be traced by anyone else.
- **Match severity to your project.** Whether a layering violation is a blocker or a note is your team's call, not the plugin's.
- **Rule IDs live in instructions, not in the plugin.** Nothing in the plugin knows what `BE-75` means. Changing which rules an advisor enforces is an instructions edit.

### Rebuilding manually

```
/rule-cache-rebuild
```

You rarely need this. The index builds at session start and rebuilds by itself when a source file's hash changes. Run it when you add a new file to `sources`, change `headingPattern`, or suspect the cache is wrong.

## How it works

1. At session start, the plugin reads `.omp/project-rule-cache.json`. If the project has no config, it does nothing.
2. It resolves `sources` into a file list and hashes each file with SHA-256.
3. It scans each file line by line for headings matching `headingPattern`. Everything from one matching heading to the next becomes one rule entry, recorded with its file path and line range.
4. Two files are written together, so they can never describe different revisions of the documents:
   - `.omp/cache/rule-index.json`: the index plus the source hashes.
   - `.omp/cache/rules-digest.md`: the same rules as flat markdown, one `## <RULE-ID>` section each.
5. On later runs (the next session start, or any `project_rule_lookup` call), it re-hashes the source files. If every hash matches and the digest is still present, it serves the cached index. Otherwise it rebuilds.

Because step 4 writes to disk, the index outlives the session that created it. That's what makes it useful after `/clear`, `/compact`, or a fresh headless run.

The session-start build exists because advisors can't trigger one themselves: they can't call plugin tools and can't run slash commands. Without it, a project whose only consumer is an advisor would never get a digest.

## Commands and tools reference

| Name | Type | Description |
|---|---|---|
| `project_rule_lookup` | tool | `project_rule_lookup(ruleId: string)`: returns the rule's text and `file:line-range`, or a not-found message. Available to the main agent and subagents, not advisors. |
| `/rule-cache-rebuild` | command | Rebuilds the index and the digest for the current project, and reports the rule count. |
| `/rule-cache-configure` | command | Interactively view or change the `sources` in `.omp/project-rule-cache.json`, without hand-editing JSON. Shows the currently configured paths (not the raw file) pre-filled in a multi-line editor — one path per line, relative to the project root. Enter inserts a new line; press Ctrl+Enter (or Ctrl+Q, for terminals that can't send Ctrl+Enter) to save, Esc to cancel. Warns about any entered path that doesn't exist, but still saves and rebuilds the index. |

Generated files:

| Path | Purpose |
|---|---|
| `.omp/cache/rule-index.json` | Index plus source hashes, backing the tool |
| `.omp/cache/rules-digest.md` | Flat markdown of the same rules, for advisors to grep |

Related omp commands:

| Command | Description |
|---|---|
| `omp plugin list` | Show installed plugins |
| `omp plugin doctor` | Diagnose plugin infrastructure problems |
| `omp plugin link <path>` | Symlink a local plugin for development |
| `omp plugin update` | Update installed plugins |
| `/reload-plugins` | Reload plugins in a running session |
| `/extensions` | Show which extensions loaded and from where |

## Troubleshooting

**`omp plugin doctor` reports `package_manifest: Not created yet`**

This is about `~/.omp/plugins/package.json`, omp's own bookkeeping file, not your plugin's manifest. It hasn't been created because no plugin has been installed through the official path yet. Run `omp plugin link` or `omp plugin install` once and it gets created. If it still doesn't appear:

```bash
mkdir -p ~/.omp/plugins/node_modules
printf '{\n  "name": "omp-plugins",\n  "private": true,\n  "dependencies": {}\n}\n' > ~/.omp/plugins/package.json
```

**Plugin installs, doctor is clean, but the tool never shows up**

Check that `package.json` declares the entry under an `extensions` array. omp has separate resolvers for `omp.extensions` / `pi.extensions` and for `omp.hooks` / `pi.hooks`, and only the `extensions` one is wired into the runtime. A string instead of an array, or the `hooks` key, will install fine and do nothing.

On Windows native there's a known omp issue where plugins install and report OK but their tools never register, because `@oh-my-pi/pi-*` can't be resolved from the compiled Bun runtime. That one isn't a configuration problem on your end.

**An advisor ignores `project_rule_lookup`: the tool isn't in its edit list**

Expected. omp builds advisor tools from its built-in factories and drops anything outside `BUILTIN_TOOL_NAMES`, so a plugin tool can never be granted to an advisor. Point the advisor at `.omp/cache/rules-digest.md` with `grep` and `read` instead; see Usage.

**`.omp/cache/` is empty after starting a session**

The session-start build didn't run. First check that `.omp/project-rule-cache.json` exists in the directory you launched omp from. If it does, the hook name may differ in your omp version, since the plugin registers `session_start` defensively, so a name mismatch fails silently rather than erroring.

Workaround: run `/rule-cache-rebuild` once per project. It only has to be repeated when the config changes, since later runs reuse the files on disk.

**Extension error: `The "paths[0]" property must be of type string, got undefined`**

An older build of this plugin assumed the session-start payload always carries `cwd`. It doesn't on every omp version. Update to the current version, which falls back to `process.cwd()`.

**Lookup returns "Project not configured"**

`.omp/project-rule-cache.json` is missing or isn't valid JSON. It must sit in the project root you launched omp from.

**Lookup returns "not found" for a rule you can see in the file**

The heading doesn't match `headingPattern`. Check the heading level (only `#` through `###` are scanned by the default pattern) and the ID format. Set a custom `headingPattern` if your convention differs, then run `/rule-cache-rebuild`.

**Results are stale after editing a document**

Hashing should catch this. If it doesn't, run `/rule-cache-rebuild`, or delete `.omp/cache/` and start a new session.

## Notes and limits

- This caches document *content*, not reasoning. An advisor still has to think through the same problem from scratch on a new session; it just gets the source material more cheaply.
- It doesn't restore the provider's prompt cache. Nothing a plugin can do will; a cold session is still cold. What shrinks is how much text has to be re-read.
- Directory sources aren't scanned recursively. List subdirectories explicitly if you need them.
- Both generated files are plain text on disk. Read them if you want to see what got parsed.
- The digest flattens every rule to `##` regardless of its heading level in the source. Nesting isn't preserved, since it exists to be grepped, not read end to end.
- Rule IDs must be unique across all indexed files. A duplicate ID in a second file overwrites the first.

## License

MIT
