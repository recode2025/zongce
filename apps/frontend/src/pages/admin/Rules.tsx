import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Drawer, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { RuleItem, addWhitelist, fetchRuleItems, fetchWhitelists, removeWhitelist, updateRuleItem } from '../../api';
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

  const load = useCallback(() => {
    fetchRuleItems({ category })
      .then(setRows)
      .catch((e) => message.error(errMsg(e)));
  }, [category, message]);
  useEffect(load, [load]);

  const save = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v || !editing) return;
    try {
      await updateRuleItem(editing.id, {
        name: v.name,
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
          ...(canEdit
            ? [
                {
                  title: '操作',
                  width: 70,
                  render: (_: any, r: RuleItem) => (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => {
                        setEditing(r);
                        form.setFieldsValue({ name: r.name, defaultScore: r.defaultScore, perTermMax: r.caps?.perTermMax, isActive: r.isActive });
                      }}
                    >
                      编辑
                    </Button>
                  ),
                } as any,
              ]
            : []),
        ]}
      />

      <Drawer title={`编辑规则 · ${editing?.code ?? ''}`} open={!!editing} onClose={() => setEditing(null)} width={420} extra={<Button type="primary" onClick={save}>保存</Button>}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input maxLength={100} />
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
