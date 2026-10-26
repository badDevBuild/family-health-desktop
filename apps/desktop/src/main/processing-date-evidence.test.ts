import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExtractionResult, ObservationCandidate, SourceSpan } from '@contracts';
import { DocumentExtractionPipeline, strengthenUnambiguousClinicalDateEvidence } from './processing-pipeline.js';
import { LegacyTextFixtureWorkspaceService as PersonalWorkspaceService } from './legacy-text-source.fixture.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const previousId = '22222222-2222-4222-8222-222222222222';
const currentId = '33333333-3333-4333-8333-333333333333';
const clinicalDate = '2024-10-25';
const resultText = '肝实质回声均匀，未见明显异常。';

function page(id: string, pageNumber: number, quote: string, spanKind: 'page' | 'image' = 'page'): SourceSpan {
  return {
    id, documentId, spanKind,
    page: pageNumber, blockId: null, lineStart: null, lineEnd: null,
    quote, readability: 'clear'
  };
}

function candidate(name = '肝胆脾胰', quote = resultText): ObservationCandidate {
  return {
    localKey: 'synthetic-result', originalName: name, standardNameCandidate: null,
    value: { kind: 'text', rawText: resultText }, unitRaw: null, referenceRangeRaw: null,
    reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
    clinicalDate, evidence: [{ sourceSpanId: currentId, quote }], issues: []
  };
}

describe('跨页同章节的临床日期补证', () => {
  it.each(['page', 'image'] as const)('%s 正文续页会补充上一页章节日期，保留原始结果', (spanKind) => {
    const first = page(previousId, 1, '超声科 肝胆脾胰彩超 检查日期：2024-10-25 检查医生：合成医生', spanKind);
    const second = page(currentId, 2, `登记流水号： 123456 2 项目名称 检查结果 单位 参考值 提示 肝胆脾胰 ${resultText} 超声科 甲状腺彩超 检查日期：2024-10-22`, spanKind);
    const input = candidate();
    const strengthened = strengthenUnambiguousClinicalDateEvidence([input], [first, second])[0]!;
    expect(strengthened.evidence).toEqual([
      input.evidence[0], { sourceSpanId: previousId, quote: '肝胆脾胰彩超 检查日期：2024-10-25 检查医生：合成医生' }
    ]);
    expect({ ...strengthened, evidence: input.evidence }).toEqual(input);
  });

  it('上一页连续数字检查时间同样可以补证，签发时间不当作章节检查时间', () => {
    const first = page(previousId, 1, '超声科 肝胆脾胰彩超 检查时间：20241025104838');
    const second = page(currentId, 2, `项目名称 检查结果 肝胆脾胰 ${resultText} 另一检查日期：2024-10-22`);
    const output = strengthenUnambiguousClinicalDateEvidence([candidate()], [first, second])[0]!;
    expect(output.evidence[1]).toEqual({ sourceSpanId: previousId, quote: '肝胆脾胰彩超 检查时间：20241025104838' });
    const issued = { ...first, quote: '肝胆脾胰彩超 报告时间：20241025104838' };
    expect(strengthenUnambiguousClinicalDateEvidence([candidate()], [issued, second])[0]!.evidence)
      .toEqual(candidate().evidence);
  });

  it('明确的小结仍可继续关联上一页同名章节', () => {
    const summary = '小结 未见明显异常。';
    const input = { ...candidate('肝胆脾胰彩超小结', summary), value: { kind: 'text' as const, rawText: '未见明显异常。' } };
    const first = page(previousId, 1, '超声科 肝胆脾胰彩超 检查日期：2024-10-25 项目名称 检查结果 肝实质回声均匀。');
    const second = page(currentId, 2, `${summary} 超声科 另一检查 检查日期：2024-10-22`);
    expect(strengthenUnambiguousClinicalDateEvidence([input], [first, second])[0]!.evidence[1])
      .toMatchObject({ sourceSpanId: previousId });
  });

  it.each([
    { name: '前页不是同名章节', previous: '甲状腺彩超 检查日期：2024-10-25' },
    { name: '同章节包含两个不同临床日期', previous: '肝胆脾胰彩超 检查日期：2024-10-25 复查日期：2024-10-22' },
    { name: '另一章节在前页已经开始', previous: '肝胆脾胰彩超 检查日期：2024-10-25 超声科 甲状腺彩超 检查日期：2024-10-22' },
    { name: '另一未注明日期章节在前页已经开始', previous: '肝胆脾胰彩超 检查日期：2024-10-25 内科 项目名称 检查结果' },
    { name: '仅有签发日期', previous: '肝胆脾胰彩超 签发日期：2024-10-25' },
    { name: '仅有报告日期', previous: '肝胆脾胰彩超 报告日期：2024-10-25' },
    { name: '前页标题有重复定位', previous: '肝胆脾胰彩超 检查日期：2024-10-25 肝胆脾胰彩超' },
    { name: '历史对比章节', previous: '肝胆脾胰彩超 检查日期：2024-10-25 历次结果对比' },
    { name: '日期与章节之间有其他正文', previous: '肝胆脾胰彩超 医生建议 检查日期：2024-10-25' }
  ])('$name 不会自动继承', ({ previous }) => {
    const first = page(previousId, 1, previous);
    const second = page(currentId, 2, `项目名称 检查结果 肝胆脾胰 ${resultText} 超声科 另一检查 检查日期：2024-10-22`);
    const input = candidate();
    expect(strengthenUnambiguousClinicalDateEvidence([input], [first, second])[0]).toEqual(input);
  });

  it.each([
    { name: '续页开始了另一章节', prefix: '超声科 甲状腺彩超 检查日期：2024-10-22 项目名称 肝胆脾胰 ' },
    { name: '结果不在页首连续正文', prefix: '无关正文 '.repeat(90) + '肝胆脾胰 ' },
    { name: '续页是历史列', prefix: '历史结果对比 肝胆脾胰 ' }
  ])('$name 不会从上一页补证', ({ prefix }) => {
    const first = page(previousId, 1, '肝胆脾胰彩超 检查日期：2024-10-25');
    const second = page(currentId, 2, `${prefix}${resultText} 超声科 另一检查 检查日期：2024-10-22`);
    const input = candidate();
    expect(strengthenUnambiguousClinicalDateEvidence([input], [first, second])[0]).toEqual(input);
  });

  it('同一上一页定位不唯一，或不是紧邻页时不猜测', () => {
    const first = page(previousId, 1, '肝胆脾胰彩超 检查日期：2024-10-25');
    const second = page(currentId, 2, `肝胆脾胰 ${resultText} 检查日期：2024-10-22`);
    const input = candidate();
    const duplicate = { ...first, id: '55555555-5555-4555-8555-555555555555' };
    expect(strengthenUnambiguousClinicalDateEvidence([input], [first, duplicate, second])[0]).toEqual(input);
    expect(strengthenUnambiguousClinicalDateEvidence([input], [first, { ...second, page: 3 }])[0]).toEqual(input);
  });
});

describe('连续数字检查时间的正式提取路径', () => {
  it('检查与签发时间分别验证，正确的检查时间进入事实而不触发局部重提取', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-compact-exam-date-'));
    const service = new PersonalWorkspaceService(root, '合成日期工作区', () => new Date('2026-10-13T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      const text = '检查时间：20240229104838 报告时间：20240301105249 肝胆脾胰 肝实质回声均匀，未见明显异常。';
      await service.importFiles([{ path: '/tmp/合成连续时间报告.txt', bytes: Buffer.from(text) }], personId);
      const docId = service.getSnapshot(null).inbox[0]!.id;
      const span = service.store.getDocumentExtractionBundle(docId).manifest.spans[0]!;
      const output: ExtractionResult = {
        schemaVersion: 1, documentId: docId,
        subject: { reportedName: null, evidence: [], confidence: 'absent' },
        coveredSourceSpanIds: [span.id],
        reportMetadata: {
          reportKind: null, title: null, organization: null, campus: null, department: null,
          reportNumber: null, examItems: [], times: [
            { value: '2024-02-29', precision: 'day', role: 'examined', evidence: [{ sourceSpanId: span.id, quote: '检查时间：20240229104838' }] },
            { value: '2024-03-01', precision: 'day', role: 'report_issued', evidence: [{ sourceSpanId: span.id, quote: '报告时间：20240301105249' }] }
          ]
        },
        candidates: [{ ...candidate('肝胆脾胰', `肝胆脾胰 ${resultText}`), clinicalDate: null,
          evidence: [{ sourceSpanId: span.id, quote: `肝胆脾胰 ${resultText}` }] }]
      };
      let turns = 0;
      const pipeline = new DocumentExtractionPipeline(service.store, {
        runStructuredTurn: async () => ({ threadId: 'synthetic-date-thread', turnId: `synthetic-date-${++turns}`, output })
      });
      await expect(pipeline.process(docId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
      expect(turns).toBe(1);
      expect(service.store.listAcceptedObservations(personId)[0]).toMatchObject({
        clinicalDate: '2024-02-29', rawText: resultText
      });
      expect(service.store.listReportMetadata(personId)[0]).toMatchObject({ reportDate: '2024-03-01' });
      expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
