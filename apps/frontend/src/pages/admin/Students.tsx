import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Input, Modal, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { ReloadOutlined, UserAddOutlined } from '@ant-design/icons';
import { EnrollStatus } from '@zc/shared';
import { ClassInfo, bindClassLeader, fetchClasses, fetchJobs, fetchStudents, patchStudent } from '../../api';
import { errMsg } from '../../api/client';
import ImportWizard from '../../components/ImportWizard';
import { fmtTime } from '../../components/common';

const ENROLL_LABEL: Record<string, string> = {
  NORMAL: '有学籍',
  SUSPENDED: '休学',
  WITHDRAWN: '退学',
  GRADUATED: '毕业',
};
const ENROLL_COLOR: Record<string, string> = { NORMAL: 'success', SUSPENDED: 'warning', WITHDRAWN: 'error', GRADUATED: 'default' };

/** 学生管理：导入向导 / 名册（学籍修正） / 班级与班委绑定 */
export default function Students() {
  const { message } = App.useApp();
  const [tab, setTab] = useState('import');

  return (
    <Tabs
      activeKey={tab}
      onChange={setTab}
      items={[
        { key: 'import', label: '学生导入', children: <ImportTab /> },
        { key: 'roster', label: '学生名册', children: <Roster /> },
        { key: 'classes', label: '班级与班委', children: <Classes message={message} /> },
      ]}
    />
  );
}

function ImportTab() {
  const [jobs, setJobs] = useState<any[]>([]);
  const load = () => fetchJobs({ kind: 'STUDENT' }).then(setJobs).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="导入学生名册（xlsx）">
        <ImportWizard kind="STUDENT" onDone={load} />
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
                    {r.summary.errors ? ` · 错误 ${r.summary.errors}` : ''}
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

function Roster() {
  const { message } = App.useApp();
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [classId, setClassId] = useState<string>();
  const [enroll, setEnroll] = useState<string>();
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchClasses().then(setClasses).catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    fetchStudents({ page, pageSize: 30, keyword: keyword || undefined, classId, enrollStatus: enroll })
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e) => message.error(errMsg(e)))
      .finally(() => setLoading(false));
  }, [page, keyword, classId, enroll, message]);
  useEffect(load, [load]);

  return (
    <Card size="small" title={`学生名册（共 ${total} 人）`}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="学号 / 姓名"
          allowClear
          style={{ width: 200 }}
          onSearch={(v) => {
            setKeyword(v);
            setPage(1);
          }}
        />
        <Select
          placeholder="班级"
          allowClear
          showSearch
          style={{ width: 200 }}
          value={classId}
          onChange={(v) => {
            setClassId(v);
            setPage(1);
          }}
          options={classes.map((c) => ({ value: c.id, label: c.name }))}
        />
        <Select
          placeholder="学籍状态"
          allowClear
          style={{ width: 130 }}
          value={enroll}
          onChange={(v) => {
            setEnroll(v);
            setPage(1);
          }}
          options={Object.entries(ENROLL_LABEL).map(([v, l]) => ({ value: v, label: l }))}
        />
        <Button icon={<ReloadOutlined />} onClick={load}>
          刷新
        </Button>
      </Space>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{ current: page, pageSize: 30, total, onChange: setPage, showSizeChanger: false, size: 'default' }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '学号', dataIndex: 'studentNo', width: 120 },
          { title: '姓名', dataIndex: 'name', width: 90 },
          { title: '班级', dataIndex: 'className', width: 170, ellipsis: true },
          { title: '专业', dataIndex: 'major', width: 160, ellipsis: true },
          {
            title: '学籍状态',
            dataIndex: 'enrollStatus',
            width: 130,
            render: (s, r: any) => (
              <Select
                size="small"
                value={s}
                style={{ width: 100 }}
                onChange={async (v) => {
                  try {
                    await patchStudent(r.id, { enrollStatus: v as EnrollStatus });
                    message.success(`${r.name} 学籍已改为 ${ENROLL_LABEL[v]}（异常队列已同步重建）`);
                    load();
                  } catch (e) {
                    message.error(errMsg(e));
                  }
                }}
                options={Object.entries(ENROLL_LABEL).map(([v, l]) => ({ value: v, label: l }))}
              />
            ),
          },
          {
            title: '账号',
            dataIndex: ['user', 'status'],
            width: 110,
            render: (s, r: any) =>
              r.user ? (
                <Space size={4}>
                  <Tag color={s === 'ACTIVE' ? 'success' : 'error'}>{s === 'ACTIVE' ? '正常' : s}</Tag>
                  {r.user.mustChangePwd && <Tag>未改密</Tag>}
                </Space>
              ) : (
                <Tag>无</Tag>
              ),
          },
        ]}
      />
    </Card>
  );
}

function Classes({ message }: { message: any }) {
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [bindOpen, setBindOpen] = useState<ClassInfo | null>(null);
  const [studentNo, setStudentNo] = useState('');

  const load = () => fetchClasses().then(setClasses).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <Card size="small" title={`班级列表（${classes.length} 个）`} extra={<Button size="small" icon={<ReloadOutlined />} onClick={load} />}>
        <Table
          size="small"
          rowKey="id"
          dataSource={classes}
          pagination={{ pageSize: 10, size: 'default' }}
          columns={[
            { title: '班级', dataIndex: 'name' },
            { title: '年级', dataIndex: 'grade', width: 80 },
            { title: '学生数', dataIndex: 'studentCount', width: 90, align: 'right' },
            {
              title: '班级负责人',
              dataIndex: 'leaderInfo',
              render: (l) => (l ? <Tag color="blue">{l.name}（{l.username}）</Tag> : <Tag color="warning">未绑定</Tag>),
            },
            {
              title: '操作',
              width: 130,
              render: (_, c: any) => (
                <Button size="small" icon={<UserAddOutlined />} onClick={() => setBindOpen(c)}>
                  {c.leaderInfo ? '更换班委' : '绑定班委'}
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title={`绑定班级负责人 · ${bindOpen?.name ?? ''}`}
        open={!!bindOpen}
        onCancel={() => setBindOpen(null)}
        onOk={async () => {
          if (!bindOpen || !studentNo.trim()) return;
          try {
            await bindClassLeader(bindOpen.id, { studentNo: studentNo.trim() });
            message.success('班委已绑定（该学生账号已升级为班级负责人角色）');
            setBindOpen(null);
            setStudentNo('');
            load();
          } catch (e) {
            message.error(errMsg(e));
          }
        }}
        okText="绑定"
      >
        <Typography.Paragraph type="secondary">输入本班学生的学号，该学生账号将升级为「班级负责人」并可登录初审工作台。</Typography.Paragraph>
        <Input placeholder="学号" value={studentNo} onChange={(e) => setStudentNo(e.target.value)} />
      </Modal>
    </>
  );
}
