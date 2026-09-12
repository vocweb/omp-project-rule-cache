import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";

// Config lives in the project, not in the plugin, so one user-scope install can
// serve every project the user works on. Each project declares its own document
// paths and nothing about the plugin has to change between them.
const PROJECT_CONFIG_FILE = ".omp/project-rule-cache.json";

// The index is written to disk rather than held in memory because the whole point
// is to survive session boundaries: /clear, /compact, /new, restarts, and separate
// headless `omp -p` invocations each start an advisor from scratch.
const CACHE_FILE = ".omp/cache/rule-index.json";

// Second output format, for advisors specifically. omp builds an advisor's tool pool
// from built-in factories only — names outside BUILTIN_TOOL_NAMES are dropped — so an
// advisor can never call this plugin's tool. It can, however, grep and read files, so
// the same index is emitted as flat markdown it can reach with built-ins.
const DIGEST_FILE = ".omp/cache/rules-digest.md";

// Permissive by default so projects work without configuring a pattern. It matches
// dotted IDs (X.10.00.2) and hyphenated ones (BE-75) alike; teams whose headings do
// not start with an identifier-shaped token override it in project config.
const DEFAULT_HEADING_PATTERN = "^#{1,3}\\s+([A-Za-z]+[\\w.\\-]*)\\b";

// This plugin is installed at user scope, so it loads in every project — including the
// many that have no requirement documents at all. Warning unconditionally about a
// missing config would be noise in all of them. These directories are the heuristic for
// "this project looks like it has requirement docs", checked before saying anything.
const CANDIDATE_DOC_DIRS = [
  "docs/project",
  "docs/requirements",
  "docs/specs",
  "docs",
];

// The hint is a one-time nudge, not a recurring warning. Choosing not to configure the
// plugin is a legitimate answer, and repeating the message every session would punish it.
const HINT_MARKER_FILE = ".omp/cache/.init-hint-shown";

interface ProjectConfig {
  sources: string[];
  headingPattern?: string;
}

// Line numbers are stored alongside the text so advisors can cite file:line in their
// findings. Without them a lookup answer cannot be traced back to the source document.
interface RuleEntry { file: string; lineStart: number; lineEnd: number; text: string; }

// Hashes are kept next to the rules so staleness can be judged from the cache file
// alone, with no separate metadata file to keep in sync.
interface CacheShape { fileHashes: Record<string, string>; rules: Record<string, RuleEntry>; }

function loadProjectConfig(cwd: string): ProjectConfig | null {
  const path = join(cwd, PROJECT_CONFIG_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Malformed JSON is treated as "not configured" rather than thrown. A broken
    // config should degrade the advisor to grep/read, not abort its turn.
    return null;
  }
}

// Distinguishes "no config file" from "config file present but unreadable". The two need
// different messages: one is a setup step the user has not done, the other is a typo in a
// file they already wrote, and telling them to create a file that exists would be wrong.
function configFileExists(cwd: string): boolean {
  return existsSync(join(cwd, PROJECT_CONFIG_FILE));
}

// Only directories that actually contain markdown count. An empty docs/ folder, or one
// holding nothing but images, is not evidence that this project has requirements to index.
function detectDocDirs(cwd: string): string[] {
  const found: string[] = [];
  for (const dir of CANDIDATE_DOC_DIRS) {
    const abs = join(cwd, dir);
    try {
      if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
      if (readdirSync(abs).some((f) => f.endsWith(".md"))) found.push(dir);
    } catch {
      // Unreadable directory (permissions, broken symlink) — not worth surfacing, it just
      // means this path cannot serve as evidence either way.
    }
  }
  // Only the most specific match is returned. CANDIDATE_DOC_DIRS is ordered narrowest
  // first, and suggesting both docs/project and its parent docs/ would index every rule
  // twice under one keyspace.
  return found.slice(0, 1);
}

function hintAlreadyShown(cwd: string): boolean {
  return existsSync(join(cwd, HINT_MARKER_FILE));
}

function markHintShown(cwd: string): void {
  try {
    const path = join(cwd, HINT_MARKER_FILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new Date().toISOString());
  } catch {
    // Failing to record the marker only means the hint may repeat next session. Not worth
    // interrupting startup over.
  }
}

// Writes the config rather than just describing it, because the alternative is the user
// hand-copying a JSON snippet from a warning message — a step that adds nothing but typos.
function scaffoldConfig(cwd: string, sources: string[]): string {
  const path = join(cwd, PROJECT_CONFIG_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ sources }, null, 2) + "\n");
  return path;
}

function resolveSourceFiles(cwd: string, sources: string[]): string[] {
  const out: string[] = [];
  for (const src of sources) {
    const abs = join(cwd, src);
    // Missing paths are skipped instead of failing: a shared config may list documents
    // that only exist on some branches or in some checkouts.
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      // Non-recursive on purpose. Requirement folders often sit next to generated or
      // vendored markdown, and pulling those in would bloat the index with noise.
      for (const f of readdirSync(abs)) if (f.endsWith(".md")) out.push(join(src, f));
    } else {
      out.push(src);
    }
  }
  return out;
}

// Content hashing rather than mtime: mtime changes on checkout, clone, and copy even
// when the text is identical, which would trigger pointless rebuilds.
function hashFile(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function parseRules(absPath: string, relPath: string, headingRe: RegExp): Record<string, RuleEntry> {
  const lines = readFileSync(absPath, "utf8").split("\n");
  const out: Record<string, RuleEntry> = {};
  let currentId: string | null = null;
  let start = 0;

  // A section runs until the next heading, so an entry can only be finalised once the
  // following heading (or EOF) is reached — hence the deferred flush.
  const flush = (endIdx: number) => {
    if (currentId) out[currentId] = { file: relPath, lineStart: start, lineEnd: endIdx - 1, text: lines.slice(start, endIdx).join("\n") };
  };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) { flush(i); currentId = m[1]; start = i; }
  }
  flush(lines.length);
  return out;
}

function buildCache(cwd: string, config: ProjectConfig): CacheShape {
  const headingRe = new RegExp(config.headingPattern || DEFAULT_HEADING_PATTERN);
  const cache: CacheShape = { fileHashes: {}, rules: {} };
  for (const rel of resolveSourceFiles(cwd, config.sources)) {
    const abs = join(cwd, rel);
    cache.fileHashes[rel] = hashFile(abs);
    // Rules from all files share one keyspace so a lookup needs only the ID, not the
    // file it happens to live in. The trade-off is that duplicate IDs across files
    // silently collide, which the README calls out.
    Object.assign(cache.rules, parseRules(abs, rel, headingRe));
  }
  return cache;
}

// Headings are flattened to a single "## <id>" level regardless of their depth in the
// source, so an advisor can grep for one predictable shape instead of guessing whether
// a rule was written as ## or ###. The source line is carried in the body because the
// advisor must cite the original document, never this generated file.
function renderDigest(cache: CacheShape): string {
  const lines: string[] = [
    "# Rule index (generated — do not edit)",
    "",
    "Each section below is one rule. Cite the `source:` path, not this file.",
    "",
  ];
  for (const [id, entry] of Object.entries(cache.rules)) {
    lines.push(
      `## ${id}`,
      `source: ${entry.file}:${entry.lineStart + 1}-${entry.lineEnd + 1}`,
      "",
      entry.text,
      "",
    );
  }
  return lines.join("\n");
}

// Both artifacts are written together so they can never disagree about which revision
// of the documents they describe.
function persistCache(cwd: string, cache: CacheShape): void {
  const cachePath = join(cwd, CACHE_FILE);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  writeFileSync(join(cwd, DIGEST_FILE), renderDigest(cache));
}

function isStale(cwd: string, cache: CacheShape): boolean {
  // Iterates the hashes recorded in the cache rather than the current config, so a file
  // that was removed from disk since indexing also counts as stale.
  return Object.entries(cache.fileHashes).some(([rel, hash]) => {
    const abs = join(cwd, rel);
    return !existsSync(abs) || hashFile(abs) !== hash;
  });
}

function loadOrBuildCache(cwd: string, config: ProjectConfig): CacheShape {
  const cachePath = join(cwd, CACHE_FILE);
  if (existsSync(cachePath)) {
    try {
      const cached: CacheShape = JSON.parse(readFileSync(cachePath, "utf8"));
      // The digest is checked too: it can go missing on its own if someone cleans the
      // cache directory partially, and an advisor with no digest has no fallback.
      if (!isStale(cwd, cached) && existsSync(join(cwd, DIGEST_FILE))) return cached;
    } catch {
      // A corrupt cache file is recoverable — rebuilding below costs one parse pass and
      // is always safer than surfacing an error the user has to act on.
    }
  }
  const fresh = buildCache(cwd, config);
  persistCache(cwd, fresh);
  return fresh;
}

export default function (pi: ExtensionAPI) {
  const z = pi.zod;

  // Nothing an advisor does can trigger a build: it cannot call plugin tools and cannot
  // run slash commands. Without a build at session start, an advisor-only project would
  // never get a digest at all. The hash check makes the common case a few file hashes.
  //
  // The hook payload is not guaranteed to carry cwd — on some omp versions it does not,
  // and passing undefined into path.join throws before the extension finishes loading.
  // process.cwd() is the fallback: omp runs with the project root as its working
  // directory, the same root the tool path resolves against.
  pi.on?.("session_start", async (ctx?: { cwd?: string; ui?: { notify?: (m: string, l?: string) => void } }) => {
    const cwd = ctx?.cwd ?? process.cwd();
    if (typeof cwd !== "string") return;

    // The hook payload does not reliably expose the UI surface. stderr is the fallback so
    // the message is never lost entirely — it lands in the session log even when it cannot
    // be shown as a notification.
    const say = (msg: string, level: "info" | "warning" = "info") =>
      ctx?.ui?.notify ? ctx.ui.notify(msg, level) : console.error(`[rule-cache] ${msg}`);

    const config = loadProjectConfig(cwd);

    if (!config) {
      // Two different failures share this branch, and they need different messages.
      if (configFileExists(cwd)) {
        // The user wrote a config and it is broken. Always worth reporting, every session,
        // because it is unambiguously a mistake and silence would leave them assuming the
        // index is being built.
        say(`${PROJECT_CONFIG_FILE} exists but is not valid JSON — the rule index was not built.`, "warning");
        return;
      }

      // No config at all. In most projects that is simply the correct state, so this only
      // speaks up when the project looks like it has requirement docs, and only once.
      const candidates = detectDocDirs(cwd);
      if (candidates.length > 0 && !hintAlreadyShown(cwd)) {
        say(
          `Found ${candidates[0]} but no ${PROJECT_CONFIG_FILE} — no rule index for this project. ` +
            `Run /rule-cache-init to create one, or ignore this if the plugin is not wanted here.`,
          "info",
        );
        markHintShown(cwd);
      }
      return;
    }

    try {
      loadOrBuildCache(cwd, config);
    } catch (err) {
      // Indexing is an optimisation, not a prerequisite, so the session still starts. But
      // failing silently here was the earlier mistake: consumers then read a stale digest,
      // or none, with no indication why.
      say(`Failed to build the rule index: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
  });

  pi.registerTool({
    name: "project_rule_lookup",
    label: "Project Rule Lookup",
    // The description is what makes a model choose this tool over grep, so it states the
    // precondition explicitly — otherwise agents call it in unconfigured projects and
    // waste a turn on the error path.
    description:
      "Look up a single rule ID/section from the project's requirement documents (pre-indexed). " +
      "Requires the project to declare .omp/project-rule-cache.json first.",
    parameters: z.object({
      ruleId: z.string().describe("Rule ID or heading to look up, e.g. 'X.10.00.2' or 'BE-75'"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadProjectConfig(ctx.cwd);
      if (!config) {
        // Returned as a normal result, not thrown: the calling agent should fall back
        // to grep/read and finish its turn rather than have it fail.
        return {
          content: [{
            type: "text",
            text: configFileExists(ctx.cwd)
              ? `${PROJECT_CONFIG_FILE} exists but is not valid JSON, so no index is available. Read the requirement documents directly instead.`
              : `Project not configured — no ${PROJECT_CONFIG_FILE}. Read the requirement documents directly instead. (The user can run /rule-cache-init to enable this tool.)`,
          }],
        };
      }
      const cache = loadOrBuildCache(ctx.cwd, config);
      const entry = cache.rules[params.ruleId];
      // Same reasoning for a miss: a wrong or renamed ID should send the caller to grep,
      // not abort it.
      if (!entry) return { content: [{ type: "text", text: `"${params.ruleId}" not found in the index.` }] };
      return {
        // +1 converts to 1-based line numbers so the citation matches what an editor shows.
        content: [{ type: "text", text: `${entry.file}:${entry.lineStart + 1}-${entry.lineEnd + 1}\n\n${entry.text}` }],
      };
    },
  });

  // Hash-based invalidation covers edits to files already indexed, but not changes to the
  // config itself (new source paths, a different headingPattern). This command exists as
  // the manual escape hatch for those cases.
  pi.registerCommand("rule-cache-rebuild", {
    description: "Rebuild the rule index for the current project",
    handler: async (_args, ctx) => {
      const config = loadProjectConfig(ctx.cwd);
      if (!config) {
        // Same two-failure split as the session-start hook: "you have not set this up" and
        // "what you set up is broken" call for different next steps.
        if (configFileExists(ctx.cwd)) {
          ctx.ui.notify(`${PROJECT_CONFIG_FILE} is not valid JSON — fix it, then rebuild.`, "warning");
        } else {
          ctx.ui.notify(`No ${PROJECT_CONFIG_FILE} found. Run /rule-cache-init to create one.`, "warning");
        }
        return;
      }
      // Unconditional rebuild — the point of invoking this by hand is to bypass the
      // staleness check, so consulting it here would defeat the command.
      const fresh = buildCache(ctx.cwd, config);
      persistCache(ctx.cwd, fresh);
      // The rule count is the only quick signal that the heading pattern actually matched;
      // a count of 0 points straight at a pattern mismatch.
      ctx.ui.notify(`Rebuilt: ${Object.keys(fresh.rules).length} rules.`, "info");
    },
  });

  // Setup is one small JSON file, but writing it by hand means knowing the schema and the
  // exact filename. This turns first-time setup into a single command.
  pi.registerCommand("rule-cache-init", {
    description: "Create .omp/project-rule-cache.json for this project and build the index",
    handler: async (args, ctx) => {
      // Never overwrite. A config already on disk may encode a headingPattern or a
      // deliberate source list that this command has no way to reconstruct.
      if (configFileExists(ctx.cwd)) {
        ctx.ui.notify(`${PROJECT_CONFIG_FILE} already exists. Edit it directly, then run /rule-cache-rebuild.`, "warning");
        return;
      }

      // An explicit argument beats the heuristic: the caller knows their layout, and the
      // candidate list only covers conventional directory names.
      const explicit = typeof args === "string" ? args.trim() : "";
      const sources = explicit ? [explicit] : detectDocDirs(ctx.cwd);

      if (sources.length === 0) {
        ctx.ui.notify(
          `No documentation directory found. Run "/rule-cache-init <path>" with the folder holding your requirement docs.`,
          "warning",
        );
        return;
      }

      const path = scaffoldConfig(ctx.cwd, sources);
      const fresh = buildCache(ctx.cwd, { sources });
      persistCache(ctx.cwd, fresh);
      const count = Object.keys(fresh.rules).length;
      // A zero count right after setup almost always means the heading pattern does not fit
      // this project's convention, so it is called out rather than reported as success.
      ctx.ui.notify(
        count > 0
          ? `Created ${path} (sources: ${sources.join(", ")}) — indexed ${count} rules.`
          : `Created ${path}, but matched 0 rules. Check that headings look like "## <RULE-ID>", or set headingPattern.`,
        count > 0 ? "info" : "warning",
      );
    },
  });
}

