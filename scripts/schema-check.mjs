#!/usr/bin/env node
/** Validates every plugin against the published JSON Schema. */
// The schema is draft 2020-12, which is Ajv's separate entry point.
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const schema = JSON.parse(readFileSync("schema/plugin-v1.schema.json", "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

let failures = 0;
let count = 0;

for (const directory of ["plugins", "drafts", "docs"]) {
  if (!existsSync(directory)) continue;
  for (const file of readdirSync(directory).filter((f) => f.endsWith(".json")).sort()) {
    count++;
    const path = join(directory, file);
    const plugin = JSON.parse(readFileSync(path, "utf8"));
    if (validate(plugin)) continue;

    failures++;
    console.log(`✗ ${path}`);
    // Ajv reports every branch of the step union; only the ones naming a real
    // path are useful to a contributor.
    const seen = new Set();
    for (const error of validate.errors ?? []) {
      const line = `    ${error.instancePath || "/"} ${error.message}`;
      if (seen.has(line)) continue;
      seen.add(line);
      console.log(line);
    }
  }
}

console.log(`\n${count} plugin(s) checked against the schema, ${failures} failing`);
process.exit(failures > 0 ? 1 : 0);
