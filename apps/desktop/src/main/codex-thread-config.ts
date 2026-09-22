import type { AiPreferences } from '@contracts';
import type { WebSearchMode } from '../../../../schemas/codex/0.145.0/ts/WebSearchMode.js';
import { HEALTH_RUNTIME_PROMPT_V3 } from './prompts/lean.js';

export interface HealthThreadStartParams {
  cwd: string;
  model: string;
  runtimeWorkspaceRoots: string[];
  approvalPolicy: 'never';
  sandbox: 'read-only';
  developerInstructions: string;
  config: { web_search: WebSearchMode };
  ephemeral: true;
  historyMode: 'paginated';
  environments: [];
  dynamicTools: [];
  selectedCapabilityRoots: [];
}

export function createHealthThreadStartParams(input: {
  workingDirectory: string;
  aiPreferences: AiPreferences;
  allowWebSearch: boolean;
}): HealthThreadStartParams {
  const config = {
    web_search: input.allowWebSearch ? 'live' : 'disabled'
  } satisfies HealthThreadStartParams['config'];

  return {
    cwd: input.workingDirectory,
    model: input.aiPreferences.modelId,
    runtimeWorkspaceRoots: [],
    approvalPolicy: 'never',
    sandbox: 'read-only',
    developerInstructions: HEALTH_RUNTIME_PROMPT_V3,
    config,
    ephemeral: true,
    historyMode: 'paginated',
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: []
  };
}
