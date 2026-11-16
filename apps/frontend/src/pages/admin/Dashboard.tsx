import { useEffect, useRef, useState } from 'react';
import { App, Card, Empty, Space, Table, Tag, Typography } from 'antd';
import {
  AuditOutlined,
  BarChartOutlined,
  CheckCircleFilled,
  FileZipOutlined,
  PartitionOutlined,
  TeamOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { fetchOverview } from '../../api';
import { errMsg } from '../../api/client';
import { BatchSelect, BatchStatusTag, useBatches } from '../../components/common';
import { ISSUE_TYPE_LABEL } from '@zc/shared';

/** 加分申请流转条目（applications 按状态计数 → 可视化横条） */
const FLOW: { key: string; label: string; color: string }[] = [
  { key: 'SUBMITTED', label: '待初审', color: 'var(--zc-primary-muted)' },
  { key: 'FIRST_PASSED', label: '待复审', color: 'var(--zc-primary)' },
  { key: 'APPROVED', label: '已认定', color: 'var(--zc-success)' },
  { key: 'REJECTED', label: '已驳回', color: 'var(--zc-danger)' },
];

/** 统计看板：批次带 + KPI 砖 + 分数分布 / 审核流转 + 分班提交率 */
export default function Dashboard() {
  const { message } = App.useApp();
  const batches = useBatches();
  const [batchId, setBatchId] = useState<string>('');
  const [data, setData] = useState<any>(null);
  const busyRef = useRef(false); // 在途互斥：StrictMode 双挂载只发一轮请求

  useEffect(() => {
    if (!batchId && batches.length) {
      const active = batches.find((b) => b.status !== 'ARCHIVED') ?? batches[0];
      setBatchId(active.id);
    }
  }, [batches, batchId]);

  useEffect(() => {
    if (!batchId || busyRef.current) return;
    busyRef.current = true;
    fetchOverview(batchId)
      .then(setData)
      .catch((e) => message.error(errMsg(e)))
      .finally(() => (busyRef.current = false));
  }, [batchId, message]);

  if (!data) {
    return batchId ? <Card size="small" loading style={{ minHeight: 300 }} /> : <Card size="small">暂无批次，请先到「批次管理」创建</Card>;
  }

  const apps: Record<string, number> = data.applications ?? {};
  const totalStudents = data.students?.total ?? 0;
  const submitted = data.submission?.reduce((s: number, c: any) => s + c.submitted, 0) ?? 0;
  const submitPct = totalStudents ? Math.round((submitted / totalStudents) * 100) : 0;
  const backlog = data.pendingReviewBacklog ?? 0;
  const pendingIssues = data.issues?.pending ?? 0;
  const dist: Record<string, number> = data.score?.distribution ?? {};
  const distMax = Math.max(1, ...Object.values(dist).map((v) => Number(v)));
  const flowMax = Math.max(1, ...FLOW.map((f) => apps[f.key] ?? 0));

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* 批次带：当前看板对象 + 批次切换 */}
      <section className="zc-dash-head">
        <div className="zc-dash-left">
          <span className="zc-dash-ico">
            <PartitionOutlined />
          </span>
          <div className="zc-dash-info">
            <div className="zc-dash-name">{data.batch?.name ?? '统计看板'}</div>
            <div className="zc-dash-semrow">
              <span className="zc-dash-sem">学期 {data.batch?.semesterKey}</span>
              {data.batch && <BatchStatusTag status={data.batch.status} />}
            </div>
          </div>
        </div>
        <div className="zc-dash-side">
          <BatchSelect value={batchId} onChange={setBatchId} style={{ minWidth: 240 }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            计算版本 v{data.batch?.calcVersion ?? '-'} · {data.batch?.published ? `第 ${data.batch.round} 轮公示中` : '未发布'}
          </Typography.Text>
        </div>
      </section>

      {/* KPI 砖 */}
      <div className="zc-kpi-grid">
        <section className="zc-kpi">
          <span className="zc-kpi-ico blue">
            <TeamOutlined />
          </span>
          <div className="zc-kpi-body">
            <div className="zc-kpi-label">在籍学生</div>
            <div className="zc-kpi-val zc-num">{totalStudents}</div>
            <div className="zc-kpi-sub">
              {data.students?.classes ?? 0} 个班级 · 学籍异常 {data.students?.abnormal ?? 0} 人
            </div>
          </div>
        </section>
        <section className="zc-kpi">
          <span className="zc-kpi-ico green">
            <FileZipOutlined />
          </span>
          <div className="zc-kpi-body">
            <div className="zc-kpi-label">材料包提交率</div>
            <div className="zc-kpi-val zc-num">
              {submitPct}
              <i>%</i>
            </div>
            <div className="zc-kpi-sub">
              已提交 {submitted} / {totalStudents} 人
            </div>
            <div className="zc-kpi-bar" aria-hidden="true">
              <span style={{ '--p': submitPct / 100 } as React.CSSProperties} />
            </div>
          </div>
        </section>
        <section className="zc-kpi">
          <span className="zc-kpi-ico orange">
            <AuditOutlined />
          </span>
          <div className="zc-kpi-body">
            <div className="zc-kpi-label">审核积压</div>
            <div className="zc-kpi-val zc-num" style={{ color: backlog > 0 ? 'var(--zc-warning)' : 'var(--zc-success)' }}>
              {backlog}
            </div>
            <div className="zc-kpi-sub">
              待初审 {apps.SUBMITTED ?? 0} · 待复审 {apps.FIRST_PASSED ?? 0}
            </div>
          </div>
        </section>
        <section className="zc-kpi">
          <span className="zc-kpi-ico red">
            <WarningOutlined />
          </span>
          <div className="zc-kpi-body">
            <div className="zc-kpi-label">待裁决成绩异常</div>
            <div className="zc-kpi-val zc-num" style={{ color: pendingIssues > 0 ? 'var(--zc-danger)' : 'var(--zc-success)' }}>
              {pendingIssues}
            </div>
            <div className="zc-kpi-sub">成绩导入数据问题</div>
          </div>
        </section>
      </div>

      {/* 分数分布 + 审核流转 */}
      <div className="zc-dash-2col">
        <Card
          size="small"
          className="zc-list-card"
          title={
            <span className="zc-card-title">
              <BarChartOutlined className="zc-card-ticon" /> 分数分布
            </span>
          }
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              v{data.score?.version ?? '-'} · {data.score?.count ?? 0} 人
            </Typography.Text>
          }
        >
          {data.score?.count ? (
            <>
              <div className="zc-dist-chart" role="img" aria-label="总分分布柱状图">
                {Object.entries(dist)
                  .reverse()
                  .map(([k, v], i) => (
                    <div key={k} className="zc-dist-col" aria-label={`${k} 分 ${v} 人`}>
                      <span className="zc-dist-val zc-num">{v}</span>
                      <div className="zc-dist-track">
                        <span className="zc-dist-bar" style={{ '--p': Number(v) / distMax, '--d': `${i * 30}ms` } as React.CSSProperties} />
                      </div>
                      <span className="zc-dist-label">{k}</span>
                    </div>
                  ))}
              </div>
              {Object.keys(data.score.flags ?? {}).length > 0 && (
                <Space wrap size={6} style={{ marginTop: 10 }}>
                  {Object.entries(data.score.flags).map(([f, n]) => (
                    <Tag key={f} className="zc-app-rule">
                      {f} × {n as number}
                    </Tag>
                  ))}
                </Space>
              )}
            </>
          ) : (
            <Empty description="尚未计算，先到「计算引擎」运行" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '24px 0' }} />
          )}
        </Card>

        <Card
          size="small"
          className="zc-list-card"
          title={
            <span className="zc-card-title">
              <AuditOutlined className="zc-card-ticon" /> 申请流转与异常
            </span>
          }
        >
          <div>
            {FLOW.map((f) => (
              <div key={f.key} className="zc-flow-row">
                <span className="zc-flow-label">
                  <span className="zc-flow-dot" style={{ background: f.color }} />
                  {f.label}
                </span>
                <div className="zc-flow-track" aria-hidden="true">
                  <span style={{ '--p': (apps[f.key] ?? 0) / flowMax, background: f.color } as React.CSSProperties} />
                </div>
                <b className="zc-num">{apps[f.key] ?? 0}</b>
              </div>
            ))}
          </div>
          <div className="zc-issue-panel">
            <div className="zc-issue-head">
              <span className="zc-issue-ico">
                <WarningOutlined />
              </span>
              <span className="zc-issue-title">成绩异常</span>
              <span className={`zc-issue-chip ${pendingIssues > 0 ? 'is-warn' : 'is-ok'}`}>
                {pendingIssues > 0 ? `待裁决 ${pendingIssues} 条` : '已全部裁决'}
              </span>
            </div>
            {(data.issues?.byType ?? []).length ? (
              <div className="zc-issue-list">
                {(data.issues.byType ?? []).map((g: any) => (
                  <div key={`${g.type}-${g.resolution}`} className="zc-issue-row">
                    <Tag color={g.resolution === 'PENDING' ? 'error' : 'default'} style={{ marginInlineEnd: 0 }}>
                      {g.resolution === 'PENDING' ? '待裁决' : '已裁决'}
                    </Tag>
                    <span className="zc-issue-name">
                      {ISSUE_TYPE_LABEL[g.type as keyof typeof ISSUE_TYPE_LABEL] ?? g.type}
                    </span>
                    <b className="zc-num">{g.count}</b>
                  </div>
                ))}
              </div>
            ) : (
              <div className="zc-issue-empty">
                <CheckCircleFilled /> 暂无异常数据
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* 分班提交率 */}
      <Card
        size="small"
        className="zc-list-card"
        title={
          <span className="zc-card-title">
            <TeamOutlined className="zc-card-ticon" /> 分班提交率
          </span>
        }
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            升序 · 末位班级需催报
          </Typography.Text>
        }
      >
        <Table
          size="small"
          rowKey="classId"
          dataSource={data.submission ?? []}
          pagination={{ pageSize: 8, size: 'default', hideOnSinglePage: true }}
          columns={[
            {
              title: '班级',
              dataIndex: 'className',
              // 序号取全表位置（render 的 index 是当前页内下标，翻页会从 1 重新数）
              render: (v: string, r: any) => (
                <Space size={8}>
                  <span className="zc-rank-idx">{(data.submission ?? []).indexOf(r) + 1}</span>
                  {v}
                </Space>
              ),
            },
            { title: '在籍人数', dataIndex: 'students', width: 100, align: 'right' },
            { title: '已提交', dataIndex: 'submitted', width: 90, align: 'right' },
            {
              title: '提交率',
              dataIndex: 'rate',
              width: 280,
              render: (v: number) => (
                <div className="zc-rate-cell">
                  <div className="zc-rate-track" aria-hidden="true">
                    <span
                      style={
                        {
                        '--p': v / 100,
                        background:
                          v >= 80
                            ? 'var(--zc-success)'
                            : v >= 50
                              ? 'var(--zc-primary-muted)'
                              : 'var(--zc-danger)',
                        } as React.CSSProperties
                      }
                    />
                  </div>
                  <b className="zc-num">{v}%</b>
                </div>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
