import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Drawer, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography, Upload } from 'antd';
import { DownloadOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import { APPLY_TYPE_LABEL, ApplyType } from '@zc/shared';
import { RuleItem, addWhitelist, downloadUnifiedTemplate, fetchBatches, fetchRuleItems, fetchWhitelists, importUnifiedScores, removeWhitelist, updateRuleItem } from '../../api';
import { errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';

const CATEGORY_LABEL: Record<string, string> = { MORAL: '品德行为', ACADEMIC: '学业表现', SPORTS: '文体表现' };
const WL_TYPE_LABEL: Record<string, string> = {
  COMP_A: 'A 类竞赛（国家级）',
  COMP_B_NATIONAL: 'B 类·国家级',
  COMP_B_PROVINCIAL: 'B 类·省级',
  COMP_B_MUNICIPAL: 'B 类·市级',
  CERT_LANG: '语言证书',
};

/** 规则字典（读全员）+ 白名单维护（写仅超管） */
export default function Rules() {
  return (
    <Tabs
      items={[
        { key: 'items', label: '加分项字典', children: <RuleItems /> },
        { key: 'whitelist', label: '赛事认定目录 / 证书白名单', children: <Whitelists /> },
      ]}
    />
  );
}

function RuleItems() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const canEdit = user?.role === 'SUPER_ADMIN';
  const [rows, setRows] = useState<RuleItem[]>([]);
  const [category, setCategory] = useState<string>();
  const [editing, setEditing] = useState<RuleItem | null>(null);
  const [form] = Form.useForm();

  // 统一加分名单导入
  const [batches, setBatches] = useState<any[]>([]);
  const [importRule, setImportRule] = useState<RuleItem | null>(null);
  const [importBatchId, setImportBatchId] = useState<string>('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);

  const load = useCallback(() => {
    fetchRuleItems({ category })
      .then(setRows)
      .catch((e) => message.error(errMsg(e)));
  }, [category, message]);
  useEffect(load, [load]);

  useEffect(() => {
    fetchBatches()
      .then((bs) => {
        setBatches(bs);
        const active = [...bs].reverse().find((b) => b.status !== 'ARCHIVED') ?? bs[bs.length - 1];
        if (active) setImportBatchId(active.id);
      })
      .catch(() => undefined);
  }, []);

  const save = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v || !editing) return;
    try {
      await updateRuleItem(editing.id, {
        name: v.name,
        applyType: v.applyType,
        defaultScore: v.defaultScore,
        caps: { ...editing.caps, perTermMax: v.perTermMax },
        isActive: v.isActive,
      });
      message.success('规则已更新（进行中批次不受影响，改的是字典；批次口径需重新激活快照）');
      setEditing(null);
      load();
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  const doImport = async () => {
    if (!importRule || !importBatchId) return;
    if (!importFile) {
      message.warning('请先选择导入文件');
      return;
    }
    setImporting(true);
    setImportResult(null);
    try {
      const r = await importUnifiedScores(importRule.id, importBatchId, importFile);
      setImportResult(r);
      message.success(`导入完成：新增 ${r.created}、覆盖更新 ${r.updated}、跳过 ${r.skipped}`);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Card size="small" title="加分项字典" extra={
      <Space>
        <Select
          allowClear
          placeholder="全部板块"
          style={{ width: 140 }}
          value={category}
          onChange={setCategory}
          options={Object.entries(CATEGORY_LABEL).map(([v, l]) => ({ value: v, label: l }))}
        />
        <Button size="small" icon={<ReloadOutlined />} onClick={load} />
      </Space>
    }>
      <Table
        size="small"
        rowKey="id"
        dataSource={rows}
        pagination={{ pageSize: 15, size: 'default' }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '代码', dataIndex: 'code', width: 220, render: (v) => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text> },
          { title: '板块', dataIndex: 'category', width: 90, render: (c) => <Tag>{CATEGORY_LABEL[c]}</Tag> },
          { title: '名称', dataIndex: 'name', width: 170 },
          {
            title: '申报方式',
            dataIndex: 'applyType',
            width: 100,
            render: (v) =>
              v === 'UNIFIED' ? (
                <Tag color="gold">统一加分</Tag>
              ) : (
                <Tag color="blue">{APPLY_TYPE_LABEL[ApplyType.SELF]}</Tag>
              ),
          },
          { title: '默认分', dataIndex: 'defaultScore', width: 80, align: 'right', className: 'zc-num', render: (v) => v ?? '-' },
          {
            title: '上限/规则',
            width: 200,
            render: (_: any, r: RuleItem) => (
              <Space size={4} wrap>
                {r.caps?.perTermMax != null && <Tag color="blue">学期≤{r.caps.perTermMax}</Tag>}
                {r.caps?.itemCountMax != null && <Tag>≤{r.caps.itemCountMax}项</Tag>}
                {r.caps?.takeHighest && <Tag color="purple">取最高</Tag>}
                {r.whitelistType && <Tag color="orange">白名单:{WL_TYPE_LABEL[r.whitelistType] ?? r.whitelistType}</Tag>}
              </Space>
            ),
          },
          { title: '导出列', dataIndex: 'exportSlot', width: 100, render: (v) => v ?? '-' },
          {
            title: '表单字段',
            width: 90,
            render: (_: any, r: RuleItem) => (
              <Button
                type="link"
                size="small"
                onClick={() =>
                  Modal.info({
                    title: `${r.name} · detailSchema`,
                    width: 560,
                    content: (
                      <pre style={{ maxHeight: 360, overflow: 'auto', fontSize: 12 }}>
                        {JSON.stringify(r.detailSchema, null, 2)}
                      </pre>
                    ),
                  })
                }
              >
                查看
              </Button>
            ),
          },
          {
            title: '操作',
            width: 140,
            render: (_: any, r: RuleItem) => (
              <Space size={0}>
                {r.applyType === 'UNIFIED' && (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => {
                      setImportRule(r);
                      setImportFile(null);
                      setImportResult(null);
                    }}
                  >
                    导入名单
                  </Button>
                )}
                {canEdit && (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => {
                      setEditing(r);
                      form.setFieldsValue({ name: r.name, applyType: r.applyType ?? 'SELF', defaultScore: r.defaultScore, perTermMax: r.caps?.perTermMax, isActive: r.isActive });
                    }}
                  >
                    编辑
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Drawer title={`编辑规则 · ${editing?.code ?? ''}`} open={!!editing} onClose={() => setEditing(null)} width={420} extra={<Button type="primary" onClick={save}>保存</Button>}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="applyType" label="申报方式" extra="统一加分：学生端不可申报，由管理员按名单导入「学号 → 分值」，直接生成已认定记录">
            <Select
              options={[
                { value: 'SELF', label: APPLY_TYPE_LABEL[ApplyType.SELF] },
                { value: 'UNIFIED', label: APPLY_TYPE_LABEL[ApplyType.UNIFIED] },
              ]}
            />
          </Form.Item>
          <Form.Item name="defaultScore" label="默认分值">
            <InputNumber style={{ width: '100%' }} min={0} max={100} step={0.1} />
          </Form.Item>
          <Form.Item name="perTermMax" label="学期上限（caps.perTermMax）">
            <InputNumber style={{ width: '100%' }} min={0} max={100} step={0.1} />
          </Form.Item>
          <Form.Item name="isActive" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>

      {/* 统一加分名单导入：模板下载 → 上传 xlsx/csv（学号/姓名/分值）→ 摘要 */}
      <Modal
        title={`统一加分导入 · ${importRule?.name ?? ''}`}
        open={!!importRule}
        onCancel={() => setImportRule(null)}
        footer={[
          <Button key="tpl" icon={<DownloadOutlined />} onClick={() => importRule && downloadUnifiedTemplate(importRule.id, importRule.name)}>
            下载模板
          </Button>,
          <Button key="cancel" onClick={() => setImportRule(null)}>
            关闭
          </Button>,
          <Button key="ok" type="primary" icon={<UploadOutlined />} loading={importing} onClick={doImport}>
            开始导入
          </Button>,
        ]}
        width="min(92vw, 560px)"
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="按模板上传「学号 → 分值」名单，导入后直接生成已认定加分记录（不经初审/复审）"
            description="同一学生重复导入按覆盖更新；该生已有个人申报记录则跳过并提示。分数最终仍受计算引擎上限规则约束。"
          />
          <Space wrap>
            <span style={{ fontSize: 13 }}>导入批次：</span>
            <Select
              style={{ width: 280 }}
              value={importBatchId || undefined}
              onChange={setImportBatchId}
              placeholder="选择批次"
              options={batches.map((b) => ({ value: b.id, label: `${b.name}（${b.semesterKey}）` }))}
            />
          </Space>
          <Upload.Dragger
            accept=".xlsx,.xls,.csv"
            maxCount={1}
            beforeUpload={(f) => {
              setImportFile(f);
              setImportResult(null);
              return false;
            }}
            onRemove={() => setImportFile(null)}
            fileList={importFile ? [{ uid: '-1', name: importFile.name, status: 'done' }] : []}
          >
            <p className="ant-upload-drag-icon"><UploadOutlined /></p>
            <p className="ant-upload-text">点击或拖拽上传名单文件</p>
            <p className="ant-upload-hint">支持 xlsx / xls / csv · 表头需含「学号」与「分值」列</p>
          </Upload.Dragger>
          {importResult && (
            <div className="zc-import-summary">
              <Typography.Text strong>导入结果</Typography.Text>
              <Space size={6} wrap style={{ marginTop: 6 }}>
                <Tag color="blue">共 {importResult.total} 行</Tag>
                <Tag color="green">新增 {importResult.created}</Tag>
                <Tag color="orange">覆盖更新 {importResult.updated}</Tag>
                <Tag color={importResult.skipped ? 'red' : 'default'}>跳过 {importResult.skipped}</Tag>
              </Space>
              {importResult.unknownStudentNos?.length > 0 && (
                <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  未匹配学号（{importResult.unknownStudentNos.length} 个）：{importResult.unknownStudentNos.slice(0, 20).join('、')}
                  {importResult.unknownStudentNos.length > 20 ? ' …' : ''}
                </Typography.Text>
              )}
              {importResult.conflicts?.length > 0 && (
                <Typography.Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                  已有个人申报而跳过（{importResult.conflicts.length} 个）：{importResult.conflicts.map((c: any) => c.studentNo).join('、')}
                </Typography.Text>
              )}
            </div>
          )}
        </Space>
      </Modal>
    </Card>
  );
}

function Whitelists() {
  const { message } = App.useApp();
  const [type, setType] = useState('COMP_A');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [names, setNames] = useState('');
  const [year, setYear] = useState<number>(new Date().getFullYear());

  const load = useCallback(() => {
    fetchWhitelists({ type, q: q || undefined, limit: 50 })
      .then(setRows)
      .catch((e) => message.error(errMsg(e)));
  }, [type, q, message]);
  useEffect(load, [load]);

  return (
    <Card
      size="small"
      title="白名单（赛事认定目录 / 语言证书分数线）"
      extra={
        <Space>
          <Select
            style={{ width: 170 }}
            value={type}
            onChange={setType}
            options={Object.entries(WL_TYPE_LABEL).map(([v, l]) => ({ value: v, label: l }))}
          />
          <Input.Search
            placeholder="搜索名称"
            allowClear
            style={{ width: 180 }}
            prefix={<SearchOutlined />}
            onSearch={setQ}
          />
          <Button size="small" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
            批量追加
          </Button>
        </Space>
      }
    >
      <Table
        size="small"
        rowKey="id"
        dataSource={rows}
        pagination={{ pageSize: 15, size: 'default' }}
        columns={[
          { title: '名称', dataIndex: 'name', ellipsis: true },
          { title: '年份', dataIndex: 'year', width: 80 },
          { title: '类型', dataIndex: 'type', width: 150, render: (t) => <Tag>{WL_TYPE_LABEL[t] ?? t}</Tag> },
          {
            title: '附加',
            dataIndex: 'extra',
            width: 160,
            render: (x: any) => (x ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{JSON.stringify(x)}</Typography.Text> : '-'),
          },
          {
            title: '操作',
            width: 70,
            render: (_, r: any) => (
              <Button
                type="link"
                size="small"
                danger
                onClick={async () => {
                  try {
                    await removeWhitelist(r.id);
                    message.success('已删除');
                    load();
                  } catch (e) {
                    message.error(errMsg(e));
                  }
                }}
              >
                删除
              </Button>
            ),
          },
        ]}
      />

      <Modal
        title={`批量追加白名单 · ${WL_TYPE_LABEL[type] ?? type}`}
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={async () => {
          const list = names.split('\n').map((s) => s.trim()).filter(Boolean);
          if (!list.length) return;
          try {
            const r = await addWhitelist({ type, year, names: list });
            message.success(`新增 ${r.added} 条，跳过重复 ${r.skipped} 条`);
            setAddOpen(false);
            setNames('');
            load();
          } catch (e) {
            message.error(errMsg(e));
          }
        }}
        okText="追加"
      >
        <InputNumber
          style={{ width: 140, marginBottom: 12 }}
          value={year}
          onChange={(v) => setYear(v ?? new Date().getFullYear())}
          addonBefore="年度"
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          每行一个赛事/证书全称（学生申报时按名称模糊匹配认定）
        </Typography.Paragraph>
        <Input.TextArea rows={8} value={names} onChange={(e) => setNames(e.target.value)} placeholder={'中国大学生程序设计竞赛\n蓝桥杯全国软件和信息技术专业人才大赛'} />
      </Modal>
    </Card>
  );
}
