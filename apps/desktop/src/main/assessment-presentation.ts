import { containsProcessNarrative, healthClaimTitle, type HealthAction, type HealthClaim, type MemberAssessmentSnapshotV3, type OverviewNode, type SystemNode } from '@contracts';
import { presentAssessmentText } from './assessment-content-quality.js';
import { findAssessmentSemanticIssues } from './assessment-semantic-quality.js';
import { buildAssessmentPriorities } from './assessment-priorities.js';

/** 展示投影独立版本化：不改变事实、模型提示词、校验规则或旧快照的有效性。 */
export const ASSESSMENT_PRESENTATION_VERSION = 'result-summary-v14';

const heldHeadlines = new Set(['部分健康判断仍需核实', '部分判断仍需核实', '这部分判断仍需核实']);
const heldSummaries = new Set([
  '已接纳的报告事实仍可查看；本系统有部分判断暂未纳入本次解读。',
  '已接纳的报告事实和其他行动仍可查看；有部分判断暂未纳入本次总览。'
]);

/** 只摘用完整、仍可发布的原句；不截断否定/条件，也不从数值推断新的健康结论。 */
export function retainedAssessmentNarrative(claims: HealthClaim[], _actions: HealthAction[] = [], nodeLimitations: string[] = []): Pick<OverviewNode, 'headline' | 'summary'> {
  const first = claims[0];
  if (!first) return {
    headline: '相关检查记录',
    summary: '可先查看检查结果和原始报告，了解这部分已有的资料。'
  };
  // 标题不能承担整条医学解释。旧主张没有独立标题时只用主题入口，完整条件留在正文。
  const headline = healthClaimTitle(first);
  const paragraphs: string[] = [];
  const usedTexts = new Set([headline]);
  const addComplete = (values: Array<string | null>): boolean => {
    const texts = values.filter((value): value is string => Boolean(value)).map((value) => presentAssessmentText(value).text);
    // 解释与其限制作为整体摘用，不截掉尾部否定或判断前提。
    if (texts.some((value) => !value || containsProcessNarrative(value))) return false;
    const unique = texts.filter((value, index, all) => !usedTexts.has(value) && all.indexOf(value) === index);
    const paragraph = unique.join('\n');
    if (!paragraph || [...paragraphs, paragraph].join('\n\n').length > 2_000) return false;
    paragraphs.push(paragraph);
    unique.forEach((value) => usedTexts.add(value));
    return true;
  };
  // 正文、原有理由和必要限制必须一起放下；不能把完整结果提到标题后漏掉其条件。
  if (!addComplete([first.text, first.rationale, first.materialUncertainty, ...nodeLimitations])) return {
    headline: '相关检查记录',
    summary: '理解这项检查需要结合完整检查条件，请查看下方结果与说明。'
  };
  // 只选同节点、同一时间性质、共享证据 ID 的现成解释，不靠词名推断关联。
  const explanation = claims.find((claim) => claim.id !== first.id && claim.kind === 'interpretation'
    && claim.temporalStatus === first.temporalStatus
    && (claim.evidenceIds.some((id) => first.evidenceIds.includes(id)) || claim.trendIds.some((id) => first.trendIds.includes(id))));
  if (explanation) addComplete([explanation.text, explanation.rationale, explanation.materialUncertainty]);
  // 行动通过原 actionIds 在行动区完整显示，不再次把整套执行说明复制到身体摘要。
  return { headline, summary: paragraphs.join('\n\n') };
}

type OverviewSystemContext = { systems: SystemNode[]; rebuiltNodeIds: string[]; actions?: HealthAction[]; overviewClaimIds?: string[] };

/** 按优先关注主题形成概况；完整主体解释不因长度被较短、无关的结果替换。 */
export function retainedOverviewNarrative(claims: HealthClaim[], nodeLimitations: string[] = [], characterLimit = 2_000,
  context?: OverviewSystemContext): Pick<OverviewNode, 'headline' | 'summary'> {
  const cleanComplete = (values: Array<string | null>): string[] | null => {
    const texts = values.filter((value): value is string => Boolean(value)).map((value) => presentAssessmentText(value).text);
    return texts.some((value) => !value || containsProcessNarrative(value)) ? null : [...new Set(texts)];
  };
  const byId = new Map(claims.map((item) => [item.id, item]));
  // 与“优先关注”共用同一主题顺序：紧急行动、高影响判断、原总览顺序。
  // 主题和正文只读取同一条主张，不因正文长就换成同系统的短结果。
  const priorities = buildAssessmentPriorities({ claims, actions: context?.actions ?? [], overview: {
    id: 'overview', headline: '整体健康情况', summary: '现有检查结果', actionIds: [], limitations: [],
    claimIds: context?.overviewClaimIds ?? claims.map((item) => item.id)
  } });
  let selected = priorities.map((issue) => byId.get(issue.id)!).filter(Boolean);
  if (selected.length === 0) {
    const represented = new Set<SystemNode['systemId']>();
    selected = claims.filter((item) => {
      const primary = item.systemIds[0];
      if (!primary || represented.has(primary) || represented.size >= 3) return false;
      represented.add(primary);
      return true;
    });
  }
  const units = selected.flatMap((item) => {
    const theme = cleanComplete([healthClaimTitle(item)])?.[0];
    // 只带主体系统的现有适用限制，不借次关联或旧节点摘要重新作医学判断。
    const node = context?.systems.find((system) => system.systemId === item.systemIds[0]);
    const complete = cleanComplete([item.text, item.rationale, item.materialUncertainty, ...(node?.limitations ?? [])]);
    return theme && complete?.length ? [{ systemId: item.systemIds[0], summary: `${theme}\n${complete.join('\n')}` }] : [];
  });
  // 标题只作整体导航，不重复医学主题；仅统计当前保留主题的主系统，不把次关联或未显示系统算进去。
  const systemCount = new Set(units.map((unit) => unit.systemId).filter(Boolean)).size;
  const headline = units.length > 0 ? `整体情况：${units.length}项重点${systemCount > 0 ? `，涉及${systemCount}个身体系统` : ''}` : '整体健康情况';
  const scope = '以下只概括现有检查覆盖的身体情况，不代表所有身体状况。';
  const detailGuidance = '完整结果、判断依据和检查条件见「身体与指标」。';
  const limits = cleanComplete(nodeLimitations);
  const summary = [scope, ...units.map((unit) => unit.summary), detailGuidance, ...(limits ?? [])].join('\n\n');
  if (!limits || summary.length > characterLimit) {
    // 发布合同放不下完整单元时只留中性详情入口；纯显示调用无预算，不会丢重点或条件。
    return { headline, summary: '理解这些检查需要结合完整检查条件，请在「身体与指标」查看完整结果与说明。' };
  }
  return { headline, summary };
}

/** 家庭与成员读取同一份完整概况；折叠属于界面行为，不另做字符预算摘要。 */
export function familyAssessmentNarrative(snapshot: MemberAssessmentSnapshotV3): Pick<OverviewNode, 'headline' | 'summary'> {
  if (!snapshot.presentation?.rebuiltNodeIds.includes('overview')) return snapshot.overview;
  return retainedOverviewNarrative(snapshot.claims, snapshot.overview.limitations, Number.POSITIVE_INFINITY,
    { systems: snapshot.systems, rebuiltNodeIds: snapshot.presentation.rebuiltNodeIds,
      actions: snapshot.actions, overviewClaimIds: snapshot.overview.claimIds });
}

/**
 * 兼容已发布的旧结果和未来的局部隔离结果。只读投影，不迁移/覆盖数据库，
 * 不恢复 held 内容，不增加模型调用。处理记录与面向用户的身体摘要分开。
 */
export function presentMemberAssessment(snapshot: MemberAssessmentSnapshotV3): MemberAssessmentSnapshotV3 {
  const held = new Set(snapshot.heldTargetIds);
  const unreadable = (value: string | null) => value !== null
    && containsProcessNarrative(presentAssessmentText(value).text);
  const unavailableClaims = new Set<string>();
  const unavailableActions = new Set<string>();
  const unavailableNodes = new Set<string>();
  const unavailableEvidence = new Set<string>();
  const semanticUnavailableClaims = new Set<string>();
  const processUnsafeClaims = new Set<string>();
  const unsafeClaimTitles = new Set<string>();
  const unsafeNodeTitles = new Set<string>();
  for (const issue of findAssessmentSemanticIssues(snapshot, snapshot.evidenceCatalog)) {
    const owner = issue.slice(issue.indexOf(':') + 1);
    if (issue.startsWith('diagnostic_title_contradiction:')) {
      // 标题的确定性越界不能反过来抹掉合格正文、临床前提和行动；只换成中性入口。
      if (snapshot.claims.some((claim) => claim.id === owner)) unsafeClaimTitles.add(owner);
      else unsafeNodeTitles.add(owner);
      continue;
    }
    if (snapshot.claims.some((claim) => claim.id === owner)) {
      semanticUnavailableClaims.add(owner);
      unavailableClaims.add(owner);
    } else {
      unavailableNodes.add(owner);
    }
  }
  // 旧结果里的混合句无法精确剥离时，整条不作健康结论；不能删掉未散瞳等条件后继续肯定判断。
  for (const claim of snapshot.claims) {
    if (held.has(claim.id) || !presentAssessmentText(claim.text).text
      || [claim.title ?? null, claim.text, claim.rationale, claim.materialUncertainty, claim.diseaseName,
        claim.changeAssessment?.summary ?? null, claim.changeAssessment?.reason ?? null].some(unreadable)) {
      unavailableClaims.add(claim.id);
      processUnsafeClaims.add(claim.id);
    }
  }
  for (const node of [snapshot.overview, ...snapshot.systems]) {
    if (!node.limitations.some(unreadable)) continue;
    unavailableNodes.add(node.id);
    node.claimIds.forEach((id) => unavailableClaims.add(id));
    node.actionIds.forEach((id) => unavailableActions.add(id));
  }
  if (snapshot.limitations.some(unreadable)) {
    unavailableNodes.add('overview');
    snapshot.systems.forEach((node) => unavailableNodes.add(node.id));
    snapshot.claims.forEach((claim) => unavailableClaims.add(claim.id));
    snapshot.actions.forEach((action) => unavailableActions.add(action.id));
  }
  // 同一份依据上的临床条件可能限制其他判断；没有独立依据时不借同源结果重建更肯定的摘要。
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const claim of snapshot.claims) {
      if (unavailableClaims.has(claim.id) && !held.has(claim.id)
        && (!semanticUnavailableClaims.has(claim.id) || processUnsafeClaims.has(claim.id))) {
        for (const id of claim.evidenceIds) {
          if (!unavailableEvidence.has(id)) { unavailableEvidence.add(id); expanded = true; }
        }
      } else if (!unavailableClaims.has(claim.id) && claim.evidenceIds.some((id) => unavailableEvidence.has(id))) {
        unavailableClaims.add(claim.id);
        expanded = true;
      }
    }
  }
  for (const action of snapshot.actions) {
    if (held.has(action.id) || action.claimIds.some((id) => unavailableClaims.has(id))
      || action.evidenceIds.some((id) => unavailableEvidence.has(id))
      || [action.title, action.why, action.firstStep, action.timing, action.reviewPlan, action.caution].some(unreadable)
      || !presentAssessmentText(action.title).text || !presentAssessmentText(action.firstStep).text) {
      unavailableActions.add(action.id);
    }
  }
  let changed = false;
  const text = (value: string, fallback: string): string => {
    const presented = presentAssessmentText(value);
    const result = unreadable(value) ? fallback : presented.text || fallback;
    if (result !== value) changed = true;
    return result;
  };
  const optionalText = (value: string | null): string | null => {
    if (value === null) return null;
    const presented = presentAssessmentText(value);
    const result = unreadable(value) ? null : presented.text || null;
    if (result !== value) changed = true;
    return result;
  };
  const limitations = (values: string[]): string[] => {
    const result = values.filter((value) => !unreadable(value)).map((value) => presentAssessmentText(value).text).filter(Boolean);
    if (JSON.stringify(result) !== JSON.stringify(values)) changed = true;
    return result;
  };
  const presentedClaims = snapshot.claims.filter((claim) => !unavailableClaims.has(claim.id)).map((claim) => ({
    ...claim,
    ...(claim.title !== undefined ? { title: unsafeClaimTitles.has(claim.id)
      ? healthClaimTitle({ ...claim, title: '' }) : text(claim.title, '相关检查记录') } : {}),
    text: text(claim.text, '这项检查尚缺具体解释。'),
    ...(claim.changeAssessment ? { changeAssessment: { ...claim.changeAssessment,
      summary: text(claim.changeAssessment.summary, '这项变化尚缺具体解释。'),
      reason: text(claim.changeAssessment.reason, '请结合完整检查记录理解。') } } : {}),
    rationale: text(claim.rationale, '具体依据见相关检查记录。'),
    materialUncertainty: optionalText(claim.materialUncertainty)
  }));
  if (unsafeClaimTitles.size > 0 || unsafeNodeTitles.size > 0) changed = true;
  const claims = JSON.stringify(presentedClaims) === JSON.stringify(snapshot.claims) ? snapshot.claims : presentedClaims;
  const presentedActions = snapshot.actions.filter((action) => !unavailableActions.has(action.id)).map((action) => ({
    ...action,
    title: text(action.title, '查看相关检查记录'),
    why: text(action.why, '结合现有检查结果安排下一步。'),
    firstStep: text(action.firstStep, '查看相关检查记录。'),
    timing: optionalText(action.timing), reviewPlan: optionalText(action.reviewPlan), caution: optionalText(action.caution)
  }));
  const actions = JSON.stringify(presentedActions) === JSON.stringify(snapshot.actions) ? snapshot.actions : presentedActions;
  const presentedQuestions = snapshot.questions.filter((question) => !held.has(question.id)
    && !question.relatedClaimIds.some((id) => unavailableClaims.has(id))
    && !question.evidenceIds.some((id) => unavailableEvidence.has(id))
    && ![question.question, question.whyItMatters].some(unreadable)).flatMap((question) => {
    const presentedQuestion = presentAssessmentText(question.question);
    if (!presentedQuestion.text) { changed = true; return []; }
    if (presentedQuestion.changed) changed = true;
    return [{ ...question, question: presentedQuestion.text,
      whyItMatters: text(question.whyItMatters, '这项信息会影响对相关检查的理解。') }];
  });
  const questions = JSON.stringify(presentedQuestions) === JSON.stringify(snapshot.questions) ? snapshot.questions : presentedQuestions;
  if (claims.length !== snapshot.claims.length || actions.length !== snapshot.actions.length
    || questions.length !== snapshot.questions.length) changed = true;
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const actionIds = new Set(actions.map((action) => action.id));
  const actionsById = new Map(actions.map((action) => [action.id, action]));
  const rebuiltNodeIds = new Set(snapshot.presentation?.rebuiltNodeIds ?? []);
  const project = <T extends OverviewNode | SystemNode>(node: T, overviewSystems: SystemNode[] = []): T => {
    const isOverview = node.id === 'overview';
    const isFallback = held.size > 0 && (held.has(node.id)
      || heldHeadlines.has(node.headline) || heldSummaries.has(node.summary));
    const retainedClaims = [...new Set(node.claimIds)].map((id) => byId.get(id))
      .filter((claim): claim is HealthClaim => Boolean(claim));
    const multipleSystems = new Set(claims.flatMap((claim) => claim.systemIds)).size > 1;
    const narrowOverview = isOverview && claims.length > 0 && (
      claims.some((claim) => node.headline === healthClaimTitle({ ...claim, title: undefined }))
      || multipleSystems && (claims.some((claim) => node.headline === healthClaimTitle(claim))
        || snapshot.systems.some((system) => node.headline === system.headline)));
    const cleanNode = { ...node, headline: unsafeNodeTitles.has(node.id)
      ? retainedClaims[0] ? healthClaimTitle(retainedClaims[0]) : '健康检查结果'
      : text(node.headline, '相关检查记录'),
      summary: text(node.summary, '可先查看检查结果和原始报告。'),
      limitations: limitations(node.limitations), claimIds: retainedClaims.map((claim) => claim.id),
      actionIds: node.actionIds.filter((id) => actionIds.has(id)) };
    const removedDependency = node.claimIds.length !== cleanNode.claimIds.length || node.actionIds.length !== cleanNode.actionIds.length;
    const unsafeSummary = [node.headline, node.summary].some(unreadable) || unavailableNodes.has(node.id)
      || isOverview && unsafeNodeTitles.has(node.id);
    const nodeChanged = JSON.stringify(cleanNode) !== JSON.stringify(node);
    if (nodeChanged) changed = true;
    if (!isFallback && !rebuiltNodeIds.has(node.id) && !removedDependency && !unsafeSummary && !narrowOverview) return nodeChanged ? cleanNode : node;
    rebuiltNodeIds.add(node.id);
    return { ...cleanNode, ...('systemId' in node && (removedDependency || unavailableNodes.has(node.id))
      ? { status: 'insufficient' as const } : {}), ...(isOverview
      // 全身总览可以使用同一成员的全部合格判断；系统摘要仍只读取自己的依赖。
      ? { ...retainedOverviewNarrative(claims, cleanNode.limitations, 2_000,
        { systems: overviewSystems, rebuiltNodeIds: [...rebuiltNodeIds], actions,
          overviewClaimIds: cleanNode.claimIds }), claimIds: [...cleanNode.claimIds,
          ...claims.filter((claim) => !cleanNode.claimIds.includes(claim.id)).map((claim) => claim.id)] }
      : retainedAssessmentNarrative(retainedClaims,
        cleanNode.actionIds.map((id) => actionsById.get(id)!).filter(Boolean), cleanNode.limitations)) };
  };
  const systems = snapshot.systems.map((node) => project(node));
  const overview = project(snapshot.overview, systems);
  const snapshotLimitations = limitations(snapshot.limitations);
  if (!changed && rebuiltNodeIds.size === 0) return snapshot;
  return {
    ...snapshot, overview, systems, claims, actions, questions, limitations: snapshotLimitations,
    presentation: { version: ASSESSMENT_PRESENTATION_VERSION,
      rebuiltNodeIds: [...rebuiltNodeIds].sort((left, right) => left === 'overview' ? -1 : right === 'overview' ? 1 : 0) }
  };
}
