#!/usr/bin/env node
/**
 * The fast lane of the plugins CI (§9.3 of the specification).
 *
 * The authoritative validator is `irctl lint`, which is the same code the
 * application runs — but building Swift takes minutes, and a contributor who
 * misspelled a key deserves to know in twenty seconds. So this script runs the
 * structural checks that are cheap and unambiguous, and the macOS job runs the
 * real thing afterwards.
 *
 * Anything this script rejects, `irctl` rejects too. It must never be the other
 * way round: if you add a rule here, add it there first.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "schema/plugin-v1.schema.json"), "utf8"));

let errors = 0;
let warnings = 0;

const fail = (file, message, hint) => {
  errors++;
  console.log(`✗ ${file}: ${message}`);
  if (hint) console.log(`    → ${hint}`);
};
const warn = (file, message) => {
  warnings++;
  console.log(`⚠ ${file}: ${message}`);
};

// ---------------------------------------------------------------------------

const STEP_ACTIONS = new Set(
  SCHEMA.$defs.step.allOf.at(-1).properties.action.enum
);

/** Walks every step, including those nested in forEach / then / else. */
function* walkSteps(steps, path = "") {
  for (const [index, step] of (steps ?? []).entries()) {
    const here = `${path}[${index}]`;
    yield [step, here];
    yield* walkSteps(step.forEach, `${here}.forEach`);
    yield* walkSteps(step.then, `${here}.then`);
    yield* walkSteps(step.else, `${here}.else`);
  }
}

function allSteps(plugin) {
  return [
    ...walkSteps(plugin.checkAuth, "checkAuth"),
    ...walkSteps(plugin.startAuth, "startAuth"),
    ...walkSteps(plugin.getConfigOptions, "getConfigOptions"),
    ...walkSteps(plugin.getDocuments, "getDocuments"),
  ];
}

function domainAllows(patterns, host) {
  return patterns.some((pattern) =>
    pattern.startsWith("*.")
      ? host.endsWith("." + pattern.slice(2))
      : host === pattern
  );
}

// Check 3 of §9.3: things that look like a contributor's own credentials.
const SECRET_SHAPES = [
  [/(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"'{}]{6,}/i, "hard-coded password"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, "e-mail address"],
  [/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/i, "API key"],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/i, "bearer token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
];

function checkPlugin(file, raw, { published }) {
  const name = basename(file);
  let plugin;
  try {
    plugin = JSON.parse(raw);
  } catch (error) {
    fail(name, `not valid JSON — ${error.message}`);
    return null;
  }

  // --- identity ------------------------------------------------------------
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(plugin.id ?? "")) {
    fail(name, `'${plugin.id}' is not a valid id`,
         "Lowercase letters, digits and hyphens, 3 to 50 characters.");
  } else if (name !== `${plugin.id}.json`) {
    fail(name, `should be named ${plugin.id}.json`,
         "Reviewers find plugins by id; the filename has to match.");
  }

  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?$/.test(plugin.version ?? "")) {
    fail(name, `'${plugin.version}' is not a semantic version`);
  }

  for (const key of ["name", "engine", "allowedDomains", "checkAuth", "getDocuments"]) {
    if (plugin[key] === undefined) fail(name, `missing required key '${key}'`);
  }

  for (const key of Object.keys(plugin)) {
    if (!Object.hasOwn(SCHEMA.properties, key)) {
      fail(name, `unknown top-level key '${key}'`,
           `Allowed: ${Object.keys(SCHEMA.properties).join(", ")}`);
    }
  }

  // --- the sandbox ---------------------------------------------------------
  const domains = plugin.allowedDomains ?? [];
  if (domains.length === 0) {
    fail(name, "allowedDomains must not be empty",
         "Without it the plugin could navigate anywhere carrying the user's session.");
  }
  for (const domain of domains) {
    if (!/^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
      fail(name, `'${domain}' is not a valid domain pattern`);
    }
    if (domain.startsWith("*.") && domain.slice(2).split(".").length < 2) {
      fail(name, `'${domain}' is far too broad`);
    }
  }

  const steps = allSteps(plugin);

  // Check 4: every host the plugin navigates to must be declared.
  for (const [step, path] of steps) {
    if (!["navigate", "downloadPdf"].includes(step.action)) continue;
    const url = step.url ?? "";
    if (url.includes("{{")) continue;
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      fail(name, `${path}: '${url}' is not a URL`);
      continue;
    }
    if (!domainAllows(domains, host)) {
      fail(name, `${path}: navigates to ${host}, which allowedDomains does not cover`);
    }
    if (step.action === "navigate" && !url.startsWith("https://")) {
      fail(name, `${path}: navigate must use https`);
    }
  }

  // --- steps ---------------------------------------------------------------
  for (const [step, path] of steps) {
    if (!STEP_ACTIONS.has(step.action)) {
      fail(name, `${path}: unknown action '${step.action}'`,
           `Known actions: ${[...STEP_ACTIONS].join(", ")}`);
    }
    if (step.timeout !== undefined && (step.timeout < 100 || step.timeout > 120000)) {
      fail(name, `${path}: timeout must be between 100 and 120000 ms`);
    }
    if (step.action === "sleep" && (step.ms ?? 0) > 30000) {
      fail(name, `${path}: sleep is capped at 30000 ms`);
    }
    for (const field of ["value", "code", "url", "data"]) {
      const text = step[field];
      if (typeof text !== "string" || text.includes("{{")) continue;
      for (const [pattern, label] of SECRET_SHAPES) {
        if (pattern.test(text)) {
          fail(name, `${path}.${field}: looks like a hard-coded ${label}`,
               "Use {{config.<key>}} or {{secret.<key>}} and declare it in configSchema.");
        }
      }
    }
  }

  // --- checkAuth must be able to answer no ---------------------------------
  const lastCheckAuth = (plugin.checkAuth ?? []).at(-1);
  if (lastCheckAuth && !["checkURL", "checkElementExists", "runJs"].includes(lastCheckAuth.action)) {
    fail(name, "checkAuth must end in a verification step",
         "Finish with checkURL or checkElementExists.");
  }

  const emitsDocument = steps.some(([step]) =>
    ["downloadPdf", "waitForPdfDownload", "printPdf", "downloadBase64Pdf"].includes(step.action)
  );
  if (!emitsDocument) fail(name, "getDocuments never emits a document");

  // --- runJs, check 5 ------------------------------------------------------
  const usesJs = steps.some(([step]) => step.action === "runJs");
  if (usesJs && plugin.usesJs !== true) {
    fail(name, "contains runJs but does not declare usesJs: true");
  }
  if (!usesJs && plugin.usesJs === true) {
    warn(name, "usesJs is declared but no runJs step is present");
  }

  // --- config --------------------------------------------------------------
  const declared = new Set(Object.keys(plugin.configSchema ?? {}));
  const used = new Set();
  const referencePattern = /\{\{\s*(?:config|secret|totp)\.([a-zA-Z0-9_]+)/g;
  for (const match of JSON.stringify(plugin).matchAll(referencePattern)) used.add(match[1]);

  for (const key of used) {
    if (!declared.has(key)) fail(name, `uses {{…${key}}} but configSchema does not declare '${key}'`);
  }
  for (const key of declared) {
    if (!used.has(key)) warn(name, `configSchema declares '${key}' but nothing uses it`);
  }

  // --- editorial -----------------------------------------------------------
  if (published) {
    if (!plugin.country?.length) warn(name, "no country declared; hard to find in the catalogue");
    if (!plugin.description) warn(name, "no description");
    if (!plugin.maintainers?.length) warn(name, "no maintainer; it will be archived if it breaks");
  }

  return { plugin, usesJs };
}

// ---------------------------------------------------------------------------

const directories = [
  // Published to users, so the editorial warnings apply.
  { path: "plugins", published: true },
  // Structurally valid but not yet run against a live account.
  { path: "drafts", published: false },
  // The reference plugin, which is checked like any other.
  { path: "docs", published: false },
];

const seenIDs = new Map();
const flaggedForReview = [];
let count = 0;

for (const { path, published } of directories) {
  const directory = join(ROOT, path);
  if (!existsSync(directory)) continue;

  for (const file of readdirSync(directory).filter((f) => f.endsWith(".json")).sort()) {
    count++;
    const full = join(directory, file);
    const result = checkPlugin(full, readFileSync(full, "utf8"), { published });
    if (!result) continue;

    // Check 2: ids are unique across the whole repository, drafts included —
    // a draft graduating to plugins/ must not collide.
    const previous = seenIDs.get(result.plugin.id);
    if (previous) {
      fail(file, `id '${result.plugin.id}' is already used by ${previous}`);
    } else {
      seenIDs.set(result.plugin.id, `${path}/${file}`);
    }
    if (result.usesJs) flaggedForReview.push(`${path}/${file}`);
  }
}

console.log(`\n${count} plugin(s) checked — ${errors} error(s), ${warnings} warning(s)`);

if (flaggedForReview.length > 0) {
  console.log(`\nNeeds human review (contains runJs): ${flaggedForReview.join(", ")}`);
  // Surfaced to the workflow so it can label the pull request.
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `needs_review=${flaggedForReview.join(" ")}\n`);
  }
}

process.exit(errors > 0 ? 1 : 0);
