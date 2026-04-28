#!/usr/bin/env node
/**
 * schedule-cli.ts — Manage Temporal schedules for prompting chatSession.
 *
 * Usage:
 *   node --loader ts-node/esm src/schedule-cli.ts create \
 *     --id farm-loop \
 *     --cron "36 * * * *" \
 *     --session twitch-sleet1213 \
 *     --user lokvolt \
 *     --prompt "Run the farm-loop skill: /farm-loop"
 *
 *   node --loader ts-node/esm src/schedule-cli.ts create \
 *     --id one-shot-reminder \
 *     --at "2026-04-28T15:00:00Z" \
 *     --session twitch-sleet1213 \
 *     --user lokvolt \
 *     --prompt "Remind lokvolt to check the base"
 *
 *   node --loader ts-node/esm src/schedule-cli.ts list
 *   node --loader ts-node/esm src/schedule-cli.ts delete --id farm-loop
 *   node --loader ts-node/esm src/schedule-cli.ts trigger --id farm-loop
 */

import { Connection, ScheduleClient, ScheduleOverlapPolicy } from '@temporalio/client';
import type { scheduledPrompt } from './workflows.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';
const TASK_QUEUE = process.env.TASK_QUEUE ?? 'chat';

async function getClient(): Promise<ScheduleClient> {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  return new ScheduleClient({ connection, namespace: TEMPORAL_NAMESPACE });
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      result[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return result;
}

async function create(args: Record<string, string>) {
  const id = args.id;
  const sessionId = args.session;
  const userId = args.user;
  const prompt = args.prompt;
  const cron = args.cron;
  const at = args.at; // ISO timestamp for one-off

  if (!id || !sessionId || !userId || !prompt) {
    console.error('Required: --id, --session, --user, --prompt');
    console.error('Plus either --cron "M H D M W" or --at "ISO-timestamp"');
    process.exit(1);
  }
  if (!cron && !at) {
    console.error('Must provide either --cron or --at');
    process.exit(1);
  }

  const client = await getClient();

  const spec: any = {};
  if (cron) {
    spec.cronExpressions = [cron];
  } else if (at) {
    // One-shot: build a 6-field cron expression (M H D Mon DoW Year) that
    // matches exactly once at the given UTC time. Combined with
    // remainingActions=1, the schedule auto-pauses after the first fire.
    const d = new Date(at);
    const cronOnce = `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} * ${d.getUTCFullYear()}`;
    spec.cronExpressions = [cronOnce];
  }

  const handle = await client.create({
    scheduleId: id,
    spec,
    action: {
      type: 'startWorkflow' as const,
      workflowType: 'scheduledPrompt',
      taskQueue: TASK_QUEUE,
      args: [sessionId, userId, prompt] as Parameters<typeof scheduledPrompt>,
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
    },
    state: at ? { remainingActions: 1 } : undefined,
  });

  const kind = cron ? `recurring (${cron})` : `one-shot (${at})`;
  console.log(`✓ Created schedule "${handle.scheduleId}" — ${kind}`);
  console.log(`  session: ${sessionId}, user: ${userId}`);
  console.log(`  prompt: ${prompt}`);
}

async function list() {
  const client = await getClient();
  let count = 0;
  for await (const schedule of client.list()) {
    count++;
    const paused = schedule.state.paused ? ' [PAUSED]' : '';
    const nextTimes = schedule.info.nextActionTimes
      .slice(0, 3)
      .map((d) => d.toISOString())
      .join(', ');
    console.log(`${schedule.scheduleId}${paused}`);
    if (schedule.memo && Object.keys(schedule.memo).length > 0) {
      console.log(`  memo: ${JSON.stringify(schedule.memo)}`);
    }
    if (nextTimes) {
      console.log(`  next: ${nextTimes}`);
    }
    const recentActions = schedule.info.recentActions ?? [];
    if (recentActions.length > 0) {
      const last = recentActions[recentActions.length - 1];
      console.log(`  last: ${(last as any).scheduledAt?.toISOString() ?? 'unknown'}`);
    }
  }
  if (count === 0) {
    console.log('No schedules found.');
  }
}

async function del(args: Record<string, string>) {
  const id = args.id;
  if (!id) {
    console.error('Required: --id');
    process.exit(1);
  }
  const client = await getClient();
  const handle = client.getHandle(id);
  await handle.delete();
  console.log(`✓ Deleted schedule "${id}"`);
}

async function trigger(args: Record<string, string>) {
  const id = args.id;
  if (!id) {
    console.error('Required: --id');
    process.exit(1);
  }
  const client = await getClient();
  const handle = client.getHandle(id);
  await handle.trigger();
  console.log(`✓ Triggered schedule "${id}" (fires now)`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'create':
      await create(args);
      break;
    case 'list':
      await list();
      break;
    case 'delete':
      await del(args);
      break;
    case 'trigger':
      await trigger(args);
      break;
    default:
      console.error('Usage: schedule-cli <create|list|delete|trigger> [options]');
      console.error('');
      console.error('Commands:');
      console.error('  create  --id NAME --session ID --user ID --prompt TEXT (--cron EXPR | --at ISO)');
      console.error('  list');
      console.error('  delete  --id NAME');
      console.error('  trigger --id NAME');
      process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
