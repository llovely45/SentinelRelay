import assert from "node:assert/strict";
import { compactSchemaSql } from "./worker.js";

const formatted = "\nCREATE TABLE example (\n  id INTEGER PRIMARY KEY,\n  label TEXT\n);\n";
assert.equal(
  compactSchemaSql(formatted),
  "CREATE TABLE example ( id INTEGER PRIMARY KEY, label TEXT );"
);

console.log("worker schema compaction tests passed");
