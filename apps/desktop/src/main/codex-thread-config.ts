import type { AiPreferences } from '@contracts';
import type { WebSearchMode } from '../../../../schemas/codex/0.145.0/ts/WebSearchMode.js';

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

const offlineInstructions = 'Return only data matching the supplied output schema. Do not call tools, access files, or provide diagnosis or prescriptions.';

const webSearchInstructions = [
  'Return only data matching the supplied output schema.',
  'You may use only the built-in web search for de-identified, generic medical background.',
  'Never put names, exact dates, verbatim report text, local paths, internal IDs, or unique combinations of personal facts into a search query.',
  'Web results must not replace or alter report facts.',
  'Do not access local files through tools or provide diagnosis or prescriptions.'
].join(' ');

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
    developerInstructions: input.allowWebSearch ? webSearchInstructions : offlineInstructions,
    config,
    ephemeral: true,
    historyMode: 'paginated',
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: []
  };
}
