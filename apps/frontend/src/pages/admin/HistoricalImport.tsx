import { useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Input, Modal, Space, Table, Tabs, Tag, Typography, Upload } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { errMsg } from '../../api/client';
import { invalidateBatchCache } from '../../components/common';
import {
  HistoricalScholarshipPreview,
  HistoricalScholarshipRecord,
  HistoricalScholarshipResult,
  HistoricalScorePreview,
  HistoricalScoreResult,
  commitHistoricalScholarships,
  commitHistoricalScores,
  fetchHistoricalScholarships,
  previewHistoricalScholarships,
  previewHistoricalScores,
} from '../../api/historical-import';

const semesterPattern = /^\d{4}-\d{4}-[12]$/;
const yearPattern = /^\d{4}-\d{4}$/;

function FilePicker({ file, busy, onChange }: { file: File | null; busy: boolean; onChange: (file: File | null) => void }) {
  const { message } = App.useApp();
  return (
    <Upload.Dragger
      accept=".xlsx"
      maxCount={1}
      disabled={busy}
      showUploadList={false}
      beforeUpload={(next) => {
        if (!next.name.toLowerCase().endsWith('.xlsx')) {
          onChange(null);
          message.warning('请选择 .xlsx 文件');
          return Upload.LIST_IGNORE;
        }
        onChange(next);
        return false;
      }}
    >
      <p className="ant-upload-drag-icon"><InboxOutlined /></p>
      <p className="ant-upload-text">{file ? file.name : '点击或拖入 Excel 文件'}</p>
      <p className="ant-upload-hint">选择 .xlsx 文件后先预览，确认前不会写入数据</p>
    </Upload.Dragger>
  );
}

function ScoreImport() {
  const { message } = App.useApp();
  const nav = useNavigate();
  const [semesterKey, setSemesterKey] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<HistoricalScorePreview | null>(null);
  const [result, setResult] = useState<HistoricalScoreResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const invalidate = () => { setPreview(null); setResult(null); setError(''); };
  const doPreview = async () => {
    if (!file) return message.warning('请先选择历史综测表');
    if (!semesterPattern.test(semesterKey)) return message.warning('学期格式应为 2025-2026-1');
    setBusy(true);
    setError('');
    setPreview(null);
    setResult(null);
    try {
      setPreview(await previewHistoricalScores(file, semesterKey));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const doCommit = async () => {
    if (!file || !preview?.canCommit || !preview.fileSha256) return;
    setBusy(true);
    setError('');
    try {
      const committed = await commitHistoricalScores(file, preview.semesterKey, preview.fileSha256);
      invalidateBatchCache();
      setResult(committed);
      setPreview(null);
      setConfirmOpen(false);
      message.success('历史综测结果已导入');
    } catch (e) {
      setConfirmOpen(false);
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert type="info" showIcon message="历史综测先导入为待发布结果"
        description="导入完成后，到“发布与公示”选择该批次并执行发布。导入不会自动发布，也不会根据汇总表还原原始课程和申报材料。" />
      <Card size="small" title="选择历史综测表">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <label htmlFor="historical-semester">所属学期</label>
          <Input id="historical-semester" value={semesterKey} placeholder="例如 2025-2026-1"
            disabled={busy} onChange={(e) => { setSemesterKey(e.target.value.trim()); invalidate(); }} />
          <FilePicker file={file} busy={busy} onChange={(next) => { setFile(next); invalidate(); }} />
          <Button type="primary" loading={busy} onClick={doPreview}>预览并校验</Button>
        </Space>
      </Card>
      {error && <Alert type="error" showIcon message="操作未完成" description={error} />}
      {preview && (
        <Card size="small" title="导入预览">
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={{ xs: 1, sm: 3 }} items={[
              { key: 'term', label: '学期', children: preview.semesterKey },
              { key: 'rows', label: '表内记录', children: preview.totalRows },
              { key: 'matched', label: '匹配学生', children: preview.matchedRows },
            ]} />
            {preview.canCommit ? (
              <Alert type="success" showIcon message="校验通过，可以确认导入" />
            ) : (
              <Alert type="warning" showIcon message="存在需要处理的问题，暂不能导入" description="请核对下面的校验结果，修正后重新上传并预览。" />
            )}
            {!!preview.warnings?.length && <Alert type="warning" showIcon message="请核对历史数据的使用范围"
              description={<ul style={{ margin: 0, paddingLeft: 20 }}>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>} />}
            {preview.issues.length > 0 && <Table size="small" rowKey={(_, index) => String(index)}
              dataSource={preview.issues} pagination={{ pageSize: 10 }} scroll={{ x: 'max-content' }}
              columns={[
                { title: '行号', dataIndex: 'row', width: 90 },
                { title: '校验结果', dataIndex: 'message' },
              ]} />}
            {preview.sample.length > 0 && <>
              <Typography.Text strong>数据预览</Typography.Text>
              <Table size="small" rowKey={(_, index) => String(index)} dataSource={preview.sample}
                pagination={false} scroll={{ x: 'max-content' }} columns={[
                  { title: '行号', dataIndex: 'row', width: 80 },
                  { title: '学号', dataIndex: 'studentNo' },
                  { title: '姓名', dataIndex: 'name' },
                  { title: '班级', dataIndex: 'className' },
                  { title: '系统班级', dataIndex: 'systemClassName' },
                  { title: '综测总分', dataIndex: 'totalScore' },
                  { title: '年级排名', dataIndex: 'rankGrade', render: (v) => v ?? '—' },
                ]} />
            </>}
            <Button type="primary" disabled={!preview.canCommit || !preview.fileSha256} onClick={() => setConfirmOpen(true)}>
              确认导入历史综测
            </Button>
          </Space>
        </Card>
      )}
      {result && <Alert type="success" showIcon message={`已导入 ${result.count} 条历史综测结果`}
        description={<Space wrap>学期 {result.semesterKey}；结果尚未发布。
          <Button type="link" onClick={() => nav('/admin/publish')}>前往发布与公示</Button></Space>} />}
      <Modal title="确认导入历史综测" open={confirmOpen} onCancel={() => setConfirmOpen(false)} onOk={doCommit}
        confirmLoading={busy} okText="确认导入" cancelText="返回检查">
        <Typography.Paragraph>将为 {preview?.semesterKey} 导入 {preview?.matchedRows ?? 0} 条历史结果。导入后仍需在发布页面操作。</Typography.Paragraph>
      </Modal>
    </Space>
  );
}

function ScholarshipImport() {
  const { message } = App.useApp();
  const [academicYear, setAcademicYear] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<HistoricalScholarshipPreview | null>(null);
  const [result, setResult] = useState<HistoricalScholarshipResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [records, setRecords] = useState<HistoricalScholarshipRecord[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [queryYear, setQueryYear] = useState('');
  const [recordsBusy, setRecordsBusy] = useState(false);

  const invalidate = () => { setPreview(null); setResult(null); setError(''); };
  const doPreview = async () => {
    if (!file) return message.warning('请先选择奖学金历史表');
    if (!yearPattern.test(academicYear)) return message.warning('学年格式应为 2025-2026');
    setBusy(true);
    setError('');
    setPreview(null);
    setResult(null);
    try {
      setPreview(await previewHistoricalScholarships(file, academicYear));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const loadRecords = async (year: string, nextPage = 1) => {
    if (!yearPattern.test(year)) return message.warning('请输入有效学年后再查询');
    setRecordsBusy(true);
    try {
      const data = await fetchHistoricalScholarships(year, nextPage);
      setRecords(data.items);
      setTotal(data.total);
      setPage(data.page);
      setQueryYear(year);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setRecordsBusy(false);
    }
  };
  const canCommit = !!preview?.fileHash && !!preview.previewToken && preview.summary.rows > 0
    && preview.summary.unmatched === 0 && preview.summary.nameMismatches === 0;
  const doCommit = async () => {
    if (!file || !preview || !canCommit) return;
    setBusy(true);
    setError('');
    try {
      const committed = await commitHistoricalScholarships(file, preview.academicYear, preview.fileHash, preview.previewToken);
      setResult(committed);
      setPreview(null);
      setConfirmOpen(false);
      message.success('历史奖学金记录已导入');
      await loadRecords(committed.academicYear);
    } catch (e) {
      setConfirmOpen(false);
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert type="info" showIcon message="奖学金表作为历史记录保存"
        description="保留来源工作表、特色项目名单和原奖项；空奖项不会被补填。历史记录不会覆盖当前正式奖学金评定结果。" />
      <Card size="small" title="选择奖学金历史表">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <label htmlFor="historical-academic-year">所属学年</label>
          <Input id="historical-academic-year" value={academicYear} placeholder="例如 2025-2026"
            disabled={busy} onChange={(e) => { setAcademicYear(e.target.value.trim()); invalidate(); }} />
          <FilePicker file={file} busy={busy} onChange={(next) => { setFile(next); invalidate(); }} />
          <Space wrap>
            <Button type="primary" loading={busy} onClick={doPreview}>预览并校验</Button>
            <Button loading={recordsBusy} disabled={busy} onClick={() => loadRecords(academicYear)}>查询该学年历史记录</Button>
          </Space>
        </Space>
      </Card>
      {error && <Alert type="error" showIcon message="操作未完成" description={error} />}
      {preview && (
        <Card size="small" title="导入预览">
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={{ xs: 1, sm: 3 }} items={[
              { key: 'year', label: '学年', children: preview.academicYear },
              { key: 'rows', label: '表内记录', children: preview.summary.rows },
              { key: 'matched', label: '匹配学生', children: preview.summary.matched },
              { key: 'pending', label: '特色名单（空奖项）', children: preview.summary.pending },
              { key: 'missing', label: '未匹配', children: preview.summary.unmatched },
              { key: 'names', label: '姓名不一致', children: preview.summary.nameMismatches },
            ]} />
            <Alert type={canCommit ? 'success' : 'warning'} showIcon
              message={canCommit ? '校验通过，可以确认导入' : '存在未匹配或姓名不一致的记录，暂不能导入'}
              description="空奖项原样保留，特色项目名单单独记录；请检查来源表和学号，必要时先完善学生信息。" />
            <Table size="small" rowKey="name" dataSource={preview.sheets} pagination={false} scroll={{ x: 'max-content' }} columns={[
              { title: '来源工作表', dataIndex: 'name' },
              { title: '记录', dataIndex: 'rows' },
              { title: '匹配', dataIndex: 'matched' },
              { title: '未匹配', dataIndex: 'unmatched' },
              { title: '姓名不一致', dataIndex: 'nameMismatches' },
              { title: '特色名单（空奖项）', dataIndex: 'pending' },
            ]} />
            {preview.issues.length > 0 && <Table size="small" rowKey={(_, index) => String(index)}
              dataSource={preview.issues} pagination={{ pageSize: 10 }} scroll={{ x: 'max-content' }} columns={[
                { title: '工作表', dataIndex: 'sheet' },
                { title: '行号', dataIndex: 'row' },
                { title: '学号', dataIndex: 'studentNo' },
                { title: '表内姓名', dataIndex: 'sourceName' },
                { title: '问题', dataIndex: 'reason' },
              ]} />}
            <Button type="primary" disabled={!canCommit} onClick={() => setConfirmOpen(true)}>确认导入历史奖学金</Button>
          </Space>
        </Card>
      )}
      {result && <Alert type="success" showIcon message={`已新增 ${result.inserted} 条，重复跳过 ${result.duplicates} 条`}
        description={`${result.academicYear} 历史奖学金记录已保存；特色项目名单保留来源。`} />}
      {records && <Card size="small" title={`${queryYear} 历史奖学金记录`}>
        <Table size="small" rowKey="id" loading={recordsBusy} dataSource={records} scroll={{ x: 'max-content' }}
          pagination={{ current: page, pageSize: 50, total, showSizeChanger: false, onChange: (next) => loadRecords(queryYear, next) }}
          columns={[
            { title: '学号', dataIndex: 'studentNo' },
            { title: '表内姓名', dataIndex: 'sourceName' },
            { title: '来源工作表', dataIndex: 'sourceSheet' },
            { title: '来源项目', dataIndex: 'projectName', render: (v) => v || '—' },
            { title: '原奖项', dataIndex: 'rawAward', render: (v) => v || '—' },
            { title: '状态', render: (_, row) => row.projectName ? <Tag color="blue">来源名单</Tag> : row.rawAward ? <Tag color="green">已记录</Tag> : <Tag>未记录奖项</Tag> },
          ]} />
      </Card>}
      <Modal title="确认导入历史奖学金" open={confirmOpen} onCancel={() => setConfirmOpen(false)} onOk={doCommit}
        confirmLoading={busy} okText="确认导入" cancelText="返回检查">
        <Typography.Paragraph>将导入 {preview?.academicYear} 的历史记录，保留来源及待确认状态；不会覆盖正式评定结果。</Typography.Paragraph>
      </Modal>
    </Space>
  );
}

export default function HistoricalImport() {
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Text type="secondary">先检查预览中的学期、学年和匹配结果，确认后再导入。</Typography.Text>
      <Tabs items={[
        { key: 'scores', label: '历史综测', children: <ScoreImport /> },
        { key: 'scholarships', label: '历史奖学金', children: <ScholarshipImport /> },
      ]} />
    </Space>
  );
}
