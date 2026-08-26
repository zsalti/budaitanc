#!/usr/bin/env node

import { buildRecoveryEmailRows } from "../src/recovery-classifier.js";
import { EMAIL_OUTPUT_HEADERS } from "../src/worker.js";

// stdin yields Buffers by default. Concatenating those buffers as strings can
// corrupt a multi-byte UTF-8 character when it lands on a chunk boundary
// (for example, "Zóra" became "Z��ra" in repeated recovery builds).
// Let Node's streaming decoder carry incomplete characters across chunks.
process.stdin.setEncoding("utf8");

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const payload = JSON.parse(input);
  const result = await buildRecoveryEmailRows(payload);
  process.stdout.write(`${JSON.stringify({ headers: EMAIL_OUTPUT_HEADERS, ...result })}\n`);
} catch (error) {
  process.stderr.write(`Recovery e-mail output build failed: ${error.message}\n`);
  process.exitCode = 1;
}
