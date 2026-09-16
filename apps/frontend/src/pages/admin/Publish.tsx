import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Input, InputNumber, Modal, Radio, Space, Table, Tabs, Tag, Typography } from 'antd';
import { CloudUploadOutlined, ReloadOutlined, RiseOutlined } from '@ant-design/icons';
import { fetchObjections, fetchRounds, handleObjection, incrementalPublish, releasePublish } from '../../api';
import { errMsg } from '../../api/client';
import { BatchSelect, fmtTime } from '../../components/common';

const ROUND_STATUS: Record<string, { color: string; text: string }> = {
  ACTIVE: { color: 'processing', text: '公示中' },
  CLOSED: { color: 'default', text: '已结束' },
};
const OBJ_STATUS: Record<string, { color: string; text: string }> = {
  SUBMITTED: { color: 'warning', text: '待处理' },
  ACCEPTED: { color: 'success', text: '成立·待更正' },
  REJECTED: { color: 'default', text: '不成立' },
};

/** 发布与公示：发布 / 轮次 / 异议看板 / 增量发布（异议更正闭环） */
export default function Publish() {
  const [batchId, setBatchId] = useState('');
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <BatchSelect value={batchId} onChange={setBatchId} />
          {!batchId && <Typography.Text type="warning">请选择批次</Typography.Text>}
        </Space>
      </Card>
      {batchId && (
        <Tabs
          items={[
            { key: 'release', label: '发布 / 公示轮次', children: <ReleaseTab batchId={batchId} /> },
            { key: 'objections', label: '异议看板', children: <ObjectionTab batchId={batchId} /> },
          ]}
        />
      )}
    </Space>
  );
}

function ReleaseTab({ batchId }: { batchId: string }) {
  const { message, modal } = App.useApp();
  const [rounds, setRounds] = useState<any[]>([]);
  const [days, setDays] = useState(3);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    fetchRounds(batchId).then(setRounds).catch((e) => message.error(errMsg(e)));
  }, [batchId, message]);
  useEffect(load, [load]);

  const active = rounds.find((r) => r.status === 'ACTIVE');

  const doRelease = () =>
    modal.confirm({
      title: '发布综测成绩',
      content: (
        <div>
          <p>当前候选版本将晋升为 PUBLISHED，成绩快照写入缓存（学生端可查），并开启公示期 {days} 天（自然日，可按工作日修正后再发布）。</p>
          <p>已发布过时本轮为「二次公示」，旧轮次自动关闭。</p>
        </div>
      ),
      onOk: async () => {
        setLoading(true);
        try {
          const r = await releasePublish({ batchId, publicityDays: days });
          message.success(`已发布：第 ${r.round} 轮 · v${r.version} · ${r.students} 人 · 公示至 ${fmtTime(r.publicityEnd)}`);
          load();
        } catch (e) {
          message.error(errMsg(e));
        } finally {
          setLoading(false);
        }
      },
    });

  const doIncremental = () =>
    modal.confirm({
      title: '增量发布（异议更正后）',
      content: '自动检测最新计算版与已发布版不一致的学生，逐生晋升并精准刷新其成绩快照；无变动时不做任何操作。流程：异议受理 → 更正数据/申请 → 重算 → 点此增量发布。',
      onOk: async () => {
        setLoading(true);
        try {
          const r = await incrementalPublish(batchId);
          if (r.refreshed > 0) message.success(`已增量发布 ${r.refreshed} 人：${(r.students ?? []).join('、')}`);
          else message.info(r.note ?? '无变动学生，快照未变更');
        } catch (e) {
          message.error(errMsg(e));
        } finally {
          setLoading(false);
        }
      },
    });

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="发布操作">
        <Space wrap>
          <InputNumber min={1} max={30} value={days} onChange={(v) => setDays(v ?? 3)} addonBefore="公示期" addonAfter="天" />
          <Button type="primary" icon={<CloudUploadOutlined />} loading={loading} onClick={doRelease}>
            {active ? '二次公示（整批重发）' : '发布成绩'}
          </Button>
          <Button icon={<RiseOutlined />} disabled={!active} loading={loading} onClick={doIncremental}>
            增量发布（更正学生）
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load} />
        </Space>
        {active && (
          <Alert
            style={{ marginTop: 12 }}
            type={new Date(active.publicityEnd).getTime() > Date.now() ? 'success' : 'warning'}
            showIcon
            message={`第 ${active.round} 轮公示进行中 · v${active.calcVersion} · 公示期至 ${fmtTime(active.publicityEnd)} · 异议 ${active.objections} 条`}
          />
        )}
      </Card>

      <Card size="small" title="公示轮次">
        <Table
          size="small"
          rowKey="id"
          dataSource={rounds}
          pagination={false}
          columns={[
            { title: '轮次', dataIndex: 'round', width: 70, render: (r) => <Tag color="purple">第 {r} 轮</Tag> },
            { title: '版本', dataIndex: 'calcVersion', width: 70, className: 'zc-num', render: (v) => `v${v}` },
            { title: '发布时间', dataIndex: 'publishedAt', width: 150, render: fmtTime },
            { title: '公示期至', dataIndex: 'publicityEnd', width: 150, render: fmtTime },
            { title: '状态', dataIndex: 'status', width: 90, render: (s) => <Tag color={ROUND_STATUS[s]?.color}>{ROUND_STATUS[s]?.text ?? s}</Tag> },
            {
              title: '统计',
              render: (_, r: any) =>
                r.stats ? (
                  <Typography.Text type="secondary">
                    {r.stats.students} 人 · 均分 {r.stats.avg}
                  </Typography.Text>
                ) : (
                  '-'
                ),
            },
            { title: '异议', dataIndex: 'objections', width: 70, align: 'right', className: 'zc-num' },
          ]}
        />
      </Card>
    </Space>
  );
}

function ObjectionTab({ batchId }: { batchId: string }) {
  const { message } = App.useApp();
  const [status, setStatus] = useState<string>('SUBMITTED');
  const [rows, setRows] = useState<any[]>([]);
  const [handling, setHandling] = useState<any>(null);
  const [result, setResult] = useState<'ACCEPTED' | 'REJECTED'>('ACCEPTED');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchObjections(batchId, status || undefined)
      .then(setRows)
      .catch((e) => message.error(errMsg(e)))
      .finally(() => setLoading(false));
  }, [batchId, status, message]);
  useEffect(load, [load]);

  const pending = rows.filter((r) => r.status === 'SUBMITTED').length;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <Typography.Text>异议状态：</Typography.Text>
          {Object.entries(OBJ_STATUS).map(([s, l]) => (
            <Button key={s} size="small" type={status === s ? 'primary' : 'default'} onClick={() => setStatus(s)}>
              {l.text}
            </Button>
          ))}
          <Button size="small" icon={<ReloadOutlined />} onClick={load} />
        </Space>
      </Card>

      <Card size="small" title={`异议列表（${status === 'SUBMITTED' ? `待处理 ${pending} 条` : `${rows.length} 条`}）`}>
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={{ pageSize: 10, size: 'default' }}
          columns={[
            { title: '学生', width: 150, render: (_, r: any) => `${r.student.name}（${r.student.studentNo}）` },
            { title: '班级', dataIndex: ['student', 'className'], width: 150, ellipsis: true },
            { title: '异议内容', dataIndex: 'content', ellipsis: true },
            { title: '提交时间', dataIndex: 'createdAt', width: 150, render: fmtTime },
            { title: '状态', dataIndex: 'status', width: 120, render: (s) => <Tag color={OBJ_STATUS[s]?.color}>{OBJ_STATUS[s]?.text ?? s}</Tag> },
            {
              title: '操作',
              width: 90,
              render: (_, r: any) =>
                r.status === 'SUBMITTED' ? (
                  <Button type="primary" ghost size="small" onClick={() => { setHandling(r); setResult('ACCEPTED'); setNote(''); }}>
                    处理
                  </Button>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.handleNote || '-'}<br />{fmtTime(r.handledAt)}</Typography.Text>
                ),
            },
          ]}
        />
      </Card>

      <Modal
        title={`处理异议 · ${handling?.student?.name ?? ''}`}
        open={!!handling}
        onCancel={() => setHandling(null)}
        onOk={async () => {
          try {
            await handleObjection(handling.id, { status: result, note: note.trim() || undefined });
            message.success(result === 'ACCEPTED' ? '已受理：请更正数据/申请后重算，再回到「发布」页做增量发布' : '已回复不成立，学生将收到通知');
            setHandling(null);
            load();
          } catch (e) {
            message.error(errMsg(e));
          }
        }}
        okText="提交处理结果"
      >
        {handling && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Typography.Paragraph style={{ marginBottom: 0, background: '#fafafa', padding: 12, borderRadius: 8 }}>
              {handling.content}
            </Typography.Paragraph>
            <Radio.Group value={result} onChange={(e) => setResult(e.target.value)}>
              <Space direction="vertical">
                <Radio value="ACCEPTED">成立（更正后重算并增量发布，学生收到受理通知）</Radio>
                <Radio value="REJECTED">不成立（维持原成绩，学生收到回复）</Radio>
              </Space>
            </Radio.Group>
            <Input.TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="处理说明（将随通知发送给学生）" maxLength={1000} />
          </Space>
        )}
      </Modal>
    </Space>
  );
}
