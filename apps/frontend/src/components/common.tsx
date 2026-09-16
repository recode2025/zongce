import { useEffect, useState } from 'react';
import { Select, Tag } from 'antd';
import {
  APP_STATUS_LABEL,
  BATCH_STATUS_LABEL,
  ISSUE_TYPE_LABEL,
  PACKAGE_SECTION_LABEL,
  RESULT_FLAG_LABEL,
} from '@zc/shared';
import { Batch, fetchBatches } from '../api';

// ---------- 状态标签 ----------

const APP_STATUS_COLOR: Record<string, string> = {
  DRAFT: 'default',
  SUBMITTED: 'processing',
  FIRST_PASSED: 'warning',
  FIRST_REJECTED: 'error',
  APPROVED: 'success',
  REJECTED: 'default',
};
export const AppStatusTag = ({ status }: { status: string }) => (
  <Tag color={APP_STATUS_COLOR[status] ?? 'default'}>{APP_STATUS_LABEL[status as keyof typeof APP_STATUS_LABEL] ?? status}</Tag>
);

const BATCH_STATUS_COLOR: Record<string, string> = {
  DRAFT: 'default',
  DATA_PREP: 'geekblue',
  COLLECTING: 'processing',
  FIRST_REVIEW: 'cyan',
  SECOND_REVIEW: 'gold',
  CALCULATED: 'purple',
  PUBLICITY: 'orange',
  ARCHIVED: 'success',
};
export const BatchStatusTag = ({ status }: { status: string }) => (
  <Tag color={BATCH_STATUS_COLOR[status] ?? 'default'}>{BATCH_STATUS_LABEL[status as keyof typeof BATCH_STATUS_LABEL] ?? status}</Tag>
);

const PKG_STATUS: Record<string, { color: string; text: string }> = {
  NOT_SUBMITTED: { color: 'default', text: '未提交' },
  SUBMITTED: { color: 'processing', text: '待初审' },
  FIRST_PASSED: { color: 'success', text: '初审通过' },
  FIRST_REJECTED: { color: 'error', text: '初审退回' },
};
export const PackageStatusTag = ({ status }: { status: string }) => {
  const m = PKG_STATUS[status] ?? { color: 'default', text: status };
  return <Tag color={m.color}>{m.text}</Tag>;
};

export const SectionTag = ({ section }: { section: string }) => (
  <Tag color={section === 'PRACTICE_VOLUNTEER' ? 'blue' : 'geekblue'}>
    {PACKAGE_SECTION_LABEL[section as keyof typeof PACKAGE_SECTION_LABEL] ?? section}
  </Tag>
);

export const IssueTypeTag = ({ type }: { type: string }) => <Tag color="volcano">{ISSUE_TYPE_LABEL[type as keyof typeof ISSUE_TYPE_LABEL] ?? type}</Tag>;

const RESOLUTION_LABEL: Record<string, { color: string; text: string }> = {
  PENDING: { color: 'error', text: '待裁决' },
  AUTO_PICK_FINAL: { color: 'blue', text: '自动取期末' },
  MANUAL_PICKED: { color: 'purple', text: '人工指定' },
  EXCLUDED: { color: 'default', text: '剔除不计' },
  INCLUDED: { color: 'success', text: '确认计入' },
};
export const ResolutionTag = ({ resolution }: { resolution: string }) => {
  const m = RESOLUTION_LABEL[resolution] ?? { color: 'default', text: resolution };
  return <Tag color={m.color}>{m.text}</Tag>;
};

export const FlagTag = ({ flag }: { flag: string }) => (
  <Tag color="warning" style={{ marginInlineEnd: 0 }}>
    {RESULT_FLAG_LABEL[flag] ?? flag}
  </Tag>
);

export const fileSize = (n?: number) => {
  if (!n && n !== 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export const fmtTime = (t?: string | Date | null) => {
  if (!t) return '-';
  const d = new Date(t);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ---------- 批次选择（管理端各页共用） ----------

let cachedBatches: Batch[] | null = null;

export function useBatches() {
  const [batches, setBatches] = useState<Batch[]>(cachedBatches ?? []);
  useEffect(() => {
    if (cachedBatches) return;
    let alive = true;
    fetchBatches()
      .then((list) => {
        cachedBatches = list;
        if (alive) setBatches(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return batches;
}

export function BatchSelect({
  value,
  onChange,
  style,
}: {
  value?: string;
  onChange: (v: string) => void;
  style?: React.CSSProperties;
}) {
  const batches = useBatches();
  return (
    <Select
      value={value}
      onChange={onChange}
      style={{ minWidth: 260, ...style }}
      placeholder="选择批次"
      options={batches.map((b) => ({
        value: b.id,
        label: `${b.name}（${b.semesterKey}）`,
      }))}
    />
  );
}
