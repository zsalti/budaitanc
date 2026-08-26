#!/usr/bin/env node

import { classifyRecoverySource } from "../src/recovery-classifier.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const payload = JSON.parse(input);
  process.stdout.write(`${JSON.stringify(classifyRecoverySource(payload))}\n`);
} catch (error) {
  process.stderr.write(`Recovery classification failed: ${error.message}\n`);
  process.exitCode = 1;
}
