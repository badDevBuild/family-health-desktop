import type { BodySystemId, HealthEventV2, MemberEvidenceRef, MetricSeriesSummary, SystemEvidenceBundle, SystemEvidenceFact } from '@contracts';
import { healthEventV2Schema, systemEvidenceBundleSchema } from '@contracts';
import { bodySystemRegistry, buildMetricSeries, conceptDictionary, linkConceptToSystems, linkLegacyCandidateToSystems, linkTextToSystems, selectContextSystems, stableHash, type TrendObservationInput } from '@core';
import type { AcceptedObservationSummary, WorkspaceStore } from '@storage';
import {
  SYSTEM_ANALYSIS_PROMPT_VERSION,
  SYSTEM_ANALYSIS_RULES_VERSION
} from './prompts/index.js';
import { SYSTEM_KNOWLEDGE_VERSION, knowledgeForSystem } from './system-knowledge.js';

function parseReferenceRange(value: string | null): { low: number | null; high: number | null } {
  if (!value) return { low: null, high: null };
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:-|\u2013|\u2014|~|\u81f3)\s*(-?\d+(?:\.\d+)?)(?:\s.*)?$/);
  if (!match) return { low: null, high: null };
  const low = Number(match[1]);
  const high = Number(match[2]);
  return Number.isFinite(low) && Number.isFinite(high) ? { low, high } : { low: null, high: null };
}

function evidenceFor(observation: AcceptedObservationSummary, eventId: string | null = null): MemberEvidenceRef {
  return {
    id: `evidence-${observation.id}-${observation.sourceSpanId}-primary`,
    kind: 'observation',
    observationId: observation.id,
    eventId,
    documentId: observation.documentId,
    sourceSpanId: observation.sourceSpanId,
    knowledgeId: null,
    label: observation.sourceLabel,
    locator: null,
    quote: observation.sourceQuote
  };
}

function evidenceSourcesFor(observation: AcceptedObservationSummary, eventId: string | null = null): MemberEvidenceRef[] {
  const refs = observation.evidence.length > 0
    ? observation.evidence
    : [{ sourceSpanId: observation.sourceSpanId, quote: observation.sourceQuote }];
  return refs.map((reference, index) => ({
    id: `evidence-${observation.id}-${reference.sourceSpanId}-${index}`,
    kind: 'observation',
    observationId: observation.id,
    eventId,
    documentId: observation.documentId,
    sourceSpanId: reference.sourceSpanId,
    knowledgeId: null,
    label: reference.sourceRole === 'duplicate_source'
      ? `${observation.sourceLabel}（同次检查的另一处来源）`
      : observation.sourceLabel,
    locator: null,
    quote: reference.quote
  }));
}

function mappingFor(observation: AcceptedObservationSummary) {
  return observation.mapping;
}

function linksFor(observation: AcceptedObservationSummary) {
  if (observation.originalNameStatus === 'legacy_missing') {
    return linkLegacyCandidateToSystems(observation.mapping, observation.modelStandardNameCandidate);
  }
  const namedLinks = linkConceptToSystems(mappingFor(observation));
  if (namedLinks.length > 0) return namedLinks;
  // “诊断/小结”本身不是器官名；仅当原文确实写出提取到的检查部位时才按部位归类。
  const site = observation.bodySite?.trim();
  if (!site || !/^(?:诊断|结论|小结|检查结论|影像结论|超声小结)$/.test(observation.originalName.trim())
    || !observation.evidence.some((reference) => reference.quote?.includes(site))) return namedLinks;
  return linkTextToSystems(site).map((systemId) => ({ systemId, relation: 'direct' as const }));
}

function displayNameFor(observation: AcceptedObservationSummary): string {
  if (observation.originalNameStatus === 'legacy_missing') {
    return `${observation.modelStandardNameCandidate ?? observation.conceptKey}（旧记录候选名）`;
  }
  const mapping = mappingFor(observation);
  return mapping.status === 'verified'
    ? mapping.canonicalName ?? observation.originalName
    : observation.originalName;
}

function trendMappingFor(observation: AcceptedObservationSummary) {
  if (observation.originalNameStatus !== 'legacy_missing') return observation.mapping;
  const name = observation.modelStandardNameCandidate ?? observation.conceptKey;
  return {
    rawName: name,
    normalizedName: name,
    conceptId: null,
    canonicalName: null,
    status: 'unmapped' as const,
    confidence: 0,
    reasons: ['旧记录缺少原始项目名，只按原有候选名精确分组。']
  };
}

function trendInput(observation: AcceptedObservationSummary, eventId: string | null = null): TrendObservationInput {
  const range = parseReferenceRange(observation.referenceRange);
  const qualifier = ['eq', 'lt', 'lte', 'gt', 'gte'].includes(observation.qualifier ?? '')
    ? observation.qualifier as TrendObservationInput['comparator']
    : null;
  const numericValue = observation.decimalValue === null ? null : Number(observation.decimalValue);
  return {
    id: observation.id,
    personId: observation.personId,
    rawName: observation.originalNameStatus === 'legacy_missing'
      ? observation.modelStandardNameCandidate ?? observation.conceptKey
      : observation.originalName,
    standardName: observation.modelStandardNameCandidate,
    resolvedMapping: trendMappingFor(observation),
    rawText: observation.rawText,
    numericValue: numericValue !== null && Number.isFinite(numericValue) ? numericValue : null,
    comparator: qualifier,
    unit: observation.unit,
    referenceLow: range.low,
    referenceHigh: range.high,
    abnormalFlag: observation.abnormalFlag,
    clinicalDate: observation.clinicalDate,
    dateRole: 'unknown',
    specimen: observation.specimen,
    method: observation.method,
    bodySite: observation.bodySite,
    documentId: observation.documentId,
    sourceSpanId: observation.sourceSpanId,
    sourceLabel: observation.sourceLabel,
    quote: observation.sourceQuote,
    evidenceSources: evidenceSourcesFor(observation, eventId),
    duplicateSourceCount: observation.evidence.filter((reference) => reference.sourceRole === 'duplicate_source').length
  };
}

function metricSeries(observations: AcceptedObservationSummary[], eventIds: Map<string, string>): MetricSeriesSummary[] {
  return buildMetricSeries(observations.map((observation) => trendInput(observation, eventIds.get(observation.documentId) ?? null)));
}

function eventsFor(store: WorkspaceStore, personId: string, observations: AcceptedObservationSummary[], systemId: BodySystemId): HealthEventV2[] {
  const metadataByDocument = new Map(store.listReportMetadata(personId).map((item) => [item.documentId, item]));
  const grouped = new Map<string, AcceptedObservationSummary[]>();
  for (const observation of observations) {
    if (!linksFor(observation).some((link) => link.systemId === systemId)) continue;
    const eventKey = metadataByDocument.get(observation.documentId)?.eventId ?? `document-${observation.documentId}`;
    grouped.set(eventKey, [...(grouped.get(eventKey) ?? []), observation]);
  }
  return [...grouped.values()].map((items): HealthEventV2 => {
    const first = items[0]!;
    const documentIds = [...new Set(items.map((item) => item.documentId))];
    const reports = documentIds
      .map((documentId) => metadataByDocument.get(documentId))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const report = reports.find((item) => item.metadataStatus === 'corrected') ?? reports[0];
    const extracted = report?.extracted;
    const dates = [...new Set(items.map((item) => item.clinicalDate).filter((value): value is string => Boolean(value)))].sort();
    const firstDate = dates[0] ?? null;
    const lastDate = dates.at(-1) ?? null;
    const spanDays = firstDate && lastDate
      ? Math.round((Date.parse(`${lastDate}T00:00:00Z`) - Date.parse(`${firstDate}T00:00:00Z`)) / 86_400_000)
      : null;
    const extractedClinicalTime = extracted?.times
      .filter((time) => ['day', 'month', 'year'].includes(time.precision) && ['sampled', 'examined', 'encounter'].includes(time.role))
      .sort((left, right) => ({ day: 3, month: 2, year: 1 }[right.precision as 'day' | 'month' | 'year']
        - { day: 3, month: 2, year: 1 }[left.precision as 'day' | 'month' | 'year']))[0];
    const explicitClinicalTime = report?.metadataStatus === 'corrected'
      ? { ...report.clinicalTime, role: 'examined' as const }
      : extractedClinicalTime;
    const eventDate = explicitClinicalTime?.value ?? (dates.length === 1 || (spanDays !== null && spanDays <= 14) ? firstDate : null);
    const endDate = explicitClinicalTime ? null : eventDate && lastDate !== eventDate ? lastDate : null;
    const eventPrecision = explicitClinicalTime?.precision as 'year' | 'month' | 'day' | undefined
      ?? (eventDate ? 'day' : 'unknown');
    const verifiedEventText = reports.map((item) => (
      item.metadataStatus === 'corrected'
        ? [item.reportKind, item.title]
        : [item.extracted?.reportKind?.value, item.extracted?.title?.value]
    ).filter(Boolean).join(' ')).join(' ');
    const looksLikeCheckup = /体检|健康检查|健康体检/i.test(verifiedEventText);
    const looksLikeImaging = items.some((item) => /超声|彩超|ct|mr|磁共振|x线|dr|影像/i.test(`${item.method ?? ''}${item.conceptKey}`));
    // 父事件优先使用已提取/已修正的报告元数据。文件名不是临床元数据，
    // 而年度体检中包含一个影像子项也不应把整个父事件改成“影像”。
    const type: HealthEventV2['type'] = looksLikeCheckup
      ? 'checkup'
      : /(影像|超声|彩超|ct|mr|磁共振|x线|dr)/i.test(verifiedEventText)
        ? 'imaging'
        : looksLikeImaging && reports.length === 0 ? 'imaging' : 'laboratory';
    const fallbackTitle = type === 'checkup'
      ? `${eventDate?.slice(0, 4) ?? '日期待确认'} 年度体检`
      : type === 'imaging' ? '影像检查' : '检验记录';
    return healthEventV2Schema.parse({
      id: report?.eventId ?? `event-document-${first.documentId}`,
      personId,
      type,
      title: report?.metadataStatus === 'corrected' ? report.title : extracted?.title?.value ?? report?.title ?? fallbackTitle,
      time: {
        value: eventDate,
        endValue: endDate,
        precision: eventPrecision,
        role: explicitClinicalTime?.role === 'sampled' ? 'specimen' : explicitClinicalTime ? 'exam' : looksLikeCheckup ? 'exam' : 'unknown',
        source: explicitClinicalTime ? 'explicit' : eventDate ? 'inherited' : 'unknown',
        displayLabel: eventDate ? (endDate ? `${eventDate} 至 ${endDate}` : eventDate) : '报告日期待确认'
      },
      organization: report?.metadataStatus === 'corrected' ? report.organization : extracted?.organization?.value ?? report?.organization ?? null,
      department: report?.metadataStatus === 'corrected' ? report.department : extracted?.department?.value ?? null,
      summary: `${items.length} 条已接纳事实${dates.length > 1 && !eventDate ? '；报告含跨期历史数据，未据此猜测本次日期' : ''}。`,
      systemIds: [...new Set(items.flatMap((item) => linksFor(item).map((link) => link.systemId)))],
      documentIds,
      factCount: items.length,
      metadataStatus: report?.metadataStatus ?? (eventDate ? 'inferred' : 'unknown')
    });
  }).sort((left, right) => (right.time.value ?? '').localeCompare(left.time.value ?? ''));
}

function systemsForNote(note: ReturnType<WorkspaceStore['listManualNotes']>[number]): { systemIds: BodySystemId[]; reason: string } {
  const selection = selectContextSystems({ kind: note.kind, text: note.immutableText, structuredFields: note.structuredFields });
  const reasons = {
    explicit: '本人补充明确指定了适用的身体系统。',
    keyword: '本人补充命中可审查的身体系统关键词。',
    global_safety: '过敏、用药或身体限制是所有系统解释的安全背景。',
    global_history: '未能安全缩小的病史或自由补充作为全局背景保留。',
    unscoped: '这条目标或自测没有可审查的系统归属，本次不送入系统分析。'
  } as const;
  return { systemIds: selection.systemIds, reason: reasons[selection.basis] };
}

function relatedSystemsForAction(
  action: ReturnType<WorkspaceStore['listActionItems']>[number],
  proposalSystems: Map<string, BodySystemId[]>
): { systemIds: BodySystemId[]; reason: string } {
  const proposalId = action.evidenceLabel?.startsWith('proposal:') ? action.evidenceLabel.slice('proposal:'.length) : null;
  const fromProposal = proposalId ? proposalSystems.get(proposalId) ?? [] : [];
  if (fromProposal.length > 0) return { systemIds: fromProposal, reason: '行动继承了已采纳生活提议的系统范围。' };
  const matched = linkTextToSystems(`${action.title} ${action.detail}`);
  return matched.length > 0
    ? { systemIds: matched, reason: '行动文本命中可审查的身体系统关键词。' }
    : { systemIds: [], reason: '行动没有明确系统归属，不用它触发所有系统重算。' };
}

export function buildSystemEvidenceBundle(
  store: WorkspaceStore,
  personId: string,
  systemId: BodySystemId,
  options: { modelId?: string; analysisWindow?: 'all_history'; excludedDocumentIds?: ReadonlySet<string> } = {}
): SystemEvidenceBundle {
  const person = store.listPersons().find((item) => item.id === personId && item.archivedAt === null);
  if (!person) throw new Error('PERSON_NOT_FOUND');
  if (!bodySystemRegistry.some((system) => system.id === systemId)) throw new Error('BODY_SYSTEM_NOT_FOUND');
  const conflictedDocumentIds = new Set(store.listOpenExtractionReviewIssues()
    .filter((issue) => issue.personId === personId && issue.kind === 'person_conflict')
    .map((issue) => issue.documentId));
  const observations = store.listAcceptedObservations(personId)
    .filter((observation) => !conflictedDocumentIds.has(observation.documentId)
      && !options.excludedDocumentIds?.has(observation.documentId));
  const eventIdsByDocument = new Map(store.listReportMetadata(personId).map((item) => [item.documentId, item.eventId]));
  const selected: Array<{ observation: AcceptedObservationSummary; fact: SystemEvidenceFact }> = [];
  const unclassifiedObservationIds: string[] = [];
  const excludedObservationIds: string[] = [];
  const unusableObservationIds: string[] = [];
  for (const observation of observations) {
    // 旧规则可能把 unknown/空结果作为观测保存；它既不能成为系统事实，也不能生成空趋势点。
    if (observation.valueKind === 'unknown' || observation.rawText.trim().length === 0) {
      if (linksFor(observation).some((item) => item.systemId === systemId)) unusableObservationIds.push(observation.id);
      else excludedObservationIds.push(observation.id);
      continue;
    }
    const mapping = mappingFor(observation);
    const link = linksFor(observation).find((item) => item.systemId === systemId);
    if (!link) {
      if (mapping.status === 'unmapped') unclassifiedObservationIds.push(observation.id);
      else excludedObservationIds.push(observation.id);
      continue;
    }
    selected.push({
      observation,
      fact: {
        observationId: observation.id,
        conceptId: mapping.conceptId,
        name: displayNameFor(observation),
        value: `${observation.rawText}${observation.unit ? ` ${observation.unit}` : ''}`,
        abnormalFlag: observation.abnormalFlag,
        time: {
          value: observation.clinicalDate,
          endValue: null,
          precision: observation.clinicalDate ? 'day' : 'unknown',
          role: 'measurement',
          source: observation.clinicalDate ? 'explicit' : 'unknown',
          displayLabel: observation.clinicalDate ?? '日期未记录'
        },
        relation: link.relation,
        relationReason: link.relation === 'direct'
          ? '该事实属于此身体系统的直接检查或测量。'
          : '该事实只作为可能相关的背景，不能据此推断因果。',
        evidence: evidenceFor(observation, eventIdsByDocument.get(observation.documentId) ?? null),
        evidenceSources: evidenceSourcesFor(observation, eventIdsByDocument.get(observation.documentId) ?? null)
      }
    });
  }
  const selectedObservations = selected.map((item) => item.observation);
  const dates = selectedObservations.map((item) => item.clinicalDate).filter((value): value is string => Boolean(value)).sort();
  const factRevision = store.getFactRevision(personId);
  const contextRevision = store.getClinicalContextRevision(personId);
  const allNotes = store.listManualNotes(personId);
  const noteSelections = allNotes.map((note) => ({ note, ...systemsForNote(note) }));
  const selectedNotes = noteSelections.filter((selection) => selection.systemIds.includes(systemId));
  const notes = selectedNotes.map(({ note, systemIds, reason }) => ({
    id: note.id,
    kind: note.kind,
    text: note.immutableText,
    effectiveDate: note.effectiveDate,
    source: 'user_reported' as const,
    revision: note.revision,
    applicableSystemIds: systemIds,
    selectionReason: reason
  }));
  const proposalSystems = new Map(store.listLifestyleProposals(personId)
    .map((proposal) => [proposal.id, proposal.relatedSystemIds as BodySystemId[]]));
  const allActions = store.listActionItems(personId);
  const actionSelections = allActions.map((action) => ({ action, ...relatedSystemsForAction(action, proposalSystems) }));
  const existingActions = actionSelections
    .filter((selection) => selection.systemIds.includes(systemId))
    .map(({ action, systemIds, reason }) => ({
      id: action.id,
      title: action.title,
      status: action.status,
      userRevision: action.userRevision,
      relatedSystemIds: systemIds,
      selectionReason: reason
    }));
  const systemEvents = eventsFor(store, personId, selectedObservations, systemId);
  const knowledge = knowledgeForSystem(systemId);
  const selectedDocumentIds = new Set(selectedObservations.map((observation) => observation.documentId));
  const eventDependencies = store.listReportMetadata(personId)
    .filter((report) => selectedDocumentIds.has(report.documentId))
    .map((report) => ({
      reportId: report.reportId,
      documentId: report.documentId,
      eventId: report.eventId,
      metadataRevision: report.metadataRevision,
      metadataStatus: report.metadataStatus,
      title: report.title,
      organization: report.organization,
      department: report.department,
      clinicalTime: report.clinicalTime
    }))
    .sort((left, right) => left.reportId.localeCompare(right.reportId));
  const inputSignature = stableHash({
    personId,
    systemId,
    personalProfile: {
      birthYear: person.birthYear,
      genderContext: person.genderContext
    },
    analysisWindow: options.analysisWindow ?? 'all_history',
    selected: selected.map((item) => ({
      id: item.observation.id,
      relation: item.fact.relation,
      mappingVersion: item.observation.mappingVersion,
      rawText: item.observation.rawText,
      unit: item.observation.unit,
      referenceRange: item.observation.referenceRange,
      clinicalDate: item.observation.clinicalDate,
      abnormalFlag: item.observation.abnormalFlag
    })),
    unusableObservationIds,
    notes: selectedNotes.map(({ note }) => ({
      id: note.id,
      revision: note.revision,
      effectiveDate: note.effectiveDate,
      text: note.immutableText,
      structuredFields: note.structuredFields
    })),
    actions: existingActions,
    eventDependencies,
    knowledge,
    selectorVersions: {
      conceptDictionary: conceptDictionary[0]?.version ?? 'unknown',
      systemRegistry: bodySystemRegistry[0]?.version ?? 'unknown',
      contextSelector: 'context-selector-v2-global-safety-first',
      actionSelector: 'action-selector-v1',
      analysisWindow: 'all-history-v1',
      sourceFactFilter: 'nonempty-result-v1',
      knowledge: SYSTEM_KNOWLEDGE_VERSION
    },
    promptVersion: SYSTEM_ANALYSIS_PROMPT_VERSION,
    rulesVersion: SYSTEM_ANALYSIS_RULES_VERSION,
    modelId: options.modelId ?? 'codex-account-default'
  });
  return systemEvidenceBundleSchema.parse({
    schemaVersion: 1,
    identity: {
      personId,
      systemId,
      birthYear: person.birthYear,
      genderContext: person.genderContext,
      contextSource: 'user_profile'
    },
    scope: {
      factRevision,
      contextRevision,
      clinicalFrom: dates[0] ?? null,
      clinicalAsOf: dates.at(-1) ?? null,
      inputSignature
    },
    directFacts: selected.filter((item) => item.fact.relation === 'direct').map((item) => item.fact),
    contextFacts: selected.filter((item) => item.fact.relation === 'context').map((item) => item.fact),
    personalContext: notes,
    events: systemEvents,
    trends: metricSeries(selected.filter((item) => item.fact.relation === 'direct').map((item) => item.observation), eventIdsByDocument),
    existingActions,
    knowledge,
    coverage: {
      selectedObservationIds: selected.map((item) => item.observation.id),
      excludedObservationIds: [...excludedObservationIds, ...unusableObservationIds],
      unclassifiedObservationIds,
      selectedContextIds: selectedNotes.map((selection) => selection.note.id),
      excludedContextIds: noteSelections.filter((selection) => !selection.systemIds.includes(systemId)).map((selection) => selection.note.id),
      selectedActionIds: existingActions.map((action) => action.id),
      excludedActionIds: actionSelections.filter((selection) => !selection.systemIds.includes(systemId)).map((selection) => selection.action.id),
      incompleteReasons: [
        ...(unclassifiedObservationIds.length > 0 ? [`${unclassifiedObservationIds.length} 条事实尚未完成概念映射。`] : []),
        ...(unusableObservationIds.length > 0 ? [`${unusableObservationIds.length} 条旧记录没有可用结果，未纳入系统分析。`] : []),
        ...(selected.length === 0 ? ['此身体系统尚无可归集事实。'] : [])
      ]
    }
  });
}
