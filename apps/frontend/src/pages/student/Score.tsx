import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, App, Button, Card, Empty, Input, List, Modal, Space, Tag, Typography } from 'antd';
import {
  CrownOutlined,
  ExclamationCircleOutlined,
  FileSearchOutlined,
  FlagOutlined,
  LockOutlined,
  ReadOutlined,
  SafetyCertificateOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { MyScoreBatch, fetchActiveBatch, fetchMyObjections, fetchMyScore, fetchMyScoreBatches, submitObjection } from '../../api';
import { errMsg } from '../../api/client';
import { FlagTag, fmtTime } from '../../components/common';
import ScoreBreakdown from '../../components/ScoreBreakdown';
import TriScale from '../../components/TriScale';
import { CountUp } from '../../components/motion';

const OBJECTION_STATUS: Record<string, { color: string; text: string }> = {
  SUBMITTED: { color: 'processing', text: '待处理' },
  ACCEPTED: { color: 'success', text: '已受理·将更正' },
  REJECTED: { color: 'default', text: '不成立' },
};

/** 三维卡片配置：名称 / 满分 / 主题色 / 图标 / 构成行 */
const DIMS: { key: 'moral' | 'academic' | 'sports'; name: string; max: number; cls: string; icon: ReactNode; rows: (d: any) => [string, any][] }[] = [
  {
    key: 'moral',
    name: '品德行为',
    max: 15,
    cls: 'moral',
    icon: <SafetyCertificateOutlined />,
    rows: (d) => [
      ['基础分', d?.base],
      ['奖扣分合计', d?.bonus],
    ],
  },
  {
    key: 'academic',
    name: '学业表现',
    max: 75,
    cls: 'academic',
    icon: <ReadOutlined />,
    rows: (d) => [
      ['加权成绩', d?.weighted],
      ['全科加分', d?.allPass],
      ['奖项加分', d?.bonus],
      // 列存正幅值，展示为负数（与明细一致，避免读作加分）
      ['不及格扣分', d?.failPenalty != null ? -Math.abs(Number(d.failPenalty)) : null],
    ],
  },
  {
    key: 'sports',
    name: '文体表现',
    max: 10,
    cls: 'sports',
    icon: <TrophyOutlined />,
    rows: (d) => [
      ['基础分', d?.base],
      ['学生干部加分', d?.cadre],
      ['文体活动总分', d?.activityTotal],
    ],
  },
];

const fv = (v: any) => (v != null ? Number(v).toFixed(2) : '-');

/** 2025-2026-1 → 2025-2026 第一学期 */
const semesterLabel = (k: string) => {
  const m = /^(\d{4})-(\d{4})-([12])$/.exec(k);
  return m ? `${m[1]}-${m[2]} ${m[3] === '1' ? '第一' : '第二'}学期` : k;
};

/** 学生查分：成绩单头部 + 三维面板 + 可解释明细 + 公示期内提异议 */
export default function MyScore() {
  const { message } = App.useApp();
  const [score, setScore] = useState<any>(null);
  const [objections, setObjections] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 历次成绩：本人有已发布成绩的全部批次；选中批次的成绩按批次缓存，来回切换不重复请求
  const [batches, setBatches] = useState<MyScoreBatch[]>([]);
  const [batchId, setBatchId] = useState<string>('');
  const [loadingScore, setLoadingScore] = useState(false);
  const cache = useRef(new Map<string, any>());

  const busyRef = useRef(false); // 在途互斥：StrictMode 双挂载只发一轮请求
  useEffect(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    fetchMyScoreBatches()
      .then((list) => {
        setBatches(list);
        if (list.length) setBatchId(list[0].batchId);
        else setErr('成绩尚未发布');
      })
      // 旧后端无该接口时退回「只看最近一次发布」
      .catch(() =>
        fetchMyScore()
          .then((s) => {
            cache.current.set(s.batchId, s);
            setBatchId(s.batchId);
          })
          .catch((e) => setErr(errMsg(e))),
      )
      .finally(() => (busyRef.current = false));
  }, []);

  const loadObjections = useCallback((id: string) => {
    fetchMyObjections(id)
      .then(setObjections)
      .catch(() => setObjections([]));
  }, []);

  useEffect(() => {
    if (!batchId) return;
    loadObjections(batchId);
    const hit = cache.current.get(batchId);
    if (hit) {
      setScore(hit);
      setErr('');
      return;
    }
    let alive = true;
    setScore(null); // 不让上一学期的分数在加载期间冒充当前学期
    setLoadingScore(true);
    fetchMyScore(batchId)
      .then((s) => {
        cache.current.set(batchId, s);
        if (!alive) return;
        setScore(s);
        setErr('');
      })
      .catch((e) => alive && (setScore(null), setErr(errMsg(e))))
      .finally(() => alive && setLoadingScore(false));
    return () => {
      alive = false;
    };
  }, [batchId, loadObjections]);

  const publicityActive = score?.publicityEnd && new Date(score.publicityEnd).getTime() > Date.now();

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* 历次成绩：横向可滑动的学期切换，每项直接显示总分 */}
      {batches.length > 0 && (
        <nav className="zc-sc-batches" aria-label="选择学期">
          {batches.map((b) => (
            <button
              key={b.batchId}
              type="button"
              aria-pressed={b.batchId === batchId}
              className={`zc-sc-batch ${b.batchId === batchId ? 'active' : ''}`}
              onClick={() => setBatchId(b.batchId)}
            >
              <span>{semesterLabel(b.semesterKey)}</span>
              <b className="zc-num">{b.totalScore.toFixed(2)}</b>
            </button>
          ))}
        </nav>
      )}

      {loadingScore && !score && <Card size="small" loading />}

      {err && !score && (
        <Card size="small">
          <Empty description={err} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      )}

      {score && (
        <>
          {/* 成绩单头部（深色）：总分滚动揭示 + 排名 + 三段刻度尺（品德 15 / 学业 75 / 文体 10） */}
          <section className="zc-report-hero" key={score.batchId}>
            <div className="zc-report-top">
              <div className="zc-report-main">
                <div className="zc-report-label">综合素质测评总分</div>
                <div className="zc-report-score zc-num">
                  <CountUp value={Number(score.totalScore ?? 0)} />
                </div>
                <div className="zc-report-who">
                  {score.className} · {score.name}（{score.studentNo}）
                </div>
              </div>
              <div className="zc-report-side">
                <div className="zc-report-ranks">
                  {score.rankHidden ? (
                    <span className="zc-rank-chip muted">
                      <LockOutlined /> 排名不公示
                    </span>
                  ) : (
                    <>
                      <span className="zc-rank-chip gold">
                        <CrownOutlined /> 年级第 {score.rankGrade ?? '-'} 名
                      </span>
                      <span className="zc-rank-chip">班级第 {score.rankClass ?? '-'} 名</span>
                    </>
                  )}
                </div>
                <div className="zc-report-meta">
                  <span className="zc-report-round">
                    第 {score.round} 轮公示 · v{score.calcVersion}
                  </span>
                  <span className={`zc-publicity-left ${publicityActive ? 'active' : ''}`}>
                    {publicityActive ? <ExclamationCircleOutlined /> : <LockOutlined />} 公示期至 {fmtTime(score.publicityEnd)}
                  </span>
                </div>
              </div>
            </div>
            <TriScale
              tone="ink"
              className="zc-report-scale"
              values={{ moral: score.moral?.total, academic: score.academic?.total, sports: score.sports?.total }}
            />
          </section>

          {/* 三维面板：图标砖 + 得分 + 满分进度条 + 构成行 */}
          <div className="zc-dim2-grid">
            {DIMS.map((D) => {
              const d = score[D.key];
              const total = d?.total;
              return (
                <section key={D.key} className={`zc-dim2 ${D.cls}`}>
                  <div className="zc-dim2-head">
                    <span className="zc-dim2-ico">{D.icon}</span>
                    <span className="zc-dim2-name">{D.name}</span>
                    <span className="zc-dim2-score zc-num">
                      {fv(total)}
                      <i>/ {D.max}</i>
                    </span>
                  </div>
                  <div>
                    {D.rows(d).map(([name, v]) => (
                      <div key={name} className="zc-dim2-row">
                        <span>{name}</span>
                        <b className={`zc-num ${Number(v) < 0 ? 'neg' : ''}`}>{fv(v)}</b>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          {!!score.flags?.length && (
            <Alert
              type="warning"
              showIcon
              message="标记提示"
              description={<Space wrap>{score.flags.map((f: string) => <FlagTag key={f} flag={f} />)}</Space>}
            />
          )}

          <Card
            size="small"
            className="zc-list-card"
            title={
              <span className="zc-card-title">
                <FileSearchOutlined className="zc-card-ticon" /> 计算明细（可解释）
              </span>
            }
          >
            <ScoreBreakdown flat breakdown={score.breakdown} courseSummary={score.courseSummary} />
          </Card>
        </>
      )}

      <Card
        size="small"
        className="zc-list-card"
        title={
          <span className="zc-card-title">
            <FlagOutlined className="zc-card-ticon" /> 成绩异议
          </span>
        }
        extra={
          publicityActive && (
            <Button type="primary" size="small" onClick={() => setModalOpen(true)}>
              提交异议
            </Button>
          )
        }
      >
        {!publicityActive && (
          <Typography.Text type="secondary">
            异议仅可在公示期内提交（本轮公示{score?.publicityEnd ? `至 ${fmtTime(score.publicityEnd)}` : '已结束'}）
          </Typography.Text>
        )}
        {publicityActive && objections.length === 0 && (
          <Empty description="暂无异议记录，如对成绩有疑问可提交异议" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
        {objections.length > 0 && (
          <List
            size="small"
            style={{ marginTop: publicityActive ? 0 : 12 }}
            dataSource={objections}
            renderItem={(o) => (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Space size={6}>
                      <Tag color={OBJECTION_STATUS[o.status]?.color}>{OBJECTION_STATUS[o.status]?.text ?? o.status}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtTime(o.createdAt)}</Typography.Text>
                    </Space>
                  }
                  description={
                    <>
                      <div>{o.content}</div>
                      {o.handleNote && <Typography.Text type="secondary">处理意见：{o.handleNote}</Typography.Text>}
                    </>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      <Modal
        title="提交成绩异议"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={async () => {
          if (content.trim().length < 10) {
            message.warning('异议说明至少 10 个字');
            return;
          }
          setSubmitting(true);
          try {
            const batch = await fetchActiveBatch().catch(() => null);
            await submitObjection({ batchId: score?.batchId ?? batch?.id, content: content.trim() });
            message.success('异议已提交，等待管理员处理');
            setModalOpen(false);
            setContent('');
            loadObjections(score.batchId);
          } catch (e) {
            message.error(errMsg(e));
          } finally {
            setSubmitting(false);
          }
        }}
        confirmLoading={submitting}
        okText="提交"
      >
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="请具体说明异议项（如：某课程成绩、某加分项分值），处理结果将通过通知告知"
        />
        <Input.TextArea rows={5} value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} showCount placeholder="至少 10 个字，最多 2000 字" />
      </Modal>
    </Space>
  );
}
