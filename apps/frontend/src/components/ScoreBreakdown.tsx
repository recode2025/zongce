import type { ReactNode } from 'react';
import { Alert, Card, Descriptions, Empty, Space, Table, Tag, Typography } from 'antd';
import { FlagTag, fileSize } from './common';

export interface BreakdownItem {
  key: string;
  score: number;
  source: 'ENGINE' | 'APPLICATION';
  applicationIds?: string[];
  note?: string;
}

export interface CourseSummary {
  source?: string;
  courseCount: number;
  totalCredit: number;
  weightedAvg: number | null;
  peScore: number | null;
  excluded: { courseName: string; reason: string }[];
}

function withRowKeys<T>(items: T[], identity: (item: T) => string) {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const id = identity(item);
    const occurrence = counts.get(id) ?? 0;
    counts.set(id, occurrence + 1);
    return { ...item, rowId: JSON.stringify([id, occurrence]) };
  });
}

/** 计算结果可解释明细：每分项来源 + 课程汇总 + 剔除原因。
    flat=true 时渲染轻量小节标题（学生查分页已嵌在外层卡片里，避免双层 Card）；管理端默认保持 Card 分节 */
export default function ScoreBreakdown({
  breakdown,
  courseSummary,
  flags,
  flat = false,
}: {
  breakdown?: BreakdownItem[];
  courseSummary?: CourseSummary;
  flags?: string[];
  flat?: boolean;
}) {
  if (courseSummary?.source === 'HISTORICAL_IMPORT') {
    return <Alert type="info" showIcon message="历史汇总，课程和分项构成未导入" />;
  }

  const section = (title: string, child: ReactNode) =>
    flat ? (
      <div className="zc-flat-sec">
        <div className="zc-flat-title">{title}</div>
        {child}
      </div>
    ) : (
      <Card size="small" title={title}>
        {child}
      </Card>
    );

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {flags && flags.length > 0 && section('标记', <Space wrap>{flags.map((f) => <FlagTag key={f} flag={f} />)}</Space>)}

      {courseSummary &&
        section(
          '课程汇总',
          <>
            <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3, lg: 4 }} bordered>
              <Descriptions.Item label="计入课程数">{courseSummary.courseCount}</Descriptions.Item>
              <Descriptions.Item label="总学分">{courseSummary.totalCredit}</Descriptions.Item>
              <Descriptions.Item label="加权均分">{courseSummary.weightedAvg ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="体育课成绩">
                {courseSummary.peScore === null ? <Tag>无专项体育课（基础分=3）</Tag> : `${courseSummary.peScore}（折算文体基础分）`}
              </Descriptions.Item>
            </Descriptions>
            {courseSummary.excluded?.length > 0 && (
              <Table
                size="small"
                style={{ marginTop: 8 }}
                rowKey="rowId"
                pagination={false}
                dataSource={withRowKeys(courseSummary.excluded, (item) => JSON.stringify([item.courseName, item.reason]))}
                scroll={{ x: 320 }}
                columns={[
                  { title: '未计入课程', dataIndex: 'courseName', ellipsis: { showTitle: true } },
                  { title: '原因', dataIndex: 'reason', render: (r: string) => <Typography.Text type="secondary">{r}</Typography.Text> },
                ]}
              />
            )}
          </>,
        )}

      {section(
        '分项明细（可解释）',
        breakdown?.length ? (
          <Table
            size="small"
            rowKey="rowId"
            pagination={false}
            dataSource={withRowKeys(breakdown, (item) => JSON.stringify([item.source, item.key]))}
            scroll={{ x: 510 }}
            columns={[
              { title: '分项', dataIndex: 'key', width: 170, render: (k: string) => <Typography.Text code style={{ whiteSpace: 'nowrap' }}>{k}</Typography.Text> },
              {
                title: '来源',
                dataIndex: 'source',
                width: 110,
                render: (s: string) => (s === 'ENGINE' ? <Tag color="geekblue">引擎计算</Tag> : <Tag color="green">申请认定</Tag>),
              },
              { title: '分值', dataIndex: 'score', width: 90, align: 'right', className: 'zc-num', render: (v: number) => <span style={{ color: v < 0 ? 'var(--zc-danger)' : undefined }}>{v.toFixed(2)}</span> },
              { title: '说明', dataIndex: 'note', ellipsis: { showTitle: true }, render: (n?: string) => (n ? <Typography.Text type="secondary">{n}</Typography.Text> : '-') },
            ]}
          />
        ) : (
          <Empty description="无分项明细" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ),
      )}
    </Space>
  );
}

export { fileSize };
