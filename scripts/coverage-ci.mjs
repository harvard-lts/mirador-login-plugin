#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

// The reusable LTS TestCoverageNode workflow appends Jest-style flags
// (--coverage=true --coverageDirectory=coverage --coverageReporters=json-summary)
// which Vitest rejects. This wrapper ignores those appended flags and runs
// Vitest emitting the json-summary report into ./coverage so the workflow can
// read coverage/coverage-summary.json (.total.lines.pct).
const result = spawnSync('npx', [
  'vitest', 'run',
  '--coverage.enabled=true',
  '--coverage.reportsDirectory=coverage',
  '--coverage.reporter=json-summary',
], { stdio: 'inherit', shell: process.platform === 'win32' });

process.exit(result.status ?? 1);
