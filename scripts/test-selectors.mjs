#!/usr/bin/env node
/**
 * §5.4.4: run each plugin's extraction selectors against anonymised HTML
 * captures, so a portal redesign is caught here rather than by a user on the
 * 5th of the month.
 *
 * A capture lives at tests/<plugin-id>/<name>.html with an expectations file
 * tests/<plugin-id>/<name>.json:
 *
 *   { "step": "getDocuments[1]", "minimumRows": 3,
 *     "fields": { "number": "F-2026-001" } }
 */
import { parseHTML } from "linkedom";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

let failures = 0;
let checked = 0;

function findStep(plugin, path) {
  const match = /^([a-zA-Z]+)\[(\d+)\]$/.exec(path);
  if (!match) return null;
  return plugin[match[1]]?.[Number(match[2])] ?? null;
}

function query(root, selector) {
  if (!selector) return root;
  if (selector.startsWith("text=")) {
    const needle = selector.slice(5).trim().toLowerCase();
    return [...root.querySelectorAll("a,button,span,div,td,li,label")].find(
      (element) => (element.textContent || "").trim().toLowerCase().includes(needle)
    ) ?? null;
  }
  if (selector.startsWith("xpath=")) return null; // not supported offline
  return root.querySelector(selector);
}

function read(element, attribute) {
  if (!element) return null;
  if (!attribute) return (element.textContent || "").trim();
  return element.getAttribute(attribute);
}

if (!existsSync("tests")) {
  console.log("No captures yet. Add one under tests/<plugin-id>/ — see CONTRIBUTING.md.");
  process.exit(0);
}

for (const id of readdirSync("tests")) {
  const directory = join("tests", id);
  // docs/ holds the reference plugin, which has a capture so that this
  // harness is itself exercised on every run.
  const pluginPath = ["plugins", "drafts", "docs"]
    .map((d) => join(d, `${id}.json`))
    .find(existsSync);

  if (!pluginPath) {
    console.log(`✗ tests/${id}: no plugin with that id`);
    failures++;
    continue;
  }
  const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));

  for (const file of readdirSync(directory).filter((f) => f.endsWith(".json"))) {
    const expectation = JSON.parse(readFileSync(join(directory, file), "utf8"));
    const html = readFileSync(join(directory, file.replace(/\.json$/, ".html")), "utf8");
    const { document } = parseHTML(html);
    checked++;

    const step = findStep(plugin, expectation.step);
    if (!step || step.action !== "extractAll") {
      console.log(`✗ ${id}/${file}: ${expectation.step} is not an extractAll step`);
      failures++;
      continue;
    }

    const rows = [...document.querySelectorAll(step.selector)];
    if (rows.length < (expectation.minimumRows ?? 1)) {
      console.log(`✗ ${id}/${file}: '${step.selector}' matched ${rows.length} row(s), expected at least ${expectation.minimumRows ?? 1}`);
      failures++;
      continue;
    }

    let rowFailures = 0;
    for (const [key, expected] of Object.entries(expectation.fields ?? {})) {
      const spec = step.fields?.[key];
      if (!spec) {
        console.log(`✗ ${id}/${file}: the step declares no field '${key}'`);
        rowFailures++;
        continue;
      }
      const actual = read(query(rows[0], spec.selector), spec.attribute);
      if (actual !== expected) {
        console.log(`✗ ${id}/${file}: field '${key}' read "${actual}", expected "${expected}"`);
        rowFailures++;
      }
    }
    if (rowFailures === 0) console.log(`✓ ${id}/${file}: ${rows.length} row(s)`);
    failures += rowFailures;
  }
}

console.log(`\n${checked} capture(s) checked, ${failures} failing`);
process.exit(failures > 0 ? 1 : 0);
