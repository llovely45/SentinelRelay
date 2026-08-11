import assert from "node:assert/strict";
import fs from "node:fs";
import { compactSchemaSql } from "./worker.js";

const formatted = "\nCREATE TABLE example (\n  id INTEGER PRIMARY KEY,\n  label TEXT\n);\n";
assert.equal(
  compactSchemaSql(formatted),
  "CREATE TABLE example ( id INTEGER PRIMARY KEY, label TEXT );"
);

const workerSource = fs.readFileSync(new URL("./worker.js", import.meta.url), "utf8");
assert.doesNotMatch(workerSource, /隐私与指纹说明/);
assert.doesNotMatch(workerSource, /class="privacy-notice"/);
assert.doesNotMatch(workerSource, /信号采集失败不会阻止验证/);

console.log("worker schema and verification page tests passed");
