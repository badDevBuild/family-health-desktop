import { useState } from 'react';
import { FileText, Upload } from 'lucide-react';
import type { DashboardSnapshot } from '@contracts';

export function ReportUploadPanel({ persons, personId, onSelectPerson, onImport, onDropFiles }: {
  persons: DashboardSnapshot['persons'];
  personId: string;
  onSelectPerson(personId: string): void;
  onImport(personId: string | null): void;
  onDropFiles(files: File[], personId: string | null): void;
}) {
  const [dragActive, setDragActive] = useState(false);
  const person = persons.find((item) => item.id === personId);
  return <section className={`panel report-upload-panel drop-zone${dragActive ? ' is-dragging' : ''}`}
    aria-label="上传报告"
    onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
    onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragActive(false); }}
    onDrop={(event) => {
      event.preventDefault();
      setDragActive(false);
      const files = Array.from(event.dataTransfer.files);
      if (files.length) onDropFiles(files, person?.id ?? null);
    }}>
    <div className="report-upload-panel__recipient">
      <div className="report-upload-panel__identity" aria-live="polite">
        <span className="avatar avatar--large" aria-hidden="true">{person?.displayName.slice(0, 1) ?? <FileText size={24} />}</span>
        <div><span className="report-upload-panel__label">本次上传给</span>
          <strong>{person?.displayName ?? '仅保存原件'}</strong>
          <span className="report-upload-panel__relation">{person?.relation ?? '暂不归属成员，不发送给 AI'}</span></div>
      </div>
      <label className="report-upload-panel__select">上传到哪位成员
        <select aria-label="归属成员" value={person?.id ?? ''} onChange={(event) => onSelectPerson(event.target.value)}>
          <option value="">仅保存原件</option>
          {persons.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.relation}</option>)}
        </select>
      </label>
    </div>
    <p className="report-upload-panel__assignment">{person
      ? `本次选择的文件都会放入${person.displayName}的档案，以你选择的成员为准。`
      : '可以先保存文件，选择成员后再自动整理。'}</p>
    <div className="report-upload-panel__files">
      <div><FileText size={24} aria-hidden="true" /><span><strong>拖入 PDF、图片、DOCX 或 TXT</strong>
        <small>{person ? '自动读取报告并更新这位成员的健康看板。' : '原件保存在本机，暂不进行 AI 处理。'}最多一次 100 份，每份不超过 100MB；旧版 .doc 原件会保留。</small></span></div>
      <button className="primary-button" onClick={() => onImport(person?.id ?? null)}><Upload size={18} aria-hidden="true" />{person ? '上传并整理' : '选择文件并保存'}</button>
    </div>
  </section>;
}
