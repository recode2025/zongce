import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Badge, Button, Empty, Modal, Segmented, Space, Tag, Typography } from 'antd';
import { CheckOutlined, CloudUploadOutlined, LineChartOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { BATCH_STATUS_FLOW, BATCH_STATUS_LABEL, BatchStatus } from '@zc/shared';
import { fetchActiveBatch, fetchAnnouncements, fetchNotifications, markNotificationRead } from '../../api';
import { BatchStatusTag, fmtTime } from '../../components/common';
import { useAuth } from '../../store/auth';

function greet(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '上午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

/** 头部日期行（如「9月21日 · 星期一」） */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const NOW = new Date();
const dateLine = `${NOW.getMonth() + 1}月${NOW.getDate()}日 · 星期${WEEKDAYS[NOW.getDay()]}`;

/** 学生可见的批次阶段（草稿/数据准备是管理端准备期，不对学生展示） */
const STUDENT_STAGES = BATCH_STATUS_FLOW.filter((s) => s !== BatchStatus.DRAFT && s !== BatchStatus.DATA_PREP);

/** 已弹窗告知过的公告 id（localStorage 记忆，仅本机） */
const ANN_SEEN_KEY = 'zc:ann-seen-v1';
const loadSeenIds = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(ANN_SEEN_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
};

/** 学生端首页：问候 + 本学期综测（阶段刻度 + 下一步） + 消息（公告 / 通知） */
export default function StudentHome() {
  const { message } = App.useApp();
  const nav = useNavigate();
  const { user } = useAuth();
  const [batch, setBatch] = useState<any>(null);
  const [announcements, setAnnouncements] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [annPopupQueue, setAnnPopupQueue] = useState<any[]>([]); // 待弹窗的新公告（逐条）
  const [annDetail, setAnnDetail] = useState<any>(null); // 点开查看的公告
  const [msgTab, setMsgTab] = useState<'ann' | 'notice'>('ann');

  const busyRef = useRef(false); // 在途互斥：StrictMode 双挂载只发一轮请求
  const load = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    Promise.allSettled([
      fetchActiveBatch()
        .then((b) => {
          setBatch(b);
          return b ? fetchAnnouncements(b.id) : [];
        })
        .then((list) => {
          setAnnouncements(list);
          // 首次见到的公告排队弹窗提示（按置顶/时间排序的第一条先弹）
          const fresh = (list ?? []).filter((x: any) => !loadSeenIds().has(x.id));
          if (fresh.length) setAnnPopupQueue(fresh);
        }),
      fetchNotifications().then(setNotifications),
    ]).finally(() => (busyRef.current = false));
  }, []);
  useEffect(load, [load]);

  /** 关闭当前弹窗：记录已告知，若队列还有下一条继续弹 */
  const closeAnnPopup = () => {
    const cur = annPopupQueue[0];
    if (cur) {
      try {
        const seen = loadSeenIds();
        seen.add(cur.id);
        localStorage.setItem(ANN_SEEN_KEY, JSON.stringify([...seen]));
      } catch {
        /* localStorage 不可用则每次都弹，可接受 */
      }
    }
    setAnnPopupQueue((q) => q.slice(1));
  };

  const currentIdx = batch ? STUDENT_STAGES.indexOf(batch.status) : -1;
  const unread = notifications.filter((n) => !n.readAt).length;

  const isCollecting = batch?.status === BatchStatus.COLLECTING;
  const isPublicity = batch?.status === BatchStatus.PUBLICITY;
  const unreadAnn = announcements.filter((a) => !loadSeenIds().has(a.id)).length;

  return (
    <div className="zc-home">
      {/* 问候：纯排版，不再用色块卡片 */}
      <header className="zc-home-greet">
        <div className="zc-home-date">{dateLine}</div>
        <h1>
          {greet()}，{user?.name ?? '同学'}
        </h1>
        <div className="zc-home-class">{user?.className ?? '软件学院'}</div>
      </header>

      {/* 本学期综测：批次 + 阶段刻度 + 按阶段给出唯一的下一步 */}
      <section className="zc-home-batch" aria-label="本学期综测">
        {batch ? (
          <>
            <div className="zc-home-batch-head">
              <div className="zc-home-batch-meta">
                <span className="zc-home-batch-cap">本学期综测 · {batch.semesterKey}</span>
                <h2>{batch.name}</h2>
              </div>
              <BatchStatusTag status={batch.status} />
            </div>

            {/* 进度轨：填充条 scaleX + 端点 translateX，均只走合成层 */}
            <div
              className="zc-stage-progress"
              aria-hidden="true"
              style={{ '--p': Math.max(currentIdx, 0) / (STUDENT_STAGES.length - 1) } as React.CSSProperties}
            >
              <span className="zc-stage-progress-bar" />
              <span className="zc-stage-progress-knob" />
            </div>
            <div className="zc-stages" role="list" aria-label="批次阶段进度">
              {STUDENT_STAGES.map((s, i) => (
                <div
                  key={s}
                  role="listitem"
                  aria-label={`${i < currentIdx ? '已完成' : i === currentIdx ? '当前阶段' : '未开始'}：${BATCH_STATUS_LABEL[s]}`}
                  className={`zc-stage ${i < currentIdx ? 'done' : ''} ${i === currentIdx ? 'current' : ''}`}
                >
                  <span className="zc-stage-dot">
                    {i < currentIdx ? <CheckOutlined /> : i === currentIdx ? i + 1 : <span className="zc-stage-pin" />}
                  </span>
                  <span className="zc-stage-label">{BATCH_STATUS_LABEL[s]}</span>
                </div>
              ))}
            </div>

            <div className={`zc-home-next ${isCollecting ? 'ok' : isPublicity ? 'warn' : 'muted'}`}>
              <div className="zc-home-next-text">
                <b>{isCollecting ? '正在收集加分材料' : isPublicity ? '成绩公示中' : '当前无需操作'}</b>
                <span>
                  {isCollecting
                    ? '提交加分申请和电子版材料包，截止前可随时修改。'
                    : isPublicity
                      ? '核对总分、排名与各项明细，有疑问在公示期内提交异议。'
                      : '下一阶段开始时会在这里和「通知」里提醒你。'}
                </span>
              </div>
              {isCollecting && (
                <Button type="primary" size="large" icon={<CloudUploadOutlined />} onClick={() => nav('/student/apply')}>
                  去提材料
                </Button>
              )}
              {isPublicity && (
                <Button type="primary" size="large" icon={<LineChartOutlined />} onClick={() => nav('/student/score')}>
                  查看成绩
                </Button>
              )}
            </div>
          </>
        ) : (
          <Empty description="本学期综测尚未开始" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </section>

      {/* 消息：公告与通知合并为一个面板，分段切换 */}
      <section className="zc-home-msgs" aria-label="消息">
        <div className="zc-home-msgs-head">
          <h2>消息</h2>
          <Segmented
            value={msgTab}
            onChange={(v) => setMsgTab(v as 'ann' | 'notice')}
            options={[
              { value: 'ann', label: <span className="zc-seg-label">公告{unreadAnn > 0 && <i className="zc-dot" />}</span> },
              {
                value: 'notice',
                label: (
                  <span className="zc-seg-label">
                    通知{unread > 0 && <Badge count={unread} size="small" style={{ marginLeft: 6 }} />}
                  </span>
                ),
              },
            ]}
          />
        </div>

        {/* key=分段：切换时列表淡入，标明内容已换 */}
        <div key={msgTab} className="zc-swap">
          {msgTab === 'ann' ? (
            announcements.length ? (
              <ul className="zc-msg-list">
                {announcements.map((a) => (
                  <li key={a.id}>
                    <button type="button" className="zc-msg" onClick={() => setAnnDetail(a)}>
                      <span className="zc-msg-title">
                        {a.pinned && <Tag color="red">置顶</Tag>}
                        {a.title}
                      </span>
                      <span className="zc-msg-body">{a.content}</span>
                      <span className="zc-msg-time">{fmtTime(a.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty description="暂无公告" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )
          ) : notifications.length ? (
            <ul className="zc-msg-list">
              {notifications.slice(0, 10).map((n) => (
                <li key={n.id}>
                  <div className={`zc-msg ${n.readAt ? '' : 'unread'}`}>
                    <span className="zc-msg-title">{n.title}</span>
                    <span className="zc-msg-body">{n.content}</span>
                    <span className="zc-msg-time">
                      {fmtTime(n.createdAt)}
                      {!n.readAt && (
                        <Button
                          type="link"
                          size="small"
                          className="zc-msg-read"
                          onClick={() => markNotificationRead(n.id).then(load).catch(() => message.error('操作失败'))}
                        >
                          标记已读
                        </Button>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty description="暂无通知" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </div>
      </section>

      {/* 新公告首次弹窗提示（未告知过的逐条弹出） */}
      <Modal
        open={annPopupQueue.length > 0}
        title={
          <Space>
            {annPopupQueue[0]?.pinned && <Tag color="red">置顶</Tag>}
            <span>{annPopupQueue[0]?.title}</span>
          </Space>
        }
        onCancel={closeAnnPopup}
        footer={
          <Button type="primary" onClick={closeAnnPopup}>
            我知道了
          </Button>
        }
        width="min(92vw, 560px)"
        styles={{ body: { maxHeight: '55vh', overflow: 'auto' } }}
      >
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>{annPopupQueue[0]?.content}</Typography.Paragraph>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          发布于 {fmtTime(annPopupQueue[0]?.createdAt)}
        </Typography.Text>
      </Modal>

      {/* 公告详情（点列表项查看全文） */}
      <Modal
        open={!!annDetail}
        onCancel={() => setAnnDetail(null)}
        footer={null}
        title={
          <Space>
            {annDetail?.pinned && <Tag color="red">置顶</Tag>}
            <span>{annDetail?.title}</span>
          </Space>
        }
        width="min(92vw, 560px)"
        styles={{ body: { maxHeight: '65vh', overflow: 'auto' } }}
      >
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>{annDetail?.content}</Typography.Paragraph>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          发布于 {fmtTime(annDetail?.createdAt)}
        </Typography.Text>
      </Modal>
    </div>
  );
}
