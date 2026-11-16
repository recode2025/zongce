import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  CheckCircleFilled,
  DownOutlined,
  DownloadOutlined,
  ExclamationCircleFilled,
  InboxOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { ISSUE_TYPE_LABEL, publicErrorText, TASK_FAILED_MESSAGE } from '@zc/shared';
import { batchResolveIssues, downloadImportTemplate, fetchIssueLines, fetchIssues, fetchJobs, importRegistration, resolveIssue } from '../../api';
import { errMsg } from '../../api/client';
import { BatchSelect, IssueTypeTag, ResolutionTag, fmtTime, useBatches } from '../../components/common';
import ImportWizard from '../../components/ImportWizard';
import JobProgress from '../../components/JobProgress';
import { useAuth } from '../../store/auth';

/** 进入「已计算」前必须清空待裁决的类型（其余类型不阻塞计算） */
const GATE_TYPES = ['MISSING', 'DEFERRED_EMPTY', 'DISQUALIFIED', 'NON_NUMERIC_SCORE'];
const ISSUE_TYPES = Object.keys(ISSUE_TYPE_LABEL) as (keyof typeof ISSUE_TYPE_LABEL)[];

type TypeCount = { issueType: string; resolution: string; _count: { _all: number } };

/** 由全批次「类型 × 裁决」分组计数派生的汇总 */
function summarize(typeCounts: TypeCount[]) {
  const total = new Map<string, number>();
  const pending = new Map<string, number>();
  for (const g of typeCounts) {
    total.set(g.issueType, (total.get(g.issueType) ?? 0) + g._count._all);
    if (g.resolution === 'PENDING') pending.set(g.issueType, (pending.get(g.issueType) ?? 0) + g._count._all);
  }
  let pendingGate = 0;
  let pendingAll = 0;
  for (const [t, n] of pending) {
    pendingAll += n;
    if (GATE_TYPES.includes(t)) pendingGate += n;
  }
  return { total, pending, pendingGate, pendingAll, pendingOther: pendingAll - pendingGate };
}

/** 成绩域：顶部「批次 + 计算门禁」状态栏；下分 成绩导入 / 异常裁决 / 综测登记表导入 */
export default function Grades() {
  const { message } = App.useApp();
  const canImport = useAuth().user?.role === 'SUPER_ADMIN';
  const batches = useBatches();
  const [batchId, setBatchId] = useState('');
  const [tab, setTab] = useState(canImport ? 'import' : 'issues');
  const [typeCounts, setTypeCounts] = useState<TypeCount[]>([]);

  // 默认选中最近一个未归档批次（与统计看板一致）
  useEffect(() => {
    if (!batchId && batches.length) setBatchId((batches.find((b) => b.status !== 'ARCHIVED') ?? batches[0]).id);
  }, [batches, batchId]);

  const loadCounts = useCallback(() => {
    if (!batchId) return;
    fetchIssues({ batchId, page: 1, pageSize: 1 })
      .then((r) => setTypeCounts(r.typeCounts ?? []))
      .catch((e) => message.error(errMsg(e)));
  }, [batchId, message]);
  useEffect(loadCounts, [loadCounts]);

  const sum = useMemo(() => summarize(typeCounts), [typeCounts]);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* 状态栏：批次 + 计算门禁（最关键的信息放在页首，不必切到异常页才看得到） */}
      <section className="zc-gr-head">
        <div className="zc-gr-batch">
          <span className="zc-gr-label">批次</span>
          <BatchSelect value={batchId || undefined} onChange={setBatchId} style={{ minWidth: 280 }} />
        </div>
        {batchId && (
          <div className={`zc-gr-gate ${sum.pendingGate > 0 ? 'block' : 'pass'}`}>
            {sum.pendingGate > 0 ? <ExclamationCircleFilled /> : <CheckCircleFilled />}
            <div className="zc-gr-gate-text">
              <b>{canImport ? (sum.pendingGate > 0 ? `计算门禁：还有 ${sum.pendingGate} 条必须裁决` : '计算门禁已通过') : `本年级待裁决异常：${sum.pendingAll} 条`}</b>
              <span>
                {!canImport ? '仅显示本年级记录；全批次导入及计算由超级管理员负责' : sum.pendingGate > 0
                  ? '缺考、缓考未出、取消资格、等级制成绩清空后，批次才能进入「已计算」'
                  : sum.pendingOther > 0
                    ? `另有 ${sum.pendingOther} 条其他异常待处理（不阻塞计算）`
                    : '没有待裁决的成绩异常'}
              </span>
            </div>
            {sum.pendingAll > 0 && tab !== 'issues' && (
              <Button type={sum.pendingGate > 0 ? 'primary' : 'default'} onClick={() => setTab('issues')}>
                去裁决
              </Button>
            )}
          </div>
        )}
      </section>

      {batchId ? (
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            ...(canImport ? [{ key: 'import', label: '成绩导入', children: <ImportTab batchId={batchId} onImported={loadCounts} /> }] : []),
            {
              key: 'issues',
              label: (
                <span className="zc-gr-tab">
                  异常裁决
                  {sum.pendingAll > 0 && <Badge count={sum.pendingAll} size="small" overflowCount={999} />}
                </span>
              ),
              children: <IssuesPanel batchId={batchId} typeCounts={typeCounts} onCounts={setTypeCounts} />,
            },
            ...(canImport ? [{ key: 'registration', label: '综测登记表导入', children: <RegistrationTab batchId={batchId} /> }] : []),
          ]}
        />
      ) : (
        <Card size="small">
          <Empty description="暂无批次，请先到「批次管理」创建" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      )}
    </Space>
  );
}

// ===================================================================== 成绩导入

/** 导入任务 summary.issues 兼容两种形态：数字，或按类型拆分的 [{ type, count }] */
function issueSummary(issues: unknown): { total: number; detail: string } {
  if (Array.isArray(issues)) {
    const rows = issues.filter((x) => x && typeof x === 'object') as { type?: string; count?: number }[];
    return {
      total: rows.reduce((n, x) => n + (Number(x.count) || 0), 0),
      detail: rows.map((x) => `${ISSUE_TYPE_LABEL[x.type as keyof typeof ISSUE_TYPE_LABEL] ?? x.type} ${x.count ?? 0}`).join('、'),
    };
  }
  const n = Number(issues);
  return { total: Number.isFinite(n) ? n : 0, detail: '' };
}

const JOB_STATUS: Record<string, { color: string; text: string }> = {
  PENDING: { color: 'default', text: '排队中' },
  RUNNING: { color: 'processing', text: '导入中' },
  DONE: { color: 'success', text: '完成' },
  FAILED: { color: 'error', text: '失败' },
};

function ImportTab({ batchId, onImported }: { batchId: string; onImported: () => void }) {
  const [jobs, setJobs] = useState<any[]>([]);
  const load = useCallback(() => {
    fetchJobs({ kind: 'GRADE', batchId }).then(setJobs).catch(() => undefined);
  }, [batchId]);
  useEffect(load, [load]);

  return (
    <div className="zc-gr-import">
      <Card size="small" title="导入课程成绩" extra={<Typography.Text type="secondary">教务系统导出的 xls / xlsx</Typography.Text>}>
        <ImportWizard
          kind="GRADE"
          batchId={batchId}
          onDone={() => {
            load();
            onImported(); // 导入会产生新的成绩异常：同步刷新页首门禁
          }}
        />
      </Card>
      <Card size="small" title="导入记录" extra={<Button type="text" size="small" icon={<ReloadOutlined />} onClick={load} aria-label="刷新导入记录" />}>
        {jobs.length ? (
          <ul className="zc-gr-jobs">
            {jobs.slice(0, 12).map((j) => {
              const st = JOB_STATUS[j.status] ?? { color: 'default', text: j.status };
              const s = j.summary;
              const iss = issueSummary(s?.issues);
              const err = j.status === 'FAILED' || j.error ? publicErrorText(j.error, TASK_FAILED_MESSAGE) : '';
              return (
                <li key={j.id}>
                  <div className="zc-gr-job-top">
                    <Tag color={st.color}>{st.text}</Tag>
                    <span className="zc-gr-job-time">{fmtTime(j.createdAt)}</span>
                  </div>
                  <div className="zc-gr-job-sum">
                    {s ? (
                      <>
                        共 <b className="zc-num">{s.total ?? 0}</b> 行 · 新增 <b className="zc-num">{s.inserted ?? 0}</b> · 更新{' '}
                        <b className="zc-num">{s.updated ?? 0}</b> · 跳过 <b className="zc-num">{s.skipped ?? 0}</b>
                        {iss.total > 0 && (
                          <>
                            {' '}
                            ·{' '}
                            <Tooltip title={iss.detail || undefined}>
                              <span className="zc-gr-job-issue">异常 {iss.total}</span>
                            </Tooltip>
                          </>
                        )}
                      </>
                    ) : err ? (
                      <span className="zc-gr-job-err">{err}</span>
                    ) : (
                      '-'
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty description="本批次还没有导入过成绩" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>
    </div>
  );
}

// ===================================================================== 综测登记表导入

/** 综测登记表（班级官方模板）导入：表3-表11 逐行转加分申请，进入初审/复审流程 */
function RegistrationTab({ batchId }: { batchId: string }) {
  const { message } = App.useApp();
  const [jobId, setJobId] = useState('');
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const doImport = async (file: File) => {
    setLoading(true);
    try {
      const r = await importRegistration(batchId, file);
      setJobId(r.jobId);
      setSummary(null);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
    return false;
  };

  return (
    <Card size="small" title="导入综测登记表">
      <div className="zc-iw-tpl">
        <span>按模板的表 3–表 11 填写后上传；学院官方登记表也可以直接上传。</span>
        <Button icon={<DownloadOutlined />} onClick={() => downloadImportTemplate('REGISTRATION').catch((e) => message.error(errMsg(e)))}>
          下载登记表模板
        </Button>
      </div>
      <Upload.Dragger accept=".xlsx" maxCount={1} showUploadList={false} beforeUpload={doImport} disabled={loading}>
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">{loading ? '正在解析…' : '点击或拖入《XX班 综测登记表.xlsx》'}</p>
        <p className="ant-upload-hint">识别表 3–表 11，每行生成一条「待初审」加分申请；重复导入会自动跳过</p>
      </Upload.Dragger>

      {jobId && (
        <div style={{ marginTop: 12 }}>
          <JobProgress
            jobId={jobId}
            onDone={(j) => {
              setSummary(j.summary);
              message.success(`登记表导入完成：新增 ${j.summary?.inserted ?? 0} 条申请`);
            }}
          />
        </div>
      )}

      {summary && (
        <div className="zc-gr-reg-result">
          <div className="zc-gr-stats">
            <div>
              <span>识别明细</span>
              <b className="zc-num">{summary.total ?? 0}</b>
            </div>
            <div className="ok">
              <span>新增申请</span>
              <b className="zc-num">{summary.inserted ?? 0}</b>
            </div>
            <div className={summary.skipped ? 'warn' : ''}>
              <span>跳过</span>
              <b className="zc-num">{summary.skipped ?? 0}</b>
            </div>
          </div>
          {!!summary.categories && (
            <div className="zc-gr-reg-row">
              <span className="zc-gr-reg-k">分类统计</span>
              <Space size={4} wrap>
                {Object.entries(summary.categories as Record<string, number>).map(([code, n]) => (
                  <Tag key={code}>
                    {code} × {n}
                  </Tag>
                ))}
              </Space>
            </div>
          )}
          {!!summary.skippedRows?.length && (
            <div className="zc-gr-reg-row">
              <span className="zc-gr-reg-k">跳过原因</span>
              <ul className="zc-gr-skips">
                {summary.skippedRows.slice(0, 10).map((s: any, i: number) => (
                  <li key={i}>
                    {s.row ? `第 ${s.row} 行：` : ''}
                    {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ===================================================================== 异常裁决

const RESOLUTION_OPTIONS = [
  { value: 'PENDING', label: '待裁决' },
  { value: 'MANUAL_PICKED', label: '人工指定' },
  { value: 'INCLUDED', label: '确认计入' },
  { value: 'EXCLUDED', label: '剔除不计' },
  { value: 'AUTO_PICK_FINAL', label: '自动取期末' },
];

type BatchAction = { mode: 'IDS' | 'TYPE'; resolution: 'INCLUDED' | 'EXCLUDED'; ids?: string[]; type?: string; count: number };

function IssuesPanel({
  batchId,
  typeCounts,
  onCounts,
}: {
  batchId: string;
  typeCounts: TypeCount[];
  onCounts: (c: TypeCount[]) => void;
}) {
  const { message } = App.useApp();
  const scopeLabel = useAuth().user?.role === 'SUPER_ADMIN' ? '本批次' : '本批次本年级';
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [type, setType] = useState<string | undefined>();
  const [resolution, setResolution] = useState<string | undefined>('PENDING');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  // 单条裁决 / 选计分行 / 批量裁决
  const [resolveOpen, setResolveOpen] = useState<{ issue: any; resolution: string } | null>(null);
  const [lines, setLines] = useState<{ issue: any; rows: any[] } | null>(null);
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const [batchOpen, setBatchOpen] = useState<BatchAction | null>(null);

  const sum = useMemo(() => summarize(typeCounts), [typeCounts]);

  const load = useCallback(() => {
    setLoading(true);
    fetchIssues({ batchId, type, resolution, page, pageSize: 20 })
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
        onCounts(r.typeCounts ?? []); // 同步页首门禁与标签计数
      })
      .catch((e) => message.error(errMsg(e)))
      .finally(() => setLoading(false));
  }, [batchId, type, resolution, page, message, onCounts]);
  useEffect(load, [load]);

  // 筛选变化时清掉跨页勾选，避免对看不见的行做批量操作
  useEffect(() => setSelected([]), [batchId, type, resolution]);

  const pickType = (t?: string) => {
    setType(t);
    setPage(1);
  };

  const closeNote = () => setNote('');

  const doResolve = async () => {
    if (!resolveOpen) return;
    try {
      await resolveIssue(resolveOpen.issue.id, { resolution: resolveOpen.resolution, note: note.trim() || undefined });
      message.success(resolveOpen.resolution === 'INCLUDED' ? '已计入' : '已剔除');
      setResolveOpen(null);
      closeNote();
      load();
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  const openLines = async (issue: any) => {
    try {
      const rows = await fetchIssueLines(issue.id);
      setLines({ issue, rows });
      setPick(issue.pickedGradeId ?? '');
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  const doPick = async () => {
    if (!lines || !pick) return;
    try {
      await resolveIssue(lines.issue.id, { resolution: 'MANUAL_PICKED', pickedGradeId: pick, note: note.trim() || undefined });
      message.success('已指定计分行');
      setLines(null);
      closeNote();
      load();
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  const doBatch = async () => {
    if (!batchOpen) return;
    try {
      const r = await batchResolveIssues({
        batchId,
        resolution: batchOpen.resolution,
        ...(batchOpen.mode === 'IDS' ? { ids: batchOpen.ids } : { type: batchOpen.type === '__GATE__' ? undefined : batchOpen.type }),
        note: note.trim() || undefined,
      });
      message.success(`已批量${batchOpen.resolution === 'INCLUDED' ? '计入' : '剔除'} ${r.count} 条`);
      setBatchOpen(null);
      closeNote();
      setSelected([]);
      load();
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  // 「一键裁决」菜单：门禁类全部 + 当前筛选类型（跨分页）
  const typePending = type ? sum.pending.get(type) ?? 0 : 0;
  const bulkMenu: MenuProps['items'] = [
    {
      type: 'group',
      label: `门禁类全部待裁决（${sum.pendingGate}）`,
      children: [
        { key: 'GATE:INCLUDED', label: '全部计入（按默认规则）', disabled: !sum.pendingGate },
        { key: 'GATE:EXCLUDED', label: '全部剔除不计', danger: true, disabled: !sum.pendingGate },
      ],
    },
    ...(type
      ? [
          { type: 'divider' as const },
          {
            type: 'group' as const,
            label: `「${ISSUE_TYPE_LABEL[type as keyof typeof ISSUE_TYPE_LABEL]}」待裁决（${typePending}）`,
            children: [
              { key: `${type}:INCLUDED`, label: '全部计入（按默认规则）', disabled: !typePending },
              { key: `${type}:EXCLUDED`, label: '全部剔除不计', danger: true, disabled: !typePending },
            ],
          },
        ]
      : []),
  ];
  const onBulk: MenuProps['onClick'] = ({ key }) => {
    const [scope, res] = key.split(':') as [string, 'INCLUDED' | 'EXCLUDED'];
    const isGate = scope === 'GATE';
    setBatchOpen({ mode: 'TYPE', type: isGate ? '__GATE__' : scope, resolution: res, count: isGate ? sum.pendingGate : typePending });
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* 类型筛选块：一眼看出每类还剩多少、哪些阻塞计算 */}
      <div className="zc-gr-types" role="group" aria-label="按异常类型筛选">
        <button type="button" aria-pressed={!type} className={`zc-gr-type ${!type ? 'active' : ''}`} onClick={() => pickType(undefined)}>
          <span className="zc-gr-type-name">全部类型</span>
          <b className={`zc-num ${sum.pendingAll ? 'pending' : 'clear'}`}>{sum.pendingAll}</b>
          <span className="zc-gr-type-sub">条待裁决</span>
        </button>
        {ISSUE_TYPES.map((t) => {
          const n = sum.total.get(t) ?? 0;
          const p = sum.pending.get(t) ?? 0;
          const gate = GATE_TYPES.includes(t);
          return (
            <button
              key={t}
              type="button"
              aria-pressed={type === t}
              className={`zc-gr-type ${type === t ? 'active' : ''} ${n === 0 ? 'empty' : ''}`}
              onClick={() => pickType(type === t ? undefined : t)}
            >
              <span className="zc-gr-type-name">{ISSUE_TYPE_LABEL[t]}</span>
              <b className={`zc-num ${p ? 'pending' : 'clear'}`}>{p}</b>
              <span className="zc-gr-type-sub">
                {n ? `共 ${n} 条` : '无'}
                {gate && <i className="zc-gr-gate-mark">阻塞计算</i>}
              </span>
            </button>
          );
        })}
      </div>

      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        {/* 工具栏：左筛选，右一键裁决 */}
        <div className="zc-gr-toolbar">
          <Space wrap>
            <Select
              style={{ width: 140 }}
              value={resolution}
              onChange={(v) => {
                setResolution(v);
                setPage(1);
              }}
              allowClear
              placeholder="全部裁决状态"
              options={RESOLUTION_OPTIONS}
            />
            <Button icon={<ReloadOutlined />} onClick={load}>
              刷新
            </Button>
          </Space>
          <Dropdown menu={{ items: bulkMenu, onClick: onBulk }} trigger={['click']}>
            <Button>
              一键裁决 <DownOutlined />
            </Button>
          </Dropdown>
        </div>

        {/* 勾选后出现的批量操作条 */}
        {selected.length > 0 && (
          <div className="zc-gr-selbar">
            <span>
              已选 <b className="zc-num">{selected.length}</b> 条待裁决
            </span>
            <Space size={8}>
              <Button size="small" type="primary" onClick={() => setBatchOpen({ mode: 'IDS', ids: selected, resolution: 'INCLUDED', count: selected.length })}>
                计入
              </Button>
              <Button size="small" danger onClick={() => setBatchOpen({ mode: 'IDS', ids: selected, resolution: 'EXCLUDED', count: selected.length })}>
                剔除
              </Button>
              <Button size="small" type="text" onClick={() => setSelected([])}>
                取消选择
              </Button>
            </Space>
          </div>
        )}

        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={items}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys as string[]),
            getCheckboxProps: (r: any) => ({ disabled: r.resolution !== 'PENDING' }),
          }}
          pagination={{ current: page, pageSize: 20, total, onChange: setPage, showSizeChanger: false, showTotal: (n) => `共 ${n} 条` }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: <Empty description={resolution === 'PENDING' ? '没有待裁决的记录' : '没有记录'} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          columns={[
            {
              title: '学生',
              width: 160,
              render: (_, r: any) => (
                <div className="zc-gr-cell2">
                  <b>{r.student.name}</b>
                  <span>
                    {r.student.studentNo} · {r.student.className}
                  </span>
                </div>
              ),
            },
            { title: '类型', dataIndex: 'issueType', width: 130, render: (t) => <IssueTypeTag type={t} /> },
            {
              title: '课程',
              width: 230,
              render: (_, r: any) => {
                const g = r.courseGrade;
                return g ? (
                  <div className="zc-gr-cell2">
                    <b>{g.courseName}</b>
                    <span>
                      {g.courseNature ?? '-'} · {g.credit} 学分
                    </span>
                  </div>
                ) : (
                  '-'
                );
              },
            },
            {
              title: '成绩',
              width: 140,
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
              width: 200,
              fixed: 'right',
              render: (_, r: any) =>
                r.resolution === 'PENDING' ? (
                  <Space size={0}>
                    {r.issueType === 'RESIT_DUP' && (
                      <Button size="small" type="link" onClick={() => openLines(r)}>
                        选计分行
                      </Button>
                    )}
                    <Button size="small" type="link" onClick={() => setResolveOpen({ issue: r, resolution: 'INCLUDED' })}>
                      计入
                    </Button>
                    <Button size="small" type="link" danger onClick={() => setResolveOpen({ issue: r, resolution: 'EXCLUDED' })}>
                      剔除
                    </Button>
                  </Space>
                ) : (
                  <Typography.Text type="secondary" ellipsis={{ tooltip: r.note }} style={{ maxWidth: 180 }}>
                    {r.note || '无备注'}
                  </Typography.Text>
                ),
            },
          ]}
        />
      </Card>

      {/* 多行成绩选行 */}
      <Drawer
        title="选择计分行"
        open={!!lines}
        onClose={() => {
          setLines(null);
          closeNote();
        }}
        width="min(620px, 100vw)"
      >
        {lines && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="学生">
                {lines.issue.student.name}（{lines.issue.student.studentNo}）
              </Descriptions.Item>
              <Descriptions.Item label="课程">{lines.issue.courseGrade?.courseName}</Descriptions.Item>
            </Descriptions>
            <Radio.Group value={pick} onChange={(e) => setPick(e.target.value)} style={{ width: '100%' }}>
              <div className="zc-gr-picks">
                {lines.rows.map((g: any) => (
                  <label key={g.id} className={`zc-gr-pick ${pick === g.id ? 'active' : ''}`}>
                    <Radio value={g.id} />
                    <div className="zc-gr-pick-body">
                      <div className="zc-gr-pick-top">
                        <Tag>{g.examType ?? '期末考试'}</Tag>
                        <b className="zc-num">{g.scoreValue ?? g.scoreText ?? '-'}</b>
                        {g.scoreFlag && <Tag color="red">{g.scoreFlag}</Tag>}
                      </div>
                      <span>
                        学分 {g.credit} · 第 {g.rowNo} 行{g.resitTerm ? ` · 补重学期 ${g.resitTerm}` : ''}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            </Radio.Group>
            <Input.TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选，记入审计）" maxLength={500} />
            <Button type="primary" block disabled={!pick} onClick={doPick}>
              以此行计分
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              人工指定优先于「自动取期末」规则。
            </Typography.Text>
          </Space>
        )}
      </Drawer>

      {/* 单条计入 / 剔除 */}
      <Modal
        title={`${resolveOpen?.resolution === 'INCLUDED' ? '计入' : '剔除'} · ${
          resolveOpen?.issue ? ISSUE_TYPE_LABEL[resolveOpen.issue.issueType as keyof typeof ISSUE_TYPE_LABEL] : ''
        }`}
        open={!!resolveOpen}
        onCancel={() => {
          setResolveOpen(null);
          closeNote();
        }}
        onOk={doResolve}
        okText={resolveOpen?.resolution === 'INCLUDED' ? '计入' : '剔除'}
        okButtonProps={{ danger: resolveOpen?.resolution === 'EXCLUDED' }}
      >
        <Typography.Paragraph>
          {resolveOpen?.resolution === 'INCLUDED'
            ? '按默认规则计入计算：缺考必修计扣分，等级制按映射折算，缓考空成绩默认不计该课。'
            : '剔除后该课程不参与加权与扣分，适用于重复行、学分为 0 等情况。'}
        </Typography.Paragraph>
        <Input.TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选，记入审计）" maxLength={500} />
      </Modal>

      {/* 批量裁决确认 */}
      <Modal
        title={`批量${batchOpen?.resolution === 'INCLUDED' ? '计入' : '剔除'} · ${batchOpen?.count ?? 0} 条`}
        open={!!batchOpen}
        onCancel={() => {
          setBatchOpen(null);
          closeNote();
        }}
        onOk={doBatch}
        okText={`确认${batchOpen?.resolution === 'INCLUDED' ? '计入' : '剔除'}`}
        okButtonProps={{ danger: batchOpen?.resolution === 'EXCLUDED' }}
      >
        <Alert
          type="warning"
          showIcon
          message={
            batchOpen?.resolution === 'INCLUDED'
              ? '按默认规则处理：缺考/取消资格的必修课计不及格扣分且该课无成绩，缓考空成绩该课暂不计入，等级制成绩按优/良/中/及格/不及格映射折算。'
              : '批量剔除只是裁决标记（确认该类异常不另行处理）；课程是否计入加权仍由计算规则自动判定。'
          }
        />
        <Typography.Paragraph type="secondary" style={{ margin: '8px 0', fontSize: 12 }}>
          {batchOpen?.mode === 'IDS'
            ? `仅作用于当前勾选的 ${batchOpen.ids?.length ?? 0} 条待裁决记录。`
            : batchOpen?.type === '__GATE__'
              ? `作用于${scopeLabel}全部缺考、缓考未出、取消资格、等级制成绩的待裁决记录（含其他分页）。`
              : `作用于${scopeLabel}该类型的全部待裁决记录（含其他分页）。`}
        </Typography.Paragraph>
        <Input.TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选，记入审计）" maxLength={500} />
      </Modal>
    </Space>
  );
}
