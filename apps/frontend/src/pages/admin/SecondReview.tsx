import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Drawer, Input, InputNumber, Modal, Select, Space, Table, Tag, Timeline, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { APP_STATUS_LABEL } from '@zc/shared';
import { ClassInfo, fetchApplicationDetail, fetchApplications, fetchClasses, secondReview } from '../../api';
import { errMsg } from '../../api/client';
import { AppStatusTag, BatchSelect, fmtTime } from '../../components/common';

/** 辅导员复审工作台：核定 grantedScore（可逐项改分）→ 批量通过/驳回 */
export default function SecondReview() {
  const { message } = App.useApp();
  const [batchId, setBatchId] = useState('');
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [classId, setClassId] = useState<string>();
  const [status, setStatus] = useState('FIRST_PASSED');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [granted, setGranted] = useState<Record<string, number | null>>({});
  const [detail, setDetail] = useState<any>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [comment, setComment] = useState('');

  useEffect(() => {
    fetchClasses().then(setClasses).catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    if (!batchId) return;
    setLoading(true);
    fetchApplications({ batchId, status, classId, page, pageSize: 20 })
      .then((r) => {
        setRows(r.rows);
        setTotal(r.total);
        setGranted(Object.fromEntries(r.rows.map((x: any) => [x.id, x.declaredScore])));
      })
      .catch((e) => message.error(errMsg(e)))
      .finally(() => setLoading(false));
  }, [batchId, status, classId, page, message]);
  useEffect(load, [load]);

  const doReview = async (action: 'APPROVE' | 'REJECT') => {
    if (!sel.length) return;
    if (action === 'REJECT' && comment.trim().length < 2) {
      message.warning('驳回必须填写原因（学生可见）');
      return;
    }
    setLoading(true);
    try {
      const overrides =
        action === 'APPROVE'
          ? Object.fromEntries(
              sel
                .filter((id) => granted[id] != null && granted[id] !== rows.find((r) => r.id === id)?.declaredScore)
                .map((id) => [id, Number(granted[id])]),
            )
          : undefined;
      const r = await secondReview({ ids: sel, action, comment: comment.trim() || undefined, grantedScores: overrides });
      message.success(`已${action === 'APPROVE' ? '认定' : '驳回'} ${r.processed} 条${overrides && Object.keys(overrides).length ? `（其中 ${Object.keys(overrides).length} 条改分）` : ''}`);
      setRejectOpen(false);
      setComment('');
      load();
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <BatchSelect value={batchId} onChange={setBatchId} />
          <Select
            style={{ width: 150 }}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={Object.entries(APP_STATUS_LABEL).map(([v, l]) => ({ value: v, label: l }))}
          />
          <Select
            placeholder="全部班级"
            allowClear
            showSearch
            style={{ width: 190 }}
            value={classId}
            onChange={(v) => {
              setClassId(v);
              setPage(1);
            }}
            options={classes.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        </Space>
      </Card>

      <Card size="small" title={`复审工作台（共 ${total} 条，已选 ${sel.length} 条）`}>
        <Space style={{ marginBottom: 12 }}>
          <Button type="primary" disabled={!sel.length} loading={loading} onClick={() => doReview('APPROVE')}>
            批量认定{sel.length && sel.some((id) => granted[id] !== rows.find((r) => r.id === id)?.declaredScore) ? '（含改分）' : ''}
          </Button>
          <Button danger disabled={!sel.length} onClick={() => setRejectOpen(true)}>
            批量驳回
          </Button>
          <Typography.Text type="secondary">核定分值为计算引擎唯一取分来源；单项上限由规则 caps 自动封顶</Typography.Text>
        </Space>
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          rowSelection={{ selectedRowKeys: sel, onChange: (keys) => setSel(keys as string[]), getCheckboxProps: (r) => ({ disabled: r.status !== 'FIRST_PASSED' }) }}
          pagination={{ current: page, pageSize: 20, total, onChange: setPage, showSizeChanger: false, size: 'default' }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '学生', width: 140, render: (_, r: any) => `${r.student.name}（${r.student.studentNo}）` },
            { title: '班级', dataIndex: ['student', 'className'], width: 150, ellipsis: true },
            { title: '申报项', dataIndex: ['ruleItem', 'name'], width: 130, ellipsis: true },
            { title: '标题', dataIndex: 'title', ellipsis: true },
            {
              title: '申报分',
              dataIndex: 'declaredScore',
              width: 80,
              align: 'right',
              className: 'zc-num',
              render: (v) => v ?? '-',
            },
            {
              title: '核定分',
              width: 130,
              render: (_, r: any) =>
                r.status === 'FIRST_PASSED' ? (
                  <InputNumber
                    size="small"
                    min={0}
                    max={(r.ruleItem as any)?.caps?.perTermMax ?? 100}
                    step={0.1}
                    value={granted[r.id] ?? null}
                    onChange={(v) => setGranted((g) => ({ ...g, [r.id]: v }))}
                    className="zc-num"
                  />
                ) : (
                  <span className="zc-num">{r.grantedScore ?? '-'}</span>
                ),
            },
            { title: '状态', dataIndex: 'status', width: 100, render: (s) => <AppStatusTag status={s} /> },
            {
              title: '操作',
              width: 70,
              render: (_, r: any) => (
                <Button type="link" size="small" onClick={() => fetchApplicationDetail(r.id).then(setDetail).catch((e) => message.error(errMsg(e)))}>
                  详情
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Drawer title={detail?.title} open={!!detail} onClose={() => setDetail(null)} width={480}>
        {detail && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space wrap>
              <AppStatusTag status={detail.status} />
              <Tag>{detail.ruleItem?.name}</Tag>
              <Typography.Text className="zc-num">申报 {detail.declaredScore ?? '-'} / 核定 {detail.grantedScore ?? '-'}</Typography.Text>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {detail.student?.name} · {detail.student?.className} · {detail.student?.studentNo}
            </Typography.Paragraph>
            {detail.level && <Tag color="geekblue">{detail.level}</Tag>}
            {detail.detail && (
              <Card size="small" title="申报信息">
                {Object.entries(detail.detail).map(([k, v]) => (
                  <Typography.Paragraph key={k} style={{ marginBottom: 4 }}>
                    <Typography.Text type="secondary">{k}：</Typography.Text>
                    {String(v)}
                  </Typography.Paragraph>
                ))}
              </Card>
            )}
            <Card size="small" title="附件（点开预览）">
              {(detail.attachments ?? []).map((att: any) => (
                <Typography.Paragraph key={att.file.uuid} style={{ marginBottom: 4 }}>
                  📎 {att.file.originalName}
                </Typography.Paragraph>
              ))}
              {!(detail.attachments ?? []).length && <Typography.Text type="secondary">无附件</Typography.Text>}
            </Card>
            <Card size="small" title="审核轨迹">
              <Timeline
                items={(detail.reviewLogs ?? []).map((l: any) => ({
                  children: (
                    <>
                      <Typography.Text strong>{l.action}</Typography.Text>
                      {l.comment && <div>{l.comment}</div>}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {l.operatorName} · {fmtTime(l.createdAt)}
                      </Typography.Text>
                    </>
                  ),
                }))}
              />
            </Card>
          </Space>
        )}
      </Drawer>

      <Modal
        title="驳回认定（原因将通知学生）"
        open={rejectOpen}
        onCancel={() => setRejectOpen(false)}
        onOk={() => doReview('REJECT')}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
      >
        <Input.TextArea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="如：赛事不在认定目录；佐证材料不足…" maxLength={500} showCount />
      </Modal>
    </Space>
  );
}
