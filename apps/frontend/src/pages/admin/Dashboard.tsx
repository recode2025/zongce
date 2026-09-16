import { useEffect, useState } from 'react';
import { App, Card, Col, Progress, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { fetchOverview } from '../../api';
import { errMsg } from '../../api/client';
import { BatchSelect, BatchStatusTag, useBatches } from '../../components/common';
import { ISSUE_TYPE_LABEL } from '@zc/shared';

/** 统计看板：提交率 / 审核积压 / 异常计数 / 分数分布 */
export default function Dashboard() {
  const { message } = App.useApp();
  const batches = useBatches();
  const [batchId, setBatchId] = useState<string>('');
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    if (!batchId && batches.length) {
      const active = batches.find((b) => b.status !== 'ARCHIVED') ?? batches[0];
      setBatchId(active.id);
    }
  }, [batches, batchId]);

  useEffect(() => {
    if (!batchId) return;
    fetchOverview(batchId)
      .then(setData)
      .catch((e) => message.error(errMsg(e)));
  }, [batchId, message]);

  if (!data) {
    return batchId ? <Card size="small" loading style={{ minHeight: 300 }} /> : <Card size="small">暂无批次，请先到「批次管理」创建</Card>;
  }

  const dist = data.score?.distribution ?? {};
  const distMax = Math.max(1, ...Object.values(dist).map((v) => Number(v)));
  const submitted = data.submission?.reduce((s: number, c: any) => s + c.submitted, 0) ?? 0;
  const totalStudents = data.students?.total ?? 0;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap size="large">
          <BatchSelect value={batchId} onChange={setBatchId} />
          {data.batch && (
            <>
              <BatchStatusTag status={data.batch.status} />
              <Typography.Text type="secondary">
                {data.batch.semesterKey} · 计算版本 v{data.batch.calcVersion}
                {data.batch.published ? ` · 第 ${data.batch.round} 轮公示` : ' · 未发布'}
              </Typography.Text>
            </>
          )}
        </Space>
      </Card>

      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="在籍学生" value={totalStudents} suffix={`人 / ${data.students.classes} 班`} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="学籍异常（休学等）" value={data.students.abnormal} valueStyle={{ color: '#faad14' }} suffix="人" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="材料包提交率"
              value={totalStudents ? Math.round((submitted / totalStudents) * 100) : 0}
              suffix={`%（${submitted}/${totalStudents}）`}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="审核积压"
              value={data.pendingReviewBacklog}
              valueStyle={{ color: data.pendingReviewBacklog > 0 ? '#fa8c16' : '#52c41a' }}
              suffix="条申请"
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <Card size="small" title={`成绩异常（待裁决 ${data.issues?.pending ?? 0} 条）`} style={{ height: '100%' }}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {(data.issues?.byType ?? []).map((g: any) => (
                <Space key={`${g.type}-${g.resolution}`} style={{ justifyContent: 'space-between', width: '100%' }} wrap>
                  <Space size={6}>
                    <Tag color={g.resolution === 'PENDING' ? 'error' : 'default'} style={{ marginInlineEnd: 0 }}>
                      {g.resolution === 'PENDING' ? '待裁决' : g.resolution}
                    </Tag>
                    <Typography.Text>{ISSUE_TYPE_LABEL[g.type as keyof typeof ISSUE_TYPE_LABEL] ?? g.type}</Typography.Text>
                  </Space>
                  <Typography.Text strong className="zc-num">{g.count}</Typography.Text>
                </Space>
              ))}
              {!(data.issues?.byType ?? []).length && <Typography.Text type="secondary">无异常数据</Typography.Text>}
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={`分数分布（v${data.score?.version ?? '-'} · ${data.score?.count ?? 0} 人）`} style={{ height: '100%' }}>
            {data.score?.count ? (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {Object.entries(dist).map(([k, v]) => (
                  <Space key={k} style={{ width: '100%' }}>
                    <Typography.Text style={{ width: 52 }}>{k}</Typography.Text>
                    <Progress percent={Math.round((Number(v) / distMax) * 100)} showInfo={false} style={{ flex: 1, marginBottom: 0 }} />
                    <Typography.Text className="zc-num" style={{ width: 36, textAlign: 'right' }}>{v as number}</Typography.Text>
                  </Space>
                ))}
                {Object.keys(data.score?.flags ?? {}).length > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    标记：{Object.entries(data.score.flags).map(([f, n]) => `${f}×${n}`).join('、')}
                  </Typography.Text>
                )}
              </Space>
            ) : (
              <Typography.Text type="secondary">尚未计算</Typography.Text>
            )}
          </Card>
        </Col>
      </Row>

      <Card size="small" title="分班提交率（升序，末位班级需催报）">
        <Table
          size="small"
          rowKey="classId"
          dataSource={data.submission ?? []}
          pagination={{ pageSize: 10, size: 'default' }}
          columns={[
            { title: '班级', dataIndex: 'className' },
            { title: '在籍人数', dataIndex: 'students', width: 100, align: 'right' },
            { title: '已提交', dataIndex: 'submitted', width: 90, align: 'right' },
            {
              title: '提交率',
              dataIndex: 'rate',
              width: 260,
              render: (v: number) => <Progress percent={v} size="small" status={v >= 80 ? 'success' : v >= 50 ? 'normal' : 'exception'} />,
            },
          ]}
        />
      </Card>
    </Space>
  );
}
