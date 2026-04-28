import { defineSignal, defineQuery } from '@temporalio/workflow';
import type { AgentConfig, Msg } from './types.js';

export const userMessageSignal = defineSignal<[string, AgentConfig?, string?]>('userMessage');
export const closeSignal       = defineSignal<[]>('close');
export const transcriptQuery   = defineQuery<Msg[]>('transcript');
