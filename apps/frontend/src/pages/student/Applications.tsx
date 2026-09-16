import { useEffect, useState } from 'react';
import { App, Button, Card, Drawer, Empty, List, Modal, Space, Tag, Timeline, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { APP_STATUS_LABEL } from '@zc/shared';
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
import { useAuth } from '../../store/auth';

/** 学生：我的申请 + 材料包状态跟踪（审核轨迹 / 撤回 / 重打包 / 包内浏览） */
export default function MyApplications() {
  const { message, modal } = App.useApp();
  const { user } = useAuth();
  const [apps, setApps] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [zipUuid, setZipUuid] = useState<{ uuid: string; name?: string } | null>(null);

  const load = () => {
    fetchMyApplications().then(setApps).catch((e) => message.error(errMsg(e)));
    fetchMyPackages().then(setPackages).catch(() => undefined);
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doWithdraw = (id: string, title: string) =>
    modal.confirm({
      title: '撤回申请',
      content: `确定撤回「${title}」？撤回后处于草稿状态，可重新编辑提交。`,
      onOk: async () => {
        try {
          await withdrawApplication(id);
          message.success('已撤回');
          load();
        } catch (e) {
          message.error(errMsg(e));
        }
      },
    });

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        size="small"
        title="我的加分申请"
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={load}>
            刷新
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
                      <span>{a.title}</span>
                      <AppStatusTag status={a.status} />
                      <Tag>{a.ruleItem?.name}</Tag>
                    </Space>
                  }
                  description={
                    <Space size={12} wrap style={{ fontSize: 12 }}>
                      <span className="zc-num">申报 {a.declaredScore ?? '-'} 分{a.grantedScore != null ? ` · 核定 ${a.grantedScore} 分` : ''}</span>
                      <span>附件 {a.attachments?.length ?? 0} 份</span>
                      <span>{fmtTime(a.createdAt)}</span>
                      {a.firstRejectReason && <Typography.Text type="danger">初审退回：{a.firstRejectReason}</Typography.Text>}
                      {a.rejectReason && <Typography.Text type="danger">复审驳回：{a.rejectReason}</Typography.Text>}
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty description="还没有加分申请，去「提材料」提交吧" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>

      <Card size="small" title="我的电子版材料包">
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
                              load();
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
                      {p.firstRejectReason && <Typography.Text type="danger">退回原因：{p.firstRejectReason}</Typography.Text>}
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

      <Drawer title={`审核轨迹 · ${detail?.title ?? ''}`} open={!!detail} onClose={() => setDetail(null)} width={420}>
        {detail && (
          <>
            <Space direction="vertical" size={4} style={{ marginBottom: 16 }}>
              <Space>
                <AppStatusTag status={detail.status} />
                <Tag>{detail.ruleItem?.name}</Tag>
              </Space>
              <Typography.Text type="secondary">
                申报分值 {detail.declaredScore ?? '-'} 分
                {detail.grantedScore != null ? ` · 核定 ${detail.grantedScore} 分` : ''}
              </Typography.Text>
            </Space>
            <Typography.Title level={5}>流转记录</Typography.Title>
            <Timeline
              items={(detail.reviewLogs ?? []).map((l: any) => ({
                color: l.action.includes('REJECT') ? 'red' : l.action === 'SUBMIT' || l.action === 'RESUBMIT' ? 'blue' : 'green',
                children: (
                  <>
                    <div>
                      <Typography.Text strong>{l.action}</Typography.Text>
                      {l.toStatus && <Tag style={{ marginLeft: 6 }}>{APP_STATUS_LABEL[l.toStatus as keyof typeof APP_STATUS_LABEL] ?? l.toStatus}</Tag>}
                    </div>
                    {l.comment && <div>{l.comment}</div>}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {l.operatorName} · {fmtTime(l.createdAt)}
                    </Typography.Text>
                  </>
                ),
              }))}
            />
            <Typography.Title level={5}>附件</Typography.Title>
            <List
              size="small"
              dataSource={detail.attachments ?? []}
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
                  📎 {att.file.originalName}
                </List.Item>
              )}
            />
          </>
        )}
      </Drawer>

      <Modal
        title={zipUuid?.name ?? '材料包'}
        open={!!zipUuid}
        onCancel={() => setZipUuid(null)}
        footer={null}
        width={860}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        {zipUuid?.uuid && <ZipBrowser uuid={zipUuid.uuid} zipName={zipUuid.name} />}
      </Modal>
    </Space>
  );
}
