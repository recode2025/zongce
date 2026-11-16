import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Badge, Button, Card, DatePicker, Empty, Input, InputNumber, Modal, Segmented, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import {
  CalculatorOutlined,
  CheckCircleFilled,
  ClockCircleFilled,
  CloudUploadOutlined,
  ExclamationCircleFilled,
  ReloadOutlined,
  RiseOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { BATCH_STATUS_LABEL, BatchStatus } from '@zc/shared';
import { Batch, fetchBatches, fetchObjections, fetchRounds, handleObjection, incrementalPublish, releasePublish } from '../../api';
import { errMsg } from '../../api/client';
import { BatchSelect, BatchStatusTag, fmtTime } from '../../components/common';
import { useAuth } from '../../store/auth';

const OBJ_STATUS: Record<string, { color: string; text: string }> = {
  SUBMITTED: { color: 'warning', text: '待处理' },
  ACCEPTED: { color: 'success', text: '已受理' },
  REJECTED: { color: 'default', text: '不成立' },
};
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
/** 公示截止默认落在当天 17:00（下班前），比「当前时刻 + N×24h」更符合公告习惯 */
const endAfterDays = (n: number) => dayjs().add(n, 'day').hour(17).minute(0).second(0).millisecond(0);
const fmtEnd = (d: Dayjs) => `${d.format('M月D日')} 周${WEEKDAY[d.day()]} ${d.format('HH:mm')}`;

/** 发布与公示：页首「批次 + 发布状态」；下分 发布（设置 / 更正闭环 / 轮次）与 异议 */
export default function Publish() {
  const { message } = App.useApp();
  const canPublish = useAuth().user?.role === 'SUPER_ADMIN';
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState('');
  const [tab, setTab] = useState(canPublish ? 'release' : 'objections');
  const [rounds, setRounds] = useState<any[]>([]);
  const [objections, setObjections] = useState<any[]>([]);

  // 批次状态必须是最新的（刚在计算引擎算完分就过来发布），不用全局缓存
  const loadBatches = useCallback(() => {
    fetchBatches()
      .then((list) => {
        setBatches(list);
        setBatchId((cur) => cur || (list.find((b) => b.status !== 'ARCHIVED') ?? list[0])?.id || '');
      })
      .catch((e) => message.error(errMsg(e)));
  }, [message]);
  useEffect(loadBatches, [loadBatches]);

  const loadRounds = useCallback(() => {
    if (!batchId || !canPublish) return;
    fetchRounds(batchId)
      .then(setRounds)
      .catch((e) => message.error(errMsg(e)));
  }, [batchId, message, canPublish]);
  const loadObjections = useCallback(() => {
    if (!batchId) return;
    // 一次取全部状态，前端分段筛选：各段计数一目了然，切换不再请求
    fetchObjections(batchId)
      .then(setObjections)
      .catch((e) => message.error(errMsg(e)));
  }, [batchId, message]);
  useEffect(() => {
    loadRounds();
    loadObjections();
  }, [loadRounds, loadObjections]);

  const refreshAll = () => {
    loadBatches();
    loadRounds();
    loadObjections();
  };

  const batch = batches.find((b) => b.id === batchId);
  const active = rounds.find((r) => r.status === 'ACTIVE');
  const pendingObj = objections.filter((o) => o.status === 'SUBMITTED').length;
  const acceptedObj = objections.filter((o) => o.status === 'ACCEPTED').length;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <section className="zc-gr-head">
        <div className="zc-gr-batch">
          <span className="zc-gr-label">批次</span>
          <BatchSelect value={batchId || undefined} onChange={setBatchId} style={{ minWidth: 280 }} />
        </div>
        {batch && canPublish && <PublishStatus batch={batch} active={active} pendingObj={pendingObj} onObjections={() => setTab('objections')} />}
      </section>

      {batchId && batch ? (
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            ...(canPublish ? [{
              key: 'release',
              label: '发布',
              children: (
                <ReleaseTab batch={batch} rounds={rounds} active={active} acceptedObj={acceptedObj} onChanged={refreshAll} onObjections={() => setTab('objections')} />
              ),
            }] : []),
            {
              key: 'objections',
              label: (
                <span className="zc-gr-tab">
                  异议
                  {pendingObj > 0 && <Badge count={pendingObj} size="small" />}
                </span>
              ),
              children: <ObjectionTab rows={objections} onChanged={loadObjections} canPublish={canPublish} />,
            },
          ]}
        />
      ) : (
        <Card size="small">
          <Empty description="暂无批次，请先到「批次管理」创建" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      )}
    </Space>
  );
}

// ===================================================================== 页首：发布状态

function PublishStatus({ batch, active, pendingObj, onObjections }: { batch: Batch; active?: any; pendingObj: number; onObjections: () => void }) {
  const nav = useNavigate();
  const canRelease = [BatchStatus.CALCULATED, BatchStatus.PUBLICITY].includes(batch.status as BatchStatus);

  if (active) {
    const end = dayjs(active.publicityEnd);
    const leftH = end.diff(dayjs(), 'hour');
    const ongoing = leftH > 0;
    return (
      <div className={`zc-gr-gate ${ongoing ? 'info' : 'pass'}`}>
        {ongoing ? <ClockCircleFilled /> : <CheckCircleFilled />}
        <div className="zc-gr-gate-text">
          <b>
            第 {active.round} 轮{ongoing ? `公示中 · 还剩 ${leftH >= 24 ? `${Math.floor(leftH / 24)} 天` : `${leftH} 小时`}` : '公示期已结束'}
          </b>
          <span>
            截止 {fmtEnd(end)} · v{active.calcVersion} · {active.stats?.students ?? '-'} 人 · 均分 {active.stats?.avg ?? '-'}
          </span>
        </div>
        {pendingObj > 0 && (
          <Button type="primary" onClick={onObjections}>
            处理异议（{pendingObj}）
          </Button>
        )}
      </div>
    );
  }
  if (batch.status === BatchStatus.ARCHIVED) {
    return (
      <div className="zc-gr-gate pass">
        <CheckCircleFilled />
        <div className="zc-gr-gate-text">
          <b>批次已归档</b>
          <span>归档后不能再发布或更正成绩</span>
        </div>
      </div>
    );
  }
  if (canRelease) {
    return (
      <div className="zc-gr-gate info">
        <CloudUploadOutlined />
        <div className="zc-gr-gate-text">
          <b>已完成计算，尚未发布</b>
          <span>发布后学生端可查分，并进入公示期</span>
        </div>
      </div>
    );
  }
  return (
    <div className="zc-gr-gate block">
      <ExclamationCircleFilled />
      <div className="zc-gr-gate-text">
        <b>暂不能发布</b>
        <span>
          批次处于「{BATCH_STATUS_LABEL[batch.status as BatchStatus] ?? batch.status}」，完成计算后才能发布
        </span>
      </div>
      <Button icon={<CalculatorOutlined />} onClick={() => nav('/admin/calc')}>
        去计算引擎
      </Button>
    </div>
  );
}

// ===================================================================== 发布

function ReleaseTab({
  batch,
  rounds,
  active,
  acceptedObj,
  onChanged,
  onObjections,
}: {
  batch: Batch;
  rounds: any[];
  active?: any;
  acceptedObj: number;
  onChanged: () => void;
  onObjections: () => void;
}) {
  const { message, modal } = App.useApp();
  const nav = useNavigate();
  const [days, setDays] = useState<number | 'custom'>(3);
  const [endAt, setEndAt] = useState<Dayjs>(() => endAfterDays(3));
  const [hideTop, setHideTop] = useState(() => !batch.historicalImport);
  const [hideN, setHideN] = useState(30);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setHideTop(!batch.historicalImport);
  }, [batch.id, batch.historicalImport]);

  const canRelease = [BatchStatus.CALCULATED, BatchStatus.PUBLICITY].includes(batch.status as BatchStatus);
  const archived = batch.status === BatchStatus.ARCHIVED;
  const isFirstRound = rounds.length === 0;
  const weekend = endAt.day() === 0 || endAt.day() === 6;
  const tooSoon = endAt.isBefore(dayjs().add(1, 'hour'));

  const pickDays = (v: number | 'custom') => {
    setDays(v);
    if (v !== 'custom') setEndAt(endAfterDays(v));
  };

  const doRelease = () =>
    modal.confirm({
      title: isFirstRound ? '发布综测成绩' : `发布第 ${rounds.length + 1} 轮公示（整批重发）`,
      width: 480,
      content: (
        <ul className="zc-pb-confirm">
          <li>当前计算结果对学生可见，学生会收到公示通知</li>
          <li>公示截止：{fmtEnd(endAt)}</li>
          {isFirstRound && hideTop && <li>年级前 {hideN} 名本轮不显示排名（总分照常显示，第二轮起恢复）</li>}
          {!isFirstRound && <li>上一轮公示自动结束，排名恢复正常显示</li>}
        </ul>
      ),
      okText: '发布',
      onOk: async () => {
        setLoading(true);
        try {
          const r = await releasePublish({ batchId: batch.id, publicityEnd: endAt.toISOString(), hideTopRank: isFirstRound && hideTop ? hideN : 0 });
          message.success(`已发布第 ${r.round} 轮：${r.students} 人，公示至 ${fmtTime(r.publicityEnd)}`);
          onChanged();
        } catch (e) {
          message.error(errMsg(e));
        } finally {
          setLoading(false);
        }
      },
    });

  const doIncremental = () =>
    modal.confirm({
      title: '增量发布更正后的成绩',
      content: '系统会找出最新计算结果与已发布成绩不一致的学生，只更新这些学生的成绩；没有变化时什么也不做。',
      okText: '增量发布',
      onOk: async () => {
        setLoading(true);
        try {
          const r = await incrementalPublish(batch.id);
          if (r.refreshed > 0) message.success(`已更新 ${r.refreshed} 名学生的成绩`);
          else message.info('没有成绩变化的学生，无需更新');
          onChanged();
        } catch (e) {
          message.error(errMsg(e));
        } finally {
          setLoading(false);
        }
      },
    });

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <div className="zc-pb-grid">
        {/* 发布设置 */}
        <Card size="small" title={isFirstRound ? '发布成绩' : `第 ${rounds.length + 1} 轮公示`} extra={<BatchStatusTag status={batch.status} />}>
          <div className="zc-pb-field">
            <span className="zc-pb-k">公示截止</span>
            <div className="zc-pb-v">
              <Segmented
                value={days}
                onChange={(v) => pickDays(v as number | 'custom')}
                options={[
                  { value: 3, label: '3 天' },
                  { value: 5, label: '5 天' },
                  { value: 7, label: '7 天' },
                  { value: 'custom', label: '自定义' },
                ]}
              />
              {days === 'custom' && (
                <DatePicker
                  showTime={{ format: 'HH:mm' }}
                  format="YYYY-MM-DD HH:mm"
                  value={endAt}
                  allowClear={false}
                  disabledDate={(d) => d.isBefore(dayjs().startOf('day'))}
                  onChange={(d) => d && setEndAt(d)}
                />
              )}
              <div className={`zc-pb-end ${weekend || tooSoon ? 'warn' : ''}`}>
                截止于 <b>{fmtEnd(endAt)}</b>
                {tooSoon ? '，距现在不足 1 小时' : weekend ? '，落在周末，可考虑顺延到工作日' : ''}
              </div>
            </div>
          </div>

          {isFirstRound && (
            <div className="zc-pb-field">
              <span className="zc-pb-k">排名显示</span>
              <div className="zc-pb-v">
                <Space wrap>
                  <Switch checked={hideTop} onChange={setHideTop} />
                  <span>第一轮隐藏年级前</span>
                  <InputNumber min={1} max={200} value={hideN} onChange={(v) => setHideN(v ?? 30)} disabled={!hideTop} style={{ width: 80 }} />
                  <span>名的排名</span>
                </Space>
                <span className="zc-pb-hint">{batch.historicalImport ? '历史批次默认显示原年级排名，可按需手动隐藏。' : '只影响学生端本轮显示，总分照常可见；第二轮起自动恢复'}</span>
              </div>
            </div>
          )}

          <div className="zc-pb-actions">
            <Button type="primary" size="large" icon={<CloudUploadOutlined />} loading={loading} disabled={!canRelease || tooSoon} onClick={doRelease}>
              {isFirstRound ? '发布成绩' : '整批重新发布'}
            </Button>
            {archived ? (
              <span className="zc-pb-hint">批次已归档，不能再发布</span>
            ) : (
              !canRelease && (
                <Button size="large" icon={<CalculatorOutlined />} onClick={() => nav('/admin/calc')}>
                  去计算引擎
                </Button>
              )
            )}
          </div>
        </Card>

        {/* 异议更正闭环 */}
        <Card size="small" title="异议更正" extra={<Button type="text" size="small" icon={<ReloadOutlined />} onClick={onChanged} aria-label="刷新" />}>
          {active ? (
            <ol className="zc-pb-steps">
              <li className={acceptedObj > 0 ? 'done' : ''}>
                <b>受理异议</b>
                <span>
                  已受理 {acceptedObj} 条。<a onClick={onObjections}>去处理异议</a>
                </span>
              </li>
              <li>
                <b>更正数据并重新计算</b>
                <span>
                  修改对应的申请或成绩后，<a onClick={() => nav('/admin/calc')}>到计算引擎重算</a>
                </span>
              </li>
              <li>
                <b>增量发布</b>
                <span>只更新成绩有变化的学生，不影响其他人和公示轮次</span>
                <Button icon={<RiseOutlined />} loading={loading} disabled={archived} onClick={doIncremental} style={{ marginTop: 8 }}>
                  增量发布
                </Button>
              </li>
            </ol>
          ) : (
            <Empty description="发布后，在这里完成异议更正" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>
      </div>

      <Card size="small" title="公示轮次">
        <Table
          size="small"
          rowKey="id"
          dataSource={rounds}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: <Empty description="还没有发布过" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          columns={[
            { title: '轮次', dataIndex: 'round', width: 80, render: (r) => `第 ${r} 轮` },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (s, r: any) =>
                s === 'ACTIVE' ? (
                  dayjs(r.publicityEnd).isAfter(dayjs()) ? <Tag color="processing">公示中</Tag> : <Tag color="warning">公示期已过</Tag>
                ) : (
                  <Tag>已结束</Tag>
                ),
            },
            { title: '计算版本', dataIndex: 'calcVersion', width: 90, render: (v) => <span className="zc-num">v{v}</span> },
            { title: '发布时间', dataIndex: 'publishedAt', width: 150, render: fmtTime },
            { title: '公示截止', dataIndex: 'publicityEnd', width: 150, render: fmtTime },
            {
              title: '人数 / 均分',
              width: 120,
              render: (_, r: any) => (r.stats ? <span className="zc-num">{r.stats.students} · {r.stats.avg}</span> : '-'),
            },
            {
              title: '隐藏排名',
              width: 100,
              render: (_, r: any) => (Number(r.stats?.hideTopRank) > 0 ? `前 ${r.stats.hideTopRank} 名` : '否'),
            },
            { title: '异议', dataIndex: 'objections', width: 70, align: 'right', render: (n) => <span className="zc-num">{n}</span> },
          ]}
        />
      </Card>
    </Space>
  );
}

// ===================================================================== 异议

function ObjectionTab({ rows, onChanged, canPublish }: { rows: any[]; onChanged: () => void; canPublish: boolean }) {
  const { message } = App.useApp();
  const [status, setStatus] = useState<string>('SUBMITTED');
  const [handling, setHandling] = useState<any>(null);
  const [result, setResult] = useState<'ACCEPTED' | 'REJECTED' | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const counts = useMemo(() => {
    const c: Record<string, number> = { SUBMITTED: 0, ACCEPTED: 0, REJECTED: 0 };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);
  const list = status === 'ALL' ? rows : rows.filter((r) => r.status === status);

  const open = (r: any) => {
    setHandling(r);
    setResult(null);
    setNote('');
  };
  const noteRequired = result === 'REJECTED';
  const submit = async () => {
    if (!handling || !result) return;
    if (noteRequired && !note.trim()) {
      message.warning('请写明不成立的理由，学生会收到这段说明');
      return;
    }
    setSaving(true);
    try {
      await handleObjection(handling.id, { status: result, note: note.trim() || undefined });
      message.success(result === 'ACCEPTED' ? (canPublish ? '已受理。更正数据并重算后，回到「发布」做增量发布' : '已受理。请联系超级管理员重算并增量发布') : '已回复学生：异议不成立');
      setHandling(null);
      onChanged();
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Segmented
        className="zc-pb-status-filter"
        aria-label="异议状态筛选"
        value={status}
        onChange={(v) => setStatus(v as string)}
        options={[
          { value: 'SUBMITTED', label: <>待处理 <span className="zc-pb-status-count">{counts.SUBMITTED}</span></> },
          { value: 'ACCEPTED', label: <>已受理 <span className="zc-pb-status-count">{counts.ACCEPTED}</span></> },
          { value: 'REJECTED', label: <>不成立 <span className="zc-pb-status-count">{counts.REJECTED}</span></> },
          { value: 'ALL', label: <>全部 <span className="zc-pb-status-count">{rows.length}</span></> },
        ]}
      />

      {list.length ? (
        <div className="zc-pb-objs">
          {list.map((r) => {
            const st = OBJ_STATUS[r.status] ?? { color: 'default', text: r.status };
            return (
              <article key={r.id} className={`zc-pb-obj ${r.status === 'SUBMITTED' ? 'pending' : ''}`}>
                <header>
                  <div className="zc-gr-cell2">
                    <b>{r.student?.name}</b>
                    <span>
                      {r.student?.studentNo} · {r.student?.className}
                    </span>
                  </div>
                  <Tag color={st.color}>{st.text}</Tag>
                </header>
                <Typography.Paragraph className="zc-pb-obj-body" ellipsis={{ rows: 4, expandable: true, symbol: '展开' }}>
                  {r.content}
                </Typography.Paragraph>
                {r.handleNote && (
                  <div className="zc-pb-obj-reply">
                    <span>处理说明</span>
                    {r.handleNote}
                  </div>
                )}
                <footer>
                  <span>
                    提交于 {fmtTime(r.createdAt)}
                    {r.handledAt ? ` · 处理于 ${fmtTime(r.handledAt)}` : ''}
                  </span>
                  {r.status === 'SUBMITTED' && (
                    <Button type="primary" size="small" onClick={() => open(r)}>
                      处理
                    </Button>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <Card size="small">
          <Empty description={status === 'SUBMITTED' ? '没有待处理的异议' : '没有记录'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      )}

      <Modal
        title={`处理异议 · ${handling?.student?.name ?? ''}`}
        open={!!handling}
        onCancel={() => setHandling(null)}
        onOk={submit}
        okText={result === 'REJECTED' ? '回复不成立' : '受理'}
        okButtonProps={{ disabled: !result, loading: saving }}
        width="min(92vw, 560px)"
      >
        {handling && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div className="zc-pb-obj-quote">{handling.content}</div>
            <div className="zc-pb-choices" role="radiogroup" aria-label="处理结果">
              <button type="button" role="radio" aria-checked={result === 'ACCEPTED'} className={`zc-pb-choice ok ${result === 'ACCEPTED' ? 'active' : ''}`} onClick={() => setResult('ACCEPTED')}>
                <b>成立</b>
                <span>{canPublish ? '需要更正。之后重算并增量发布，学生会收到受理通知' : '需要更正。请联系超级管理员重算并增量发布'}</span>
              </button>
              <button type="button" role="radio" aria-checked={result === 'REJECTED'} className={`zc-pb-choice no ${result === 'REJECTED' ? 'active' : ''}`} onClick={() => setResult('REJECTED')}>
                <b>不成立</b>
                <span>维持原成绩，学生会收到你写的理由</span>
              </button>
            </div>
            <Input.TextArea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={noteRequired ? '写明不成立的理由（必填，会发送给学生）' : '处理说明（选填，会发送给学生）'}
              maxLength={1000}
              showCount
              status={noteRequired && !note.trim() ? 'warning' : undefined}
            />
          </Space>
        )}
      </Modal>
    </Space>
  );
}
