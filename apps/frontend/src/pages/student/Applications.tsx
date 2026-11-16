import { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Drawer, Empty, List, Modal, Space, Tag, Timeline, Typography } from 'antd';
import { AuditOutlined, FileZipOutlined, PaperClipOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  downloadFile,
  fetchMyApplications,
  fetchMyPackages,
  openFileOnline,
  rebuildPackage,
  withdrawApplication,
} from '../../api';
import { errMsg } from '../../api/client';
import { AppStatusTag, PackageStatusTag, SectionTag, fmtTime } from '../../components/common';
import ZipBrowser from '../../components/ZipBrowser';

/** 审核轨迹动作中文化（后端 reviewLog.action 存英文码） */
const ACTION_LABEL: Record<string, string> = {
  APPLICATION_SUBMIT: '提交申请',
  SUBMIT: '提交申请',
  RESUBMIT: '重新提交',
  WITHDRAW: '撤回',
  FIRST_PASS: '初审通过',
  FIRST_REJECT: '初审退回',
  APPROVE: '复审认定',
  REJECT: '复审驳回',
};
const actionColor = (a: string) => (a.includes('REJECT') ? 'red' : a === 'WITHDRAW' ? 'gray' : a.includes('SUBMIT') ? 'blue' : 'green');

/** 手动刷新冷却（秒）：防连点打爆接口，又不至于等太久 */
const REFRESH_CD = 5;

/** 学生：我的申请 + 材料包状态跟踪（概览胶囊 / 审核轨迹 / 撤回 / 重打包 / 包内浏览） */
export default function MyApplications() {
  const { message, modal } = App.useApp();
  const nav = useNavigate();
  const [apps, setApps] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [zipUuid, setZipUuid] = useState<{ uuid: string; name?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [cd, setCd] = useState(0); // 刷新按钮冷却倒计时
  const busyRef = useRef(false); // 在途互斥（StrictMode 双挂载也只发一次）
  const lastLoadRef = useRef(0);

  const load = (force = false) => {
    if (busyRef.current) return;
    if (!force && Date.now() - lastLoadRef.current < REFRESH_CD * 1000) return;
    busyRef.current = true;
    lastLoadRef.current = Date.now();
    setLoading(true);
    setCd(REFRESH_CD);
    Promise.allSettled([fetchMyApplications(), fetchMyPackages()]).then(([a, p]) => {
      if (a.status === 'fulfilled') setApps(a.value);
      else message.error(errMsg(a.reason));
      if (p.status === 'fulfilled') setPackages(p.value);
    }).finally(() => {
      busyRef.current = false;
      setLoading(false);
    });
  };
  useEffect(() => load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // 冷却倒计时（每秒递减）
  useEffect(() => {
    if (cd <= 0) return;
    const t = setTimeout(() => setCd((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cd]);

  const doWithdraw = (id: string, title: string) =>
    modal.confirm({
      title: '撤回申请',
      content: `确定撤回「${title}」？撤回后处于草稿状态，可重新编辑提交。`,
      onOk: async () => {
        try {
          await withdrawApplication(id);
          message.success('已撤回');
          load(true);
        } catch (e) {
          message.error(errMsg(e));
        }
      },
    });

  const pending = apps.filter((a) => ['SUBMITTED', 'FIRST_PASSED'].includes(a.status));
  const back = apps.filter((a) => ['FIRST_REJECTED', 'REJECTED'].includes(a.status));
  const grantedSum = apps.filter((a) => a.status === 'APPROVED').reduce((s, a) => s + Number(a.grantedScore ?? 0), 0);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* 概览胶囊：已认定 / 审核中 / 退回 / 材料包 */}
      <div className="zc-app-stats">
        <span className="zc-stat-chip ok">
          已认定 <b className="zc-num">{Math.round(grantedSum * 100) / 100}</b> 分
        </span>
        <span className="zc-stat-chip">
          审核中 <b className="zc-num">{pending.length}</b> 项
        </span>
        {back.length > 0 && (
          <span className="zc-stat-chip bad">
            退回 <b className="zc-num">{back.length}</b> 项
          </span>
        )}
        <span className="zc-stat-chip">
          材料包 <b className="zc-num">{packages.length}</b> 份
        </span>
      </div>

      <Card
        size="small"
        className="zc-list-card"
        title={
          <span className="zc-card-title">
            <AuditOutlined className="zc-card-ticon" /> 我的加分申请
          </span>
        }
        extra={
          <Button size="small" icon={<ReloadOutlined spin={loading} />} disabled={loading || cd > 0} onClick={() => load()}>
            {cd > 0 ? `刷新（${cd}s）` : '刷新'}
          </Button>
        }
      >
        {apps.length ? (
          <List
            size="small"
            dataSource={apps}
            renderItem={(a) => (
              <List.Item
                actions={[
                  <Button key="detail" type="link" size="small" onClick={() => setDetail(a)}>
                    轨迹
                  </Button>,
                  ...(a.status === 'SUBMITTED'
                    ? [
                        <Button key="wd" type="link" size="small" danger onClick={() => doWithdraw(a.id, a.title)}>
                          撤回
                        </Button>,
                      ]
                    : []),
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space wrap size={6}>
                      <span className="zc-app-title">{a.title}</span>
                      <AppStatusTag status={a.status} />
                      <Tag className="zc-app-rule">{a.ruleItem?.name}</Tag>
                    </Space>
                  }
                  description={
                    <>
                      <div className="zc-app-info">
                        <span className="zc-num">
                          申报 <b>{a.declaredScore ?? '-'}</b> 分
                        </span>
                        <span className="zc-num ok">
                          核定 <b>{a.grantedScore ?? '-'}</b> 分
                        </span>
                        <span className="zc-app-meta">
                          附件 {a.attachments?.length ?? 0} 份 · {fmtTime(a.createdAt)}
                        </span>
                      </div>
                      {a.firstRejectReason && <div className="zc-app-reject">初审退回：{a.firstRejectReason}</div>}
                      {a.rejectReason && <div className="zc-app-reject">复审驳回：{a.rejectReason}</div>}
                    </>
                  }
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty description="还没有加分申请，去「提材料」提交吧" image={Empty.PRESENTED_IMAGE_SIMPLE}>
            <Button type="primary" ghost size="small" onClick={() => nav('/student/apply')}>
              去提材料
            </Button>
          </Empty>
        )}
      </Card>

      <Card
        size="small"
        className="zc-list-card"
        title={
          <span className="zc-card-title">
            <FileZipOutlined className="zc-card-ticon" /> 我的电子版材料包
          </span>
        }
      >
        {packages.length ? (
          <List
            size="small"
            dataSource={packages}
            renderItem={(p) => (
              <List.Item
                actions={[
                  <Button
                    key="view"
                    type="link"
                    size="small"
                    onClick={() => setZipUuid({ uuid: p.zipFile?.uuid, name: p.namingReport?.zipName })}
                    disabled={!p.zipFile?.uuid}
                  >
                    查看包内
                  </Button>,
                  ...(p.status !== 'FIRST_PASSED'
                    ? [
                        <Button
                          key="rebuild"
                          type="link"
                          size="small"
                          onClick={async () => {
                            try {
                              const r = await rebuildPackage(p.id);
                              message.success(`已重新打包：${r.namingReport.zipName}`);
                              load(true);
                            } catch (e) {
                              message.error(errMsg(e));
                            }
                          }}
                        >
                          重新打包
                        </Button>,
                      ]
                    : []),
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space wrap size={6}>
                      <SectionTag section={p.section} />
                      <PackageStatusTag status={p.status} />
                      <Typography.Text code style={{ fontSize: 12 }}>
                        {p.namingReport?.zipName ?? '-'}
                      </Typography.Text>
                    </Space>
                  }
                  description={
                    <>
                      {p.firstRejectReason && <div className="zc-app-reject">退回原因：{p.firstRejectReason}</div>}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        提交于 {fmtTime(p.submittedAt)}
                      </Typography.Text>
                    </>
                  }
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty description="尚未提交电子版材料包（两个板块各一份）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>

      <Drawer
        title={
          <span className="zc-card-title zc-drawer-title">
            <AuditOutlined className="zc-card-ticon" /> 审核轨迹 · {detail?.title ?? ''}
          </span>
        }
        open={!!detail}
        onClose={() => setDetail(null)}
        width="min(92vw, 420px)"
      >
        {detail && (
          <>
            <Space direction="vertical" size={4} style={{ marginBottom: 16 }}>
              <Space wrap size={6}>
                <AppStatusTag status={detail.status} />
                <Tag className="zc-app-rule">{detail.ruleItem?.name}</Tag>
              </Space>
              <Typography.Text type="secondary">
                申报分值 {detail.declaredScore ?? '-'} 分
                {detail.grantedScore != null ? ` · 核定 ${detail.grantedScore} 分` : ''}
              </Typography.Text>
            </Space>
            <div className="zc-flat-title">流转记录</div>
            <Timeline
              items={(detail.reviewLogs ?? []).map((l: any) => ({
                color: actionColor(l.action),
                children: (
                  <>
                    <div>
                      <Typography.Text strong>{ACTION_LABEL[l.action] ?? l.action}</Typography.Text>
                      {l.toStatus && (
                        <span style={{ marginLeft: 6 }}>
                          <AppStatusTag status={l.toStatus} />
                        </span>
                      )}
                    </div>
                    {l.comment && <div>{l.comment}</div>}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {l.operatorName} · {fmtTime(l.createdAt)}
                    </Typography.Text>
                  </>
                ),
              }))}
            />
            <div className="zc-flat-title" style={{ marginTop: 16 }}>
              附件
            </div>
            {detail.attachments?.length ? (
              <List
                size="small"
                dataSource={detail.attachments}
                renderItem={(att: any) => (
                  <List.Item
                    actions={[
                      <Button
                        key="p"
                        type="link"
                        size="small"
                        onClick={() => openFileOnline(att.file.uuid, att.file.ext)}
                        disabled={!['pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(att.file.ext)}
                      >
                        预览
                      </Button>,
                      <Button key="d" type="link" size="small" onClick={() => downloadFile(att.file.uuid, att.file.originalName)}>
                        下载
                      </Button>,
                    ]}
                  >
                    <Space size={4}>
                      <PaperClipOutlined style={{ color: 'var(--zc-text-3)' }}
                      />
                      {att.file.originalName}
                    </Space>
                  </List.Item>
                )}
              />
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                暂无附件
              </Typography.Text>
            )}
          </>
        )}
      </Drawer>

      <Modal
        title={zipUuid?.name ?? '材料包'}
        open={!!zipUuid}
        onCancel={() => setZipUuid(null)}
        footer={null}
        width="min(96vw, 860px)"
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        {zipUuid?.uuid && <ZipBrowser uuid={zipUuid.uuid} zipName={zipUuid.name} />}
      </Modal>
    </Space>
  );
}
