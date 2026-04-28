#!/usr/bin/env node
/**
 * schedule-hud-poller.ts
 *
 * Polls Temporal schedules every few seconds and writes /tmp/sleet1213-crons.json
 * in the format the CronHud Meteor module expects. Replaces the old PostToolUse
 * hook that only captured CronCreate/Delete events from the built-in cron tools.
 *
 * Run as a long-lived sidecar:
 *   node --loader ts-node/esm src/schedule-hud-poller.ts
 *
 * Env:
 *   TEMPORAL_ADDRESS   (default 127.0.0.1:7233)
 *   TEMPORAL_NAMESPACE (default "default")
 *   HUD_POLL_INTERVAL  (default 5000 — ms between polls)
 *   HUD_JSON_PATH      (default /tmp/sleet1213-crons.json)
 */

import { Connection, ScheduleClient } from '@temporalio/client';
import { writeFileSync, renameSync } from 'node:fs';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';
const POLL_INTERVAL = Number(process.env.HUD_POLL_INTERVAL ?? 5000);
const JSON_PATH = process.env.HUD_JSON_PATH ?? '/tmp/sleet1213-crons.json';

interface CronEntry {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  state: string;
  nextFire?: string;
}

/**
 * Convert a Temporal CalendarSpec into a human-readable cron-ish string.
 * E.g. minute=[{start:9,end:9}], hour=[{start:0,end:23}] → "9 * * * *"
 */
function calendarToCron(cal: any): string {
  const field = (ranges: any[], allStart: number, allEnd: number): string => {
    if (!ranges || ranges.length === 0) return '*';
    // Single value where start===end
    if (ranges.length === 1) {
      const r = ranges[0];
      if (r.start === r.end) return String(r.start);
      if (r.start === allStart && r.end === allEnd) return '*';
      // Step pattern
      if (r.start === allStart && r.step > 1) return `*/${r.step}`;
    }
    // Multiple specific values
    return ranges.map((r: any) => {
      if (r.start === r.end) return String(r.start);
      if (typeof r.start === 'string') return '*'; // JANUARY-DECEMBER etc.
      return `${r.start}-${r.end}`;
    }).join(',');
  };

  const min = field(cal.minute, 0, 59);
  const hr = field(cal.hour, 0, 23);
  const dom = field(cal.dayOfMonth, 1, 31);
  // month and dayOfWeek may use string enums
  const mon = cal.month?.length === 1 &&
    typeof cal.month[0].start === 'string' ? '*' : field(cal.month, 1, 12);
  const dow = cal.dayOfWeek?.length === 1 &&
    typeof cal.dayOfWeek[0].start === 'string' ? '*' : field(cal.dayOfWeek, 0, 6);

  return `${min} ${hr} ${dom} ${mon} ${dow}`;
}

async function poll(client: ScheduleClient): Promise<void> {
  const crons: CronEntry[] = [];

  // Collect schedule IDs from list(), then describe() each for full details
  const scheduleIds: string[] = [];
  for await (const summary of client.list()) {
    scheduleIds.push(summary.scheduleId);
  }

  for (const id of scheduleIds) {
    try {
      const handle = client.getHandle(id);
      const desc = await handle.describe();

      // Extract cron expression
      let cronExpr = '?';
      const spec = desc.spec as any;
      if (spec?.calendars?.length) {
        cronExpr = calendarToCron(spec.calendars[0]);
      } else if (spec?.intervals?.length) {
        const iv = spec.intervals[0];
        const every = iv.every;
        if (typeof every === 'number') {
          cronExpr = `every ${Math.round(every / 60000)}m`;
        } else if (typeof every === 'object' && every.seconds) {
          cronExpr = `every ${Math.round(every.seconds / 60)}m`;
        }
      }

      // Extract prompt from action args
      let prompt = '';
      const action = desc.action as any;
      if (action?.args?.length >= 3) {
        prompt = String(action.args[2] ?? '').slice(0, 60);
      } else if (action?.workflowType) {
        prompt = String(action.workflowType);
      }

      const paused = desc.state.paused;
      const nextTimes = desc.info.nextActionTimes ?? [];
      const nextFire = nextTimes.length > 0 ? nextTimes[0].toISOString() : undefined;
      const recurring = nextTimes.length > 1;

      crons.push({
        id,
        cron: cronExpr,
        prompt,
        recurring,
        durable: true,
        state: paused ? 'paused' : 'scheduled',
        nextFire,
      });
    } catch (err) {
      // Schedule may have been deleted between list and describe
      console.warn(`[hud-poller] failed to describe ${id}:`, (err as Error).message);
    }
  }

  const data = {
    updated: new Date().toISOString(),
    crons,
  };

  const tmpPath = `${JSON_PATH}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, JSON_PATH);
}

async function main() {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new ScheduleClient({ connection, namespace: TEMPORAL_NAMESPACE });

  console.log(`[hud-poller] polling Temporal schedules every ${POLL_INTERVAL}ms → ${JSON_PATH}`);

  // Initial poll
  await poll(client).catch((err) =>
    console.error('[hud-poller] poll error:', (err as Error).message),
  );

  // Recurring poll
  setInterval(async () => {
    try {
      await poll(client);
    } catch (err) {
      console.error('[hud-poller] poll error:', (err as Error).message);
    }
  }, POLL_INTERVAL);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
