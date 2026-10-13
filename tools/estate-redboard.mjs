#!/usr/bin/env node
/**
 * estate-redboard.mjs — the network sees its own red (R324-FIX-MAIN).
 *
 * Honest by construction: every verdict comes from the GitHub API, every
 * transition is appended to the issue body, every board is committed as
 * evidence. The board NEVER exits non-zero — a red board that emails per run
 * is exactly the flood we are burying (T-77). The issue is the loud channel.
 *
 * Zero dependencies. Node >= 18.
 */
import fs from "fs";
import path from "path";

const OWNER = "roshpinacare-sys";
const TOKEN = process.env.PAT || "";
const ISSUE_TOKEN = process.env.ISSUE_TOKEN || TOKEN;
const API = "https://api.github.com";
const STATE_FILE = "state/redboard.json";
const ISSUE_TITLE = "estate red board — the network's live red set";
const WINDOW_MIN = 95;

const H = (t) => ({
  Authorization: `Bearer ${t}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "estate-redboard",
});

async function api(url, token = TOKEN) {
  const res = await fetch(url, { headers: H(token) });
  const json = await res.json().catch(() => null);
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
    throw new Error(`rate-limit at ${url}`);
  return { status: res.status, json };
}

async function allRepos() {
  const out = [];
  for (let p = 1; ; p++) {
    const { status, json } = await api(`${API}/user/repos?per_page=100&page=${p}&sort=pushed`);
    if (status !== 200 || !Array.isArray(json) || json.length === 0) break;
    out.push(...json);
    if (json.length < 100) break;
  }
  return out;
}

function redKey(r) { return `${r.repo}|${r.workflow}`; }

async function scan() {
  const repos = await allRepos();
  const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();
  const red = new Map();
  const stale = [];
  const skipped = [];
  for (const r of repos) {
    const { status, json } = await api(
      `${API}/repos/${OWNER}/${r.name}/actions/runs?per_page=60&created=>=${since.slice(0,19)}`);
    if (status !== 200 || !Array.isArray(json.workflow_runs)) {
      skipped.push({ repo: r.name, why: `runs API ${status}` });
      continue;
    }
    const byWf = new Map();
    for (const run of json.workflow_runs) {
      const w = byWf.get(run.name) || { conclusions: [], lastAt: null, lastRun: null };
      w.conclusions.push(run.conclusion);
      if (!w.lastAt || run.created_at > w.lastAt) { w.lastAt = run.created_at; w.lastRun = run; }
      byWf.set(run.name, w);
    }
    for (const [wf, w] of byWf) {
      const fails = w.conclusions.filter((c) => c === "failure").length;
      const last = w.lastRun?.conclusion;
      // RED = latest run is a failure INSIDE the scan window (the board measures the PRESENT).
      // A failure older than the window with no newer run = STALE (tracked, not alarmed) —
      // this is how covenanted/disabled flows (T-77 if:false) age out honestly.
      if (last === "failure") {
        const fresh = new Date(w.lastAt) >= new Date(since);
        const entry = {
          repo: r.name, workflow: wf, failsInWindow: fails,
          lastAt: w.lastAt, url: w.lastRun?.html_url || "",
        };
        if (fresh) red.set(`${r.name}|${wf}`, entry);
        else stale.push(entry);
      }
    }
  }
  return { red, stale, skipped, reposScanned: repos.length };
}

function prevBoard() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { redKeys: [], transitions: [] }; }
}

async function upsertIssue(body) {
  // find the ONE open tracking issue (search by exact title)
  const l = await api(`${API}/repos/${OWNER}/sovereign-lighthouse/issues?state=open&per_page=100`, ISSUE_TOKEN);
  let num = (Array.isArray(l.json) ? l.json : []).find((i) => i.title === ISSUE_TITLE)?.number;
  if (!num) {
    const c = await fetch(`${API}/repos/${OWNER}/sovereign-lighthouse/issues`, {
      method: "POST", headers: H(ISSUE_TOKEN), "Content-Type": "application/json",
      body: JSON.stringify({ title: ISSUE_TITLE, body, labels: ["estate", "red-board"] }),
    });
    return c.json();
  }
  await fetch(`${API}/repos/${OWNER}/sovereign-lighthouse/issues/${num}`, {
    method: "PATCH", headers: H(ISSUE_TOKEN), "Content-Type": "application/json",
    body: JSON.stringify({ body }),
  });
  return { number: num, updated: true };
}

function render(red, transitions, meta, stale) {
  const L = [];
  L.push(`**${new Date().toISOString()}** — ${meta.reposScanned} repos scanned (window ${WINDOW_MIN}min) · red=${red.size}`);
  L.push("");
  if (red.size === 0) {
    L.push("✅ **estate clean — no workflow's latest run is red.**");
  } else {
    L.push("| repo | workflow | fails/95m | last red |");
    L.push("|---|---|---|---|");
    for (const r of [...red.values()].sort((a, b) => a.repo.localeCompare(b.repo)))
      L.push(`| ${r.repo} | ${r.workflow} | ${r.failsInWindow} | ${r.lastAt} |`);
  }
  if (stale?.length) {
    L.push("", "### stale (last run failed before the window; no newer run — covenanted or dormant)");
    for (const r of stale) L.push(`- \`${r.repo}|${r.workflow}\` — last red ${r.lastAt}`);
  }
  if (transitions.length) {
    L.push("", "### transitions (state-based alerting — the only history that matters)");
    for (const t of transitions.slice(0, 12))
      L.push(`- ${t.at} · **${t.kind}** · \`${t.key}\``);
  }
  if (meta.skipped.length) {
    L.push("", "### skipped honestly");
    for (const s of meta.skipped) L.push(`- ${s.repo} — ${s.why}`);
  }
  L.push("", "_evidence: `state/redboard.json` committed every scan · board exits 0 always — this issue is the alarm._");
  return L.join("\n");
}

async function main() {
  const at = new Date().toISOString();
  const { red, stale, skipped, reposScanned } = await scan();
  const prev = prevBoard();
  const prevSet = new Set(prev.redKeys || []);
  const curSet = new Set([...red.keys()]);
  const transitions = [...(prev.transitions || [])];
  let changed = false;
  for (const k of curSet) if (!prevSet.has(k)) { transitions.unshift({ at, kind: "NEW-RED", key: k }); changed = true; }
  for (const k of prevSet) if (!curSet.has(k)) { transitions.unshift({ at, kind: "RECOVERED", key: k }); changed = true; }
  const trimmed = transitions.slice(0, 50);

  const board = {
    schema: "estate-redboard/1", at,
    redKeys: [...curSet],
    red: Object.fromEntries([...red.entries()]),
    stale,
    transitions: trimmed,
  };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(board, null, 1) + "\n");

  const body = render(red, trimmed, { reposScanned, skipped }, stale);
  let issue = "not-touched";
  try { issue = await upsertIssue(body); } catch (e) { issue = `issue-error: ${e.message}`; }

  console.log(`redboard: red=${red.size} changed=${changed} issue=${typeof issue === "object" ? `#${issue.number}` : issue} at=${at}`);
  // anti-flood law: exit 0 ALWAYS — the commit + issue are the alarms
}

main().catch((e) => {
  console.error(`redboard crashed: ${e.message}`);
  try { fs.mkdirSync("state", { recursive: true }); fs.writeFileSync(STATE_FILE,
    JSON.stringify({ schema: "estate-redboard/1", at: new Date().toISOString(), crashed: true, error: e.message }, null, 1)); } catch {}
  process.exit(0);
});
