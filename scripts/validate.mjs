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

// The engine version each piece of vocabulary first appeared in. A plugin
// using one of these while declaring an older `engine` range still installs on
// applications that predate it — which reject it as *invalid*, sending users
// hunting for a fault in a plugin that is perfectly correct.
const FEATURE_ENGINE = new Map([
  ["apiRequest", [1, 1, 0]],
  ["extractAll.items", [1, 1, 0]],
]);

const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function requiredEngineFloor(steps, plugin) {
  // Declaring an API transport is itself 1.2.0 vocabulary.
  let floor = plugin?.api ? [1, 2, 0] : [1, 0, 0];
  for (const [step] of steps) {
    const features = [step.action];
    if (step.action === "extractAll" && step.items !== undefined) {
      features.push("extractAll.items");
    }
    for (const feature of features) {
      const introduced = FEATURE_ENGINE.get(feature);
      if (introduced && compareVersions(introduced, floor) > 0) floor = introduced;
    }
  }
  return floor;
}

// Only ">=x.y.z" is worth reasoning about here; anything else the schema
// already constrains, and a stricter range cannot admit an older engine.
function admitsEngine(range, version) {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range ?? "");
  if (!match) return false;
  return compareVersions(match.slice(1).map(Number), version) <= 0;
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

  const floor = requiredEngineFloor(steps, plugin);
  if (compareVersions(floor, [1, 0, 0]) > 0 && admitsEngine(plugin.engine, [1, 0, 0])) {
    fail(name, `uses vocabulary introduced in engine ${floor.join(".")} `
             + `but '${plugin.engine}' also admits older engines`,
         `Set "engine": ">=${floor.join(".")}".`);
  }

  // Check 4: every host the plugin navigates to must be declared.
  for (const [step, path] of steps) {
    if (!["navigate", "downloadPdf", "apiRequest"].includes(step.action)) continue;
    let url = step.url ?? "";
    if (url.includes("{{")) continue;
    // A relative path inherits the API's host, which is checked in its own right.
    if (plugin.api?.baseUrl && url.startsWith("/")) {
      url = plugin.api.baseUrl.replace(/\/+$/, "") + url;
    }
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
    if (["navigate", "apiRequest"].includes(step.action) && !url.startsWith("https://")) {
      fail(name, `${path}: ${step.action} must use https`);
    }
  }

  // --- steps ---------------------------------------------------------------
  for (const [step, path] of steps) {
    if (step.action === "extractAll") {
      if (!step.selector && !step.items) {
        fail(name, `${path}: extractAll needs either 'selector' or 'items'`,
             "'selector' walks the page; 'items' walks a JSON list from apiRequest.");
      }
      if (step.selector && step.items) {
        fail(name, `${path}: extractAll takes 'selector' or 'items', not both`);
      }
    }
    if (step.action === "apiRequest" && step.method
        && !["GET", "POST"].includes(step.method.toUpperCase())) {
      fail(name, `${path}: only GET and POST are allowed`,
           "A collector does not modify a portal.");
    }
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

  // --- the API transport ---------------------------------------------------
  if (plugin.api) {
    const BROWSER_ONLY = new Set([
      "navigate", "waitForURL", "waitForElement", "waitForNavigation", "waitForNetworkIdle",
      "click", "type", "dropdownSelect", "runJs", "checkElementExists", "checkURL",
      "extractNetworkResponse", "waitForPdfDownload", "printPdf", "downloadBase64Pdf",
    ]);
    for (const [step, path] of steps) {
      if (BROWSER_ONLY.has(step.action)) {
        fail(name, `${path}: '${step.action}' needs a browser, and this plugin declares an API`,
             "API plugins use apiRequest, extractAll over items, extract and downloadPdf.");
      }
    }
    if (plugin.startAuth !== undefined) {
      fail(name, "an API plugin has no interactive sign-in",
           "Credentials are entered once; remove startAuth.");
    }

    const auth = plugin.api.auth;
    if (auth?.type === "signature") {
      if (!auth.signature) fail(name, "a signed API needs a signature recipe");
      else if (/^hmac/.test(auth.signature.algorithm ?? "") && !auth.signature.key) {
        fail(name, `${auth.signature.algorithm} needs a key`);
      }
    }
    if (auth?.type === "oauth2ClientCredentials" && !auth.token) {
      fail(name, "OAuth2 needs a token endpoint");
    }
    if (auth?.type === "basic" && (!auth.username || !auth.password)) {
      fail(name, "basic authentication needs a username and a password");
    }

    // Every host the transport itself reaches is subject to the sandbox too.
    for (const [raw, where] of [
      [plugin.api.baseUrl, "api.baseUrl"],
      [auth?.time?.url, "api.auth.time.url"],
      [auth?.token?.url, "api.auth.token.url"],
    ]) {
      if (!raw || raw.includes("{{")) continue;
      let host;
      try {
        host = new URL(raw).hostname.toLowerCase();
      } catch {
        fail(name, `${where}: '${raw}' is not a URL`);
        continue;
      }
      if (!domainAllows(domains, host)) {
        fail(name, `${where}: ${host} is not in allowedDomains`,
             "The sandbox applies to API calls too.");
      }
    }

    // Only a password field reaches the Keychain; anything else sits in the
    // database in clear.
    for (const [key, field] of Object.entries(plugin.configSchema ?? {})) {
      const looksSecret = ["secret", "password", "token", "consumerkey", "privatekey", "apikey"]
        .some((needle) => key.toLowerCase().includes(needle));
      if (looksSecret && field.type !== "password" && field.type !== "totp") {
        fail(name, `configSchema.${key}: '${key}' looks like a credential but is not a password field`,
             "Only password fields reach the Keychain.");
      }
    }
  }

  // --- checkAuth must be able to answer no ---------------------------------
  const lastCheckAuth = (plugin.checkAuth ?? []).at(-1);
  // An API plugin verifies by making an authenticated call: a wrong key answers
  // 401, which the engine reports as "credentials refused". There is no URL to
  // compare and no element to find.
  const apiVerifies = plugin.api !== undefined && lastCheckAuth?.action === "apiRequest";
  if (lastCheckAuth && !apiVerifies &&
      !["checkURL", "checkElementExists", "runJs"].includes(lastCheckAuth.action)) {
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
  const status = plugin.status ?? "active";
  if (published && status === "active" && !plugin.maintainers?.length) {
    warn(name, "claims to be working but has no maintainer to tell when it stops");
  }
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
