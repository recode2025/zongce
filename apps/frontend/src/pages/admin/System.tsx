import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { KeyOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, SendOutlined } from '@ant-design/icons';
import { createAnnouncement, createUser, deleteAnnouncement, fetchAnnouncements, fetchApplySwitch, fetchAuditLogs, fetchBatches, fetchLoginPassphrase, fetchUsers, resetPwdBatch, updateApplySwitch, updateLoginPassphrase, updateUser } from '../../api';
import { errMsg } from '../../api/client';
import { fmtTime } from '../../components/common';
import { ROLE_TEXT, useAuth } from '../../store/auth';

const AUDIT_ACTION: Record<string, string> = {
  LOGIN: '登录',
  LOGIN_FAIL: '登录失败',
  IMPORT: '导入',
  GRADE_RESOLVE: '成绩裁决',
  FIRST_REVIEW_PASS: '初审通过',
  FIRST_REVIEW_REJECT: '初审退回',
  SECOND_REVIEW_APPROVE: '复审认定',
  SECOND_REVIEW_REJECT: '复审驳回',
  PACKAGE_FIRST_PASS: '材料包初审通过',
  PACKAGE_FIRST_REJECT: '材料包初审退回',
  PUBLISH: '发布',
  PUBLISH_INCREMENTAL: '增量发布',
  OBJECTION_SUBMIT: '提交异议',
  OBJECTION_HANDLE: '异议处理',
  EXPORT_RESULT: '导出结果',
  CALC_RUN: '计算',
  BATCH_CREATE: '创建批次',
  BATCH_TRANSITION: '阶段流转',
  RULE_UPDATE: '规则变更',
  RULE_CREATE: '新建规则',
  WHITELIST_ADD: '白名单追加',
  WHITELIST_REMOVE: '白名单删除',
  USER_UPDATE: '用户变更',
  APPLY_SWITCH: '提交通道开关',
  STUDENT_UPDATE: '学生变更',
  FILE_UPLOAD: '文件上传',
  APPLICATION_SUBMIT: '提交申请',
  PACKAGE_SUBMIT: '提交材料包',
  WITHDRAW: '撤回申请',
};

/** 系统管理：用户角色 / 审计日志 / 公告 / 安全设置（用户与审计仅超管） */
export default function System() {
  const canManage = useAuth().user?.role === 'SUPER_ADMIN';
  return (
    <Tabs
      items={[
        ...(canManage ? [{ key: 'users', label: '用户与角色', children: <Users /> },
        { key: 'audit', label: '审计日志', children: <Audit /> }] : []),
        { key: 'ann', label: '公告', children: <Announcements /> },
        { key: 'security', label: '安全设置', children: <Security /> },
      ]}
    />
  );
}

/** 安全设置：管理员登录密语口令 + 学生提交通道开关 */
function Security() {
  const { message } = App.useApp();
  const canManage = useAuth().user?.role === 'SUPER_ADMIN';
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 学生提交通道开关（服务端强制）
  const [applyEnabled, setApplyEnabled] = useState(true);
  const [applyLoading, setApplyLoading] = useState(true);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (canManage) fetchLoginPassphrase()
      .then((r) => setValue(r.value))
      .catch((e) => message.error(errMsg(e)))
      .finally(() => setLoading(false));
    fetchApplySwitch()
      .then((r) => setApplyEnabled(r.enabled))
      .catch(() => undefined)
      .finally(() => setApplyLoading(false));
  }, [message, canManage]);

  const save = async () => {
    const v = value.trim();
    if (v.length < 4) {
      message.warning('密语口令至少 4 个字符');
      return;
    }
    setSaving(true);
    try {
      await updateLoginPassphrase(v);
      message.success('密语口令已更新，立即生效');
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleApply = async (v: boolean) => {
    setSwitching(true);
    try {
      const r = await updateApplySwitch(v);
      setApplyEnabled(r.enabled);
      message.success(r.enabled ? '提交通道已开启' : '提交通道已关闭（服务端强制，立即生效）');
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title={<Space><SendOutlined /> 学生提交通道</Space>} style={{ maxWidth: 560 }}>
        <Alert
          style={{ marginBottom: 16 }}
          type={applyEnabled ? 'success' : 'error'}
          showIcon
          message={applyEnabled ? '提交通道：开启中' : '提交通道：已关闭'}
          description="关闭后学生端立即无法提交加分申报与材料包（服务端强制校验，修改前端代码也无法绕过）；批次阶段限制仍独立生效。适用于收集截止后临时封口、或需要暂停受理进行调整的场景。"
        />
        <Space size="middle">
          <Switch checked={applyEnabled} loading={applyLoading || switching} onChange={toggleApply} disabled={applyLoading || !canManage} />
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {applyEnabled ? '学生可正常提交' : '暂停受理一切学生提交'}
          </Typography.Text>
        </Space>
      </Card>

      {canManage && <Card size="small" title={<Space><SafetyCertificateOutlined /> 登录密语口令</Space>} style={{ maxWidth: 560 }}>
      <Alert
        style={{ marginBottom: 16 }}
        type="info"
        showIcon
        message="管理员登录第一道门：点击「管理员登录」后须先输入此口令完成验证，通过后 10 分钟内免重复验证。"
        description="口令在管理员本地登录时于后端强制校验（学生数字大外登录不受影响）；泄露或周期性更换时在此修改，立即生效。"
      />
      <Space.Compact block>
        <Input.Password
          size="large"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="登录密语口令（4-64 个字符）"
          maxLength={64}
          disabled={loading}
          visibilityToggle
        />
        <Button type="primary" size="large" loading={saving} onClick={save}>
          保存
        </Button>
      </Space.Compact>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
        默认口令为 DUFL1964；修改后请同步通知需要登录管理端的老师
      </Typography.Paragraph>
    </Card>}
    </Space>
  );
}

function Users() {
  const { message } = App.useApp();
  const { user: me } = useAuth();
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [role, setRole] = useState<string>();
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(() => {
    setLoading(true);
    fetchUsers({ page, pageSize: 20, role, keyword: keyword || undefined })
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e) => message.error(errMsg(e)))
      .finally(() => setLoading(false));
  }, [page, role, keyword, message]);
  useEffect(load, [load]);

  return (
    <Card
      size="small"
      title={`用户（${total}）`}
      extra={
        <Space>
          <Button size="small" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建账号
          </Button>
          <Popconfirm
            title="批量重置密码"
            description={`将所选 ${sel.length} 个学生账号密码重置为初始规则密码（学号后6位），并要求下次登录改密。`}
            disabled={!sel.length}
            onConfirm={async () => {
              try {
                const r = await resetPwdBatch(sel);
                message.success(`已重置 ${r.count} 个账号`);
                load();
              } catch (e) {
                message.error(errMsg(e));
              }
            }}
          >
            <Button size="small" danger icon={<KeyOutlined />} disabled={!sel.length}>
              重置所选密码（{sel.length}）
            </Button>
          </Popconfirm>
        </Space>
      }
    >
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          placeholder="角色"
          allowClear
          style={{ width: 150 }}
          value={role}
          onChange={(v) => {
            setRole(v);
            setPage(1);
          }}
          options={Object.entries(ROLE_TEXT).map(([v, l]) => ({ value: v, label: l }))}
        />
        <Input.Search
          placeholder="账号 / 姓名"
          allowClear
          style={{ width: 200 }}
          onSearch={(v) => {
            setKeyword(v);
            setPage(1);
          }}
        />
        <Button icon={<ReloadOutlined />} onClick={load} />
      </Space>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={items}
        rowSelection={{ selectedRowKeys: sel, onChange: (keys) => setSel(keys as string[]), getCheckboxProps: (r) => ({ disabled: r.role !== 'STUDENT' }) }}
        pagination={{ current: page, pageSize: 20, total, onChange: setPage, showSizeChanger: false, size: 'default' }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '账号', dataIndex: 'username', width: 130 },
          { title: '姓名', dataIndex: 'name', width: 110 },
          {
            title: '角色',
            dataIndex: 'role',
            width: 150,
            render: (r, row: any) => (
              <Select
                size="small"
                value={r}
                style={{ width: 120 }}
                disabled={row.id === me?.id}
                onChange={async (v) => {
                  try {
                    await updateUser(row.id, { role: v });
                    message.success('角色已变更');
                    load();
                  } catch (e) {
                    message.error(errMsg(e));
                  }
                }}
                options={Object.entries(ROLE_TEXT).map(([v, l]) => ({ value: v, label: l }))}
              />
            ),
          },
          { title: '负责班级', dataIndex: 'classLeaderOf', width: 160, ellipsis: true, render: (c) => (c ? <Tag color="blue">{c.name}</Tag> : '-') },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (s, row: any) => (
              <Switch
                size="small"
                checked={s === 'ACTIVE'}
                disabled={row.id === me?.id}
                onChange={async (v) => {
                  try {
                    await updateUser(row.id, { status: v ? 'ACTIVE' : 'DISABLED' });
                    message.success(v ? '已启用' : '已停用');
                    load();
                  } catch (e) {
                    message.error(errMsg(e));
                  }
                }}
              />
            ),
          },
          { title: '待改密', dataIndex: 'mustChangePwd', width: 80, render: (v) => (v ? <Tag color="orange">是</Tag> : '-') },
          { title: '创建', dataIndex: 'createdAt', width: 150, render: fmtTime },
        ]}
      />

      <Modal
        title="新建账号"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={async () => {
          const v = await form.validateFields().catch(() => null);
          if (!v) return;
          try {
            await createUser(v);
            message.success(`账号 ${v.username} 已创建（初始密码：${v.password ?? '系统随机，要求首登改密'}）`);
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
          <Space size="middle" wrap>
            <Form.Item name="username" label="账号" rules={[{ required: true }]}>
              <Input style={{ width: 180 }} />
            </Form.Item>
            <Form.Item name="name" label="姓名" rules={[{ required: true }]}>
              <Input style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="role" label="角色" rules={[{ required: true }]} initialValue="GRADE_ADMIN">
              <Select style={{ width: 150 }} options={Object.entries(ROLE_TEXT).filter(([v]) => v !== 'STUDENT').map(([v, l]) => ({ value: v, label: l }))} />
            </Form.Item>
          </Space>
          <Form.Item name="grade" label="负责年级（管理员）">
            <Input style={{ width: 180 }} placeholder="如 2025" />
          </Form.Item>
          <Form.Item name="password" label="初始密码（留空则随机生成）">
            <Input.Password style={{ width: 260 }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

function Audit() {
  const { message } = App.useApp();
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchAuditLogs({ page, pageSize: 30, action })
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e) => message.error(errMsg(e)))
      .finally(() => setLoading(false));
  }, [page, action, message]);
  useEffect(load, [load]);

  return (
    <Card size="small" title={`审计日志（${total} 条 · 只追加不可篡改）`}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          placeholder="动作"
          allowClear
          showSearch
          style={{ width: 220 }}
          value={action}
          onChange={(v) => {
            setAction(v);
            setPage(1);
          }}
          options={Object.entries(AUDIT_ACTION).map(([v, l]) => ({ value: v, label: `${l}（${v}）` }))}
        />
        <Button icon={<ReloadOutlined />} onClick={load} />
      </Space>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{ current: page, pageSize: 30, total, onChange: setPage, showSizeChanger: false, size: 'default' }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '时间', dataIndex: 'createdAt', width: 150, render: fmtTime },
          { title: '动作', dataIndex: 'action', width: 170, render: (a) => <Tag>{AUDIT_ACTION[a] ?? a}</Tag> },
          { title: '资源', dataIndex: 'resourceType', width: 110 },
          { title: '资源ID', dataIndex: 'resourceId', width: 110, ellipsis: true, render: (v) => (v ? <Typography.Text code style={{ fontSize: 11 }}>{v.slice(0, 8)}…</Typography.Text> : '-') },
          {
            title: '详情',
            dataIndex: 'detail',
            ellipsis: true,
            render: (d) =>
              d ? (
                <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: JSON.stringify(d) }}>
                  {JSON.stringify(d)}
                </Typography.Text>
              ) : (
                '-'
              ),
          },
          { title: 'IP', dataIndex: 'ip', width: 120 },
        ]}
      />
    </Card>
  );
}

function Announcements() {
  const { message } = App.useApp();
  const canManage = useAuth().user?.role === 'SUPER_ADMIN';
  const [rows, setRows] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(() => {
    fetchAnnouncements().then(setRows).catch((e) => message.error(errMsg(e)));
  }, [message]);
  useEffect(load, [load]);
  useEffect(() => {
    fetchBatches().then(setBatches).catch(() => undefined);
  }, []);

  return (
    <Card size="small" title="公告" extra={canManage && <Button size="small" icon={<PlusOutlined />} onClick={() => setOpen(true)}>发布公告</Button>}>
      <Table
        size="small"
        rowKey="id"
        dataSource={rows}
        pagination={{ pageSize: 10, size: 'default' }}
        columns={[
          { title: '标题', dataIndex: 'title', width: 260, render: (v, r: any) => <Space size={4}>{r.pinned && <Tag color="red">置顶</Tag>}{v}</Space> },
          { title: '内容', dataIndex: 'content', ellipsis: true },
          { title: '发布时间', dataIndex: 'createdAt', width: 150, render: fmtTime },
          {
            title: '操作',
            width: 70,
            render: (_, r: any) => canManage && (
              <Popconfirm
                title="删除公告"
                onConfirm={async () => {
                  try {
                    await deleteAnnouncement(r.id);
                    message.success('已删除');
                    load();
                  } catch (e) {
                    message.error(errMsg(e));
                  }
                }}
              >
                <Button type="link" size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />

      <Modal
        title="发布公告"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={async () => {
          const v = await form.validateFields().catch(() => null);
          if (!v) return;
          try {
            await createAnnouncement(v);
            message.success('公告已发布（学生端首页可见）');
            setOpen(false);
            form.resetFields();
            load();
          } catch (e) {
            message.error(errMsg(e));
          }
        }}
        okText="发布"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true }]}>
            <Input.TextArea rows={5} maxLength={2000} showCount />
          </Form.Item>
          <Space size="middle">
            <Form.Item name="batchId" label="关联批次（可选）">
              <Select allowClear style={{ width: 240 }} placeholder="全站公告" options={batches.map((b) => ({ value: b.id, label: b.name }))} />
            </Form.Item>
            <Form.Item name="pinned" label="置顶" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}
