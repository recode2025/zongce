import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Drawer, Input, Modal, Radio, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { ISSUE_TYPE_LABEL } from '@zc/shared';
import { fetchIssueLines, fetchIssues, fetchJobs, resolveIssue } from '../../api';
import { errMsg } from '../../api/client';
import { BatchSelect, IssueTypeTag, ResolutionTag, fmtTime } from '../../components/common';
import ImportWizard from '../../components/ImportWizard';

const GATE_TYPES = ['MISSING', 'DEFERRED_EMPTY', 'DISQUALIFIED', 'NON_NUMERIC_SCORE']; // 进计算前必须清空 PENDING 的类型

/** 成绩域：导入 + 异常数据面板（人工裁决） */
export default function Grades() {
  const [batchId, setBatchId] = useState('');
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Space>
          <Typography.Text>批次：</Typography.Text>
          <BatchSelect value={batchId} onChange={setBatchId} />
          {!batchId && <Typography.Text type="warning">请选择批次</Typography.Text>}
        </Space>
      </Card>
      {batchId && (
        <Tabs
          items={[
            { key: 'import', label: '成绩导入', children: <ImportTab batchId={batchId} /> },
            { key: 'issues', label: '异常数据面板', children: <IssuesPanel batchId={batchId} /> },
          ]}
        />
      )}
    </Space>
  );
}

function ImportTab({ batchId }: { batchId: string }) {
  const [jobs, setJobs] = useState<any[]>([]);
  const load = () => fetchJobs({ kind: 'GRADE', batchId }).then(setJobs).catch(() => undefined);
  useEffect(() => {
    load();
  }, [batchId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="导入课程成绩（教务导出 xls/xlsx）">
        <ImportWizard kind="GRADE" batchId={batchId} onDone={load} />
      </Card>
      <Card size="small" title="导入任务记录">
        <Table
          size="small"
          rowKey="id"
          dataSource={jobs}
          pagination={{ pageSize: 8, size: 'default' }}
          columns={[
            { title: '时间', dataIndex: 'createdAt', width: 150, render: fmtTime },
            { title: '状态', dataIndex: 'status', width: 90, render: (s) => <Tag color={s === 'DONE' ? 'success' : s === 'FAILED' ? 'error' : 'processing'}>{s}</Tag> },
            {
              title: '结果',
              render: (_, r: any) =>
                r.summary ? (
                  <Typography.Text type="secondary">
                    共 {r.summary.total} · 新增 {r.summary.inserted} · 更新 {r.summary.updated} · 跳过 {r.summary.skipped}
                    {r.summary.issues ? ` · 异常 ${r.summary.issues}` : ''}
                  </Typography.Text>
                ) : (
                  r.error ?? '-'
                ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}

function IssuesPanel({ batchId }: { batchId: string }) {
  const { message } = App.useApp();
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [typeCounts, setTypeCounts] = useState<any[]>([]);
  const [type, setType] = useState<string | undefined>();
  const [resolution, setResolution] = useState<string>('PENDING');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState<{ issue: any; rows: any[] } | null>(null);
  const [pick, setPick] = useState<string>('');
  const [note, setNote] = useState('');
  const [resolveOpen, setResolveOpen] = useState<{ issue: any; resolution: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchIssues({ batchId, type, resolution: resolution || undefined, page, pageSize: 20 })
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
        setTypeCounts(r.typeCounts);
      })
      .catch((e) => message.error(errMsg(e)))
      .finally(() => setLoading(false));
  }, [batchId, type, resolution, page, message]);
  useEffect(load, [load]);

  const pendingGate = typeCounts
    .filter((g) => g.resolution === 'PENDING' && GATE_TYPES.includes(g.issueType))
    .reduce((s, g) => s + g._count._all, 0);

  const openLines = async (issue: any) => {
    try {
      const rows = await fetchIssueLines(issue.id);
      setLines({ issue, rows });
      setPick(issue.pickedGradeId ?? '');
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  const doResolve = async () => {
    if (!resolveOpen) return;
    try {
      await resolveIssue(resolveOpen.issue.id, {
        resolution: resolveOpen.resolution,
        note: note.trim() || undefined,
      });
      message.success('已裁决');
      setResolveOpen(null);
      setNote('');
      load();
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  const doPick = async () => {
    if (!lines || !pick) return;
    try {
      await resolveIssue(lines.issue.id, { resolution: 'MANUAL_PICKED', pickedGradeId: pick, note: note.trim() || undefined });
      message.success('已人工指定计分行');
      setLines(null);
      setNote('');
      load();
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  const course = (g: any) =>
    g ? `${g.courseName}（${g.courseNature ?? '-'}·${g.credit}学分）` : '-';

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {pendingGate > 0 ? (
        <Alert type="error" showIcon message={`门禁未通过：缺考/缓考未出/取消资格/等级制成绩仍有 ${pendingGate} 条待裁决，清空后才能进入「已计算」`} />
      ) : (
        <Alert type="success" showIcon message="门禁类异常已全部裁决（补考/学分为0类不阻塞计算）" />
      )}

      <Card size="small">
        <Space wrap style={{ marginBottom: 12 }}>
          {Object.entries(ISSUE_TYPE_LABEL).map(([t, l]) => {
            const n = typeCounts.filter((g) => g.issueType === t).reduce((s, g) => s + g._count._all, 0);
            const pend = typeCounts.filter((g) => g.issueType === t && g.resolution === 'PENDING').reduce((s, g) => s + g._count._all, 0);
            return (
              <Button
                key={t}
                size="small"
                type={type === t ? 'primary' : 'default'}
                ghost={type === t}
                onClick={() => {
                  setType(type === t ? undefined : t);
                  setPage(1);
                }}
              >
                {l} {n > 0 && <Tag style={{ marginLeft: 4 }} color={pend > 0 ? 'error' : 'default'}>{pend > 0 ? `待${pend}` : 'OK'}</Tag>}
              </Button>
            );
          })}
          <Select
            size="small"
            style={{ width: 130 }}
            value={resolution}
            onChange={(v) => {
              setResolution(v);
              setPage(1);
            }}
            allowClear
            placeholder="全部裁决状态"
            options={[
              { value: 'PENDING', label: '待裁决' },
              { value: 'MANUAL_PICKED', label: '人工指定' },
              { value: 'INCLUDED', label: '确认计入' },
              { value: 'EXCLUDED', label: '剔除不计' },
              { value: 'AUTO_PICK_FINAL', label: '自动取期末' },
            ]}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        </Space>
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={items}
          pagination={{ current: page, pageSize: 20, total, onChange: setPage, showSizeChanger: false, size: 'default' }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '学生', width: 130, render: (_, r: any) => `${r.student.name}（${r.student.studentNo}）` },
            { title: '班级', dataIndex: ['student', 'className'], width: 150, ellipsis: true },
            { title: '类型', dataIndex: 'issueType', width: 140, render: (t) => <IssueTypeTag type={t} /> },
            { title: '课程', width: 230, ellipsis: true, render: (_, r: any) => course(r.courseGrade) },
            {
              title: '成绩',
              width: 150,
              render: (_, r: any) => {
                const g = r.courseGrade;
                return (
                  <Space size={4} wrap>
                    <span className="zc-num">{g?.scoreValue ?? '-'}</span>
                    {g?.scoreFlag && <Tag color="red">{g.scoreFlag}</Tag>}
                    {g?.examType === '补考' && <Tag color="orange">补考</Tag>}
                    {g?.scoreText && <Tag>{g.scoreText}</Tag>}
                  </Space>
                );
              },
            },
            { title: '裁决', dataIndex: 'resolution', width: 100, render: (s) => <ResolutionTag resolution={s} /> },
            {
              title: '操作',
              width: 240,
              render: (_, r: any) =>
                r.resolution === 'PENDING' ? (
                  <Space size={4}>
                    {r.issueType === 'RESIT_DUP' && (
                      <Button size="small" onClick={() => openLines(r)}>
                        选计分行
                      </Button>
                    )}
                    <Button size="small" type="primary" ghost onClick={() => setResolveOpen({ issue: r, resolution: 'INCLUDED' })}>
                      计入
                    </Button>
                    <Button size="small" danger ghost onClick={() => setResolveOpen({ issue: r, resolution: 'EXCLUDED' })}>
                      剔除
                    </Button>
                  </Space>
                ) : (
                  <Typography.Text type="secondary">{r.note ?? '-'}</Typography.Text>
                ),
            },
          ]}
        />
      </Card>

      {/* 多行成绩选行 */}
      <Drawer title="同课程多行成绩 · 选择计分行" open={!!lines} onClose={() => setLines(null)} width={620}>
        {lines && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={2}>
              <Descriptions.Item label="学生">{lines.issue.student.name}（{lines.issue.student.studentNo}）</Descriptions.Item>
              <Descriptions.Item label="课程">{lines.issue.courseGrade?.courseName}</Descriptions.Item>
            </Descriptions>
            <Radio.Group value={pick} onChange={(e) => setPick(e.target.value)} style={{ width: '100%' }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                {lines.rows.map((g: any) => (
                  <Radio key={g.id} value={g.id} style={{ width: '100%', alignItems: 'flex-start' }}>
                    <Card size="small" style={{ marginTop: 4 }}>
                      <Space size={8} wrap>
                        <Tag>{g.examType ?? '期末考试'}</Tag>
                        <Typography.Text strong className="zc-num">成绩 {g.scoreValue ?? g.scoreText ?? '-'}</Typography.Text>
                        {g.scoreFlag && <Tag color="red">{g.scoreFlag}</Tag>}
                        <Typography.Text type="secondary">学分 {g.credit} · 行号 {g.rowNo}{g.resitTerm ? ` · 补重学期 ${g.resitTerm}` : ''}</Typography.Text>
                      </Space>
                    </Card>
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
            <Input.TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="裁决备注（可选）" maxLength={500} />
            <Button type="primary" disabled={!pick} onClick={doPick}>
              确认以此行计分（人工指定优先于自动规则）
            </Button>
          </Space>
        )}
      </Drawer>

      {/* 计入/剔除 */}
      <Modal
        title={`裁决 · ${resolveOpen?.issue ? ISSUE_TYPE_LABEL[resolveOpen.issue.issueType as keyof typeof ISSUE_TYPE_LABEL] : ''}`}
        open={!!resolveOpen}
        onCancel={() => {
          setResolveOpen(null);
          setNote('');
        }}
        onOk={doResolve}
        okText="确认"
      >
        <Typography.Paragraph>
          {resolveOpen?.resolution === 'INCLUDED'
            ? '确认按默认规则计入计算（缺考必修将计扣分、等级制按映射折算前的原样参与、缓考空成绩默认剔除该课）'
            : '剔除后该课程不参与加权与扣分（适用于重复行、学分为 0 等）'}
        </Typography.Paragraph>
        <Input.TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选，入审计）" maxLength={500} />
      </Modal>
    </Space>
  );
}
