import { useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { BATCH_STATUS_FLOW, BATCH_STATUS_LABEL } from '@zc/shared';
import { activateRulesSnapshot, createBatch, fetchBatches, transitionBatch } from '../../api';
import { errMsg } from '../../api/client';
import { BatchStatusTag, fmtTime } from '../../components/common';

/** 批次管理：创建 / 激活规则快照 / 阶段流转（门禁校验在服务端） */
export default function Batches() {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const load = () => {
    setLoading(true);
    fetchBatches()
      .then(setRows)
      .catch((e) => message.error(errMsg(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const nextOf = (status: string) => {
    const i = BATCH_STATUS_FLOW.indexOf(status as any);
    return i >= 0 && i < BATCH_STATUS_FLOW.length - 1 ? BATCH_STATUS_FLOW[i + 1] : null;
  };

  const doTransition = (row: any, to: string) =>
    modal.confirm({
      title: `阶段流转确认`,
      content: `将「${row.name}」从 ${BATCH_STATUS_LABEL[row.status as keyof typeof BATCH_STATUS_LABEL]} 推进到 ${BATCH_STATUS_LABEL[to as keyof typeof BATCH_STATUS_LABEL]}？门禁条件不满足时将被拒绝。`,
      onOk: async () => {
        try {
          await transitionBatch(row.id, to);
          message.success(`已进入「${BATCH_STATUS_LABEL[to as keyof typeof BATCH_STATUS_LABEL]}」`);
          load();
        } catch (e) {
          message.error(errMsg(e));
        }
      },
    });

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建批次
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          <Typography.Text type="secondary">
            流程：{BATCH_STATUS_FLOW.map((s) => BATCH_STATUS_LABEL[s]).join(' → ')}
          </Typography.Text>
        </Space>
      </Card>

      <Card size="small" title="批次列表">
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '批次', dataIndex: 'name', render: (v, r: any) => <Typography.Text strong>{v}</Typography.Text> },
            { title: '学期', dataIndex: 'semesterKey', width: 110 },
            { title: '状态', dataIndex: 'status', width: 100, render: (s) => <BatchStatusTag status={s} /> },
            {
              title: '数据量',
              width: 260,
              render: (_, r: any) => (
                <Space size={4} wrap>
                  <Tag>申请 {r.counts?.applications ?? 0}</Tag>
                  <Tag>成绩 {r.counts?.courseGrades ?? 0}</Tag>
                  <Tag>结果 {r.counts?.calcResults ?? 0}</Tag>
                  <Tag>异议 {r.counts?.objections ?? 0}</Tag>
                </Space>
              ),
            },
            { title: '计算版本', dataIndex: 'currentCalcVersion', width: 90, align: 'right', className: 'zc-num' },
            { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (t: string) => fmtTime(t) },
            {
              title: '操作',
              width: 250,
              render: (_, r: any) => {
                const next = nextOf(r.status);
                return (
                  <Space size={4}>
                    <Popconfirm
                      title="激活规则快照"
                      description="把当前规则字典固化为本批次口径（已有快照将被重建），确认？"
                      onConfirm={async () => {
                        try {
                          const x = await activateRulesSnapshot(r.id);
                          message.success(`已激活 ${x.count} 条规则快照`);
                        } catch (e) {
                          message.error(errMsg(e));
                        }
                      }}
                    >
                      <Button size="small" icon={<ThunderboltOutlined />}>
                        激活规则
                      </Button>
                    </Popconfirm>
                    {next && (
                      <Button size="small" type="primary" ghost onClick={() => doTransition(r, next)}>
                        进入「{BATCH_STATUS_LABEL[next]}」
                      </Button>
                    )}
                    {!next && <Typography.Text type="secondary">已归档</Typography.Text>}
                  </Space>
                );
              },
            },
          ]}
        />
      </Card>

      <Modal
        title="新建批次"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const v = await form.validateFields().catch(() => null);
          if (!v) return;
          try {
            await createBatch(v);
            message.success('批次已创建');
            setCreateOpen(false);
            form.resetFields();
            load();
          } catch (e) {
            message.error(errMsg(e));
          }
        }}
        okText="创建"
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="semesterKey"
            label="学期"
            rules={[
              { required: true },
              { pattern: /^\d{4}-\d{4}-[12]$/, message: '格式：2025-2026-1（第几学期用 1/2）' },
            ]}
          >
            <Input placeholder="2025-2026-1" />
          </Form.Item>
          <Form.Item name="name" label="批次名称" rules={[{ required: true }]}>
            <Input placeholder="如：2025 级 2025-2026-1 学期综测" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
