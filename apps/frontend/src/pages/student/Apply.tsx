import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Form,
  Grid,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
} from 'antd';
import {
  ArrowLeftOutlined,
  BookOutlined,
  BulbOutlined,
  CameraOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  InfoCircleOutlined,
  PaperClipOutlined,
  PlusOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { ACTIVITY_LEVEL_LABEL, ActivityLevel, BATCH_STATUS_LABEL, BatchStatus } from '@zc/shared';
import { RuleItem, fetchActiveBatch, fetchMyApplications, fetchRuleItems, fetchWhitelists, generateApplicationDraft, generateApplicationDraftFromImages, submitApplication, uploadMaterial } from '../../api';
import { errMsg } from '../../api/client';
import { fileSize } from '../../components/common';
import { useAuth } from '../../store/auth';

const ALLOW_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];
const MAX_FILE_MB = 20;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const CATEGORY_LABEL: Record<string, string> = { MORAL: '品德行为', ACADEMIC: '学业表现', SPORTS: '文体表现' };
const CATEGORIES = [
  { value: 'MORAL', label: '品德', icon: SafetyCertificateOutlined, cls: 'moral' },
  { value: 'ACADEMIC', label: '学业', icon: BookOutlined, cls: 'academic' },
  { value: 'SPORTS', label: '文体', icon: TrophyOutlined, cls: 'sports' },
] as const;
const CAT_CLS: Record<string, string> = { MORAL: 'moral', ACADEMIC: 'academic', SPORTS: 'sports' };

interface UploadedItem {
  fileId: string;
  uuid: string;
  name: string;
  size: number;
}

/** 清单中的一条申报（= 提交后的一份加分申请） */
interface Draft {
  id: string;
  ruleId: string;
  title: string;
  detail: Record<string, any>;
  files: UploadedItem[];
  /** 幂等键：每次编辑后重新生成；网络失败原样重试不会重复提交 */
  idem: string;
  /** 上次提交失败的原因（改动后清除） */
  error?: string;
}

/** 与后端 buildDedupeKey 同口径，用于提前提示「重复申报」 */
const norm = (s: any) => String(s ?? '').replace(/\s+/g, '').toUpperCase();
const normCompetition = (s: any) => String(s ?? '').replace(/[\s·・.。,，、()（）""'']/g, '').toLowerCase();
function dedupeKey(ruleCode: string, title: string, detail: Record<string, any>) {
  if (detail.certNo) return `CERT:${norm(detail.certNo)}`;
  if (ruleCode === 'ACA_COMPETITION') return `COMP:${norm(detail.competitionName ?? title)}|${norm(detail.rank)}`;
  if (detail.activityName) return `ACT:${norm(detail.activityName)}|${norm(detail.date)}`;
  if (detail.title) return `RES:${norm(detail.title)}`;
  return `T:${norm(title)}`;
}

/** 草稿本机暂存（按用户 + 批次隔离）：手机切出去拍照、刷新都不丢。存储不可用时静默降级 */
function useDrafts(key: string | null) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      setDrafts(raw ? (JSON.parse(raw) as Draft[]) : []);
    } catch {
      setDrafts([]);
    }
    loadedKey.current = key;
  }, [key]);
  useEffect(() => {
    if (!key || loadedKey.current !== key) return;
    try {
      if (drafts.length) localStorage.setItem(key, JSON.stringify(drafts));
      else localStorage.removeItem(key);
    } catch {
      /* 存储不可用：仅本次会话有效 */
    }
  }, [key, drafts]);
  return [drafts, setDrafts] as const;
}

/** 一条草稿还缺什么（空数组 = 可提交） */
function missingOf(d: Draft, rule: RuleItem | undefined): string[] {
  if (!rule) return ['加分项已停用'];
  const out: string[] = [];
  if (!d.title.trim()) out.push('名称');
  if (rule.code === 'ACA_COMPETITION' && d.detail.competitionName && normCompetition(d.detail.competitionName) !== normCompetition(d.title)) out.push('竞赛名称核对');
  for (const f of rule.detailSchema ?? []) {
    const v = rule.code === 'ACA_COMPETITION' && f.field === 'competitionName' ? d.title : d.detail[f.field];
    if (f.required && (v === undefined || v === null || v === '')) out.push(f.label);
  }
  if (rule.evidence?.some((e) => e.required) && !d.files.length) out.push('佐证材料');
  return out;
}

/** 明细摘要（卡片上展示：选项显示中文标签） */
function detailChips(d: Draft, rule: RuleItem | undefined): string[] {
  if (!rule) return [];
  const chips: string[] = [];
  for (const f of rule.detailSchema ?? []) {
    if (rule.code === 'ACA_COMPETITION' && f.field === 'competitionName') continue;
    const v = d.detail[f.field];
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'select') chips.push(f.options?.find((o) => o.value === v)?.label ?? String(v));
    else if (f.type === 'boolean' && typeof v === 'boolean') chips.push(`${f.label} ${v ? '是' : '否'}`);
    else chips.push(`${f.label} ${v}`);
  }
  return chips.slice(0, 3);
}

/** 兼容旧版文本输入保存的常见布尔值，未知文本仍保留供用户检查。 */
function normalizeBooleanDetail(detail: Record<string, any>, rule?: RuleItem): Record<string, any> {
  const result = { ...detail };
  for (const field of rule?.detailSchema ?? []) {
    if (field.type !== 'boolean') continue;
    const value = result[field.field];
    if (value === 'true' || value === '是') result[field.field] = true;
    else if (value === 'false' || value === '否') result[field.field] = false;
  }
  return result;
}

// ===================================================================== 细则弹窗 / 统一加分说明

function RuleDetailModal({ rule, open, onCancel }: { rule: RuleItem | null; open: boolean; onCancel: () => void }) {
  if (!rule) return null;
  const levelMap = rule.levelScoreMap ?? {};
  return (
    <Modal
      title={rule.name}
      open={open}
      onCancel={onCancel}
      footer={
        <Button type="primary" onClick={onCancel}>
          知道了
        </Button>
      }
      width="min(92vw, 560px)"
    >
      <div className="zc-rule-detail">
        <div className="zc-rule-detail-row">
          <span className="zc-rule-detail-k">所属板块</span>
          <span>{CATEGORY_LABEL[rule.category] ?? rule.category}</span>
        </div>
        {rule.defaultScore != null && (
          <div className="zc-rule-detail-row">
            <span className="zc-rule-detail-k">默认分值</span>
            <span>
              <b className="zc-num">{rule.defaultScore}</b> 分（以管理员复审核定为准）
            </span>
          </div>
        )}
        {Object.keys(levelMap).length > 0 && (
          <div className="zc-rule-detail-row">
            <span className="zc-rule-detail-k">级别分值</span>
            <Space size={6} wrap>
              {(Object.keys(ACTIVITY_LEVEL_LABEL) as ActivityLevel[])
                .filter((l) => levelMap[l] != null)
                .map((l) => (
                  <Tag key={l} color="blue">
                    {ACTIVITY_LEVEL_LABEL[l]} {levelMap[l]} 分
                  </Tag>
                ))}
            </Space>
          </div>
        )}
        <div className="zc-rule-detail-row">
          <span className="zc-rule-detail-k">上限规则</span>
          <Space size={6} wrap>
            {rule.caps?.perTermMax != null && <Tag color="blue">学期上限 {rule.caps.perTermMax} 分</Tag>}
            {rule.caps?.itemCountMax != null && <Tag>最多计 {rule.caps.itemCountMax} 项</Tag>}
            {rule.caps?.takeHighest && <Tag color="purple">同类取最高</Tag>}
            {!rule.caps?.perTermMax && !rule.caps?.itemCountMax && !rule.caps?.takeHighest && <Tag>无特殊上限</Tag>}
          </Space>
        </div>
        {rule.evidence?.length > 0 && (
          <div className="zc-rule-detail-row">
            <span className="zc-rule-detail-k">佐证材料</span>
            <Space size={6} wrap>
              {rule.evidence.map((e, i) => (
                <Tag key={i} color={e.required ? 'orange' : 'default'}>
                  {e.label}
                  {e.required ? '（必须）' : '（可选）'}
                </Tag>
              ))}
            </Space>
          </div>
        )}
        {rule.description && (
          <div className="zc-rule-detail-desc">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {rule.description}
            </Typography.Text>
          </div>
        )}
        {rule.whitelistType?.startsWith('COMP') && (
          <Alert style={{ marginTop: 10 }} type="warning" showIcon message="须在教务处当年度赛事认定目录内，不在目录内的竞赛不予加分" />
        )}
      </div>
    </Modal>
  );
}

function UnifiedNote({ names }: { names: string[] }) {
  if (!names.length) return null;
  return (
    <div className="zc-unified-banner" role="note">
      <div className="zc-unified-head">
        <InfoCircleOutlined />
        <b>这些加分由学院统一导入，无需申报</b>
      </div>
      <div className="zc-unified-tags">
        {names.map((n) => (
          <Tag key={n} className="zc-unified-tag">
            {n}
          </Tag>
        ))}
      </div>
      <span className="zc-unified-note">名单有遗漏的，请带证明材料联系管理员。</span>
    </div>
  );
}

// ===================================================================== 选择加分项（编辑器第一屏）

function RulePicker({
  rules,
  countByRule,
  onPick,
}: {
  rules: RuleItem[];
  countByRule: (ruleId: string) => { drafts: number; submitted: number };
  onPick: (r: RuleItem) => void;
}) {
  const [cat, setCat] = useState<string>('ACADEMIC');
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const k = q.trim();
    // 有搜索词时跨板块搜索，免得学生先猜分类
    return rules.filter((r) => (k ? r.name.includes(k) : r.category === cat));
  }, [rules, cat, q]);

  return (
    <div className="zc-ap-picker">
      <Input
        allowClear
        size="large"
        prefix={<SearchOutlined />}
        placeholder="搜索加分项，如：竞赛、志愿、证书"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {!q.trim() && (
        <Segmented
          block
          size="large"
          value={cat}
          onChange={(v) => setCat(v as string)}
          options={CATEGORIES.map((c) => ({
            value: c.value,
            label: (
              <span className={`zc-ap-seg ${c.cls}`}>
                <c.icon /> {c.label}
              </span>
            ),
          }))}
        />
      )}
      {list.length ? (
        <ul className="zc-ap-rules">
          {list.map((r) => {
            const n = countByRule(r.id);
            return (
              <li key={r.id}>
                <button type="button" className={`zc-ap-rule ${CAT_CLS[r.category]}`} onClick={() => onPick(r)}>
                  <span className="zc-ap-rule-main">
                    <b>{r.name}</b>
                    <span className="zc-ap-rule-tags">
                      {r.defaultScore != null && <Tag color="blue">{r.defaultScore} 分</Tag>}
                      {r.caps?.takeHighest && <Tag>同类取最高</Tag>}
                      {r.evidence?.some((e) => e.required) && <Tag color="orange">需佐证</Tag>}
                      {n.submitted > 0 && <Tag color="green">已提交 {n.submitted}</Tag>}
                      {n.drafts > 0 && <Tag color="geekblue">清单中 {n.drafts}</Tag>}
                    </span>
                  </span>
                  <RightOutlined className="zc-ap-rule-go" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty description={q.trim() ? '没有找到相关加分项' : '该板块暂无可自主申报的加分项'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </div>
  );
}

// ===================================================================== 填写表单（编辑器第二屏）

/** AI 只整理学生提供的事实；结果填入空字段，仍由学生核对、保存和提交。 */
function AiDraft({ rule, form, files, disabled }: { rule: RuleItem; form: ReturnType<typeof Form.useForm>[0]; files: UploadedItem[]; disabled: boolean }) {
  const { message } = App.useApp();
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedFiles = files.filter((f) => selectedIds.includes(f.fileId));
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const generate = async () => {
    if ((!text.trim() && !selectedFiles.length) || loading) return;
    setError('');
    setLoading(true);
    try {
      const result = selectedFiles.length
        ? await generateApplicationDraftFromImages({ ruleItemId: rule.id, fileIds: selectedFiles.map((f) => f.fileId), ...(text.trim() ? { text: text.trim() } : {}) })
        : await generateApplicationDraft({ ruleItemId: rule.id, text: text.trim() });
      if (!active.current) return;
      const current = form.getFieldsValue(true);
      const empty = (v: unknown) => v == null || (typeof v === 'string' && !v.trim());
      const values: { title?: string; detail: Record<string, unknown> } = { detail: {} };
      const titleSuggestion = result?.title || (rule.code === 'ACA_COMPETITION' ? result?.detail?.competitionName : undefined);
      if (empty(current.title) && typeof titleSuggestion === 'string' && titleSuggestion.trim() && titleSuggestion.trim().length <= 100) values.title = titleSuggestion.trim();
      for (const field of rule.detailSchema ?? []) {
        const value = result?.detail?.[field.field];
        if (!empty(current.detail?.[field.field]) || empty(value)) continue;
        if (field.type === 'select') {
          if (typeof value === 'string' && field.options?.some((o) => o.value === value)) values.detail[field.field] = value;
        } else if (field.type === 'number') {
          if (typeof value === 'number' && Number.isFinite(value)) values.detail[field.field] = value;
        } else if (field.type === 'date') {
          if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) values.detail[field.field] = value;
        } else if (field.type === 'boolean') {
          if (typeof value === 'boolean') values.detail[field.field] = value;
        } else if (typeof value === 'string' && value.trim().length <= 200) {
          values.detail[field.field] = value.trim();
        }
      }
      if (!values.title && !Object.keys(values.detail).length) {
        message.info('没有可填入的空字段，请补充事实或手动填写');
        return;
      }
      form.setFieldsValue(values);
      message.success('已填入空字段，请核对内容并补充佐证');
    } catch (e) {
      if (active.current) setError(errMsg(e));
    } finally {
      if (active.current) setLoading(false);
    }
  };

  return (
    <div className="zc-ap-ai">
      <div className="zc-ap-ai-title"><BulbOutlined aria-hidden="true" /> <b>AI 辅助填写</b></div>
      <p className="zc-ap-ai-hint">描述真实经历，也可选择已上传的佐证图片，AI 会整理到下方空字段。请核对结果后自行保存和提交。</p>
      <Input.TextArea
        value={text}
        onChange={(e) => { setText(e.target.value); setError(''); }}
        maxLength={3000}
        showCount
        autoSize={{ minRows: 3, maxRows: 6 }}
        disabled={disabled || loading}
        placeholder="例如：2026 年参加校运动会，获得男子 100 米第三名"
        aria-label="用于 AI 填写的真实经历"
      />
      <div className="zc-ap-ai-images">
        <b>选择佐证图片（可选，最多 3 张）</b>
        <p>请先在下方「佐证材料」上传图片。支持 JPG、PNG、WebP，每张不超过 5 MB；暂不支持 PDF。</p>
        {files.map((f) => {
          const image = /\.(jpe?g|png|webp)$/i.test(f.name);
          const supported = image && f.size <= 5 * 1024 * 1024;
          const checked = selectedIds.includes(f.fileId);
          const hint = !image ? '不支持此格式' : f.size > 5 * 1024 * 1024 ? '超过 5 MB' : '';
          return <Checkbox key={f.fileId} checked={checked && supported} disabled={disabled || loading || !supported || (!checked && selectedFiles.length >= 3)} onChange={(e) => {
            setSelectedIds((ids) => e.target.checked ? [...ids, f.fileId] : ids.filter((id) => id !== f.fileId));
            setError('');
          }}><span>{f.name}{hint ? `（${hint}）` : ''}</span></Checkbox>;
        })}
      </div>
      <p className="zc-ap-ai-privacy">点击生成会将输入文字和所选图片发送给第三方 AI 服务，图片可能包含个人信息，请确认后再选择。发起请求会消耗每日额度，服务失败也计次。</p>
      {error && <Alert className="zc-ap-ai-error" type="error" showIcon message={error} />}
      <Button className="zc-ap-ai-button" onClick={generate} loading={loading} disabled={disabled || (!text.trim() && !selectedFiles.length)}>
        {loading ? '正在生成…' : '生成填写建议'}
      </Button>
    </div>
  );
}

function EntryFields({
  rule,
  files,
  setFiles,
  uploading,
  setUploading,
  disabled,
  large,
}: {
  rule: RuleItem;
  files: UploadedItem[];
  setFiles: (f: UploadedItem[] | ((x: UploadedItem[]) => UploadedItem[])) => void;
  uploading: number;
  setUploading: React.Dispatch<React.SetStateAction<number>>;
  disabled: boolean;
  large: boolean;
}) {
  const { message } = App.useApp();
  const [wl, setWl] = useState<string[]>([]);
  const active = useRef(true);
  const timer = useRef<number>();
  const isComp = !!rule.whitelistType?.startsWith('COMP');
  const size = large ? 'large' : 'middle';

  // 赛事目录：输入即搜（250ms 防抖），可自由输入
  const searchWl = (q: string) => {
    window.clearTimeout(timer.current);
    if (!q.trim()) return setWl([]);
    timer.current = window.setTimeout(() => {
      fetchWhitelists({ q, limit: 20 })
        .then((ws) => setWl(ws.map((w) => w.name)))
        .catch(() => undefined);
    }, 250);
  };
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; window.clearTimeout(timer.current); };
  }, []);

  const beforeUpload = (f: File) => {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOW_EXT.includes(ext)) {
      message.error(`「${f.name}」格式不支持，请上传 PDF 或图片`);
      return Upload.LIST_IGNORE;
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      message.error(`「${f.name}」超过 ${MAX_FILE_MB}MB`);
      return Upload.LIST_IGNORE;
    }
    setUploading((n) => n + 1);
    uploadMaterial(f)
      .then((r) => { if (active.current) setFiles((xs) => [...xs, { fileId: r.id, uuid: r.uuid, name: f.name, size: r.size }]); })
      .catch((e) => { if (active.current) message.error(`「${f.name}」上传失败：${errMsg(e)}`); })
      .finally(() => { if (active.current) setUploading((n) => n - 1); });
    return false;
  };

  const evidenceHint = rule.evidence?.length
    ? rule.evidence.map((e) => e.label + (e.required ? '（必须）' : '')).join('、')
    : '可选';

  return (
    <>
      <Form.Item
        name="title"
        label={isComp ? '竞赛名称' : '活动 / 证书全称'}
        rules={[{ required: true, whitespace: true, message: isComp ? '请填写竞赛名称' : '请填写活动或证书全称' }]}
        extra={isComp ? '须在教务处当年度赛事认定目录内，输入关键字可搜索' : '按证书或活动的官方全称填写'}
      >
        {isComp ? (
          <AutoComplete size={size} options={wl.map((n) => ({ value: n }))} onSearch={searchWl} placeholder="如：蓝桥杯全国软件和信息技术专业人才大赛" />
        ) : (
          <Input size={size} placeholder="如：2025 年大连市马拉松志愿服务" maxLength={100} />
        )}
      </Form.Item>

      {rule.detailSchema?.filter((f) => !(rule.code === 'ACA_COMPETITION' && f.field === 'competitionName')).map((f) => (
        <Form.Item
          key={f.field}
          name={['detail', f.field]}
          label={f.label}
          rules={f.required ? [{ required: true, message: `请填写${f.label}` }] : undefined}
          {...(f.type === 'boolean' ? {
            getValueProps: (value: unknown) => ({ value: typeof value === 'boolean' ? String(value) : value }),
            getValueFromEvent: (value: string | undefined) => value === 'true' ? true : value === 'false' ? false : value,
          } : {})}
        >
          {f.type === 'select' ? (
            <Select
              size={size}
              placeholder={`选择${f.label}`}
              options={f.options?.map((o) => ({
                value: o.value,
                label: typeof o.score === 'number' ? `${o.label}（${o.score} 分）` : o.label,
              }))}
            />
          ) : f.type === 'boolean' ? (
            <Select size={size} allowClear placeholder={`选择${f.label}`} options={[{ value: 'true', label: '是' }, { value: 'false', label: '否' }]} />
          ) : f.type === 'number' ? (
            <InputNumber size={size} style={{ width: '100%' }} placeholder={f.placeholder ?? `填写${f.label}`} inputMode="decimal" />
          ) : f.type === 'date' ? (
            <Input size={size} type="date" />
          ) : (
            <Input size={size} placeholder={f.placeholder ?? `填写${f.label}`} maxLength={200} />
          )}
        </Form.Item>
      ))}

      <Form.Item label="佐证材料" required={rule.evidence?.some((e) => e.required)} extra={`${evidenceHint} · PDF 或图片，单个不超过 ${MAX_FILE_MB}MB`}>
        <div className="zc-ap-files">
          {files.map((f) => (
            <div key={f.fileId} className="zc-ap-file">
              <PaperClipOutlined />
              <span className="zc-ap-file-name">{f.name}</span>
              <span className="zc-ap-file-size">{fileSize(f.size)}</span>
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label={`删除 ${f.name}`}
                onClick={() => setFiles((xs) => xs.filter((x) => x.fileId !== f.fileId))}
              />
            </div>
          ))}
          <Upload multiple accept={ALLOW_EXT.map((e) => `.${e}`).join(',')} showUploadList={false} beforeUpload={beforeUpload} disabled={disabled}>
            <button type="button" className="zc-ap-upload" disabled={disabled}>
              {uploading > 0 ? <Spin size="small" /> : <CameraOutlined />}
              <span>{uploading > 0 ? `正在上传 ${uploading} 个文件…` : files.length ? '继续添加' : '拍照或选择文件'}</span>
            </button>
          </Upload>
        </div>
      </Form.Item>
    </>
  );
}

// ===================================================================== 页面

/** 学生加分申报：申报清单（同一加分项可添加多条）→ 一起提交 */
export default function Apply() {
  const { message, modal } = App.useApp();
  const { user } = useAuth();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;

  const [batch, setBatch] = useState<any>(null);
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [mine, setMine] = useState<any[]>([]);
  const [mineError, setMineError] = useState('');
  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [drafts, setDrafts] = useDrafts(user && batch ? `zc:apply-drafts:${user.id}:${batch.id}` : null);

  // 编辑器：editing = 正在编辑的草稿 id（null = 新建）；rule = 已选加分项（null = 还在选）
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [editRule, setEditRule] = useState<RuleItem | null>(null);
  const [competitionNameMismatch, setCompetitionNameMismatch] = useState(false);
  const [editFiles, setEditFiles] = useState<UploadedItem[]>([]);
  const [editUploading, setEditUploading] = useState(0);
  const [form] = Form.useForm();

  const [detailRule, setDetailRule] = useState<RuleItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [lastResult, setLastResult] = useState<{ ok: { title: string; res: any }[]; failed: number } | null>(null);

  const loadMine = useCallback((batchId: string) => {
    fetchMyApplications(batchId)
      .then((items) => { setMine(items); setMineError(''); })
      .catch(() => setMineError('已提交记录加载失败，暂时无法提示可能重复的申报。'));
  }, []);

  const loadData = useCallback(async () => {
    setLoadingData(true);
    setLoadError('');
    try {
      const [activeBatch, items] = await Promise.all([fetchActiveBatch(), fetchRuleItems()]);
      setBatch(activeBatch);
      setRules(items);
      if (activeBatch) loadMine(activeBatch.id);
    } catch (e) {
      setLoadError(errMsg(e));
    } finally {
      setLoadingData(false);
    }
  }, [loadMine]);

  useEffect(() => { void loadData(); }, [loadData]);

  const applyEnabled = batch?.applyEnabled !== false;
  const collectable = !!batch && ['COLLECTING', 'FIRST_REVIEW'].includes(batch.status) && applyEnabled;
  const ruleMap = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules]);
  const selfRules = useMemo(() => rules.filter((r) => r.applyType !== 'UNIFIED' && r.isActive !== false), [rules]);
  const unifiedNames = useMemo(() => rules.filter((r) => r.applyType === 'UNIFIED').map((r) => r.name), [rules]);

  // 后端口径：同一去重键已存在且未被「初审退回 / 复审驳回」时拒绝重复提交（撤回后的草稿也算）
  const blockedKeys = useMemo(
    () => new Set(mine.filter((a) => !['FIRST_REJECTED', 'REJECTED'].includes(a.status)).map((a) => `${a.ruleItemId}|${a.dedupeKey}`)),
    [mine],
  );
  const isDuplicate = (d: Draft, rule?: RuleItem) => !!rule && blockedKeys.has(`${rule.id}|${dedupeKey(rule.code, d.title, d.detail)}`);

  const countByRule = useCallback(
    (ruleId: string) => ({
      drafts: drafts.filter((d) => d.ruleId === ruleId).length,
      submitted: mine.filter((a) => a.ruleItemId === ruleId && a.status !== 'DRAFT').length,
    }),
    [drafts, mine],
  );

  // ---------- 编辑器 ----------
  const openNew = () => {
    setEditorVersion((v) => v + 1);
    setEditUploading(0);
    setEditing(null);
    setEditRule(null);
    setCompetitionNameMismatch(false);
    setEditFiles([]);
    form.resetFields();
    setEditorOpen(true);
  };
  const openEdit = (d: Draft) => {
    setEditorVersion((v) => v + 1);
    setEditUploading(0);
    const rule = ruleMap.get(d.ruleId);
    setCompetitionNameMismatch(rule?.code === 'ACA_COMPETITION' && !!d.detail.competitionName && normCompetition(d.detail.competitionName) !== normCompetition(d.title));
    setEditing(d.id);
    setEditRule(rule ?? null);
    setEditFiles(d.files);
    form.resetFields();
    form.setFieldsValue({ title: d.title, detail: normalizeBooleanDetail(d.detail, rule) });
    setEditorOpen(true);
  };
  const pickRule = (r: RuleItem) => {
    setEditorVersion((v) => v + 1);
    setEditUploading(0);
    setEditRule(r);
    setCompetitionNameMismatch(false);
    setEditFiles([]);
    form.resetFields();
  };
  const closeEditor = () => setEditorOpen(false);

  /** 保存到清单；again = 保存后继续添加同一加分项（多个竞赛/活动逐条录） */
  const save = async (again: boolean) => {
    if (!editRule) return;
    if (editUploading) { message.warning('请等待佐证材料上传完成'); return; }
    let v: { title: string; detail?: Record<string, any> };
    try {
      v = await form.validateFields();
    } catch {
      message.warning('还有必填项没填');
      return;
    }
    const detail = Object.fromEntries(Object.entries(v.detail ?? {}).filter(([, x]) => x !== undefined && x !== null && x !== ''));
    if (editRule.code === 'ACA_COMPETITION') detail.competitionName = String(v.title ?? '').trim();
    const next: Draft = {
      id: editing ?? newId(),
      ruleId: editRule.id,
      title: String(v.title ?? '').trim(),
      detail,
      files: editFiles,
      idem: newId(),
    };
    setDrafts((xs) => (editing ? xs.map((x) => (x.id === editing ? next : x)) : [...xs, next]));
    setLastResult(null);
    if (again) {
      setEditorVersion((v) => v + 1);
      message.success('已加入清单，继续填写下一条');
      setEditing(null);
      setCompetitionNameMismatch(false);
      setEditFiles([]);
      form.resetFields();
    } else {
      message.success(editing ? '已保存修改' : '已加入清单');
      setEditorOpen(false);
    }
  };

  const duplicateDraft = (d: Draft) => {
    const r = ruleMap.get(d.ruleId);
    if (!r) return;
    setEditorVersion((v) => v + 1);
    setEditUploading(0);
    // 复制同类：保留加分项与选项，清空名称和附件，直接打开编辑
    setEditing(null);
    setEditRule(r);
    setCompetitionNameMismatch(false);
    setEditFiles([]);
    form.resetFields();
    form.setFieldsValue({ detail: normalizeBooleanDetail(d.detail, r) });
    setEditorOpen(true);
  };

  const removeDraft = (d: Draft) =>
    modal.confirm({
      title: '从清单中删除这一条？',
      content: d.title || ruleMap.get(d.ruleId)?.name,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => setDrafts((xs) => xs.filter((x) => x.id !== d.id)),
    });

  // ---------- 提交 ----------
  const readyDrafts = drafts.filter((d) => !missingOf(d, ruleMap.get(d.ruleId)).length);
  const submitAll = async () => {
    if (!batch || !readyDrafts.length) return;
    setSubmitting(true);
    setProgress(0);
    const ok: { title: string; res: any }[] = [];
    const failed = new Map<string, string>();
    const done = new Set<string>();
    for (const d of readyDrafts) {
      try {
        const res = await submitApplication(
          { batchId: batch.id, ruleItemId: d.ruleId, title: d.title, detail: d.detail, fileIds: d.files.map((f) => f.fileId) },
          d.idem,
        );
        ok.push({ title: d.title, res });
        done.add(d.id);
      } catch (e) {
        failed.set(d.id, errMsg(e));
      }
      setProgress((n) => n + 1);
    }
    // 成功的移出清单；失败的留在原位并标出原因
    setDrafts((xs) => xs.filter((x) => !done.has(x.id)).map((x) => (failed.has(x.id) ? { ...x, error: failed.get(x.id) } : x)));
    setSubmitting(false);
    setLastResult({ ok, failed: failed.size });
    loadMine(batch.id);
    if (!failed.size) message.success(`已提交 ${ok.length} 条，等待班级初审`);
    else if (!ok.length) message.error('提交失败，请查看清单中的红色提示');
    else message.warning(`成功 ${ok.length} 条，失败 ${failed.size} 条`);
  };

  const notReady = drafts.length - readyDrafts.length;
  const submittedCount = mine.filter((a) => a.status !== 'DRAFT').length;

  // ---------- 渲染 ----------
  const editorTitle = !editRule ? '选择加分项' : editing ? '修改' : '添加一条';
  const editorFooter = editRule ? (
    <div className="zc-ap-editor-foot">
      {!editing && (
        <Button size={isMobile ? 'large' : 'middle'} onClick={() => save(true)} disabled={!collectable || editUploading > 0}>
          保存，再加一条同类
        </Button>
      )}
      <Button type="primary" size={isMobile ? 'large' : 'middle'} onClick={() => save(false)} disabled={!collectable || editUploading > 0}>
        {editing ? '保存修改' : '加入清单'}
      </Button>
    </div>
  ) : null;

  if (loadingData) return <div className="zc-ap-loading"><Spin tip="正在加载申报信息"><div className="zc-ap-loading-space" /></Spin></div>;
  if (loadError) return <Alert type="error" showIcon message="申报信息加载失败" description={loadError} action={<Button onClick={() => void loadData()}>重试</Button>} />;

  return (
    <div className="zc-ap">
      {!batch && <Alert type="info" showIcon message="当前没有开放的测评批次" description="请等待管理员开放批次后再申报。" />}
      {batch && mineError && <Alert type="warning" showIcon message={mineError} action={<Button onClick={() => loadMine(batch.id)}>重试</Button>} />}
      {batch && !applyEnabled && (
        <Alert type="error" showIcon message="提交通道已临时关闭" description="管理员暂时关闭了加分申报，请留意班级群和公告，开放后再提交。" />
      )}
      {batch && applyEnabled && !collectable && (
        <Alert type="warning" showIcon message={`当前批次处于「${BATCH_STATUS_LABEL[batch.status as BatchStatus] ?? batch.status}」阶段，暂不能提交加分申报`} />
      )}

      {/* 页头 */}
      <header className="zc-ap-head">
        <div>
          <h1>加分申报</h1>
          <p>
            比赛、证书、活动各加一条，同一类可以加多条。
            {submittedCount > 0 && (
              <>
                {' '}
                本批次已提交 <b className="zc-num">{submittedCount}</b> 条，
                <Link to="/student/applications">查看进度</Link>
              </>
            )}
          </p>
        </div>
        {!isMobile && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openNew} disabled={!collectable}>
            添加一条
          </Button>
        )}
      </header>

      {/* 上次提交结果 */}
      {lastResult && lastResult.ok.length > 0 && (
        <div className="zc-ap-result">
          <b>已提交 {lastResult.ok.length} 条，等待班级初审</b>
          <ul>
            {lastResult.ok.map((x, i) => (
              <li key={i}>
                {x.title}
                {x.res?.declaredScore != null && <span>申报 {x.res.declaredScore} 分</span>}
                {x.res?.whitelistHit && <span>目录命中：{x.res.whitelistHit}</span>}
              </li>
            ))}
          </ul>
          <Link to="/student/applications">到「我的」查看审核进度</Link>
        </div>
      )}

      {/* 申报清单 */}
      {drafts.length ? (
        <section className="zc-ap-list" aria-label="待提交清单">
          <div className="zc-ap-list-head">
            <span>
              待提交 <b className="zc-num">{drafts.length}</b> 条
              {notReady > 0 && <em>，{notReady} 条还没填完</em>}
            </span>
          </div>
          {drafts.map((d) => {
            const rule = ruleMap.get(d.ruleId);
            const miss = missingOf(d, rule);
            const dup = !miss.length && isDuplicate(d, rule);
            const chips = detailChips(d, rule);
            return (
              <article key={d.id} className={`zc-ap-item ${CAT_CLS[rule?.category ?? ''] ?? ''} ${d.error ? 'err' : ''}`}>
                <button type="button" className="zc-ap-item-main" onClick={() => openEdit(d)} aria-label={`修改：${d.title || rule?.name}`}>
                  <span className="zc-ap-item-rule">
                    {CATEGORY_LABEL[rule?.category ?? ''] ?? ''} · {rule?.name ?? '已停用的加分项'}
                  </span>
                  <span className={`zc-ap-item-title ${d.title ? '' : 'empty'}`}>{d.title || '未填写名称'}</span>
                  <span className="zc-ap-item-meta">
                    {chips.map((c) => (
                      <Tag key={c}>{c}</Tag>
                    ))}
                    <span className="zc-ap-item-files">
                      <PaperClipOutlined /> {d.files.length}
                    </span>
                    {d.error ? (
                      <Tag color="red">提交失败</Tag>
                    ) : miss.length ? (
                      <Tag color="orange">缺{miss.join('、')}</Tag>
                    ) : dup ? (
                      <Tag color="gold">可能与已提交的重复</Tag>
                    ) : (
                      <Tag color="green">可提交</Tag>
                    )}
                  </span>
                  {d.error && <span className="zc-ap-item-err">{d.error}</span>}
                </button>
                <div className="zc-ap-item-actions">
                  <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(d)}>
                    修改
                  </Button>
                  <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => duplicateDraft(d)} disabled={!collectable}>
                    再加一条同类
                  </Button>
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeDraft(d)} aria-label="删除" />
                </div>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="zc-ap-empty">
          <b>清单还是空的</b>
          <p>把这学期的比赛、证书、志愿和文体活动逐条加进来，填完后一起提交。</p>
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={openNew} disabled={!collectable}>
            添加一条
          </Button>
        </section>
      )}

      <UnifiedNote names={unifiedNames} />

      {/* 底部操作条：手机贴在底部导航之上，桌面贴在视口底部 */}
      {drafts.length > 0 && (
        <div className="zc-ap-bar">
          {isMobile && (
            <Button size="large" icon={<PlusOutlined />} onClick={openNew} disabled={!collectable} aria-label="添加一条">
              添加
            </Button>
          )}
          <Button type="primary" size="large" loading={submitting} disabled={!collectable || !readyDrafts.length} onClick={submitAll} className="zc-ap-submit">
            {submitting ? `提交中 ${progress}/${readyDrafts.length}` : `提交 ${readyDrafts.length} 条`}
          </Button>
        </div>
      )}

      {/* 编辑器：手机底部弹出，桌面右侧抽屉 */}
      <Drawer
        open={editorOpen}
        onClose={closeEditor}
        placement={isMobile ? 'bottom' : 'right'}
        height={isMobile ? '92dvh' : undefined}
        width={isMobile ? undefined : 520}
        className="zc-ap-editor"
        title={
          <div className="zc-ap-editor-title">
            {editRule && !editing && (
              <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={() => setEditRule(null)} aria-label="重新选择加分项" />
            )}
            <span>{editorTitle}</span>
          </div>
        }
        footer={editorFooter}
        forceRender
      >
        <Form form={form} layout="vertical" requiredMark="optional" className="zc-ap-form">
          {editorOpen && (!editRule ? (
            <RulePicker rules={selfRules} countByRule={countByRule} onPick={pickRule} />
          ) : (
            <>
            <div className={`zc-ap-editor-rule ${CAT_CLS[editRule.category]}`}>
              <div>
                <span>{CATEGORY_LABEL[editRule.category]}</span>
                <b>{editRule.name}</b>
              </div>
              <Button type="link" size="small" onClick={() => setDetailRule(editRule)}>
                细则
              </Button>
            </div>
            {competitionNameMismatch && <Alert type="warning" showIcon message="原草稿的竞赛名称与标题不一致" description="请核对竞赛名称；保存后将以标题为准。" style={{ marginBottom: 16 }} />}
              <AiDraft key={`ai:${editRule.id}:${editorVersion}`} rule={editRule} form={form} files={editFiles} disabled={!collectable} />
              <EntryFields key={`fields:${editRule.id}:${editorVersion}`} rule={editRule} files={editFiles} setFiles={setEditFiles} uploading={editUploading} setUploading={setEditUploading} disabled={!collectable} large={isMobile} />
            </>
          ))}
        </Form>
      </Drawer>

      <RuleDetailModal rule={detailRule} open={!!detailRule} onCancel={() => setDetailRule(null)} />
    </div>
  );
}
