import { useMemo, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Space, Steps, Table, Tag, Typography } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { Upload } from 'antd';
import { ImportPreview, confirmImport, previewImport } from '../api';
import { errMsg } from '../api/client';
import { MappingTable } from './MappingTable';
import JobProgress from './JobProgress';

export interface ImportWizardProps {
  kind: 'STUDENT' | 'GRADE';
  /** GRADE 导入必须指定批次 */
  batchId?: string;
  onDone?: (summary: any) => void;
}

/** 两阶段导入向导：上传解析 → 列映射确认（可改）→ 提交 → 任务进度 */
export default function ImportWizard({ kind, batchId, onDone }: ImportWizardProps) {
  const { message } = App.useApp();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<{ target: string; label: string; required?: boolean; source?: string }[]>([]);
  const [termKey, setTermKey] = useState<string>('');
  const [jobId, setJobId] = useState<string>('');
  const [jobSummary, setJobSummary] = useState<any>(null);

  const fileName = preview?.fileName ?? '';

  const doPreview = async (file: File) => {
    setLoading(true);
    try {
      const p = await previewImport(kind, file);
      setPreview(p);
      setMapping(p.mapping);
      if (p.termKeys?.length) setTermKey(p.termKeys.includes('2025-2026-1') ? '2025-2026-1' : p.termKeys[0]);
      setStep(1);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
    return false; // 阻止 antd 自动上传
  };

  const doConfirm = async () => {
    if (!preview) return;
    if (kind === 'GRADE' && !termKey) {
      message.warning('请选择要导入的学期');
      return;
    }
    setLoading(true);
    try {
      const r = await confirmImport({
        token: preview.token,
        kind,
        mapping,
        batchId,
        termKey: kind === 'GRADE' ? termKey : undefined,
        options: { fileName: preview.fileName },
      });
      setJobId(r.jobId);
      setStep(2);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const sampleColumns = useMemo(() => {
    const used = mapping.filter((m) => m.source).map((m) => m.source!);
    return used.slice(0, 8).map((h) => ({
      title: h,
      dataIndex: h,
      key: h,
      ellipsis: true,
      width: 130,
      render: (v: any) => (v === null || v === undefined ? <Tag>空</Tag> : String(v).slice(0, 40)),
    }));
  }, [mapping, preview]);

  return (
    <Card size="small">
      <Steps
        size="small"
        current={step}
        items={[
          { title: '上传解析' },
          { title: '列映射确认' },
          { title: kind === 'STUDENT' ? '导入执行' : '导入执行' },
        ]}
        style={{ marginBottom: 20 }}
      />

      {step === 0 && (
        <Upload.Dragger
          accept=".xlsx,.xls"
          maxCount={1}
          showUploadList={false}
          beforeUpload={doPreview}
          disabled={loading}
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">{loading ? '正在解析表头…' : '点击或拖入 Excel 文件（.xlsx / .xls）'}</p>
          <p className="ant-upload-hint">
            {kind === 'STUDENT'
              ? '学生名册：支持 65 列宽表，系统按列名别名自动匹配（学号/姓名/班级/学籍状态…）'
              : '课程成绩表：教务系统导出原表，含多学期数据时将要求选择学期'}
          </p>
        </Upload.Dragger>
      )}

      {step === 1 && preview && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={
              <Space wrap>
                <span>{fileName}：共 {preview.totalRows} 行数据</span>
                {preview.termKeys && preview.termKeys.length > 0 && (
                  <span>
                    文件含多学期：
                    {preview.termKeys.map((t) => (
                      <Tag.CheckableTag key={t} checked={termKey === t} onChange={() => setTermKey(t)}>
                        {t}
                      </Tag.CheckableTag>
                    ))}
                  </span>
                )}
              </Space>
            }
          />
          {kind === 'GRADE' && preview.termKeys && preview.termKeys.length > 0 && !termKey && (
            <Alert type="warning" showIcon message="请点击上方学期标签，选择要导入的学期" />
          )}
          <MappingTable headers={preview.headers} mapping={mapping} onChange={setMapping} />
          <Typography.Title level={5} style={{ marginBottom: 0 }}>数据预览（前 5 行·映射列）</Typography.Title>
          <Table
            size="small"
            rowKey={(_, i) => String(i)}
            columns={sampleColumns}
            dataSource={preview.sampleRows}
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
          <Space>
            <Button onClick={() => setStep(0)}>重新上传</Button>
            <Button type="primary" loading={loading} onClick={doConfirm} disabled={kind === 'GRADE' && (!batchId || !termKey)}>
              确认映射并开始导入
            </Button>
            {kind === 'GRADE' && !batchId && <Typography.Text type="danger">请先在页面顶部选择批次</Typography.Text>}
          </Space>
        </Space>
      )}

      {step === 2 && jobId && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <JobProgress
            jobId={jobId}
            onDone={(j) => {
              setJobSummary(j.summary);
              onDone?.(j.summary);
            }}
          />
          {jobSummary && (
            <>
              <Descriptions bordered size="small" column={4}>
                <Descriptions.Item label="总行数">{jobSummary.total}</Descriptions.Item>
                <Descriptions.Item label="新增">{jobSummary.inserted}</Descriptions.Item>
                <Descriptions.Item label="更新">{jobSummary.updated}</Descriptions.Item>
                <Descriptions.Item label="跳过">{jobSummary.skipped}</Descriptions.Item>
              </Descriptions>
              {!!jobSummary.issues && (
                <Alert type="warning" showIcon message={`发现 ${jobSummary.issues} 条异常数据，请前往「异常数据面板」裁决`} />
              )}
              <Button onClick={() => { setStep(0); setPreview(null); setJobSummary(null); }}>继续导入下一份文件</Button>
            </>
          )}
        </Space>
      )}
    </Card>
  );
}
