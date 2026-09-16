import { Card, Descriptions, Empty, Space, Table, Tag, Typography } from 'antd';
import { FlagTag, fileSize } from './common';

export interface BreakdownItem {
  key: string;
  score: number;
  source: 'ENGINE' | 'APPLICATION';
  applicationIds?: string[];
  note?: string;
}

export interface CourseSummary {
  courseCount: number;
  totalCredit: number;
  weightedAvg: number | null;
  peScore: number | null;
  excluded: { courseName: string; reason: string }[];
}

/** 计算结果可解释明细：每分项来源 + 课程汇总 + 剔除原因 */
export default function ScoreBreakdown({ breakdown, courseSummary, flags }: { breakdown?: BreakdownItem[]; courseSummary?: CourseSummary; flags?: string[] }) {
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {flags && flags.length > 0 && (
        <Card size="small" title="标记">
          <Space wrap>{flags.map((f) => <FlagTag key={f} flag={f} />)}</Space>
        </Card>
      )}

      {courseSummary && (
        <Card size="small" title="课程汇总">
          <Descriptions size="small" column={4} bordered>
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
              rowKey={(_, i) => String(i)}
              pagination={false}
              dataSource={courseSummary.excluded}
              columns={[
                { title: '未计入课程', dataIndex: 'courseName' },
                { title: '原因', dataIndex: 'reason', render: (r: string) => <Typography.Text type="secondary">{r}</Typography.Text> },
              ]}
            />
          )}
        </Card>
      )}

      <Card size="small" title="分项明细（可解释）">
        {breakdown?.length ? (
          <Table
            size="small"
            rowKey={(_, i) => String(i)}
            pagination={false}
            dataSource={breakdown}
            columns={[
              { title: '分项', dataIndex: 'key', render: (k: string) => <Typography.Text code>{k}</Typography.Text> },
              {
                title: '来源',
                dataIndex: 'source',
                width: 110,
                render: (s: string) => (s === 'ENGINE' ? <Tag color="geekblue">引擎计算</Tag> : <Tag color="green">申请认定</Tag>),
              },
              { title: '分值', dataIndex: 'score', width: 90, align: 'right', className: 'zc-num', render: (v: number) => v.toFixed(2) },
              { title: '说明', dataIndex: 'note', render: (n?: string) => (n ? <Typography.Text type="secondary">{n}</Typography.Text> : '-') },
            ]}
          />
        ) : (
          <Empty description="无分项明细" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>
    </Space>
  );
}

export { fileSize };
