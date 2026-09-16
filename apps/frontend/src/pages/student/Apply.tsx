import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Steps,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { CloudUploadOutlined, DeleteOutlined, FileTextOutlined, GiftOutlined, PartitionOutlined } from '@ant-design/icons';
import { ACTIVITY_LEVEL_LABEL, LEVEL_PREFIX, NAMING_RULES, ActivityLevel } from '@zc/shared';
import {
  RuleItem,
  fetchActiveBatch,
  fetchRuleItems,
  fetchWhitelists,
  submitApplication,
  submitPackage,
  uploadMaterial,
} from '../../api';
import { errMsg } from '../../api/client';
import { fileSize } from '../../components/common';
import ZipBrowser from '../../components/ZipBrowser';
import { useAuth } from '../../store/auth';

const ALLOW_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];
const idemKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random()}`);

type Mode = 'APP' | 'PKG_PV' | 'PKG_BONUS';
const CATEGORY_LABEL: Record<string, string> = { MORAL: '品德行为', ACADEMIC: '学业表现', SPORTS: '文体表现' };

interface UploadedItem {
  fileId: string;
  uuid: string;
  name: string;
  size: number;
  /** PKG_PV */
  role?: '社会实践' | '志愿服务';
  /** PKG_BONUS */
  itemName?: string;
  level?: string;
}

/** 学生提交向导：加分申请 / 板块一材料包 / 板块二材料包（服务端规范打包） */
export default function Apply() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const nav = useNavigate();
  const [batch, setBatch] = useState<any>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);

  // 加分申请
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [category, setCategory] = useState<string>('MORAL');
  const [rule, setRule] = useState<RuleItem | null>(null);
  const [form] = Form.useForm();
  const [title, setTitle] = useState('');
  const [wlOptions, setWlOptions] = useState<string[]>([]);
  const [appFiles, setAppFiles] = useState<UploadedItem[]>([]);
  const [appResult, setAppResult] = useState<any>(null);

  // 材料包
  const [pkgFiles, setPkgFiles] = useState<UploadedItem[]>([]);
  const [cadreName, setCadreName] = useState('');
  const [certs, setCerts] = useState('');
  const [pkgResult, setPkgResult] = useState<any>(null);

  useEffect(() => {
    fetchActiveBatch()
      .then((b) => setBatch(b))
      .catch(() => undefined);
    fetchRuleItems()
      .then(setRules)
      .catch(() => undefined);
  }, []);

  const collectable = batch && ['COLLECTING', 'FIRST_REVIEW'].includes(batch.status);
  const catRules = useMemo(() => rules.filter((r) => r.category === category), [rules, category]);

  const upload = async (f: File): Promise<UploadedItem | null> => {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOW_EXT.includes(ext)) {
      message.error(`仅支持 ${ALLOW_EXT.join(' / ')} 格式`);
      return null;
    }
    if (f.size > 20 * 1024 * 1024) {
      message.error('单个文件不超过 20MB');
      return null;
    }
    try {
      const r = await uploadMaterial(f);
      return { fileId: r.id, uuid: r.uuid, name: r.originalName, size: r.size };
    } catch (e) {
      message.error(errMsg(e));
      return null;
    }
  };

  const onUpload = async (f: File) => {
    const item = await upload(f);
    if (!item) return false;
    if (mode === 'APP') setAppFiles((xs) => [...xs, item]);
    else if (mode === 'PKG_PV')
      setPkgFiles((xs) => [...xs, { ...item, role: /志愿/.test(f.name) ? '志愿服务' : '社会实践' }]);
    else setPkgFiles((xs) => [...xs, { ...item, itemName: f.name.replace(/\.[^.]+$/, ''), level: 'UNIVERSITY' }]);
    message.success(`已上传：${f.name}`);
    return false;
  };

  // ---------- 提交 ----------

  const submitApp = async () => {
    if (!batch || !rule) return;
    if (!title.trim()) {
      message.warning('请填写活动/证书全称');
      return;
    }
    if (rule.evidence?.some((e) => e.required) && appFiles.length === 0) {
      message.warning('该加分项必须上传佐证材料');
      return;
    }
    let detail: Record<string, any> = {};
    try {
      const v = await form.validateFields();
      detail = v;
    } catch {
      return;
    }
    setLoading(true);
    try {
      const r = await submitApplication(
        {
          batchId: batch.id,
          ruleItemId: rule.id,
          title: title.trim(),
          detail,
          fileIds: appFiles.map((f) => f.fileId),
        },
        idemKey(),
      );
      setAppResult(r);
      setStep(mode === 'APP' ? 3 : 2);
      message.success('提交成功，等待班级初审');
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const submitPkg = async () => {
    if (!batch) return;
    if (!pkgFiles.length) {
      message.warning('请至少上传一份材料');
      return;
    }
    setLoading(true);
    try {
      const dto =
        mode === 'PKG_PV'
          ? {
              batchId: batch.id,
              section: 'PRACTICE_VOLUNTEER' as const,
              items: pkgFiles.map((f) => ({ fileId: f.fileId, role: f.role })),
            }
          : {
              batchId: batch.id,
              section: 'BONUS_EVIDENCE' as const,
              items: pkgFiles.map((f) => ({ fileId: f.fileId, nameOverride: f.itemName, level: f.level })),
              meta: { cadreName, certs },
            };
      const r = await submitPackage(dto, idemKey());
      setPkgResult(r);
      setStep(2);
      message.success(`材料包已规范打包：${r.namingReport.zipName}`);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  // ---------- zip 名预览 ----------

  const zipPreview = useMemo(() => {
    const no = user?.username ?? '';
    const nm = user?.name ?? '';
    if (mode === 'PKG_PV') {
      const p = pkgFiles.filter((f) => (f.role ?? '社会实践') === '社会实践').length;
      const v = pkgFiles.length - p;
      return `${no} ${nm} ${p}社会实践 ${v}志愿服务.zip`;
    }
    if (mode === 'PKG_BONUS') {
      const c = pkgFiles.filter((f) => ['NATIONAL', 'PROVINCIAL', 'MUNICIPAL'].includes(f.level ?? '')).length;
      let t = `${no} ${nm} ${pkgFiles.length}加分证明 ${c}比赛活动`;
      if (certs.trim()) t += ` ${certs.trim()}`;
      if (cadreName.trim()) t += ` ${cadreName.trim()}`;
      return `${t}.zip`;
    }
    return '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pkgFiles, certs, cadreName, user]);

  const reset = () => {
    setMode(null);
    setStep(0);
    setRule(null);
    setTitle('');
    setAppFiles([]);
    setPkgFiles([]);
    setAppResult(null);
    setPkgResult(null);
    setCadreName('');
    setCerts('');
    form.resetFields();
  };

  const uploadButton = (hint: string) => (
    <Upload.Dragger
      multiple
      accept={ALLOW_EXT.map((e) => `.${e}`).join(',')}
      showUploadList={false}
      beforeUpload={onUpload}
      disabled={!collectable}
    >
      <p className="ant-upload-drag-icon"><CloudUploadOutlined /></p>
      <p className="ant-upload-text">点击或拍照上传（PDF / 图片）</p>
      <p className="ant-upload-hint">{hint}· 单文件 ≤20MB</p>
    </Upload.Dragger>
  );

  const stepItems =
    mode === 'APP'
      ? [{ title: '选择类型' }, { title: '选择加分项' }, { title: '填写与上传' }, { title: '完成' }]
      : [{ title: '选择类型' }, { title: '上传材料' }, { title: '完成' }];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {batch && !collectable && (
        <Alert type="warning" showIcon message={`当前批次处于「${batch.status}」阶段，材料收集结束后不可提交`} />
      )}
      <Card size="small">
        <Steps size="small" current={step} items={stepItems} style={{ marginBottom: 4 }} direction="horizontal" />
      </Card>

      {/* Step 0：选择提交类型 */}
      {step === 0 && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert type="info" showIcon message="提交分为三类：加分项申报（进入审核与计算）+ 电子版材料包两个板块（供班级初审留档）" />
          <div className="zc-mode-grid">
            {[
              { key: 'APP', icon: <GiftOutlined />, title: '加分项申报', desc: '科研/竞赛/证书/干部/志愿等分项申报，需辅导员复审核定分值' },
              { key: 'PKG_PV', icon: <FileTextOutlined />, title: '材料包·社会实践/志愿服务', desc: '板块一：上传扫描件，系统自动按规范命名打包' },
              { key: 'PKG_BONUS', icon: <PartitionOutlined />, title: '材料包·加分证明', desc: '板块二：比赛/活动/证书扫描件，自动加级别前缀' },
            ].map((m) => (
              <Card
                key={m.key}
                hoverable
                size="small"
                className="zc-mode-card"
                onClick={() => {
                  setMode(m.key as Mode);
                  setStep(1);
                }}
              >
                <div className="zc-mode-icon">{m.icon}</div>
                <Typography.Text strong>{m.title}</Typography.Text>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                  {m.desc}
                </Typography.Paragraph>
              </Card>
            ))}
          </div>
        </Space>
      )}

      {/* APP：选择加分项 */}
      {step === 1 && mode === 'APP' && (
        <Card size="small" title="选择加分项类型">
          <Select
            value={category}
            onChange={(c) => {
              setCategory(c);
              setRule(null);
            }}
            style={{ width: 160, marginBottom: 12 }}
            options={Object.entries(CATEGORY_LABEL).map(([v, l]) => ({ value: v, label: l }))}
          />
          {catRules.length ? (
            <div className="zc-rule-grid">
              {catRules.map((r) => (
                <Card
                  key={r.id}
                  size="small"
                  hoverable
                  className={`zc-rule-card ${rule?.id === r.id ? 'active' : ''}`}
                  onClick={() => setRule(r)}
                >
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Typography.Text strong>{r.name}</Typography.Text>
                    <Space size={4} wrap>
                      {r.defaultScore != null && <Tag color="blue">{r.defaultScore} 分</Tag>}
                      {r.caps?.perTermMax != null && <Tag>学期上限 {r.caps.perTermMax}</Tag>}
                      {r.caps?.takeHighest && <Tag>同类取最高</Tag>}
                      {r.evidence?.some((e) => e.required) && <Tag color="orange">需佐证</Tag>}
                    </Space>
                    {/* display:block 使 ellipsis 生效（inline span 上 overflow/ellipsis 无效，长文本会溢出卡片） */}
                    {r.description && (
                      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }} ellipsis={{ tooltip: r.description }}>
                        {r.description}
                      </Typography.Text>
                    )}
                  </Space>
                </Card>
              ))}
            </div>
          ) : (
            <Empty description="该板块暂无可用加分项" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
          <div style={{ marginTop: 16 }}>
            <Button onClick={() => setStep(0)}>上一步</Button>{' '}
            <Button type="primary" disabled={!rule} onClick={() => setStep(2)}>
              下一步
            </Button>
          </div>
        </Card>
      )}

      {/* APP：填写与上传 */}
      {step === 2 && mode === 'APP' && rule && (
        <Card size="small" title={`申报：${rule.name}`}>
          <Form form={form} layout="vertical" requiredMark="optional">
            <Form.Item
              label="活动 / 证书全称"
              required
              extra={
                rule.whitelistType?.startsWith('COMP')
                  ? '须在教务处当年度赛事认定目录内，输入可搜索目录'
                  : '请按证书或活动官方全称填写（用于命名规范与查重）'
              }
            >
              {rule.whitelistType?.startsWith('COMP') ? (
                <Select
                  showSearch
                  value={title || undefined}
                  placeholder="搜索赛事认定目录（如：蓝桥杯）"
                  filterOption={false}
                  onSearch={(q) =>
                    fetchWhitelists({ q, limit: 20 })
                      .then((ws) => setWlOptions(ws.map((w) => w.name)))
                      .catch(() => undefined)
                  }
                  onChange={setTitle}
                  notFoundContent={title ? '未搜索到，可手动输入' : null}
                  options={wlOptions.map((o) => ({ value: o, label: o }))}
                  allowClear
                />
              ) : (
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="活动/证书全称" maxLength={100} />
              )}
            </Form.Item>

            {rule.detailSchema?.map((f) => (
              <Form.Item
                key={f.field}
                name={f.field}
                label={
                  <span>
                    {f.label}
                    {f.type === 'select' && f.options?.some((o) => typeof o.score === 'number') && (
                      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                       （分值随选项）
                      </Typography.Text>
                    )}
                  </span>
                }
                rules={f.required ? [{ required: true, message: `请填写${f.label}` }] : undefined}
              >
                {f.type === 'select' ? (
                  <Select
                    placeholder={`请选择${f.label}`}
                    options={f.options?.map((o) => ({
                      value: o.value,
                      label: typeof o.score === 'number' ? `${o.label}（+${o.score}分）` : o.label,
                    }))}
                  />
                ) : f.type === 'number' ? (
                  <InputNumber style={{ width: '100%' }} placeholder={f.placeholder ?? `请输入${f.label}`} />
                ) : f.type === 'date' ? (
                  <Input type="date" placeholder={f.placeholder} />
                ) : (
                  <Input placeholder={f.placeholder ?? `请输入${f.label}`} maxLength={200} />
                )}
              </Form.Item>
            ))}

            <Form.Item label="佐证材料" required={rule.evidence?.some((e) => e.required)}>
              {uploadButton(
                rule.evidence?.length
                  ? `要求：${rule.evidence.map((e) => e.label + (e.required ? '（必须）' : '')).join('、')} · `
                  : '',
              )}
              {appFiles.length > 0 && (
                <div className="zc-file-list">
                  {appFiles.map((f) => (
                    <div key={f.fileId} className="zc-file-row">
                      <span className="zc-file-name">📎 {f.name}</span>
                      <span className="zc-file-size">{fileSize(f.size)}</span>
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => setAppFiles((xs) => xs.filter((x) => x.fileId !== f.fileId))}
                      />
                    </div>
                  ))}
                </div>
              )}
            </Form.Item>
          </Form>
          <Space style={{ marginTop: 8 }}>
            <Button onClick={() => setStep(1)}>上一步</Button>
            <Button type="primary" loading={loading} onClick={submitApp} disabled={!collectable}>
              提交申请
            </Button>
          </Space>
        </Card>
      )}

      {/* 材料包：上传与命名 */}
      {step === 1 && (mode === 'PKG_PV' || mode === 'PKG_BONUS') && (
        <Card size="small" title={mode === 'PKG_PV' ? '板块一：社会实践 / 志愿服务' : '板块二：加分证明'}>
          <Alert
            style={{ marginBottom: 12 }}
            type="info"
            showIcon
            message={
              mode === 'PKG_PV'
                ? '上传社会实践与志愿服务扫描件（可为多份），系统自动命名为「社会实践N / 志愿服务N」'
                : '上传比赛/活动/证书扫描件，填写活动全称并选择级别，系统自动加「国/省/市/校/院」前缀'
            }
          />
          {uploadButton(mode === 'PKG_PV' ? '每份材料对应一次实践或志愿服务 · ' : '文件名 = 级别前缀 + 活动全称 · ')}

          {pkgFiles.length > 0 && (
            <div className="zc-file-list" style={{ marginTop: 12 }}>
              {pkgFiles.map((f, i) => (
                <div key={f.fileId} className="zc-file-row">
                  <span className="zc-file-name">📎 {f.name}</span>
                  {mode === 'PKG_PV' ? (
                    <Select
                      size="small"
                      value={f.role}
                      style={{ width: 120, flex: 'none' }}
                      onChange={(v) => setPkgFiles((xs) => xs.map((x, j) => (i === j ? { ...x, role: v } : x)))}
                      options={[
                        { value: '社会实践', label: '社会实践' },
                        { value: '志愿服务', label: '志愿服务' },
                      ]}
                    />
                  ) : (
                    <>
                      <Input
                        size="small"
                        style={{ flex: '1 1 150px', minWidth: 130 }}
                        value={f.itemName}
                        placeholder="活动/比赛/证书全称"
                        onChange={(e) => setPkgFiles((xs) => xs.map((x, j) => (i === j ? { ...x, itemName: e.target.value } : x)))}
                      />
                      <Select
                        size="small"
                        value={f.level}
                        style={{ width: 110, flex: 'none' }}
                        onChange={(v) => setPkgFiles((xs) => xs.map((x, j) => (i === j ? { ...x, level: v } : x)))}
                        options={(Object.keys(ACTIVITY_LEVEL_LABEL) as ActivityLevel[]).map((l) => ({
                          value: l,
                          label: `${LEVEL_PREFIX[l]}级`,
                        }))}
                      />
                    </>
                  )}
                  <span className="zc-file-size">{fileSize(f.size)}</span>
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => setPkgFiles((xs) => xs.filter((_, j) => j !== i))}
                  />
                </div>
              ))}
            </div>
          )}

          {mode === 'PKG_BONUS' && (
            <Space style={{ marginTop: 12 }} wrap>
              <Input
                style={{ width: 220 }}
                value={certs}
                onChange={(e) => setCerts(e.target.value)}
                placeholder="证书名称（多个空格分隔，无则不填）"
                maxLength={100}
              />
              <Input
                style={{ width: 180 }}
                value={cadreName}
                onChange={(e) => setCadreName(e.target.value)}
                placeholder="干部名称（如：班长，无则不填）"
                maxLength={50}
              />
            </Space>
          )}

          {zipPreview && (
            <Alert
              style={{ marginTop: 12 }}
              type="success"
              showIcon
              message={
                <>
                  压缩包将命名为：<Typography.Text code copyable>{zipPreview}</Typography.Text>
                </>
              }
            />
          )}
          <div style={{ marginTop: 16 }}>
            <Button onClick={() => setStep(0)}>上一步</Button>{' '}
            <Button type="primary" loading={loading} onClick={submitPkg} disabled={!collectable}>
              打包并提交
            </Button>
          </div>
        </Card>
      )}

      {/* 完成 */}
      {(step === 3 && mode === 'APP' && appResult) || (step === 2 && mode && mode !== 'APP' && pkgResult) ? (
        <Card size="small" title="提交成功">
          {mode === 'APP' ? (
            <Space direction="vertical">
              <Typography.Text>
                「{appResult.title}」已提交，状态：<Tag color="processing">待初审</Tag>
              </Typography.Text>
              {appResult.whitelistHit && <Alert type="success" showIcon message={`赛事目录命中：${appResult.whitelistHit}`} />}
              {appResult.declaredScore != null && <Typography.Text type="secondary">申报分值：{appResult.declaredScore} 分（最终以辅导员复审核定为准）</Typography.Text>}
            </Space>
          ) : (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Typography.Text>
                材料包已按规范打包：<Typography.Text code copyable>{pkgResult.namingReport.zipName}</Typography.Text>
              </Typography.Text>
              {pkgResult.namingReport.warnings?.length > 0 && (
                <Alert type="warning" showIcon message={pkgResult.namingReport.warnings.join('；')} />
              )}
              <Typography.Text type="secondary">包内文件：{pkgResult.namingReport.entries.map((e: any) => e.entryName).join('、')}</Typography.Text>
              <ZipBrowser uuid={pkgResult.zipFileUuid} zipName={pkgResult.namingReport.zipName} />
            </Space>
          )}
          <div style={{ marginTop: 16 }}>
            <Space>
              <Button type="primary" onClick={reset}>
                再提交一项
              </Button>
              <Button onClick={() => nav('/student/applications')}>查看我的材料</Button>
            </Space>
          </div>
        </Card>
      ) : null}
    </Space>
  );
}
