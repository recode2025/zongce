import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Radio, Select, Space, Table, Tag, Typography } from 'antd';
import { DownloadOutlined, FileExcelOutlined, ReloadOutlined } from '@ant-design/icons';
import { ClassInfo, createExport, downloadFile, fetchClasses, fetchExportHistory } from '../../api';
import { errMsg } from '../../api/client';
import { BatchSelect, fmtTime } from '../../components/common';
import JobProgress from '../../components/JobProgress';

/** 导出中心：分班（30 列模板）/ 全年级（多 sheet 或单表全量）· 发布态取每生最新 PUBLISHED 行 */
export default function ExportCenter() {
  const { message } = App.useApp();
  const [batchId, setBatchId] = useState('');
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [scope, setScope] = useState<'CLASS' | 'GRADE'>('GRADE');
  const [classId, setClassId] = useState<string>();
  const [jobId, setJobId] = useState('');
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchClasses().then(setClasses).catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    if (!batchId) return;
    fetchExportHistory(batchId)
      .then(setHistory)
      .catch(() => undefined);
  }, [batchId]);
  useEffect(load, [load]);

  const doExport = async () => {
    if (!batchId || (scope === 'CLASS' && !classId)) {
      message.warning(scope === 'CLASS' ? '请选择班级' : '请选择批次');
      return;
    }
    setLoading(true);
    try {
      const r = await createExport({ batchId, scope, classId: scope === 'CLASS' ? classId : undefined });
      setJobId(r.jobId);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="导出综测结果（30 列模板 · 与 大数据2025级1班.xlsx 严格一致）">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <BatchSelect value={batchId} onChange={(v) => { setBatchId(v); setJobId(''); }} />
            <Radio.Group
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
                setJobId('');
              }}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="GRADE">全年级</Radio.Button>
              <Radio.Button value="CLASS">按班级</Radio.Button>
            </Radio.Group>
            {scope === 'CLASS' && (
              <Select
                placeholder="选择班级"
                showSearch
                style={{ width: 200 }}
                value={classId}
                onChange={setClassId}
                options={classes.map((c) => ({ value: c.id, label: c.name }))}
              />
            )}
            <Button type="primary" icon={<FileExcelOutlined />} loading={loading} disabled={!batchId} onClick={doExport}>
              生成导出文件
            </Button>
          </Space>
          <Typography.Text type="secondary">
            发布态导出自动取每生最新已发布版本（含异议更正后的学生）；未发布批次导出当前候选版本（预览用）。产物经审计留痕后下载。
          </Typography.Text>
          {jobId && (
            <JobProgress
              jobId={jobId}
              onDone={(j) => {
                const s = j.summary ?? {};
                message.success(`导出完成：${s.students} 人 · ${s.classes} 班 · v${s.version}${s.published ? '' : '（候选版）'}`);
                load();
              }}
            />
          )}
          {jobId && (
            <Button
              icon={<DownloadOutlined />}
              onClick={async () => {
                try {
                  const j = history.find((x) => x.id === jobId) ?? (await fetchExportHistory(batchId)).find((x) => x.id === jobId);
                  const s = j?.summary;
                  if (s?.fileUuid) await downloadFile(s.fileUuid, s.fileName);
                  else message.info('任务尚未生成文件，请稍候');
                } catch (e) {
                  message.error(errMsg(e));
                }
              }}
            >
              下载刚导出的文件
            </Button>
          )}
        </Space>
      </Card>

      <Card size="small" title="导出记录" extra={<Button size="small" icon={<ReloadOutlined />} onClick={load} />}>
        <Table
          size="small"
          rowKey="id"
          dataSource={history}
          pagination={{ pageSize: 10, size: 'default' }}
          columns={[
            { title: '时间', dataIndex: 'createdAt', width: 150, render: fmtTime },
            { title: '状态', dataIndex: 'status', width: 90, render: (s) => <Tag color={s === 'DONE' ? 'success' : s === 'FAILED' ? 'error' : 'processing'}>{s}</Tag> },
            {
              title: '产物',
              render: (_, r: any) =>
                r.summary ? (
                  <Space size={8} wrap>
                    <Typography.Text>{r.summary.fileName}</Typography.Text>
                    <Tag>{r.summary.students} 人</Tag>
                    <Tag>{r.summary.classes} 班</Tag>
                    <Tag color={r.summary.published ? 'success' : 'warning'}>v{r.summary.version}{r.summary.published ? '' : ' 候选'}</Tag>
                  </Space>
                ) : (
                  r.error ?? '-'
                ),
            },
            {
              title: '下载',
              width: 90,
              render: (_, r: any) =>
                r.summary?.fileUuid ? (
                  <Button type="link" size="small" icon={<DownloadOutlined />} onClick={() => downloadFile(r.summary.fileUuid, r.summary.fileName)}>
                    下载
                  </Button>
                ) : (
                  '-'
                ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
