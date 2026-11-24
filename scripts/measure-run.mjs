#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Anthropic API list rates (USD per 1M tokens) matching @makko/model-config.
 * [input, cacheRead, cacheWrite5m, cacheWrite1h, output]
 */
export const PRICING = {
  "claude-haiku-5-5": { input: 0.1, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2, output: 0.5, longContextAbove: 100_000, longContextMult: 5.0 },
  "claude-sonnet-5-5": { input: 2.0, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4.0, output: 10.0 },
  "claude-opus-5-5": { input: 4.0, cacheRead: 0.2, cacheWrite5m: 5.0, cacheWrite1h: 8.0, output: 20.0 },
  "claude-fable-5-2": { input: 8.0, cacheRead: 0.4, cacheWrite5m: 10.0, cacheWrite1h: 16.0, output: 40.0 },
  // Legacy / fallback Claude model aliases
  "claude-sonnet-5": { input: 3.0, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6.0, output: 15.0 },
  "claude-opus-5": { input: 5.0, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10.0, output: 25.0 },
};

const IGNORED_LOC_PATTERNS = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|deno\.lock|Cargo\.lock|poetry\.lock)$/u,
  /(^|\/)(\.archflow|\.claude|dist|build|coverage|node_modules|__fixtures__|golden|__snapshots__)\//u,
  /\.min\.(js|css|mjs)$/u,
  /\.map$/u,
  /\.snap$/u,
];

const CODE_FILE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|sql|sh|bash|css|scss|html|gd|glsl|wgsl|c|cc|cpp|h|hpp|java|kt|rb|php|swift)$/iu;

export function calcMessageCostUsd(model, usage) {
  const rates = PRICING[model];
  if (!rates || !usage || typeof usage !== "object") return 0;
  const inp = Number(usage.input_tokens || 0);
  const cr = Number(usage.cache_read_input_tokens || 0);
  const cwTotal = Number(usage.cache_creation_input_tokens || 0);
  const cc = usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : {};
  let cw5 = Number(cc.ephemeral_5m_input_tokens || 0);
  const cw1 = Number(cc.ephemeral_1h_input_tokens || 0);
  if (cw5 + cw1 === 0 && cwTotal > 0) cw5 = cwTotal;
  const out = Number(usage.output_tokens || 0);
  const promptTotal = inp + cr + cwTotal;
  const mult = rates.longContextAbove && promptTotal > rates.longContextAbove ? (rates.longContextMult ?? 1) : 1;
  return (
    (inp * rates.input + cr * rates.cacheRead + cw5 * rates.cacheWrite5m + cw1 * rates.cacheWrite1h + out * rates.output) *
    mult
  ) / 1_000_000;
}

function emptyUsageBucket() {
  return {
    turns: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUsd: 0,
  };
}

function addBucket(dst, src) {
  dst.turns += src.turns;
  dst.inputTokens += src.inputTokens;
  dst.cacheReadTokens += src.cacheReadTokens;
  dst.cacheWriteTokens += src.cacheWriteTokens;
  dst.cacheWrite5mTokens += src.cacheWrite5mTokens;
  dst.cacheWrite1hTokens += src.cacheWrite1hTokens;
  dst.outputTokens += src.outputTokens;
  dst.thinkingTokens += src.thinkingTokens;
  dst.costUsd += src.costUsd;
}

/**
 * Parse a Claude Code JSONL transcript, deduplicating streaming chunks by message.id.
 */
export function parseClaudeTranscript(filePath) {
  const msgs = new Map();
  let firstTs = null;
  let lastTs = null;
  let maxContextTokens = 0;
  let anon = 0;

  const content = readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = typeof d.timestamp === "string" ? d.timestamp : null;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }
    if (d.type !== "assistant") continue;
    const msg = d.message;
    if (!msg || typeof msg !== "object" || !msg.usage || typeof msg.usage !== "object") continue;
    const model = typeof msg.model === "string" ? msg.model : "unknown";
    if (model === "<synthetic>") continue;
    const mid = typeof msg.id === "string" && msg.id ? msg.id : `anon_${anon++}`;
    msgs.set(mid, { model, usage: msg.usage });
  }

  const byModel = {};
  for (const { model, usage } of msgs.values()) {
    if (!byModel[model]) byModel[model] = emptyUsageBucket();
    const b = byModel[model];
    const inp = Number(usage.input_tokens || 0);
    const cr = Number(usage.cache_read_input_tokens || 0);
    const cw = Number(usage.cache_creation_input_tokens || 0);
    const cc = usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : {};
    let cw5 = Number(cc.ephemeral_5m_input_tokens || 0);
    const cw1 = Number(cc.ephemeral_1h_input_tokens || 0);
    if (cw5 + cw1 === 0 && cw > 0) cw5 = cw;
    const out = Number(usage.output_tokens || 0);
    const think = Number(usage.output_tokens_details?.thinking_tokens || 0);
    const ctx = inp + cr + cw;
    if (ctx > maxContextTokens) maxContextTokens = ctx;
    b.turns += 1;
    b.inputTokens += inp;
    b.cacheReadTokens += cr;
    b.cacheWriteTokens += cw;
    b.cacheWrite5mTokens += cw5;
    b.cacheWrite1hTokens += cw1;
    b.outputTokens += out;
    b.thinkingTokens += think;
    b.costUsd += calcMessageCostUsd(model, usage);
  }

  return { byModel, firstTs, lastTs, maxContextTokens, turns: msgs.size };
}

/**
 * Classify a sub-agent spawn by its agentType and description into workflow roles.
 */
export function classifySubagent(agentType, description) {
  const at = String(agentType || "").toLowerCase();
  const dl = String(description || "").toLowerCase().trim();

  if (dl.includes("deferral")) return "deferral_pass";

  // Gate lenses (exclude task implementation of gate fix tasks like "Implement M1-C6 form gate fixes")
  const isGateLens =
    /\b(gate|browser check)\b/u.test(dl) &&
    (/\b(lens|runtime|dogfood|fidelity|architecture|quality|browser check)\b/u.test(dl) || !dl.startsWith("implement ")) &&
    !dl.startsWith("implement ") &&
    !dl.startsWith("fix ") &&
    !/\bfix(er)?\b/u.test(dl) &&
    !/\breview m\d+-/u.test(dl) &&
    !/\bverify\b/u.test(dl);
  if (isGateLens) return "gate_lens";

  // Planning, exploration, research, milestone detailing, plan revisions
  const isPlanningAgent =
    at === "general-purpose" ||
    at === "explore" ||
    at === "plan" ||
    /\b(explore |research |write first run plan|detail milestone|re-plan|synthesize |apply approval|plan review|vet of |revise plan|revise .*plan|revise m\d+\b|fix model job serialization design|fix replay-safe file writes|counter-review points|from vet)\b/u.test(
      dl,
    );
  if (isPlanningAgent && !at.includes("-implementer") && !at.includes("-reviewer")) {
    if (at === "explore" || /\bexplore\b/u.test(dl)) return "planning_explore";
    if (/\b(research|synthesize)\b/u.test(dl)) return "planning_research";
    if (/\b(revise|revision|vet|apply approval|plan review|counter-review|fix model job|fix replay-safe)\b/u.test(dl)) {
      return "planning_revision";
    }
    return "planning_plan";
  }

  // Reviewers
  if (at.includes("reviewer") || /\b(review|verify|fix-verify|merge)\b/u.test(dl)) {
    if (/\bmerge\b/u.test(dl) || (/\b(counter-review|cr1|cr2|cr3)\b/u.test(dl) && !/\bverify\b/u.test(dl))) {
      return "review_merge";
    }
    if (/\b(verify|fix-verify)\b/u.test(dl)) return "review_fix_verify";
    return "review_task";
  }

  // Implementers vs fixers
  if (at.includes("implementer")) {
    if (/\b(fix|fixer|revert)\b/u.test(dl) && !dl.startsWith("implement ")) return "fix";
    return "implement";
  }

  return "other";
}

function normalizeSourceOrigin(sourceRaw) {
  const s = String(sourceRaw || "").toLowerCase();
  if (s.includes("human-review") || s.includes("human_review")) return "human_review";
  if (s === "unplanned" || s.startsWith("unplanned")) return "unplanned";
  if (s === "carried" || (s.startsWith("carried") && !s.includes("counter") && !s.includes("tests"))) return "carried";
  if (s === "structure" || s.startsWith("structure")) return "structure";
  const hasSelf = /\bself\b/u.test(s) || /\bstructure\b/u.test(s);
  const hasCross = /\b(counter|tests|test-reviewer)\b/u.test(s);
  if (hasSelf && hasCross) return "both";
  if (hasCross) return "cross_model_only";
  if (hasSelf) return "in_model_only";
  return "other";
}

/**
 * Parse a task review file (<id>-r1.md) for findings, sources, delta rounds, and decisions.
 */
export function parseReviewFile(content) {
  const rows = [];
  const decisions = { fix: 0, defer: 0, dismiss: 0, keep: 0, revert: 0, decided: 0, halt: 0, other: 0 };
  let inFindings = false;
  let isPostR1 = false;
  let hasR2 = false;

  for (const line of content.split("\n")) {
    if (/^##\s+Round r2\b/iu.test(line)) hasR2 = true;
    if (/^###?\s+(Delta review|Round r[2-9])/iu.test(line)) isPostR1 = true;

    if (/^\|\s*id\s*\|\s*severity\s*\|\s*source\s*\|/iu.test(line)) {
      inFindings = true;
      continue;
    }
    if (inFindings) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) {
        inFindings = false;
        continue;
      }
      if (/^\|\s*-+/u.test(trimmed)) continue;
      const cols = trimmed
        .replace(/^\|/u, "")
        .replace(/\|$/u, "")
        .split("|")
        .map((c) => c.trim());
      if (cols.length >= 4) {
        const severity = cols[1].toLowerCase();
        const source = cols[2].toLowerCase();
        rows.push({
          id: cols[0],
          severity,
          source,
          origin: normalizeSourceOrigin(source),
          isStructure: source.includes("structure"),
          isPostR1,
        });
      }
    }

    const dm = /^-\s+([^:]+):\s*(fix|fixed|defer|dismiss|keep|revert|decided|halt|won't fix)\b/iu.exec(line.trim());
    if (dm) {
      const ids = dm[1]
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const count = Math.max(ids.length, 1);
      const act = dm[2].toLowerCase();
      if (act === "fix" || act === "fixed") decisions.fix += count;
      else if (act === "defer") decisions.defer += count;
      else if (act === "dismiss" || act === "won't fix") decisions.dismiss += count;
      else if (act === "keep") decisions.keep += count;
      else if (act === "revert") decisions.revert += count;
      else if (act === "decided") decisions.decided += count;
      else if (act === "halt") decisions.halt += count;
      else decisions.other += count;
    }
  }

  return { rows, decisions, hasR2 };
}

export function parseGateFile(content) {
  const counts = { critical: 0, major: 0, minor: 0, note: 0 };
  let inTable = false;
  for (const line of content.split("\n")) {
    if (/^\|\s*id\s*\|\s*severity\s*\|/iu.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) {
        inTable = false;
        continue;
      }
      if (/^\|\s*-+/u.test(trimmed)) continue;
      const cols = trimmed
        .replace(/^\|/u, "")
        .replace(/\|$/u, "")
        .split("|")
        .map((c) => c.trim().toLowerCase());
      if (cols.length >= 2 && cols[1] in counts) counts[cols[1]] += 1;
    }
  }
  return counts;
}

function claudeProjectDirForRepo(repoDir) {
  const resolved = resolve(repoDir);
  // Claude Code replaces "/" and "." with "-" in project directory slugs
  const slug = resolved.replace(/[/.]/gu, "-");
  const candidate = join(homedir(), ".claude", "projects", slug);
  if (existsSync(candidate)) return candidate;
  return null;
}

function detectExtraReposFromPlan(runDir, primaryRepo) {
  const planPath = join(runDir, "PLAN.md");
  if (!existsSync(planPath)) return [];
  const text = readFileSync(planPath, "utf8").slice(0, 6000);
  const found = new Set();
  const primaryResolved = resolve(primaryRepo);
  for (const m of text.matchAll(/`(\/[^`\s]+)`/gu)) {
    const p = m[1];
    if (!p || p.includes("<") || p.startsWith("/tmp")) continue;
    const res = resolve(p);
    if (res === primaryResolved) continue;
    if (existsSync(join(res, ".git"))) found.add(res);
  }
  return [...found];
}

function measureGitRepo(repoDir, baseRef = "main", sinceDate = null) {
  const empty = {
    repo: basename(repoDir),
    commits: 0,
    sourceFiles: 0,
    sourceAdded: 0,
    sourceDeleted: 0,
    testFiles: 0,
    testAdded: 0,
    testDeleted: 0,
    grossAdded: 0,
    grossDeleted: 0,
  };
  if (!existsSync(repoDir)) return empty;
  try {
    let base = "";
    for (const ref of [baseRef, "origin/main", "master", "origin/master"]) {
      try {
        base = execFileSync("git", ["-C", repoDir, "merge-base", "HEAD", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (base) break;
      } catch {
        // try next ref
      }
    }
    if (!base) return empty;
    if (sinceDate) {
      // Find the last commit before sinceDate on this branch so diff covers only commits from sinceDate onward
      const beforeCommit = execFileSync(
        "git",
        ["-C", repoDir, "rev-list", "-n", "1", `--before=${sinceDate}T00:00:00Z`, `${base}..HEAD`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (beforeCommit) base = beforeCommit;
    }
    const commits = Number(
      execFileSync("git", ["-C", repoDir, "rev-list", "--count", `${base}..HEAD`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
    );
    const numstat = execFileSync("git", ["-C", repoDir, "diff", "--numstat", `${base}..HEAD`], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of numstat.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3 || parts[0] === "-") continue;
      const a = Number(parts[0]);
      const d = Number(parts[1]);
      const filePath = parts[2];
      if (IGNORED_LOC_PATTERNS.some((rx) => rx.test(filePath))) continue;
      if (!CODE_FILE_EXT.test(filePath)) continue;
      if (/(^|\/)__tests__\/|\.(test|spec)\.[a-z0-9]+$/iu.test(filePath)) {
        empty.testFiles += 1;
        empty.testAdded += a;
        empty.testDeleted += d;
      } else {
        empty.sourceFiles += 1;
        empty.sourceAdded += a;
        empty.sourceDeleted += d;
      }
    }
    const logStat = execFileSync("git", ["-C", repoDir, "log", "--numstat", "--format=", `${base}..HEAD`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of logStat.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3 || parts[0] === "-") continue;
      const filePath = parts[2];
      if (IGNORED_LOC_PATTERNS.some((rx) => rx.test(filePath))) continue;
      if (!CODE_FILE_EXT.test(filePath)) continue;
      empty.grossAdded += Number(parts[0]);
      empty.grossDeleted += Number(parts[1]);
    }
    empty.commits = commits;
    return empty;
  } catch {
    return empty;
  }
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function detectWorkflowCommit() {
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function mtimeDate(filePath) {
  try {
    return statSync(filePath).mtime.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * Measure an ArchFlow run directory + its Claude transcripts + its git output.
 */
export function measureRun({
  runDir,
  repoDirs = [],
  claudeProjectDir = null,
  baseRef = "main",
  since = null,
  note = null,
  workflowCommit = null,
  id = null,
  label = null,
  date = null,
}) {
  const absRunDir = resolve(runDir);
  if (!existsSync(absRunDir)) {
    throw new Error(`Run directory not found: ${absRunDir}`);
  }
  const runName = basename(absRunDir);
  // Primary repo is ancestor containing .archflow
  const archflowIdx = absRunDir.lastIndexOf("/.archflow/");
  const primaryRepo = archflowIdx >= 0 ? absRunDir.slice(0, archflowIdx) : dirname(absRunDir);

  const allRepos = [primaryRepo, ...repoDirs.map((r) => resolve(r))];
  if (repoDirs.length === 0) {
    for (const extra of detectExtraReposFromPlan(absRunDir, primaryRepo)) {
      if (!allRepos.includes(extra)) allRepos.push(extra);
    }
  }

  const claudeDir = claudeProjectDir ? resolve(claudeProjectDir) : claudeProjectDirForRepo(primaryRepo);

  // 1. Parse PROGRESS.md
  const progressPath = join(absRunDir, "PROGRESS.md");
  const progressText = existsSync(progressPath) ? readFileSync(progressPath, "utf8") : "";
  const progressBytes = Buffer.byteLength(progressText, "utf8");
  const statusMatch = /\*\*STATUS:\s*([^*]+)\*\*/u.exec(progressText);
  const status = statusMatch ? statusMatch[1].trim() : "UNKNOWN";

  const taskLogSection = /## Task log\s*\n([\s\S]*?)(?:\n## |\s*$)/u.exec(progressText)?.[1] ?? "";
  const taskLines = taskLogSection.split("\n").filter((l) => l.trim().startsWith("- "));
  const writers = { sonnet: 0, opusHatch: 0, other: 0 };
  const hatches = { fableReview: 0, runtimeHatch: 0 };
  const fixRoundsDist = { 0: 0, 1: 0, 2: 0, "3+": 0 };
  let orchestratorFixups = 0;

  for (const line of taskLines) {
    if (/opus\s*(implementer\s*)?\(hatch\)/iu.test(line)) writers.opusHatch += 1;
    else if (/—\s*sonnet\b|\bsonnet\b/iu.test(line)) writers.sonnet += 1;
    else writers.other += 1;
    if (/`?fable`?\s+review/iu.test(line)) hatches.fableReview += 1;
    if (/run-time hatch/iu.test(line)) hatches.runtimeHatch += 1;
    if (/fixup/iu.test(line)) orchestratorFixups += 1;
    const rm = /(\d+)\s+fix round/iu.exec(line);
    const r = rm ? Number(rm[1]) : 0;
    if (r >= 3) fixRoundsDist["3+"] += 1;
    else fixRoundsDist[r] = (fixRoundsDist[r] || 0) + 1;
  }

  // 2. Parse reviews/*-r1.md and reviews/gate-*.md
  const reviewsDir = join(absRunDir, "reviews");
  const reviewFiles = existsSync(reviewsDir)
    ? readdirSync(reviewsDir)
        .filter((f) => /-r1\.md$/u.test(f))
        .filter((f) => !since || (mtimeDate(join(reviewsDir, f)) ?? "") >= since)
        .sort()
    : [];
  const gateFiles = existsSync(reviewsDir)
    ? readdirSync(reviewsDir)
        .filter((f) => /^gate-.*\.md$/u.test(f))
        .filter((f) => !since || (mtimeDate(join(reviewsDir, f)) ?? "") >= since)
        .sort()
    : [];

  const findings = {
    reviewFiles: reviewFiles.length,
    totalRows: 0,
    critical: 0,
    major: 0,
    minor: 0,
    note: 0,
    structureRows: 0,
    noDecisionRows: 0,
    minorOnlyFixTasks: 0,
    postR1: { critical: 0, major: 0, minor: 0, note: 0 },
    byOrigin: {
      in_model_only: { critical: 0, major: 0, minor: 0 },
      cross_model_only: { critical: 0, major: 0, minor: 0 },
      both: { critical: 0, major: 0, minor: 0 },
      structure: { critical: 0, major: 0, minor: 0 },
    },
    decisions: { fix: 0, defer: 0, dismiss: 0, keep: 0, revert: 0, decided: 0, halt: 0, other: 0 },
    byMilestone: {},
  };

  for (const rf of reviewFiles) {
    const ms = /^(M\d+)-/u.exec(rf)?.[1] ?? "OTHER";
    if (!findings.byMilestone[ms]) {
      findings.byMilestone[ms] = { tasks: 0, critical: 0, major: 0, minor: 0, note: 0, structure: 0 };
    }
    findings.byMilestone[ms].tasks += 1;
    const parsed = parseReviewFile(readFileSync(join(reviewsDir, rf), "utf8"));
    for (const [k, v] of Object.entries(parsed.decisions)) findings.decisions[k] += v;
    let hasSerious = false;
    let hasMinor = false;
    for (const row of parsed.rows) {
      findings.totalRows += 1;
      if (row.severity in findings) findings[row.severity] += 1;
      if (row.severity in findings.byMilestone[ms]) findings.byMilestone[ms][row.severity] += 1;
      if (row.isStructure) {
        findings.structureRows += 1;
        findings.byMilestone[ms].structure += 1;
      }
      if (row.severity === "note") findings.noDecisionRows += 1;
      if (row.severity === "critical" || row.severity === "major") hasSerious = true;
      if (row.severity === "minor") hasMinor = true;
      if (row.isPostR1 && row.severity in findings.postR1) findings.postR1[row.severity] += 1;
      if (row.severity === "critical" || row.severity === "major" || row.severity === "minor") {
        if (row.origin in findings.byOrigin) {
          findings.byOrigin[row.origin][row.severity] += 1;
        }
      }
    }
    if (!hasSerious && hasMinor && parsed.hasR2) findings.minorOnlyFixTasks += 1;
  }

  const gates = { files: gateFiles.length, critical: 0, major: 0, minor: 0, note: 0 };
  for (const gf of gateFiles) {
    const gc = parseGateFile(readFileSync(join(reviewsDir, gf), "utf8"));
    gates.critical += gc.critical;
    gates.major += gc.major;
    gates.minor += gc.minor;
    gates.note += gc.note;
  }

  // 3. Parse counter-review packets
  const packetsDir = join(absRunDir, "packets");
  const counterReview = { total: 0, taskR1: 0, taskDelta: 0, plan: 0, milestoneGate: 0, failures: 0, issuesFound: 0, deltaIssuesFound: 0, humanReviewReasons: 0 };
  if (existsSync(packetsDir)) {
    for (const entry of readdirSync(packetsDir)) {
      if (!/-cr\d+$/u.test(entry)) continue;
      const sp = join(packetsDir, entry, "summary.json");
      if (!existsSync(sp)) continue;
      if (since && (mtimeDate(sp) ?? "") < since) continue;
      let d;
      try {
        d = JSON.parse(readFileSync(sp, "utf8"));
      } catch {
        continue;
      }
      counterReview.total += 1;
      const isPlan = entry.startsWith("plan-");
      const isGate = entry.includes("gate") || entry.includes("milestone") || /^M\d+-cr/u.test(entry);
      const isDelta = !isPlan && !isGate && /-cr[2-9]\d*$/u.test(entry);
      if (isPlan) counterReview.plan += 1;
      else if (isGate) counterReview.milestoneGate += 1;
      else if (isDelta) counterReview.taskDelta += 1;
      else counterReview.taskR1 += 1;

      if (!d.ok) counterReview.failures += 1;
      counterReview.humanReviewReasons += Array.isArray(d.human_review_reasons) ? d.human_review_reasons.length : 0;
      const reports = Array.isArray(d.reports) ? d.reports : [];
      const hadIssues = reports.some((r) => r.outcome === "issues_found");
      if (hadIssues) {
        counterReview.issuesFound += 1;
        if (isDelta) counterReview.deltaIssuesFound += 1;
      }
    }
  }

  // 4. Parse Claude session & subagent JSONLs
  const claude = {
    projectDir: claudeDir,
    sessions: 0,
    subagents: 0,
    firstDate: null,
    lastDate: null,
    activeDays: 0,
    orchestratorPeakCtxMax: 0,
    orchestratorPeakCtxAvg: 0,
    orchestratorOver300k: 0,
    fixVerifyOnOpus: 0,
    fixVerifyOnSonnet: 0,
    byModel: {},
    byCategory: {},
    totals: emptyUsageBucket(),
  };

  const days = new Set();
  const orchPeaks = [];
  let sonnetImplCost = 0;
  let opusImplCost = 0;

  if (claudeDir && existsSync(claudeDir)) {
    const topEntries = readdirSync(claudeDir);
    const orchFiles = topEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(claudeDir, f));

    for (const ofile of orchFiles) {
      const parsed = parseClaudeTranscript(ofile);
      if (parsed.turns === 0) continue;
      if (since && (parsed.lastTs ? parsed.lastTs.slice(0, 10) : "") < since) continue;
      claude.sessions += 1;
      orchPeaks.push(parsed.maxContextTokens);
      if (parsed.maxContextTokens > claude.orchestratorPeakCtxMax) claude.orchestratorPeakCtxMax = parsed.maxContextTokens;
      if (parsed.maxContextTokens > 300_000) claude.orchestratorOver300k += 1;
      if (parsed.firstTs) {
        const d = parsed.firstTs.slice(0, 10);
        days.add(d);
        if (!claude.firstDate || d < claude.firstDate) claude.firstDate = d;
      }
      if (parsed.lastTs) {
        const d = parsed.lastTs.slice(0, 10);
        days.add(d);
        if (!claude.lastDate || d > claude.lastDate) claude.lastDate = d;
      }
      if (!claude.byCategory.orchestrator) claude.byCategory.orchestrator = { spawns: 0, ...emptyUsageBucket() };
      claude.byCategory.orchestrator.spawns += 1;
      for (const [m, b] of Object.entries(parsed.byModel)) {
        if (!claude.byModel[m]) claude.byModel[m] = emptyUsageBucket();
        addBucket(claude.byModel[m], b);
        addBucket(claude.byCategory.orchestrator, b);
        addBucket(claude.totals, b);
      }
    }

    for (const entry of topEntries) {
      const subDir = join(claudeDir, entry, "subagents");
      if (!existsSync(subDir) || !statSync(subDir).isDirectory()) continue;
      for (const sf of readdirSync(subDir)) {
        if (!sf.endsWith(".jsonl")) continue;
        const sPath = join(subDir, sf);
        const mPath = sPath.replace(/\.jsonl$/u, ".meta.json");
        let meta = {};
        if (existsSync(mPath)) {
          try {
            meta = JSON.parse(readFileSync(mPath, "utf8"));
          } catch {
            meta = {};
          }
        }
        const parsed = parseClaudeTranscript(sPath);
        if (parsed.turns === 0) continue;
        if (since && (parsed.lastTs ? parsed.lastTs.slice(0, 10) : "") < since) continue;
        claude.subagents += 1;
        if (parsed.firstTs) {
          const d = parsed.firstTs.slice(0, 10);
          days.add(d);
          if (!claude.firstDate || d < claude.firstDate) claude.firstDate = d;
        }
        if (parsed.lastTs) {
          const d = parsed.lastTs.slice(0, 10);
          days.add(d);
          if (!claude.lastDate || d > claude.lastDate) claude.lastDate = d;
        }
        const cat = classifySubagent(meta.agentType, meta.description);
        if (!claude.byCategory[cat]) claude.byCategory[cat] = { spawns: 0, ...emptyUsageBucket() };
        claude.byCategory[cat].spawns += 1;
        if (cat === "review_fix_verify") {
          const modelsUsed = Object.keys(parsed.byModel);
          if (modelsUsed.some((m) => m.includes("opus") || m.includes("fable"))) claude.fixVerifyOnOpus += 1;
          else if (modelsUsed.some((m) => m.includes("sonnet"))) claude.fixVerifyOnSonnet += 1;
        }
        for (const [m, b] of Object.entries(parsed.byModel)) {
          if (!claude.byModel[m]) claude.byModel[m] = emptyUsageBucket();
          addBucket(claude.byModel[m], b);
          addBucket(claude.byCategory[cat], b);
          addBucket(claude.totals, b);
          if (cat === "implement") {
            if (m.includes("sonnet")) sonnetImplCost += b.costUsd;
            else opusImplCost += b.costUsd;
          }
        }
      }
    }
  }

  claude.activeDays = days.size;
  claude.orchestratorPeakCtxAvg = orchPeaks.length ? Math.round(orchPeaks.reduce((a, b) => a + b, 0) / orchPeaks.length) : 0;

  // 5. Git output across all repos
  const gitRepos = allRepos.map((r) => measureGitRepo(r, baseRef, since));
  const git = {
    repos: gitRepos,
    commits: gitRepos.reduce((s, r) => s + r.commits, 0),
    sourceFiles: gitRepos.reduce((s, r) => s + r.sourceFiles, 0),
    testFiles: gitRepos.reduce((s, r) => s + r.testFiles, 0),
    netSourceLoc: gitRepos.reduce((s, r) => s + (r.sourceAdded - r.sourceDeleted), 0),
    netTestLoc: gitRepos.reduce((s, r) => s + (r.testAdded - r.testDeleted), 0),
    netTotalLoc: gitRepos.reduce((s, r) => s + (r.sourceAdded - r.sourceDeleted) + (r.testAdded - r.testDeleted), 0),
    grossAdded: gitRepos.reduce((s, r) => s + r.grossAdded, 0),
    grossDeleted: gitRepos.reduce((s, r) => s + r.grossDeleted, 0),
  };

  // 6. Rollups & Derived KPIs
  const mergedTasks = since ? reviewFiles.length : Math.max(taskLines.length, reviewFiles.length);
  const catCost = (c) => claude.byCategory[c]?.costUsd ?? 0;
  const catTokens = (c) => {
    const b = claude.byCategory[c];
    return b ? b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens + b.outputTokens : 0;
  };
  const catOutput = (c) => claude.byCategory[c]?.outputTokens ?? 0;

  const planningInitCost = catCost("planning_explore") + catCost("planning_research") + catCost("planning_plan");
  const planningRevCost = catCost("planning_revision");
  const planningCost = planningInitCost + planningRevCost;
  const planningTokens =
    catTokens("planning_explore") + catTokens("planning_research") + catTokens("planning_plan") + catTokens("planning_revision");
  const planningRevTokens = catTokens("planning_revision");

  const implementCost = catCost("implement");
  const implementTokens = catTokens("implement");
  const fixCost = catCost("fix");
  const fixTokens = catTokens("fix");
  const reviewCost = catCost("review_task") + catCost("review_fix_verify") + catCost("review_merge") + catCost("gate_lens") + catCost("deferral_pass");
  const reviewTokens =
    catTokens("review_task") + catTokens("review_fix_verify") + catTokens("review_merge") + catTokens("gate_lens") + catTokens("deferral_pass");
  const orchestratorCost = catCost("orchestrator");
  const orchestratorTokens = catTokens("orchestrator");

  const totalCost = claude.totals.costUsd;
  const totalTokens =
    claude.totals.inputTokens + claude.totals.cacheReadTokens + claude.totals.cacheWriteTokens + claude.totals.outputTokens;
  const fableCost = claude.byModel["claude-fable-5-2"]?.costUsd ?? 0;
  const opusCost = claude.byModel["claude-opus-5-5"]?.costUsd ?? 0;
  const sonnetCost = claude.byModel["claude-sonnet-5-5"]?.costUsd ?? 0;
  const haikuCost = claude.byModel["claude-haiku-5-5"]?.costUsd ?? 0;

  const seriousCaught = findings.critical + findings.major;
  const seriousEscaped = gates.critical + gates.major;
  const actedOn = findings.decisions.fix + findings.decisions.defer;
  const decidedFindings = actedOn + findings.decisions.dismiss;
  const signalRate = decidedFindings > 0 ? actedOn / decidedFindings : null;

  // Transparent counterfactual "without ArchFlow" guesstimate:
  // (a) Unreviewed Opus-direct coding floor: if a human drove plain Opus sessions directly without
  //     structured planning/reviews/gates, the Sonnet implementer share (~2x cheaper per token than Opus)
  //     would run at Opus rates, plus ~25% ad-hoc exploration/steering overhead.
  // (b) Realistic debug-adjusted range: assumes 30-50% of the serious defects caught before merge
  //     would otherwise surface during manual QA/prod and cost ~$10-$12 each in ad-hoc Opus debug turns
  //     (excluding the human's own debugging hours).
  const opusDirectCodeFloor = (opusImplCost + sonnetImplCost * 2.0) * 1.25;
  const unreviewedBugDebugEstLow = seriousCaught * 0.3 * 10;
  const unreviewedBugDebugEstHigh = seriousCaught * 0.5 * 12;

  const kpis = {
    mergedTasks,
    totalCostUsd: round(totalCost, 2),
    costPerTaskUsd: mergedTasks > 0 ? round(totalCost / mergedTasks, 2) : 0,
    costPerKlocUsd: git.netTotalLoc > 0 ? round((totalCost / git.netTotalLoc) * 1000, 2) : 0,
    costPerSourceKlocUsd: git.netSourceLoc > 0 ? round((totalCost / git.netSourceLoc) * 1000, 2) : 0,
    tokensPerTaskM: mergedTasks > 0 ? round(totalTokens / mergedTasks / 1_000_000, 2) : 0,
    outputTokensPerTaskK: mergedTasks > 0 ? round(claude.totals.outputTokens / mergedTasks / 1_000, 1) : 0,
    fableSharePct: totalCost > 0 ? round((fableCost / totalCost) * 100, 1) : 0,
    opusSharePct: totalCost > 0 ? round((opusCost / totalCost) * 100, 1) : 0,
    sonnetSharePct: totalCost > 0 ? round((sonnetCost / totalCost) * 100, 1) : 0,
    haikuSharePct: totalCost > 0 ? round((haikuCost / totalCost) * 100, 1) : 0,
    costPerDayUsd: claude.activeDays > 0 ? round(totalCost / claude.activeDays, 2) : 0,
    reviewToWriteRatio: implementCost + fixCost > 0 ? round(reviewCost / (implementCost + fixCost), 2) : 0,
    seriousCaught,
    seriousCaughtPerTask: mergedTasks > 0 ? round(seriousCaught / mergedTasks, 2) : 0,
    totalBugsCaught: findings.critical + findings.major + findings.minor,
    totalBugsCaughtPerTask: mergedTasks > 0 ? round((findings.critical + findings.major + findings.minor) / mergedTasks, 2) : 0,
    seriousEscapedToGates: seriousEscaped,
    gateEscapeRatePct: seriousCaught + seriousEscaped > 0 ? round((seriousEscaped / (seriousCaught + seriousEscaped)) * 100, 1) : 0,
    signalRatePct: signalRate !== null ? round(signalRate * 100, 1) : null,
    noDecisionRowSharePct: findings.totalRows > 0 ? round((findings.noDecisionRows / findings.totalRows) * 100, 1) : 0,
    structureFindingsPerTask: mergedTasks > 0 ? round(findings.structureRows / mergedTasks, 2) : 0,
    crossModelOnlyMajorSharePct:
      findings.major > 0 ? round((findings.byOrigin.cross_model_only.major / findings.major) * 100, 1) : 0,
    crossModelOnlyMinorSharePct:
      findings.minor > 0 ? round((findings.byOrigin.cross_model_only.minor / findings.minor) * 100, 1) : 0,
    planningCostUsd: round(planningCost, 2),
    planningInitCostUsd: round(planningInitCost, 2),
    planningRevisionCostUsd: round(planningRevCost, 2),
    planningSharePct: totalCost > 0 ? round((planningCost / totalCost) * 100, 1) : 0,
    planningTokensM: round(planningTokens / 1_000_000, 1),
    planningRevisionTokensM: round(planningRevTokens / 1_000_000, 1),
    implementCostUsd: round(implementCost, 2),
    implementTokensM: round(implementTokens / 1_000_000, 1),
    fixCostUsd: round(fixCost, 2),
    fixTokensM: round(fixTokens / 1_000_000, 1),
    fixOutputTokensM: round(catOutput("fix") / 1_000_000, 2),
    reviewCostUsd: round(reviewCost, 2),
    reviewTokensM: round(reviewTokens / 1_000_000, 1),
    orchestratorCostUsd: round(orchestratorCost, 2),
    orchestratorTokensM: round(orchestratorTokens / 1_000_000, 1),
    progressFileKb: round(progressBytes / 1024, 1),
    counterfactual: {
      unreviewedOpusFloorUsd: round(opusDirectCodeFloor, 0),
      debugAdjustedLowUsd: round(opusDirectCodeFloor + unreviewedBugDebugEstLow, 0),
      debugAdjustedHighUsd: round(opusDirectCodeFloor + unreviewedBugDebugEstHigh, 0),
      workflowOverheadRatio: opusDirectCodeFloor > 0 ? round(totalCost / opusDirectCodeFloor, 2) : 0,
      costPerSeriousBugUsd: seriousCaught > 0 ? round((totalCost - opusDirectCodeFloor) / seriousCaught, 2) : 0,
    },
  };

  // 7. Automated health diagnostics ("is it working?")
  const checks = [];
  checks.push({
    name: "Cost per merged task",
    status: kpis.costPerTaskUsd <= 10 ? "good" : kpis.costPerTaskUsd <= 15 ? "warn" : "bad",
    value: `$${kpis.costPerTaskUsd}/task`,
    target: "≤ $10/task (baseline $15.60)",
  });
  checks.push({
    name: "Strongest-model (Fable) share",
    status: kpis.fableSharePct <= 20 ? "good" : kpis.fableSharePct <= 35 ? "warn" : "bad",
    value: `${kpis.fableSharePct}%`,
    target: "≤ 20% (baseline 46%)",
  });
  checks.push({
    name: "Review-to-write cost ratio",
    status: kpis.reviewToWriteRatio <= 1.2 ? "good" : kpis.reviewToWriteRatio <= 1.6 ? "warn" : "bad",
    value: `${kpis.reviewToWriteRatio}x`,
    target: "≤ 1.2x (Claude review vs write+fix)",
  });
  checks.push({
    name: "Review signal rate (acted on)",
    status: kpis.signalRatePct === null ? "info" : kpis.signalRatePct >= 85 ? "good" : kpis.signalRatePct >= 70 ? "warn" : "bad",
    value: kpis.signalRatePct !== null ? `${kpis.signalRatePct}%` : "n/a",
    target: "≥ 85%",
  });
  checks.push({
    name: "No-decision review rows",
    status: kpis.noDecisionRowSharePct <= 40 ? "good" : kpis.noDecisionRowSharePct <= 60 ? "warn" : "bad",
    value: `${kpis.noDecisionRowSharePct}%`,
    target: "≤ 40% (baseline 72%)",
  });
  checks.push({
    name: "PROGRESS.md live-state hygiene",
    status: kpis.progressFileKb <= 20 ? "good" : kpis.progressFileKb <= 40 ? "warn" : "bad",
    value: `${kpis.progressFileKb} KB`,
    target: "≤ 20 KB (archive finished milestones)",
  });
  const totalFv = claude.fixVerifyOnOpus + claude.fixVerifyOnSonnet;
  const fvOpusPct = totalFv > 0 ? round((claude.fixVerifyOnOpus / totalFv) * 100, 0) : 0;
  checks.push({
    name: "Fix-verify Opus share",
    status: fvOpusPct <= 65 ? "good" : fvOpusPct <= 85 ? "warn" : "bad",
    value: `${fvOpusPct}% (${claude.fixVerifyOnOpus}/${totalFv})`,
    target: "≤ 65% (route minor test-backed verifies to Sonnet)",
  });

  return {
    id: id || (since ? `${runName}-since-${since}` : runName),
    label: label || (since ? `${runName} (since ${since})` : runName),
    kind: "measured",
    date: date || claude.lastDate || new Date().toISOString().slice(0, 10),
    dateRange: claude.firstDate && claude.lastDate ? `${claude.firstDate}..${claude.lastDate}` : null,
    since: since || null,
    workflowCommit: workflowCommit || detectWorkflowCommit(),
    note: note || null,
    status,
    kpis,
    writers,
    hatches,
    fixRoundsDist,
    orchestratorFixups,
    findings,
    gates,
    counterReview,
    git,
    claude: {
      sessions: claude.sessions,
      subagents: claude.subagents,
      activeDays: claude.activeDays,
      orchestratorPeakCtxMax: claude.orchestratorPeakCtxMax,
      orchestratorPeakCtxAvg: claude.orchestratorPeakCtxAvg,
      orchestratorOver300k: claude.orchestratorOver300k,
      fixVerifyOnOpus: claude.fixVerifyOnOpus,
      fixVerifyOnSonnet: claude.fixVerifyOnSonnet,
      totals: {
        ...claude.totals,
        costUsd: round(claude.totals.costUsd, 2),
      },
      byModel: Object.fromEntries(
        Object.entries(claude.byModel).map(([m, b]) => [m, { ...b, costUsd: round(b.costUsd, 2) }]),
      ),
      byCategory: Object.fromEntries(
        Object.entries(claude.byCategory).map(([c, b]) => [c, { ...b, costUsd: round(b.costUsd, 2) }]),
      ),
    },
    checks,
  };
}

function fmtUsd(n) {
  if (n === null || n === undefined) return "—";
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtInt(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US");
}

function badge(status) {
  if (status === "good") return "PASS";
  if (status === "warn") return "WATCH";
  if (status === "bad") return "ACTION";
  return "INFO";
}

function shortChartLabel(run) {
  if (run.kind === "baseline") return "Baseline";
  const id = String(run.id || run.label || "");
  if (id.length <= 15) return id;
  return id.replace(/^stage-missing-features$/u, "stage-feats").replace(/^stage-templates$/u, "stage-tmpls").slice(0, 15);
}

/**
 * Render METRICS.md from a history object ({ schemaVersion, runs: [...] }).
 */
export function renderMetricsMarkdown(history) {
  const runs = history.runs || [];
  const measured = runs.filter((r) => r.kind === "measured");
  const latest = measured[measured.length - 1] || runs[runs.length - 1];
  const baseline = runs.find((r) => r.kind === "baseline");

  const lines = [];
  lines.push("# ArchFlow Workflow Metrics");
  lines.push("");
  lines.push(
    "Automated measurements of whether `/archflow-run` is meeting its goal from [PURPOSE.md](PURPOSE.md): **the best automated code for the least compute**.",
  );
  lines.push("");
  lines.push(
    "> All dollar figures are Claude-side API list prices (Sonnet 5.5 $2/$10, Opus 5.5 $4/$20, Fable 5.2 $8/$40, Haiku 5.5 $0.10/$0.50 per 1M input/output tokens, with 5-minute and 1-hour cache-write rates) computed from deduplicated Claude Code session and sub-agent transcripts. Cross-model counter-reviewer (Codex / Gemini) spend is tracked separately by call count because Codex CLI does not emit token usage in `result.json` yet.",
  );
  lines.push("");

  // Scorecard for latest run
  if (latest && latest.checks) {
    lines.push(`## Is it working? (Latest measured run: \`${latest.label}\`)`);
    lines.push("");
    lines.push("| Check | Result | Target | Status |");
    lines.push("|---|---|---|---|");
    for (const c of latest.checks) {
      lines.push(`| ${c.name} | **${c.value}** | ${c.target} | ${badge(c.status)} |`);
    }
    lines.push("");
  }

  // Cross-run comparison table
  lines.push("## Baseline & Run History");
  lines.push("");
  lines.push(
    "| Run | Dates | Tasks | Net LOC | Claude Cost | $/Task | $/1k LOC | Fable % | Review/Write | Serious Caught (/task) | Gate Escapes | Signal % | No-Decision Rows |",
  );
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of runs) {
    const k = r.kpis;
    const loc = r.git?.netTotalLoc ? fmtInt(r.git.netTotalLoc) : "—";
    const costKloc = k.costPerKlocUsd ? fmtUsd(k.costPerKlocUsd) : "—";
    const sig = k.signalRatePct !== null && k.signalRatePct !== undefined ? `${k.signalRatePct}%` : "—";
    const nd = k.noDecisionRowSharePct !== null && k.noDecisionRowSharePct !== undefined ? `${k.noDecisionRowSharePct}%` : "—";
    const rw = k.reviewToWriteRatio ? `${k.reviewToWriteRatio}x` : "—";
    lines.push(
      `| ${r.label}${r.kind === "baseline" ? " *(baseline)*" : ""} | ${r.dateRange || r.date} | ${fmtInt(k.mergedTasks)} | ${loc} | ${fmtUsd(k.totalCostUsd)} | **${fmtUsd(k.costPerTaskUsd)}** | ${costKloc} | ${k.fableSharePct}% | ${rw} | ${fmtInt(k.seriousCaught)} (${k.seriousCaughtPerTask}) | ${fmtInt(k.seriousEscapedToGates)} | ${sig} | ${nd} |`,
    );
  }
  lines.push("");

  // Mermaid charts
  if (runs.length >= 2) {
    const labels = runs.map((r) => `"${shortChartLabel(r)}"`).join(", ");
    const costPerTask = runs.map((r) => r.kpis.costPerTaskUsd).join(", ");
    const fablePct = runs.map((r) => r.kpis.fableSharePct).join(", ");
    const seriousPerTask = runs.map((r) => r.kpis.seriousCaughtPerTask).join(", ");
    const maxCost = Math.ceil(Math.max(...runs.map((r) => r.kpis.costPerTaskUsd), 16) / 2) * 2;
    const maxBugs = Math.max(1.0, round(Math.max(...runs.map((r) => r.kpis.seriousCaughtPerTask)) * 1.25, 2));

    lines.push("## Trends Over Time");
    lines.push("");
    lines.push("### Cost per merged task (USD, API list price)");
    lines.push("");
    lines.push("```mermaid");
    lines.push("xychart-beta");
    lines.push('    title "Claude API Cost per Merged Task ($)"');
    lines.push(`    x-axis [${labels}]`);
    lines.push(`    y-axis "USD / task" 0 --> ${maxCost}`);
    lines.push(`    bar [${costPerTask}]`);
    lines.push(`    line [${costPerTask}]`);
    lines.push("```");
    lines.push("");

    lines.push("### Strongest-model (Fable) share of spend (%)");
    lines.push("");
    lines.push("```mermaid");
    lines.push("xychart-beta");
    lines.push('    title "Share of Claude Spend on Strongest Model (Fable %)"');
    lines.push(`    x-axis [${labels}]`);
    lines.push('    y-axis "Percent (%)" 0 --> 55');
    lines.push(`    bar [${fablePct}]`);
    lines.push(`    line [${fablePct}]`);
    lines.push("```");
    lines.push("");

    lines.push("### Serious defects (critical + major) caught before merge per task");
    lines.push("");
    lines.push("```mermaid");
    lines.push("xychart-beta");
    lines.push('    title "Serious Defects Caught Before Merge per Task"');
    lines.push(`    x-axis [${labels}]`);
    lines.push(`    y-axis "Serious bugs / task" 0 --> ${maxBugs}`);
    lines.push(`    bar [${seriousPerTask}]`);
    lines.push("```");
    lines.push("");
  }

  // Deep breakdown of the latest measured run
  if (latest && latest.kind === "measured") {
    const k = latest.kpis;
    lines.push(`## Spend & Token Breakdown (\`${latest.label}\`)`);
    lines.push("");
    lines.push("```mermaid");
    lines.push("xychart-beta");
    lines.push(`    title "Where Claude Spend Went — ${latest.label} ($)"`);
    lines.push('    x-axis ["Planning", "Plan Rev", "Implement", "Code Fix", "Review+Gate", "Orchestrator"]');
    const buckets = [k.planningInitCostUsd, k.planningRevisionCostUsd, k.implementCostUsd, k.fixCostUsd, k.reviewCostUsd, k.orchestratorCostUsd];
    const maxB = Math.ceil(Math.max(...buckets, 50) / 50) * 50;
    lines.push(`    y-axis "USD" 0 --> ${maxB}`);
    lines.push(`    bar [${buckets.join(", ")}]`);
    lines.push("```");
    lines.push("");

    lines.push("| Phase | Cost (USD) | Share | Total Tokens (incl. cache) | What it covers |");
    lines.push("|---|---:|---:|---:|---|");
    const pct = (v) => (k.totalCostUsd > 0 ? `${round((v / k.totalCostUsd) * 100, 1)}%` : "0%");
    lines.push(
      `| **Planning (initial + detail)** | ${fmtUsd(k.planningInitCostUsd)} | ${pct(k.planningInitCostUsd)} | ${round(k.planningTokensM - k.planningRevisionTokensM, 1)}M | Haiku explorers, research, Fable first plan, milestone detailing |`,
    );
    lines.push(
      `| **Plan revisions** | ${fmtUsd(k.planningRevisionCostUsd)} | ${pct(k.planningRevisionCostUsd)} | ${k.planningRevisionTokensM}M | STOP pivots, counter-review plan revisions, plan vets |`,
    );
    lines.push(
      `| **Implementation (first pass)** | ${fmtUsd(k.implementCostUsd)} | ${pct(k.implementCostUsd)} | ${k.implementTokensM}M | Fresh worktree implementers (${latest.writers.sonnet} Sonnet, ${latest.writers.opusHatch} Opus hatch) |`,
    );
    lines.push(
      `| **Code revisions (fix rounds)** | ${fmtUsd(k.fixCostUsd)} | ${pct(k.fixCostUsd)} | ${k.fixTokensM}M | Fresh fixers resolving task review & delta findings |`,
    );
    lines.push(
      `| **Reviews, fix-verify & gates** | ${fmtUsd(k.reviewCostUsd)} | ${pct(k.reviewCostUsd)} | ${k.reviewTokensM}M | Opus/Fable task reviews, fix verifies, merges, gate lenses, deferrals |`,
    );
    lines.push(
      `| **Orchestrator** | ${fmtUsd(k.orchestratorCostUsd)} | ${pct(k.orchestratorCostUsd)} | ${k.orchestratorTokensM}M | ${latest.claude.sessions} Opus sessions (avg peak ${Math.round(latest.claude.orchestratorPeakCtxAvg / 1000)}k ctx) |`,
    );
    lines.push(
      `| **Total** | **${fmtUsd(k.totalCostUsd)}** | **100%** | **${round((latest.claude.totals.inputTokens + latest.claude.totals.cacheReadTokens + latest.claude.totals.cacheWriteTokens + latest.claude.totals.outputTokens) / 1_000_000, 1)}M** | ${fmtInt(k.mergedTasks)} tasks · ${fmtInt(latest.git.netTotalLoc)} net LOC (${fmtInt(latest.git.netSourceLoc)} src + ${fmtInt(latest.git.netTestLoc)} tests) |`,
    );
    lines.push("");

    // Counterfactual section
    const cf = k.counterfactual;
    lines.push(`## With ArchFlow vs. Estimated Without Workflow (\`${latest.label}\`)`);
    lines.push("");
    lines.push("This is an explicit, transparent guesstimate — not an exact controlled A/B test:");
    lines.push("");
    lines.push("| Scenario | Estimated Claude Cost | Notes |");
    lines.push("|---|---:|---|");
    lines.push(
      `| **Unreviewed direct Opus coding (floor)** | ~${fmtUsd(cf.unreviewedOpusFloorUsd)} | Scales first-pass implementation to Opus rates + 25% ad-hoc steering; assumes **zero** independent review and ships with defects unscreened. |`,
    );
    lines.push(
      `| **Direct coding + ad-hoc QA/bug-fix tax** | ~${fmtUsd(cf.debugAdjustedLowUsd)}–${fmtUsd(cf.debugAdjustedHighUsd)} | Assumes 30–50% of the ${k.seriousCaught} serious defects caught before merge would otherwise surface later at ~$10–$12 of Opus debug turns each, **not counting human QA/debugging hours**. |`,
    );
    lines.push(
      `| **Actual ArchFlow run** | **${fmtUsd(k.totalCostUsd)}** | **${cf.workflowOverheadRatio}×** the unreviewed coding floor; caught **${k.seriousCaught} serious defects** (${latest.findings.critical} critical, ${latest.findings.major} major) and **${latest.findings.minor} minors** before merge (~${fmtUsd(cf.costPerSeriousBugUsd)} of verification overhead per serious defect prevented). |`,
    );
    lines.push("");

    // Defect catch origin table
    const orig = latest.findings.byOrigin;
    lines.push(`## Who Catches the Bugs? (\`${latest.label}\`)`);
    lines.push("");
    lines.push("| Catch Origin | Critical | Major | Minor | Takeaway |");
    lines.push("|---|---:|---:|---:|---|");
    lines.push(
      `| In-model review only (\`self\`) | ${orig.in_model_only.critical} | ${orig.in_model_only.major} | ${orig.in_model_only.minor} | Opus/Fable reviewers probing real builds & invariants |`,
    );
    lines.push(
      `| Both families (\`self+counter/tests\`) | ${orig.both.critical} | ${orig.both.major} | ${orig.both.minor} | High-confidence corroborated defects |`,
    );
    lines.push(
      `| Cross-model only (\`counter\` / \`tests\`) | ${orig.cross_model_only.critical} | ${orig.cross_model_only.major} | ${orig.cross_model_only.minor} | Caught exclusively by opposite-family review (${k.crossModelOnlyMajorSharePct}% of majors, ${k.crossModelOnlyMinorSharePct}% of minors) |`,
    );
    lines.push(
      `| Structure pass (\`structure\`) | ${orig.structure.critical} | ${orig.structure.major} | ${orig.structure.minor} | Codebase organization findings (${k.structureFindingsPerTask}/task) |`,
    );
    lines.push("");

    if (latest.counterReview.total > 0) {
      lines.push(
        `Cross-model counter-review reliability: **${latest.counterReview.total - latest.counterReview.failures}/${latest.counterReview.total}** succeeded (${round(((latest.counterReview.total - latest.counterReview.failures) / latest.counterReview.total) * 100, 1)}%), raising issues on **${latest.counterReview.issuesFound}/${latest.counterReview.total}** packets (including **${latest.counterReview.deltaIssuesFound}/${latest.counterReview.taskDelta}** post-fix delta reviews).`,
      );
      lines.push("");
    }
  }

  // Per-milestone progression for latest run if multi-milestone
  if (latest?.findings?.byMilestone && Object.keys(latest.findings.byMilestone).length > 1) {
    lines.push(`## Milestone Progression (\`${latest.label}\`)`);
    lines.push("");
    lines.push("| Milestone | Tasks | Critical | Major | Minor | Structure (/task) |");
    lines.push("|---|---:|---:|---:|---:|---:|");
    for (const [ms, m] of Object.entries(latest.findings.byMilestone).sort()) {
      const spt = m.tasks > 0 ? round(m.structure / m.tasks, 2) : 0;
      lines.push(`| ${ms} | ${m.tasks} | ${m.critical} | ${m.major} | ${m.minor} | ${m.structure} (${spt}) |`);
    }
    lines.push("");
  }

  if (baseline) {
    lines.push("## Reproducing & Updating This Report");
    lines.push("");
    lines.push("Measure any `/archflow-run` directory (and optionally append it to `metrics/history.json` and regenerate this file):");
    lines.push("");
    lines.push("```bash");
    lines.push("# Inspect a run without writing files");
    lines.push("npm run metrics -- --run /path/to/repo/.archflow/runs/<name>");
    lines.push("");
    lines.push("# Record the run into metrics/history.json and refresh METRICS.md");
    lines.push("npm run metrics -- --run /path/to/repo/.archflow/runs/<name> --record --render");
    lines.push("");
    lines.push("# Measure only sessions/reviews after a workflow change and compare before vs. after");
    lines.push('npm run metrics -- --run /path/to/repo/.archflow/runs/<name> --since YYYY-MM-DD --id <slug> --note "<change>" --record --render');
    lines.push("npm run metrics -- --compare baseline-2026-11-18 3d-model-tool");
    lines.push("```");
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Compare two recorded runs and return directional deltas for every key KPI.
 */
export function compareRuns(beforeRun, afterRun) {
  const bk = beforeRun.kpis || {};
  const ak = afterRun.kpis || {};
  const metrics = [
    { key: "costPerTaskUsd", label: "Cost / merged task ($)", lowerIsBetter: true, unit: "$" },
    { key: "costPerKlocUsd", label: "Cost / 1k net LOC ($)", lowerIsBetter: true, unit: "$" },
    { key: "fableSharePct", label: "Fable share of spend (%)", lowerIsBetter: true, unit: "%" },
    { key: "reviewToWriteRatio", label: "Review / write ratio (x)", lowerIsBetter: true, unit: "x" },
    { key: "seriousCaughtPerTask", label: "Serious bugs caught / task", lowerIsBetter: null, unit: "" },
    { key: "seriousEscapedToGates", label: "Serious bugs escaped to gates", lowerIsBetter: true, unit: "" },
    { key: "signalRatePct", label: "Review signal rate (%)", lowerIsBetter: false, unit: "%" },
    { key: "noDecisionRowSharePct", label: "No-decision review rows (%)", lowerIsBetter: true, unit: "%" },
    { key: "progressFileKb", label: "PROGRESS.md size (KB)", lowerIsBetter: true, unit: " KB" },
  ];
  const rows = [];
  for (const m of metrics) {
    const bv = bk[m.key];
    const av = ak[m.key];
    if (bv === undefined || bv === null || av === undefined || av === null) continue;
    if ((m.key === "costPerKlocUsd") && (bv === 0 || av === 0)) continue;
    const delta = round(av - bv, 2);
    const pct = bv !== 0 ? round(((av - bv) / Math.abs(bv)) * 100, 1) : null;
    let verdict = "INFO";
    if (m.lowerIsBetter !== null) {
      if (Math.abs(delta) < 0.01) verdict = "SAME";
      else if ((m.lowerIsBetter && delta < 0) || (!m.lowerIsBetter && delta > 0)) verdict = "IMPROVED";
      else verdict = "REGRESSED";
    }
    rows.push({ ...m, before: bv, after: av, delta, pct, verdict });
  }
  return {
    before: { id: beforeRun.id, label: beforeRun.label, date: beforeRun.date, tasks: bk.mergedTasks, workflowCommit: beforeRun.workflowCommit ?? null },
    after: { id: afterRun.id, label: afterRun.label, date: afterRun.date, tasks: ak.mergedTasks, workflowCommit: afterRun.workflowCommit ?? null },
    rows,
  };
}

function formatComparisonText(cmp) {
  const lines = [];
  lines.push(`\nComparison: ${cmp.before.label} (${cmp.before.tasks} tasks)  →  ${cmp.after.label} (${cmp.after.tasks} tasks)`);
  lines.push("─".repeat(84));
  for (const r of cmp.rows) {
    const sign = r.delta > 0 ? "+" : "";
    const pctStr = r.pct !== null ? ` (${sign}${r.pct}%)` : "";
    lines.push(
      `  [${r.verdict.padEnd(9)}] ${r.label.padEnd(32)} ${String(r.before).padStart(7)}${r.unit}  →  ${String(r.after).padStart(7)}${r.unit}   ${sign}${r.delta}${r.unit}${pctStr}`,
    );
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = {
    run: null,
    repos: [],
    claudeDir: null,
    baseRef: "main",
    since: null,
    note: null,
    workflowCommit: null,
    id: null,
    label: null,
    date: null,
    record: null,
    render: null,
    compare: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--run") opts.run = argv[++i];
    else if (a === "--repo") opts.repos.push(argv[++i]);
    else if (a === "--claude-dir") opts.claudeDir = argv[++i];
    else if (a === "--base") opts.baseRef = argv[++i];
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "--note") opts.note = argv[++i];
    else if (a === "--workflow-rev") opts.workflowCommit = argv[++i];
    else if (a === "--id") opts.id = argv[++i];
    else if (a === "--label") opts.label = argv[++i];
    else if (a === "--date") opts.date = argv[++i];
    else if (a === "--compare") opts.compare = [argv[++i], argv[++i]];
    else if (a === "--json") opts.json = true;
    else if (a === "--record") {
      opts.record = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "metrics/history.json";
    } else if (a === "--render") {
      opts.render = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "METRICS.md";
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/measure-run.mjs --run <run-dir> [--repo <path>]... [--since YYYY-MM-DD] [--note <text>] [--id <slug>] [--label <name>] [--record [metrics/history.json]] [--render [METRICS.md]] [--compare <idA> <idB>] [--json]",
      );
      process.exit(0);
    }
  }
  return opts;
}

function printHumanSummary(m) {
  const k = m.kpis;
  console.log(`\nArchFlow Run Metrics: ${m.label} (${m.dateRange || m.date}, ${m.status})`);
  console.log("─".repeat(72));
  console.log(
    `Tasks merged: ${k.mergedTasks} | Net LOC: ${fmtInt(m.git.netTotalLoc)} (${fmtInt(m.git.netSourceLoc)} src + ${fmtInt(m.git.netTestLoc)} tests)`,
  );
  console.log(
    `Claude API cost: ${fmtUsd(k.totalCostUsd)} (${fmtUsd(k.costPerTaskUsd)}/task, ${fmtUsd(k.costPerKlocUsd)}/1k LOC, ${k.tokensPerTaskM}M tok/task)`,
  );
  console.log(
    `Model mix: Opus ${k.opusSharePct}% | Sonnet ${k.sonnetSharePct}% | Fable ${k.fableSharePct}% | Haiku ${k.haikuSharePct}%`,
  );
  console.log(
    `Phases: Planning ${fmtUsd(k.planningInitCostUsd)} + PlanRev ${fmtUsd(k.planningRevisionCostUsd)} | Impl ${fmtUsd(k.implementCostUsd)} | Fix ${fmtUsd(k.fixCostUsd)} | Review+Gate ${fmtUsd(k.reviewCostUsd)} | Orch ${fmtUsd(k.orchestratorCostUsd)}`,
  );
  console.log(
    `Defects caught before merge: ${m.findings.critical} crit, ${m.findings.major} maj (${k.seriousCaughtPerTask}/task), ${m.findings.minor} min | Gate escapes: ${k.seriousEscapedToGates} | Signal: ${k.signalRatePct ?? "n/a"}%`,
  );
  console.log(
    `Without-workflow guesstimate: ~${fmtUsd(k.counterfactual.unreviewedOpusFloorUsd)} (unreviewed floor) to ~${fmtUsd(k.counterfactual.debugAdjustedLowUsd)}–${fmtUsd(k.counterfactual.debugAdjustedHighUsd)} (with ad-hoc debug tax)`,
  );
  console.log("\nHealth checks:");
  for (const c of m.checks) {
    console.log(`  [${badge(c.status).padEnd(6)}] ${c.name}: ${c.value} (target: ${c.target})`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const historyPath = resolve(opts.record || "metrics/history.json");
  let history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : { schemaVersion: 1, runs: [] };

  let measurement = null;
  if (opts.run) {
    measurement = measureRun({
      runDir: opts.run,
      repoDirs: opts.repos,
      claudeProjectDir: opts.claudeDir,
      baseRef: opts.baseRef,
      since: opts.since,
      note: opts.note,
      workflowCommit: opts.workflowCommit,
      id: opts.id,
      label: opts.label,
      date: opts.date,
    });
    if (opts.record) {
      const idx = history.runs.findIndex((r) => r.id === measurement.id);
      if (idx >= 0) history.runs[idx] = measurement;
      else history.runs.push(measurement);
      mkdirSync(dirname(historyPath), { recursive: true });
      writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
    }
  }

  if (opts.render) {
    const outPath = resolve(opts.render);
    writeFileSync(outPath, renderMetricsMarkdown(history), "utf8");
    if (!opts.json) console.log(`Rendered ${outPath}`);
  }

  if (opts.compare) {
    const [idA, idB] = opts.compare;
    const runA = history.runs.find((r) => r.id === idA);
    const runB = history.runs.find((r) => r.id === idB);
    if (!runA || !runB) {
      console.error(`Run id not found in ${historyPath}: ${!runA ? idA : idB}`);
      process.exit(1);
    }
    const cmp = compareRuns(runA, runB);
    if (opts.json) console.log(JSON.stringify(cmp, null, 2));
    else console.log(formatComparisonText(cmp));
  } else if (measurement) {
    if (opts.json) console.log(JSON.stringify(measurement, null, 2));
    else printHumanSummary(measurement);
  } else if (!opts.render) {
    console.error("Provide --run <run-dir>, --compare <idA> <idB>, and/or --render [METRICS.md]. Use --help for options.");
    process.exit(1);
  }
}
