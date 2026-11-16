import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Collapse, Empty, Input, Modal, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DownloadOutlined, EditOutlined, InfoCircleOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { SCHOLARSHIP_AWARD_LABEL, SCHOLARSHIP_AWARD_ORDER, ScholarshipAward } from '@zc/shared';
import {
  ScholarshipResult,
  ScholarshipRow,
  downloadScholarshipExport,
  fetchScholarshipYears,
  fetchScholarships,
  setScholarshipAward,
} from '../../api';
import { errMsg } from '../../api/client';
import { fetchHistoricalScholarshipSummary, HistoricalScholarshipSummaryRow } from '../../api/historical-import';
import { useAuth } from '../../store/auth';
import { useNavigate } from 'react-router-dom';

type FailRule = 'STRICT' | 'ENGINE';

const AWARD_COLOR: Record<string, string> = {
  NATIONAL: 'red',
  NATIONAL_ENCOURAGE: 'volcano',
  SCHOOL_1: 'gold',
  SCHOOL_2: 'blue',
  SCHOOL_3: 'cyan',
};
const AWARD_OPTIONS = SCHOLARSHIP_AWARD_ORDER.map((k) => ({ value: k, label: SCHOLARSHIP_AWARD_LABEL[k] }));
const FAIL_RULE_HELP: Record<FailRule, string> = {
  STRICT: '两学期内任何课程（含选修、含补考前的期末成绩）不及格、缺考或取消考试资格，都算挂科',
  ENGINE: '只认综测计算时已扣「必修不及格分」的情况，与查分页的扣分一致',
};
const fmt = (v: number | null) => (v == null ? '—' : v.toFixed(2));
const termLabel = (k: string) => (k.endsWith('-1') ? '第一学期' : '第二学期');

/** 奖学金评定：两学期综测总和排名（无挂科者参与），管理员手动设定奖项 */
function ScholarshipAssessment() {
  const { message, modal } = App.useApp();
  const [years, setYears] = useState<string[]>([]);
  const [year, setYear] = useState('');
  const [grade, setGrade] = useState<number | undefined>();
  const [major, setMajor] = useState<string | undefined>();
  const [failRule, setFailRule] = useState<FailRule>('STRICT');
  const [data, setData] = useState<ScholarshipResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'eligible' | 'others'>('eligible');
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<ScholarshipRow | null>(null);
  const [noteText, setNoteText] = useState('');

  useEffect(() => {
    fetchScholarshipYears()
      .then((ys) => {
        setYears(ys.map((y) => y.academicYear));
        if (ys.length) setYear(ys[0].academicYear);
      })
      .catch((e) => message.error(errMsg(e)));
  }, [message]);

  const load = useCallback(() => {
    if (!year) return;
    setLoading(true);
    fetchScholarships({ academicYear: year, grade, major, failRule })
      .then((r) => {
        setData(r);
        // 首次加载未选年级时默认最新一届，避免不同年级混排
        if (grade === undefined && r.grades.length) setGrade(r.grades[0]);
      })
      .catch((e) => message.error(errMsg(e)))
      .finally(() => setLoading(false));
  }, [year, grade, major, failRule, message]);
  useEffect(load, [load]);

  const rows = data?.rows ?? [];
  const eligible = useMemo(() => rows.filter((r) => r.eligible), [rows]);
  const others = useMemo(() => rows.filter((r) => !r.eligible), [rows]);
  const shown = useMemo(() => {
    const list = view === 'eligible' ? eligible : others;
    const k = q.trim();
    return k ? list.filter((r) => r.name.includes(k) || r.studentNo.includes(k) || r.className.includes(k)) : list;
  }, [view, eligible, others, q]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) if (r.award) c[r.award] = (c[r.award] ?? 0) + 1;
    return c;
  }, [rows]);

  /**
   * 保存奖项（乐观更新，失败回滚）。
   * note：undefined = 不改备注（沿用原值）；null / 空串 = 清空；其余 = 新备注。取消奖项时备注一并清除。
   */
  const save = async (row: ScholarshipRow, award: string | null, note?: string | null) => {
    const prev = { award: row.award, awardNote: row.awardNote };
    const finalNote = award ? (note === undefined ? row.awardNote : note || null) : null;
    const patchRow = (a: string | null, n: string | null) =>
      setData((d) => (d ? { ...d, rows: d.rows.map((x) => (x.studentId === row.studentId ? { ...x, award: a, awardNote: n } : x)) } : d));
    patchRow(award, finalNote);
    setSaving(row.studentId);
    try {
      // 后端每次按传入值覆盖备注：始终带上最终备注（空串 = 清空）
      await setScholarshipAward({ academicYear: year, studentId: row.studentId, award, note: award ? finalNote ?? '' : undefined });
      message.success(award ? `${row.name}：${SCHOLARSHIP_AWARD_LABEL[award as ScholarshipAward]}` : `已取消 ${row.name} 的奖项`);
    } catch (e) {
      patchRow(prev.award, prev.awardNote);
      message.error(errMsg(e));
    } finally {
      setSaving(null);
    }
  };

  /** 未参与排名的学生设奖：先确认（管理员裁量，不硬拦） */
  const onAward = (row: ScholarshipRow, award: string | null) => {
    if (award && !row.eligible) {
      modal.confirm({
        title: `${row.name} 未参与排名`,
        content: `原因：${row.reason}。确定仍要设定为「${SCHOLARSHIP_AWARD_LABEL[award as ScholarshipAward]}」吗？`,
        okText: '仍要设定',
        cancelText: '取消',
        onOk: () => save(row, award),
      });
      return;
    }
    save(row, award);
  };

  const awardCell = (r: ScholarshipRow) => (
    <Space size={4}>
      <Select
        size="small"
        style={{ width: 150 }}
        allowClear
        placeholder="未评"
        value={r.award ?? undefined}
        loading={saving === r.studentId}
        onChange={(v) => onAward(r, v ?? null)}
        options={AWARD_OPTIONS.map((o) => ({ value: o.value, label: <Tag color={AWARD_COLOR[o.value]}>{o.label}</Tag> }))}
      />
      {r.award && (
        <Tooltip title={r.awardNote ? `备注：${r.awardNote}` : '添加备注'}>
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            className={r.awardNote ? 'zc-sch-noted' : ''}
            aria-label="编辑备注"
            onClick={() => {
              setNoteFor(r);
              setNoteText(r.awardNote ?? '');
            }}
          />
        </Tooltip>
      )}
    </Space>
  );

  const studentCell = (r: ScholarshipRow) => (
    <div className="zc-gr-cell2">
      <b>{r.name}</b>
      <span>
        {r.studentNo} · {r.className}
      </span>
    </div>
  );

  const semesters = data?.semesters ?? [];
  const termCols: ColumnsType<ScholarshipRow> = semesters.map((s, i) => ({
    title: (
      <span>
        {termLabel(s.semesterKey)}
        {s.source === 'CALC' && <Tag color="orange" style={{ marginLeft: 4 }}>未发布</Tag>}
      </span>
    ),
    width: 120,
    align: 'right',
    render: (_: unknown, r: ScholarshipRow) => <span className="zc-num">{fmt(r.terms[i])}</span>,
  }));

  const failCell = (r: ScholarshipRow) =>
    r.fails.length ? (
      <Tooltip
        title={
          <ul className="zc-sch-fails">
            {r.fails.map((f, i) => (
              <li key={i}>
                {termLabel(f.semesterKey)} · {f.courseName}：{f.score}
                {f.examType === '补考' ? '（补考）' : ''}
                {f.required ? '' : '（非必修）'}
              </li>
            ))}
          </ul>
        }
      >
        <span className="zc-sch-failtext">
          {r.fails.slice(0, 2).map((f) => `${f.courseName} ${f.score}`).join('、')}
          {r.fails.length > 2 ? ` 等 ${r.fails.length} 门` : ''}
        </span>
      </Tooltip>
    ) : (
      '—'
    );

  const eligibleCols: ColumnsType<ScholarshipRow> = [
    { title: '排名', dataIndex: 'rank', width: 70, fixed: 'left', render: (v) => <b className="zc-num zc-sch-rank">{v}</b> },
    { title: '学生', width: 200, render: (_, r) => studentCell(r) },
    ...termCols,
    { title: '两学期总和', dataIndex: 'sum', width: 110, align: 'right', render: (v) => <b className="zc-num">{fmt(v)}</b> },
    { title: '奖学金', width: 210, render: (_, r) => awardCell(r) },
  ];
  const otherCols: ColumnsType<ScholarshipRow> = [
    { title: '学生', width: 200, render: (_, r) => studentCell(r) },
    ...termCols,
    { title: '两学期总和', dataIndex: 'sum', width: 110, align: 'right', render: (v) => <span className="zc-num">{fmt(v)}</span> },
    { title: '不参与原因', dataIndex: 'reason', width: 150, render: (v) => <Tag color={String(v).startsWith('缺少') ? 'default' : 'red'}>{v}</Tag> },
    { title: '不及格课程', width: 240, render: (_, r) => failCell(r) },
    { title: '奖学金', width: 210, render: (_, r) => awardCell(r) },
  ];

  const query = { academicYear: year, grade, major, failRule };
  const notPublished = semesters.filter((s) => s.source !== 'PUBLISHED');

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {/* 筛选条 */}
      <section className="zc-sch-bar">
        <div className="zc-sch-filters">
          <label>
            <span>学年</span>
            <Select style={{ width: 140 }} value={year || undefined} onChange={(v) => { setYear(v); setGrade(undefined); setMajor(undefined); }} options={years.map((y) => ({ value: y, label: `${y} 学年` }))} placeholder="选择学年" />
          </label>
          <label>
            <span>年级</span>
            <Select style={{ width: 110 }} value={grade} onChange={(v) => { setGrade(v); setMajor(undefined); }} options={(data?.grades ?? []).map((g) => ({ value: g, label: `${g} 级` }))} />
          </label>
          <label>
            <span>专业</span>
            <Select style={{ width: 170 }} value={major} onChange={setMajor} allowClear placeholder="全部专业" options={(data?.majors ?? []).map((m) => ({ value: m, label: m }))} />
          </label>
          <label>
            <span>
              挂科口径
              <Tooltip title={FAIL_RULE_HELP[failRule]}>
                <InfoCircleOutlined style={{ marginLeft: 4, color: 'var(--zc-text-3)' }} />
              </Tooltip>
            </span>
            <Segmented
              value={failRule}
              onChange={(v) => setFailRule(v as FailRule)}
              options={[
                { value: 'STRICT', label: '严格' },
                { value: 'ENGINE', label: '同综测计算' },
              ]}
            />
          </label>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load} aria-label="刷新" />
          <Button type="primary" icon={<DownloadOutlined />} disabled={!data} onClick={() => downloadScholarshipExport(query).catch((e) => message.error(errMsg(e)))}>
            导出 Excel
          </Button>
        </Space>
      </section>

      {data && (
        <>
          {/* 学期来源 + 排名范围 */}
          <div className="zc-sch-info">
            {semesters.map((s) => (
              <span key={s.semesterKey} className={`zc-sch-src ${s.source === 'PUBLISHED' ? 'ok' : 'warn'}`}>
                {termLabel(s.semesterKey)} {s.semesterKey} ·{' '}
                {s.source === 'PUBLISHED' ? '已发布成绩' : s.source === 'CALC' ? `未发布，使用计算结果 v${s.version}` : '暂无成绩'}
              </span>
            ))}
            <span className="zc-sch-scope">
              排名范围：{grade ? `${grade} 级` : '全部年级'}
              {major ? ` · ${major}` : ' · 全部专业'}
            </span>
          </div>
          {notPublished.length > 0 && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              {notPublished.map((s) => termLabel(s.semesterKey)).join('、')}成绩尚未发布，分数和排名可能还会变化；建议发布后再最终确定奖项。
            </Typography.Text>
          )}

          {/* 奖项统计 */}
          <div className="zc-sch-stats">
            <div className="zc-sch-stat main">
              <span>参与排名</span>
              <b className="zc-num">{eligible.length}</b>
              <small>共 {rows.length} 人</small>
            </div>
            {SCHOLARSHIP_AWARD_ORDER.map((k) => (
              <div key={k} className={`zc-sch-stat aw-${AWARD_COLOR[k]}`}>
                <span>{SCHOLARSHIP_AWARD_LABEL[k]}</span>
                <b className="zc-num">{counts[k] ?? 0}</b>
                <small>人</small>
              </div>
            ))}
          </div>
        </>
      )}

      <Card size="small" styles={{ body: { paddingTop: 12 } }}>
        <div className="zc-gr-toolbar">
          <Segmented
            value={view}
            onChange={(v) => setView(v as 'eligible' | 'others')}
            options={[
              { value: 'eligible', label: `参与排名 ${eligible.length}` },
              { value: 'others', label: `不参与排名 ${others.length}` },
            ]}
          />
          <Input allowClear prefix={<SearchOutlined />} placeholder="姓名 / 学号 / 班级" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        </div>
        <Table
          size="small"
          rowKey="studentId"
          loading={loading}
          dataSource={shown}
          columns={view === 'eligible' ? eligibleCols : otherCols}
          scroll={{ x: 'max-content' }}
          rowClassName={(r) => (r.award ? 'zc-sch-awarded' : '')}
          pagination={{ pageSize: 50, showSizeChanger: false, showTotal: (n) => `共 ${n} 人` }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={!year ? '还没有可评定的学年' : view === 'eligible' ? '没有符合排名条件的学生' : '所有学生都参与排名'}
              />
            ),
          }}
        />
      </Card>

      <Modal
        title={`备注 · ${noteFor?.name ?? ''}`}
        open={!!noteFor}
        onCancel={() => setNoteFor(null)}
        okText="保存"
        onOk={async () => {
          if (!noteFor) return;
          await save(noteFor, noteFor.award, noteText.trim() || null);
          setNoteFor(null);
        }}
      >
        <Input.TextArea rows={3} value={noteText} onChange={(e) => setNoteText(e.target.value)} maxLength={255} showCount placeholder="如：评审会议纪要编号、调剂说明" />
      </Modal>
    </Space>
  );
}

/** 历史奖学金仅展示来源表中的原始奖项和特色项目，不推算资格或发放状态。 */
export default function Scholarship() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const navigate = useNavigate();
  const canViewHistory = user?.role === 'SUPER_ADMIN';
  const [year, setYear] = useState('');
  const [queryYear, setQueryYear] = useState('');
  const [rows, setRows] = useState<HistoricalScholarshipSummaryRow[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = async (selectedYear: string, selectedPage = 1) => {
    if (!/^\d{4}-\d{4}$/.test(selectedYear)) {
      message.warning('请输入学年，例如 2025-2026');
      return;
    }
    setLoading(true);
    try {
      const data = await fetchHistoricalScholarshipSummary(selectedYear, selectedPage);
      setRows(data.items);
      setPage(data.page);
      setTotal(data.total);
      setQueryYear(selectedYear);
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert type="info" showIcon message="按学年查看历史奖学金名单"
        description="原表中的奖项和特色项目名单分别保留。未记录表示当前导入材料中没有发现奖项，不代表已完成资格审核或奖金发放。" />
      {canViewHistory ? <>
        <Card size="small" title="历史获奖情况">
          <Space wrap>
            <label htmlFor="scholarship-history-year">学年</label>
            <Input id="scholarship-history-year" placeholder="例如 2025-2026" value={year} disabled={loading}
              onChange={(e) => { setYear(e.target.value.trim()); setRows(null); setQueryYear(''); }}
              onPressEnter={() => load(year)} style={{ width: 170 }} />
            <Button type="primary" loading={loading} onClick={() => load(year)}>查询</Button>
            <Button onClick={() => navigate('/admin/historical-import')}>导入历史表</Button>
          </Space>
        </Card>
        {rows && <Card size="small" title={`${queryYear} 奖学金记录`}>
          <Table<HistoricalScholarshipSummaryRow>
            size="small" rowKey="studentId" loading={loading} dataSource={rows} scroll={{ x: 'max-content' }}
            pagination={{ current: page, total, pageSize: 50, showSizeChanger: false, onChange: (next) => load(queryYear, next), showTotal: (n) => `共 ${n} 人` }}
            columns={[
              { title: '学号', dataIndex: 'studentNo' },
              { title: '姓名', dataIndex: 'name' },
              { title: '获奖情况', dataIndex: 'hasAward', render: (v) => v ? <Tag color="green">有记录</Tag> : <Tag>未记录</Tag> },
              { title: '原奖项', dataIndex: 'awards', render: (items: HistoricalScholarshipSummaryRow['awards']) => items.length
                ? <Space wrap>{items.map((item) => <Tooltip key={item.name} title={item.sources.map((s) => `${s.sourceSheet} 第 ${s.sourceRow} 行`).join('；')}><Tag>{item.name}</Tag></Tooltip>)}</Space>
                : '—' },
              { title: '特色项目名单', dataIndex: 'projects', render: (items: HistoricalScholarshipSummaryRow['projects']) => items.length
                ? <Space wrap>{items.map((item) => <Tooltip key={item.name} title={item.sources.map((s) => `${s.sourceSheet} 第 ${s.sourceRow} 行`).join('；')}><Tag color="blue">{item.name}</Tag></Tooltip>)}</Space>
                : '—' },
            ]}
          />
        </Card>}
      </> : <Alert type="warning" showIcon message="历史奖学金名单仅超级管理员可查看" />}
      <Collapse items={[{ key: 'assessment', label: '原评定工具（按需展开）', children: <ScholarshipAssessment /> }]} />
    </Space>
  );
}
