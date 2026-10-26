import { useRef, useState } from 'react';
import { CalendarClock, FileCheck2, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import type { DashboardSnapshot } from '@contracts';

export type DateCorrectionConsentResult = boolean | 'date_correction_scope_changed';

export interface DateCorrectionConsentDialogProps {
  snapshot: DashboardSnapshot;
  documentId: string;
  onClose(): void;
  onLogin(): void;
  onConfirm(documentId: string, expectedDataRevision: string): Promise<DateCorrectionConsentResult>;
}

/** 授权单份原件日期核实及同成员综合，不接收用户提供的“正确日期”。 */
export function DateCorrectionConsentDialog({ snapshot, documentId, onClose, onLogin, onConfirm }: DateCorrectionConsentDialogProps) {
  const [target] = useState(() => {
    const document = snapshot.inbox.find((item) => item.id === documentId);
    const person = snapshot.persons.find((member) => member.id === document?.personId);
    return { documentId, personId: person?.id ?? null,
      documentLabel: document?.displayName ?? '无法确认的报告', personLabel: person?.displayName ?? '无法确认的成员',
      workspaceMode: snapshot.workspaceMode, workspaceName: snapshot.workspaceName,
      valid: snapshot.workspaceMode === 'personal' && document?.status === 'completed'
        && Boolean(document.displayName.trim() && person?.displayName.trim())
        && !document.inProcessingCenter && document.acceptedFactCount !== 0
        && /^[a-f0-9]{64}$/.test(person?.dataRevision ?? '') };
  });
  const documents = snapshot.inbox.filter((item) => item.id === target.documentId);
  const document = documents[0];
  const person = snapshot.persons.find((member) => member.id === target.personId);
  const validTarget = target.valid && documentId === target.documentId && documents.length === 1
    && document?.personId === target.personId && document.status === 'completed'
    && document.displayName === target.documentLabel && person?.displayName === target.personLabel
    && !document.inProcessingCenter && document.acceptedFactCount !== 0
    && /^[a-f0-9]{64}$/.test(person?.dataRevision ?? '')
    && snapshot.workspaceMode === target.workspaceMode && snapshot.workspaceName === target.workspaceName;
  const scopeSignature = JSON.stringify({ documentId, targetDocumentId: target.documentId, validTarget,
    personId: document?.personId, documentLabel: document?.displayName, status: document?.status,
    inProcessingCenter: document?.inProcessingCenter, sourceLabel: document?.sourceLabel,
    discoveredAt: document?.discoveredAt, format: document?.format, acceptedFactCount: document?.acceptedFactCount,
    personLabel: person?.displayName, personAcceptedFactCount: person?.acceptedFactCount,
    dataRevision: person?.dataRevision, clinicalContextRevision: person?.clinicalContextRevision,
    workspaceMode: snapshot.workspaceMode, workspaceName: snapshot.workspaceName,
    accountStatus: snapshot.account.status, accountLabel: snapshot.account.displayLabel });
  const [previousSignature, setPreviousSignature] = useState(scopeSignature);
  const [confirmedScope, setConfirmedScope] = useState<{ signature: string; dataRevision: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [submissionError, setSubmissionError] = useState(false);
  const [rejectedRevision, setRejectedRevision] = useState<string | null>(null);
  const pending = useRef(false);
  if (previousSignature !== scopeSignature) {
    setPreviousSignature(scopeSignature);
    if (confirmedScope !== null) setConfirmedScope(null);
  }
  const awaitingFreshSnapshot = rejectedRevision !== null && person?.dataRevision === rejectedRevision;
  const confirmed = confirmedScope?.signature === scopeSignature;
  const connected = snapshot.account.status === 'connected';
  async function submit() {
    if (pending.current || !connected || !validTarget || !confirmed || !confirmedScope || awaitingFreshSnapshot) return;
    pending.current = true;
    setBusy(true);
    setSubmissionError(false);
    const revision = confirmedScope.dataRevision;
    try {
      const result = await onConfirm(target.documentId, revision);
      if (result === true) onClose();
      else {
        setConfirmedScope(null);
        if (result === 'date_correction_scope_changed') setRejectedRevision(revision);
        else setSubmissionError(true);
      }
    } catch {
      setConfirmedScope(null);
      setSubmissionError(true);
    } finally { pending.current = false; setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (!busy && event.target === event.currentTarget) onClose();
  }}>
    <section className="member-dialog process-consent-dialog" style={{ borderRadius: 16, padding: 24 }}
      role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="date-correction-consent-title">
      <header><div><span className="eyebrow">单份报告日期核实</span><h2 id="date-correction-consent-title">让模型核实并修正日期</h2></div>
        <button className="icon-button" style={{ minWidth: 44, minHeight: 44 }} disabled={busy} onClick={onClose} aria-label="关闭日期核实确认"><X size={19} /></button>
      </header>
      <p style={{ fontSize: 16 }}>仅核实 <strong>{target.personLabel}</strong> 的这份报告：<strong>{target.documentLabel}</strong>。</p>
      <p style={{ fontSize: 16 }}>将把这份报告的<strong>完整原件发送给 OpenAI/Codex，独立读取两次</strong>，核对报告日期及各项目的检查日期。由模型根据原件判断，无需你输入正确日期。</p>
      <p style={{ fontSize: 16 }}>核实后，还会把 <strong>{target.personLabel}</strong> 当前 <strong>{person?.acceptedFactCount ?? 0} 条已保存的检查事实、必要的报告原句和本人补充</strong> 发送给同一接收方 <strong>OpenAI/Codex</strong>，更新这位成员的综合解读。</p>
      <p style={{ fontSize: 16 }}>后续综合不重新发送其他报告原件，不改变其他成员的资料与解读。</p>
      <p style={{ fontSize: 16 }}>综合解读沿用既有联网设置。如启用联网搜索，健康信息可能被误带入搜索查询，应用目前无法在发送前拦截实际查询词；授权前请确认你接受这项风险。</p>
      <div className="consent-facts" style={{ fontSize: 16, padding: 16 }}>
        <span><CalendarClock size={18} /> 只允许更正这份报告已有事实的自动日期</span>
        <span><FileCheck2 size={18} /> 保留旧版本和历史记录，其他检查事实与已有计划继续保留</span>
        <span><ShieldCheck size={18} /> 日期无法核实时保留原记录，不凭猜测修改</span>
      </div>
      {!validTarget && <p role="alert" className="form-error" style={{ fontSize: 16 }}>原先选择的报告、所属成员或工作区已变化，暂时不能提交。请取消后重新打开这份报告的确认窗。</p>}
      <label className="check-label" style={{ fontSize: 16, minHeight: 44 }}>
        <input type="checkbox" checked={confirmed} disabled={busy || !validTarget || !connected || awaitingFreshSnapshot}
          onChange={(event) => {
            setConfirmedScope(event.target.checked && validTarget && connected && !awaitingFreshSnapshot && person
              ? { signature: scopeSignature, dataRevision: person.dataRevision } : null);
            setSubmissionError(false);
            if (!awaitingFreshSnapshot) setRejectedRevision(null);
          }} /> 我授权向 OpenAI/Codex 发送这一份完整原件进行两次独立日期核实，并使用上述当前成员已有资料更新综合解读
      </label>
      {!connected && <p style={{ fontSize: 16 }}>请先连接 Codex，再确认本次发送范围。</p>}
      {submissionError && <p role="alert" className="form-error" style={{ fontSize: 16 }}>暂时无法确认日期核实任务。不会自动重试；请先查看处理中心，或稍后重新打开并授权。</p>}
      {rejectedRevision !== null && <p role="alert" className="form-error" style={{ fontSize: 16 }}>这份报告或成员资料已变化，本次授权已撤回。{awaitingFreshSnapshot ? '请等待档案刷新，或取消后重新打开，再确认当前资料。' : '请重新勾选授权后再开始。'}</p>}
      <div className="dialog-actions">
        <button className="secondary-button" style={{ fontSize: 16 }} disabled={busy} onClick={onClose}>取消</button>
        {!connected ? <button className="primary-button" style={{ fontSize: 16 }} onClick={onLogin}>连接 Codex</button>
          : <button className="primary-button" style={{ fontSize: 16 }} disabled={!confirmed || busy || !validTarget || awaitingFreshSnapshot} onClick={() => void submit()}>
            {busy ? <LoaderCircle size={18} className="spin" /> : <CalendarClock size={18} />} 授权并核实日期
          </button>}
      </div>
    </section>
  </div>;
}
