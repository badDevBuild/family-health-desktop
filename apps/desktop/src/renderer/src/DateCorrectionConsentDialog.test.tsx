// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '@contracts';
import { createDemoSnapshot } from '../../../../../packages/test-fixtures/src/index.js';
import { DateCorrectionConsentDialog, type DateCorrectionConsentDialogProps } from './DateCorrectionConsentDialog.js';

afterEach(cleanup);

// 只使用虚构成员与文件；不访问真实报告、账户或服务。
function snapshot(): DashboardSnapshot {
  const demo = createDemoSnapshot();
  const person = { ...demo.persons[0]!, id: 'date-synthetic-person', displayName: '日期测试成员', acceptedFactCount: 7, dataRevision: 'a'.repeat(64) };
  return { ...demo, workspaceMode: 'personal', workspaceName: '日期测试工作区', account: { ...demo.account, status: 'connected', displayLabel: '合成账户' },
    persons: [person], jobs: [], inbox: [{ id: 'date-synthetic-document', displayName: '合成日期报告.pdf', personId: person.id,
      personLabel: person.displayName, format: 'PDF', sourceLabel: '合成原件', discoveredAt: '2026-01-01T00:00:00Z',
      status: 'completed', inProcessingCenter: false, sentToAi: true, aiTransmissionStatus: 'completed', acceptedFactCount: 2, issue: null }] };
}

function mount(overrides: Partial<DateCorrectionConsentDialogProps> = {}) {
  const props: DateCorrectionConsentDialogProps = { snapshot: snapshot(), documentId: 'date-synthetic-document',
    onClose: vi.fn(), onLogin: vi.fn(), onConfirm: vi.fn(async () => true), ...overrides };
  const view = render(<DateCorrectionConsentDialog {...props} />);
  const dialog = screen.getByRole('dialog', { name: '让模型核实并修正日期' });
  const checkbox = within(dialog).getByRole('checkbox') as HTMLInputElement;
  const submit = () => within(dialog).getByRole('button', { name: '授权并核实日期' }) as HTMLButtonElement;
  return { ...view, props, dialog, checkbox, submit };
}

describe('单报告日期纠错授权', () => {
  it('固定展示单份报告、成员、完整原件和两次读取；不提供日期或多选输入', async () => {
    const { dialog, checkbox, submit, props } = mount();
    expect(dialog.textContent).toContain('日期测试成员');
    expect(dialog.textContent).toContain('合成日期报告.pdf');
    expect(dialog.textContent).toContain('完整原件发送给 OpenAI/Codex，独立读取两次');
    expect(dialog.textContent).toContain('7 条已保存的检查事实、必要的报告原句和本人补充');
    expect(dialog.textContent).toContain('发送给同一接收方 OpenAI/Codex，更新这位成员的综合解读');
    expect(dialog.textContent).toContain('后续综合不重新发送其他报告原件，不改变其他成员的资料与解读');
    expect(dialog.textContent).toContain('沿用既有联网设置');
    expect(dialog.textContent).toContain('健康信息可能被误带入搜索查询');
    expect(dialog.textContent).toContain('无法在发送前拦截实际查询词');
    expect(checkbox.labels?.[0]?.textContent).toContain('两次独立日期核实');
    expect(checkbox.labels?.[0]?.textContent).toContain('使用上述当前成员已有资料更新综合解读');
    expect(dialog.textContent).toContain('只允许更正这份报告已有事实的自动日期');
    expect(dialog.textContent).toContain('保留旧版本和历史记录，其他检查事实与已有计划继续保留');
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(dialog.querySelector('input[type="date"]')).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(submit().disabled).toBe(true);
    fireEvent.click(checkbox);
    await act(async () => fireEvent.click(submit()));
    expect(props.onConfirm).toHaveBeenCalledExactlyOnceWith('date-synthetic-document', 'a'.repeat(64));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it.each(['revision', 'accepted_fact_count', 'account', 'workspace', 'document_person', 'document_name', 'person_name', 'document_removed', 'person_removed', 'prop_document'] as const)('%s 变化撤回勾选，不转交到其他报告或成员', (change) => {
    const { props, rerender, checkbox, dialog, submit } = mount();
    fireEvent.click(checkbox);
    const next = structuredClone(props.snapshot);
    if (change === 'revision') next.persons[0]!.dataRevision = 'b'.repeat(64);
    if (change === 'accepted_fact_count') next.persons[0]!.acceptedFactCount = 9;
    if (change === 'account') next.account.displayLabel = '另一合成账户';
    if (change === 'workspace') next.workspaceName = '另一个合成工作区';
    if (change === 'document_person') next.inbox[0]!.personId = 'another-person';
    if (change === 'document_name') next.inbox[0]!.displayName = '另一个名称.pdf';
    if (change === 'person_name') next.persons[0]!.displayName = '另一个名称';
    if (change === 'document_removed') next.inbox = [];
    if (change === 'person_removed') next.persons = [];
    rerender(<DateCorrectionConsentDialog {...props} snapshot={next}
      documentId={change === 'prop_document' ? 'another-document' : props.documentId} />);
    expect(checkbox.checked).toBe(false);
    expect(submit().disabled).toBe(true);
    expect(dialog.textContent).toContain('合成日期报告.pdf');
    expect(dialog.textContent).toContain('日期测试成员');
    if (change === 'accepted_fact_count') expect(dialog.textContent).toContain('9 条已保存的检查事实');
    fireEvent.click(submit());
    expect(props.onConfirm).not.toHaveBeenCalled();
    rerender(<DateCorrectionConsentDialog {...props} />);
    expect(checkbox.checked).toBe(false);
  });

  it('无关成员和报告到达不扩大范围，也不撤销已经确认的范围', () => {
    const { props, rerender, checkbox } = mount();
    fireEvent.click(checkbox);
    const next = structuredClone(props.snapshot);
    next.persons.push({ ...next.persons[0]!, id: 'unrelated-person', displayName: '合成父亲', acceptedFactCount: 19 });
    next.inbox.push({ ...next.inbox[0]!, id: 'unrelated-document', personId: 'unrelated-person' });
    rerender(<DateCorrectionConsentDialog {...props} snapshot={next} />);
    expect(checkbox.checked).toBe(true);
    expect(screen.queryByText('合成父亲')).toBeNull();
    expect(screen.getByRole('dialog').textContent).toContain('7 条已保存的检查事实');
    expect(screen.getByRole('dialog').textContent).not.toContain('19 条');
    expect(screen.getByRole('dialog').textContent).toContain('不改变其他成员的资料与解读');
  });

  it('退出账户立即撤销勾选，重新连接后仍需手动确认', () => {
    const { props, rerender, checkbox } = mount();
    fireEvent.click(checkbox);
    rerender(<DateCorrectionConsentDialog {...props} snapshot={{ ...props.snapshot, account: { ...props.snapshot.account, status: 'disconnected' } }} />);
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '连接 Codex' }));
    expect(props.onLogin).toHaveBeenCalledTimes(1);
    rerender(<DateCorrectionConsentDialog {...props} />);
    expect(checkbox.checked).toBe(false);
  });

  it.each(['missing', 'queued', 'ignored', 'zero_facts', 'processing', 'bad_revision', 'demo'] as const)('无效目标 %s 不可授权', (invalid) => {
    const current = snapshot();
    if (invalid === 'missing') current.inbox = [];
    if (invalid === 'queued') current.inbox[0]!.status = 'queued';
    if (invalid === 'ignored') current.inbox[0]!.status = 'ignored';
    if (invalid === 'zero_facts') current.inbox[0]!.acceptedFactCount = 0;
    if (invalid === 'processing') current.inbox[0]!.inProcessingCenter = true;
    if (invalid === 'bad_revision') current.persons[0]!.dataRevision = 'invalid';
    if (invalid === 'demo') current.workspaceMode = 'demo';
    const { checkbox, submit, props } = mount({ snapshot: current });
    expect(checkbox.disabled).toBe(true);
    fireEvent.click(submit());
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('等待回执时防双击和取消；失败不自动重试且撤回授权', async () => {
    let finish: (value: false) => void = () => undefined;
    const onConfirm = vi.fn(() => new Promise<false>((resolve) => { finish = resolve; }));
    const { dialog, checkbox, submit, props } = mount({ onConfirm });
    fireEvent.click(checkbox);
    fireEvent.click(submit());
    fireEvent.click(submit());
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    await act(async () => finish(false));
    expect(checkbox.checked).toBe(false);
    expect(submit().disabled).toBe(true);
    expect(within(dialog).getByRole('alert').textContent).toContain('不会自动重试');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('范围过期后旧版本不能重新勾选，新版本到达后需再次授权', async () => {
    const onConfirm = vi.fn(async () => 'date_correction_scope_changed' as const);
    const { props, rerender, checkbox, submit, dialog } = mount({ onConfirm });
    fireEvent.click(checkbox);
    await act(async () => fireEvent.click(submit()));
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    expect(within(dialog).getByRole('alert').textContent).toContain('请等待档案刷新');
    const next = structuredClone(props.snapshot);
    next.persons[0]!.dataRevision = 'c'.repeat(64);
    rerender(<DateCorrectionConsentDialog {...props} snapshot={next} />);
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(submit().disabled).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
