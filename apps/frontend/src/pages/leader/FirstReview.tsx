import { useCallback, useEffect, useState } from 'react';
import {
  App,
  Button,
  Card,
  Drawer,
  Input,
  Modal,
  Pagination,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { APP_STATUS_LABEL } from '@zc/shared';
import {
  ClassInfo,
  fetchApplications,
  fetchBatches,
  fetchClasses,
  fetchPackages,
  fetchReviewStats,
  firstReview,
  packageFirstReview,
} from '../../api';
import { errMsg } from '../../api/client';
import { AppStatusTag, BatchStatusTag, PackageStatusTag, SectionTag, fileSize, fmtTime } from '../../components/common';
import ZipBrowser from '../../components/ZipBrowser';

/** 班级初审工作台（班委自动限本班）：加分申请 + 材料包，批量通过/退回，压缩包在线浏览 */
export default function FirstReview() {
  const { message } = App.useApp();
  const [batches, setBatches] = useState<any[]>([]);
  const [batchId, setBatchId] = useState('');
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [classId, setClassId] = useState<string | undefined>();

  const [stats, setStats] = useState<any>(null);
  const [apps, setApps] = useState<any[]>([]);
  const [appsTotal, setAppsTotal] = useState(0);
  const [appStatus, setAppStatus] = useState('SUBMITTED');
  const [appPage, setAppPage] = useState(1);

  const [pkgs, setPkgs] = useState<any[]>([]);
  const [pkgsTotal, setPkgsTotal] = useState(0);
  const [pkgStatus, setPkgStatus] = useState('SUBMITTED');
  const [pkgPage, setPkgPage] = useState(1);

  const [selApps, setSelApps] = useState<string[]>([]);
  const [selPkgs, setSelPkgs] = useState<string[]>([]);
  const [zipUuid, setZipUuid] = useState<{ uuid: string; name?: string } | null>(null);
  const [appDetail, setAppDetail] = useState<any>(null);
  const [rejectOpen, setRejectOpen] = useState<{ kind: 'app' | 'pkg' } | null>(null);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchBatches()
      .then((bs) => {
        setBatches(bs);
        const active = bs.find((b) => b.status !== 'ARCHIVED') ?? bs[0];
        if (active) setBatchId(active.id);
      })
      .catch((e) => message.error(errMsg(e)));
    fetchClasses()
      .then(setClasses)
      .catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!batchId) return;
    setLoading(true);
    try {
      const st = await fetchReviewStats(batchId).catch(() => null);
      setStats(st);
      const a = await fetchApplications({ batchId, status: appStatus || undefined, classId, page: appPage, pageSize: 20 });
      setApps(a.rows);
      setAppsTotal(a.total);
      const p = await fetchPackages({ batchId, status: pkgStatus || undefined, classId, page: pkgPage, pageSize: 20 });
      setPkgs(p.rows);
      setPkgsTotal(p.total);
      setSelApps([]);
      setSelPkgs([]);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [batchId, appStatus, pkgStatus, classId, appPage, pkgPage]);
  useEffect(() => {
    load();
  }, [load]);

  const doFirst = async (kind: 'app' | 'pkg', action: 'PASS' | 'REJECT') => {
    const ids = kind === 'app' ? selApps : selPkgs;
    if (!ids.length) return;
    if (action === 'REJECT' && comment.trim().length < 2) {
      message.warning('退回必须填写原因（学生可见）');
      return;
    }
    setLoading(true);
    try {
      const r = kind === 'app' ? await firstReview({ ids, action, comment: comment.trim() || undefined }) : await packageFirstReview({ ids, action, comment: comment.trim() || undefined });
      message.success(`已处理 ${r.processed} 条`);
      setRejectOpen(null);
      setComment('');
      load();
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const batch = batches.find((b) => b.id === batchId);
  const clsSelect = (
    <Select
      allowClear
      placeholder="全部班级"
      style={{ width: 180 }}
      value={classId}
      onChange={(v) => {
        setClassId(v);
        setAppPage(1);
        setPkgPage(1);
      }}
      options={classes.map((c) => ({ value: c.id, label: c.name }))}
    />
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <Select
            style={{ width: 280 }}
            value={batchId}
            onChange={(v) => {
              setBatchId(v);
              setAppPage(1);
              setPkgPage(1);
            }}
            options={batches.map((b) => ({ value: b.id, label: `${b.name}（${b.semesterKey}）` }))}
          />
          {batch && <BatchStatusTag status={batch.status} />}
          {clsSelect}
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        </Space>
        {stats && (
          <Space size="large" style={{ marginTop: 12 }} wrap>
            {Object.entries(stats.applications).map(([s, n]) => (
              <Statistic
                key={s}
                title={APP_STATUS_LABEL[s as keyof typeof APP_STATUS_LABEL] ?? s}
                value={n as number}
                valueStyle={{ color: s === 'SUBMITTED' ? '#faad14' : undefined, fontSize: 20 }}
              />
            ))}
            <Statistic title="材料包待初审" value={stats.packages.SUBMITTED ?? 0} valueStyle={{ color: '#faad14', fontSize: 20 }} />
            <Statistic title="材料包已通过" value={stats.packages.FIRST_PASSED ?? 0} valueStyle={{ fontSize: 20 }} />
          </Space>
        )}
      </Card>

      <Card size="small" title="加分申请初审">
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ width: 160 }}
            value={appStatus}
            onChange={(v) => {
              setAppStatus(v);
              setAppPage(1);
            }}
            allowClear
            placeholder="全部状态"
            options={Object.entries(APP_STATUS_LABEL).map(([v, l]) => ({ value: v, label: l }))}
          />
          <Typography.Text type="secondary">已选 {selApps.length} 条</Typography.Text>
          <Button type="primary" disabled={!selApps.length} loading={loading} onClick={() => doFirst('app', 'PASS')}>
            批量通过
          </Button>
          <Button danger disabled={!selApps.length} onClick={() => setRejectOpen({ kind: 'app' })}>
            批量退回
          </Button>
        </Space>
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={apps}
          rowSelection={{ selectedRowKeys: selApps, onChange: (keys) => setSelApps(keys as string[]), getCheckboxProps: (r) => ({ disabled: r.status !== 'SUBMITTED' }) }}
          pagination={{ current: appPage, pageSize: 20, total: appsTotal, onChange: setAppPage, showSizeChanger: false, size: 'default' }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '学生', dataIndex: ['student', 'name'], width: 90, render: (v, r: any) => `${v}（${r.student.studentNo.slice(-4)}）` },
            { title: '班级', dataIndex: ['student', 'className'], width: 150, ellipsis: true },
            { title: '申报项', dataIndex: ['ruleItem', 'name'], width: 130, ellipsis: true },
            { title: '标题', dataIndex: 'title', ellipsis: true },
            { title: '申报分', dataIndex: 'declaredScore', width: 80, align: 'right', className: 'zc-num' },
            { title: '附件', dataIndex: 'attachments', width: 70, render: (a: any[]) => (a?.length ? <Tag color="blue">{a.length}份</Tag> : <Tag>无</Tag>) },
            { title: '状态', dataIndex: 'status', width: 100, render: (s) => <AppStatusTag status={s} /> },
            {
              title: '操作',
              width: 80,
              render: (_, r: any) => (
                <Button type="link" size="small" onClick={() => setAppDetail(r)}>
                  详情
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" title="材料包初审">
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            style={{ width: 160 }}
            value={pkgStatus}
            onChange={(v) => {
              setPkgStatus(v);
              setPkgPage(1);
            }}
            allowClear
            placeholder="全部状态"
            options={[
              { value: 'SUBMITTED', label: '待初审' },
              { value: 'FIRST_PASSED', label: '初审通过' },
              { value: 'FIRST_REJECTED', label: '初审退回' },
            ]}
          />
          <Typography.Text type="secondary">已选 {selPkgs.length} 个</Typography.Text>
          <Button type="primary" disabled={!selPkgs.length} loading={loading} onClick={() => doFirst('pkg', 'PASS')}>
            批量通过
          </Button>
          <Button danger disabled={!selPkgs.length} onClick={() => setRejectOpen({ kind: 'pkg' })}>
            批量退回
          </Button>
        </Space>
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={pkgs}
          rowSelection={{ selectedRowKeys: selPkgs, onChange: (keys) => setSelPkgs(keys as string[]), getCheckboxProps: (r) => ({ disabled: r.status !== 'SUBMITTED' }) }}
          pagination={{ current: pkgPage, pageSize: 20, total: pkgsTotal, onChange: setPkgPage, showSizeChanger: false, size: 'default' }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '学生', dataIndex: ['student', 'name'], width: 90 },
            { title: '班级', dataIndex: ['student', 'className'], width: 150, ellipsis: true },
            { title: '板块', dataIndex: 'section', width: 130, render: (s) => <SectionTag section={s} /> },
            {
              title: '压缩包',
              dataIndex: ['namingReport', 'zipName'],
              ellipsis: true,
              render: (v: string, r: any) => (
                <Typography.Text code style={{ fontSize: 12 }}>
                  {v ?? '-'}{r.zipFile ? `（${fileSize(r.zipFile.size)}）` : ''}
                </Typography.Text>
              ),
            },
            { title: '提交时间', dataIndex: 'submittedAt', width: 140, render: (t: string) => fmtTime(t) },
            { title: '状态', dataIndex: 'status', width: 100, render: (s) => <PackageStatusTag status={s} /> },
            {
              title: '操作',
              width: 90,
              render: (_, r: any) => (
                <Button type="link" size="small" disabled={!r.zipFile?.uuid} onClick={() => setZipUuid({ uuid: r.zipFile.uuid, name: r.namingReport?.zipName })}>
                  在线浏览
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {/* 申请详情抽屉 */}
      <Drawer title={appDetail?.title} open={!!appDetail} onClose={() => setAppDetail(null)} width={460}>
        {appDetail && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space wrap>
              <AppStatusTag status={appDetail.status} />
              <Tag>{appDetail.ruleItem?.name}</Tag>
              <Typography.Text className="zc-num">申报 {appDetail.declaredScore ?? '-'} 分</Typography.Text>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {appDetail.student?.name} · {appDetail.student?.className} · {appDetail.student?.studentNo}
            </Typography.Paragraph>
            {appDetail.detail && (
              <Card size="small" title="申报信息">
                {Object.entries(appDetail.detail).map(([k, v]) => (
                  <Typography.Paragraph key={k} style={{ marginBottom: 4 }}>
                    <Typography.Text type="secondary">{k}：</Typography.Text>
                    {String(v)}
                  </Typography.Paragraph>
                ))}
              </Card>
            )}
            <Card size="small" title="附件">
              {(appDetail.attachments ?? []).map((att: any) => (
                <Typography.Paragraph key={att.file.uuid} style={{ marginBottom: 4 }}>
                  📎 {att.file.originalName}（{fileSize(att.file.size)}）
                </Typography.Paragraph>
              ))}
              {!(appDetail.attachments ?? []).length && <Typography.Text type="secondary">无附件</Typography.Text>}
            </Card>
            {appDetail.firstRejectReason && <Typography.Text type="danger">初审退回原因：{appDetail.firstRejectReason}</Typography.Text>}
            {appDetail.status === 'SUBMITTED' && (
              <Space>
                <Button
                  type="primary"
                  onClick={() => {
                    setSelApps([appDetail.id]);
                    doFirst('app', 'PASS');
                  }}
                >
                  通过
                </Button>
                <Button
                  danger
                  onClick={() => {
                    setSelApps([appDetail.id]);
                    setRejectOpen({ kind: 'app' });
                  }}
                >
                  退回
                </Button>
              </Space>
            )}
          </Space>
        )}
      </Drawer>

      {/* zip 浏览抽屉 */}
      <Drawer
        title={`材料包 · ${zipUuid?.name ?? ''}`}
        open={!!zipUuid}
        onClose={() => setZipUuid(null)}
        width={960}
        styles={{ body: { padding: 12, overflow: 'hidden' } }}
      >
        {zipUuid?.uuid && <ZipBrowser uuid={zipUuid.uuid} zipName={zipUuid.name} />}
      </Drawer>

      {/* 退回原因 */}
      <Modal
        title="退回材料（原因将通知学生）"
        open={!!rejectOpen}
        onCancel={() => {
          setRejectOpen(null);
          setComment('');
        }}
        onOk={() => rejectOpen && doFirst(rejectOpen.kind, 'REJECT')}
        okText="确认退回"
        okButtonProps={{ danger: true }}
      >
        <Input.TextArea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="如：扫描件不清晰；命名不符合规范；缺少志愿服务材料…" maxLength={500} showCount />
      </Modal>
    </Space>
  );
}
