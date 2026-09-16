import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Drawer, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { ExperimentOutlined, FileExcelOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { ClassInfo, createExport, downloadFile, fetchCalcDetail, fetchCalcResults, fetchCalcVersions, fetchClasses, runCalc } from '../../api';
import { errMsg } from '../../api/client';
import { BatchSelect, FlagTag, fmtTime } from '../../components/common';
import JobProgress from '../../components/JobProgress';
import ScoreBreakdown from '../../components/ScoreBreakdown';

/** 计算引擎：试算（dryRun 差异报告不落版）/ 正式计算（版本化）/ 结果预览（breakdown 可解释） */
export default function Calc() {
  const { message, modal } = App.useApp();
  const [batchId, setBatchId] = useState('');
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [versions, setVersions] = useState<any[]>([]);
  const [version, setVersion] = useState<string>();
  const [classId, setClassId] = useState<string>();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState<{ jobId: string; kind: 'DRY' | 'RUN' | 'EXPORT' } | null>(null);
  const [detail, setDetail] = useState<any>(null);

  useEffect(() => {
    fetchClasses().then(setClasses).catch(() => undefined);
  }, []);

  const loadVersions = useCallback(() => {
    if (!batchId) return;
    fetchCalcVersions(batchId)
      .then((vs) => {
        setVersions(vs);
        setVersion((old) => old ?? String(vs[0]?.version ?? ''));
      })
      .catch(() => undefined);
  }, [batchId]);

  const load = useCallback(() => {
    if (!batchId) return;
    setLoading(true);
    fetchCalcResults({ batchId, version, classId, q: q || undefined, page, pageSize: 50 })
      .then((r) => {
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch((e) => message.error(errMsg(e)))
      .finally(() => setLoading(false));
  }, [batchId, version, classId, q, page, message]);
  useEffect(loadVersions, [loadVersions]);
  useEffect(load, [load]);

  const doRun = (dryRun: boolean) =>
    modal.confirm({
      title: dryRun ? '试算（不落版）' : '正式计算',
      content: dryRun
        ? '试算仅生成差异报告与逐生结果预览，不产生新版本，不影响已发布成绩。'
        : '正式计算将生成新版本（CANDIDATE），已发布成绩不受影响；发布时才会晋升 PUBLISHED。公示期重算用于异议更正。',
      onOk: async () => {
        try {
          const r = await runCalc(batchId, dryRun);
          setJob({ jobId: r.jobId, kind: dryRun ? 'DRY' : 'RUN' });
        } catch (e) {
          message.error(errMsg(e));
        }
      },
    });

  const doExportAcademic = async () => {
    try {
      const r = await createExport({ batchId, scope: 'ACADEMIC' });
      setJob({ jobId: r.jobId, kind: 'EXPORT' });
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <BatchSelect value={batchId} onChange={(v) => { setBatchId(v); setVersion(undefined); }} />
          <Button icon={<ExperimentOutlined />} disabled={!batchId} onClick={() => doRun(true)}>
            试算（差异报告）
          </Button>
          <Button type="primary" icon={<ThunderboltOutlined />} disabled={!batchId} onClick={() => doRun(false)}>
            正式计算
          </Button>
          <Button icon={<FileExcelOutlined />} disabled={!batchId} onClick={doExportAcademic}>
            导出学业分
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => { loadVersions(); load(); }}>
            刷新
          </Button>
        </Space>
      </Card>

      {job && (
        <Card size="small" title={job.kind === 'DRY' ? '试算任务' : job.kind === 'EXPORT' ? '学业分导出任务' : '计算任务'}>
          <JobProgress
            jobId={job.jobId}
            onDone={(j) => {
              const s = j.summary ?? {};
              if (job.kind === 'EXPORT') {
                message.success(`学业分导出完成：${s.students} 人 · v${s.version}`);
                if (s.fileUuid) downloadFile(s.fileUuid, s.fileName).catch((e) => message.error(errMsg(e)));
                return;
              }
              message.success(
                job.kind === 'DRY'
                  ? `试算完成：${s.students} 人${s.changed ? `，${s.changed} 人有差异` : ''}`
                  : `计算完成：版本 v${s.version} · ${s.students} 人`,
              );
              loadVersions();
              load();
            }}
          />
        </Card>
      )}

      {versions.length > 0 && (
        <Card size="small" title="计算版本">
          <Space wrap>
            {versions.map((v) => (
              <Tag.CheckableTag key={v.version} checked={version === String(v.version)} onChange={() => setVersion(String(v.version))}>
                v{v.version} · {v.status === 'PUBLISHED' ? '已发布' : v.status === 'CANDIDATE' ? '候选' : '已废弃'} · {v._count._all}人 · 最高{v._max.totalScore ?? '-'}
              </Tag.CheckableTag>
            ))}
            <Typography.Text type="secondary">点击切换版本查看</Typography.Text>
          </Space>
        </Card>
      )}

      <Card size="small" title={`计算结果（${total} 人）`}>
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            placeholder="全部班级"
            allowClear
            showSearch
            style={{ width: 190 }}
            value={classId}
            onChange={(v) => { setClassId(v); setPage(1); }}
            options={classes.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Input.Search
            placeholder="学号 / 姓名"
            allowClear
            style={{ width: 180 }}
            onSearch={(v) => { setQ(v); setPage(1); }}
          />
        </Space>
        {!version && versions.length === 0 && <Alert type="info" showIcon message="尚未计算，点击「试算」或「正式计算」开始" />}
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={{ current: page, pageSize: 50, total, onChange: setPage, showSizeChanger: false, size: 'default' }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '年级排名', dataIndex: 'rankGrade', width: 85, align: 'right', className: 'zc-num' },
            { title: '班级排名', dataIndex: 'rankClass', width: 85, align: 'right', className: 'zc-num' },
            { title: '班级', dataIndex: ['student', 'className'], width: 150, ellipsis: true },
            { title: '学号', dataIndex: ['student', 'studentNo'], width: 110 },
            { title: '姓名', dataIndex: ['student', 'name'], width: 80 },
            { title: '品德', dataIndex: 'moralTotal', width: 70, align: 'right', className: 'zc-num' },
            { title: '学业', dataIndex: 'academicTotal', width: 70, align: 'right', className: 'zc-num' },
            { title: '文体', dataIndex: 'sportsTotal', width: 70, align: 'right', className: 'zc-num' },
            {
              title: '总分',
              dataIndex: 'totalScore',
              width: 85,
              align: 'right',
              className: 'zc-num',
              render: (v) => <Typography.Text strong>{Number(v).toFixed(2)}</Typography.Text>,
            },
            {
              title: '标记',
              width: 120,
              render: (_, r: any) => ((r.flags ?? []).length ? <Space size={2} wrap>{(r.flags as string[]).slice(0, 2).map((f) => <Tag key={f} color="warning">{f}</Tag>)}</Space> : '-'),
            },
            { title: '状态', dataIndex: 'status', width: 90, render: (s) => <Tag color={s === 'PUBLISHED' ? 'success' : s === 'CANDIDATE' ? 'processing' : 'default'}>{s === 'PUBLISHED' ? '已发布' : s === 'CANDIDATE' ? '候选' : '已废弃'}</Tag> },
            {
              title: '操作',
              width: 70,
              render: (_, r: any) => (
                <Button
                  type="link"
                  size="small"
                  onClick={() => fetchCalcDetail(r.studentId, batchId, r.version).then(setDetail).catch((e) => message.error(errMsg(e)))}
                >
                  明细
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title={detail ? `计算明细 · ${detail.student.name}（${detail.student.studentNo}）` : ''}
        open={!!detail}
        onClose={() => setDetail(null)}
        width={760}
      >
        {detail && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Card size="small">
              <Space size="large" wrap>
                <Typography.Text className="zc-num">总分 <Typography.Text strong style={{ fontSize: 22 }}>{Number(detail.totalScore).toFixed(2)}</Typography.Text></Typography.Text>
                <Typography.Text className="zc-num">年级第 {detail.rankGrade ?? '-'} · 班级第 {detail.rankClass ?? '-'}</Typography.Text>
                <Tag>v{detail.version} · {detail.status}</Tag>
                <Typography.Text type="secondary">引擎 {detail.engineVersion}</Typography.Text>
              </Space>
            </Card>
            {!!detail.flags?.length && <Alert type="warning" showIcon message={<Space wrap>{(detail.flags as string[]).map((f: string) => <FlagTag key={f} flag={f} />)}</Space>} />}
            <ScoreBreakdown breakdown={detail.breakdown} courseSummary={detail.courseSummary} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>计算于 {fmtTime(detail.createdAt)}</Typography.Text>
          </Space>
        )}
      </Drawer>
    </Space>
  );
}
