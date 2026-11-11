/**
 * T2 E2E layout guard: a long plan name made the optimisation card wider than its column (job card cut off at 390 px
 * and 1280 px: state badge, percentage and progress bar outside the card). Grid tracks default to `auto`, which grow
 * to the nowrap name's min-content width; the job list, its items and the progress block must use a shrinkable
 * track (`grid-cols-[minmax(0,1fr)]`). Playwright check: scratchpad t2-layout.cjs `clipped()`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, f), 'utf8');
const SHRINK = 'grid-cols-[minmax(0,1fr)]';

test('T2 E2E: the optimisation job list and card use shrinkable grid tracks (no clipped job card)', () => {
  const panel = src('OptimisePanel.tsx');
  const list = /<ul className="([^"]*)">\s*\{started\.map/.exec(panel);
  assert.ok(list, 'job list <ul> found');
  assert.ok(list[1].includes(SHRINK), `job list needs ${SHRINK}: "${list[1]}"`);
  const item = /<li key=\{s\.seed\.shiftId\} className="([^"]*)"/.exec(panel);
  assert.ok(item, 'job list <li> found');
  assert.ok(item[1].includes(SHRINK) && item[1].includes('min-w-0'), `job item needs min-w-0 and ${SHRINK}: "${item[1]}"`);
  const card = /className="([^"]*)" data-testid="job-progress"/.exec(src('planner-ui.tsx'));
  assert.ok(card, 'JobProgress root found');
  assert.ok(card[1].includes(SHRINK) && card[1].includes('min-w-0'), `JobProgress root needs min-w-0 and ${SHRINK}: "${card[1]}"`);
});
