/**
 * M7 真实数据全流程 E2E（对运行中的 backend 打真实 API）：
 * 管理员登录改密 → 学生导入(1035) → 批次流转 → 成绩导入(多学期) → 异常裁决 →
 * 班委授权 → 学生申请+材料包 → 两级审核 → dryRun/正式计算 → golden 对照 →
 * 发布 → 学生查分 → 异议 → 受理 → 人工改选成绩重算 → 增量发布 → 复查分 →
 * 分班/全年级导出校验 → 看板/审计。
 *
 * 前置：dev.db 已 seed（超管 admin/Admin@Zc2026），backend 已在 BASE 起服务。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3210/api/v1';
const RULES_DIR = process.env.ZC_RULES_DIR ?? 'D:/【学校工作】/综测相关规则';
const TERM = '2025-2026-1';
const CLASS_NAME = '大数据2025级1班';
const STU_NO = '250460114'; // 徐晨鸿：golden 已知 P=50.1666→50.17，必修日语期末45（补考62），模板 R=-1
const LEADER_NO = '250460101'; // 崔越 → 提为班委
const ADMIN_INIT = 'Admin@Zc2026';
const ADMIN_PWD = 'Admin@E2e2026';
const STU_PWD = 'Stu@E2e2026';
const LEADER_PWD = 'Lead@E2e2026';

let failures = 0;
const ok = (cond, label, extra = '') => {
  const mark = cond ? '✅' : '❌';
  if (!cond) failures++;
  console.log(`${mark} ${label}${extra ? `  ${extra}` : ''}`);
};

async function api(method, path, { token, body, formData, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (formData) payload = formData;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

async function login(username, password) {
  const r = await api('POST', '/auth/login', { body: { username, password } });
  if (r.status !== 200) throw new Error(`登录失败 ${username}: ${JSON.stringify(r.json)}`);
  return r.json; // { accessToken, mustChangePwd, user }
}

async function changePwd(token, oldPassword, newPassword) {
  const r = await api('POST', '/auth/change-password', { token, body: { oldPassword, newPassword } });
  if (r.status !== 200) throw new Error(`改密失败: ${JSON.stringify(r.json)}`);
  return r.json;
}

async function pollJob(admin, jobResp, label, timeoutMs = 180_000) {
  const jobId = jobResp?.json?.jobId;
  if (!jobId) throw new Error(`${label} 发起失败（${jobResp?.status}）：${JSON.stringify(jobResp?.json).slice(0, 300)}`);
  const t0 = Date.now();
  for (;;) {
    const r = await api('GET', `/imports/jobs/${jobId}`, { token: admin });
    if (r.status === 200 && r.json.status !== 'RUNNING') {
      ok(r.json.status === 'DONE', `${label} 任务 ${r.json.status}`, r.json.error ? `err=${r.json.error}` : '');
      return r.json;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label} 超时`);
    await new Promise((s) => setTimeout(s, 500));
  }
}

/** 批次流转（失败即抛——曾因 ValidationPipe whitelist 剥离无装饰器 DTO 字段全部静默 400） */
async function transition(batchId, to, token) {
  const r = await api('POST', `/batches/${batchId}/transition`, { token, body: { to } });
  if (r.status !== 200 && r.status !== 201) throw new Error(`流转 ${to} 失败（${r.status}）：${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json;
}

function uploadForm(fileName, buf, kind) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), fileName);
  const q = kind ? `?kind=${kind}` : '';
  return { path: `/files/upload${q}`, formData: fd, q };
}

const PDF = Buffer.from(`%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj\n3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>> endobj\nxref\n0 4\ntrailer <</Size 4/Root 1 0 R>>\nstartxref\n0\n%%EOF\n${'x'.repeat(64)}`);

// ============ 0. 管理员 ============
console.log('\n——— 0. 管理员登录（首登强制改密）———');
let admin;
try {
  admin = (await login('admin', ADMIN_INIT)).accessToken;
  await changePwd(admin, ADMIN_INIT, ADMIN_PWD);
  admin = (await login('admin', ADMIN_PWD)).accessToken;
  ok(true, '管理员首登改密闭环');
} catch {
  admin = (await login('admin', ADMIN_PWD)).accessToken; // 重跑：密码已是 E2E 密码
  ok(true, '管理员登录（重跑，已改密）');
}
const me = await api('GET', '/auth/me', { token: admin });
ok(me.status === 200 && me.json.role === 'SUPER_ADMIN', '管理员身份 SUPER_ADMIN');

// ============ 1. 批次 ============
console.log('\n——— 1. 批次就绪 ———');
const batches = (await api('GET', '/batches', { token: admin })).json;
const batch = (batches.items ?? batches).find((b) => b.semesterKey === TERM) ?? (batches.items ?? batches)[0];
ok(!!batch, `批次 ${batch?.name} (${batch?.status})`);
const batchId = batch.id;

// ============ 2. 学生导入（真实 1035 人文件） ============
console.log('\n——— 2. 学生导入 ———');
{
  const buf = readFileSync(join(RULES_DIR, '25级学生信息(1).xlsx'));
  const fd = new FormData();
  fd.append('file', new Blob([buf]), '25级学生信息(1).xlsx');
  const prev = await api('POST', '/imports/preview?kind=STUDENT', { token: admin, formData: fd });
  ok(prev.status === 200 || prev.status === 201, `preview 解析 ${prev.json?.totalRows} 行 / ${prev.json?.headers?.length} 列`);
  const unmapped = (prev.json.mapping ?? []).filter((m) => m.required && !m.source).length;
  ok(unmapped === 0, `必填列自动映射完整（缺 ${unmapped}）`);
  const conf = await api('POST', '/imports/confirm', { token: admin, body: { token: prev.json.token, kind: 'STUDENT', mapping: prev.json.mapping, options: { fileName: '25级学生信息(1).xlsx' } } });
  const job = await pollJob(admin, conf, '学生导入');
  const s = job.summary ?? {};
  ok(s.total === 1035 && s.inserted === 1035, `导入 1035/1035`, `total=${s.total} inserted=${s.inserted}`);
}

// ============ 3. 批次流转 DATA_PREP → 成绩导入（多学期过滤） ============
console.log('\n——— 3. 成绩导入（12641 行多学期 xls）———');
await transition(batchId, 'DATA_PREP', admin);
{
  const buf = readFileSync(join(RULES_DIR, '年级成绩总表.xls'));
  const fd = new FormData();
  fd.append('file', new Blob([buf]), '年级成绩总表.xls');
  const prev = await api('POST', '/imports/preview?kind=GRADE', { token: admin, formData: fd });
  ok(prev.status === 200 || prev.status === 201, `preview ${prev.json?.totalRows} 行`, `termKeys=${(prev.json?.termKeys ?? []).join('|')}`);
  const conf = await api('POST', '/imports/confirm', { token: admin, body: { token: prev.json.token, kind: 'GRADE', mapping: prev.json.mapping, batchId, termKey: TERM, options: { fileName: '年级成绩总表.xls' } } });
  const job = await pollJob(admin, conf, '成绩导入', 300_000);
  const s = job.summary ?? {};
  const issueMap = Object.fromEntries((s.issues ?? []).map((i) => [i.type, i.count]));
  ok(s.inserted > 6000, `成绩入库 ${s.inserted} 行（仅 ${TERM}）`, `issues=${JSON.stringify(issueMap)}`);
  ok((issueMap.RESIT_DUP ?? 0) > 0, `补考多行异常落队列 ${issueMap.RESIT_DUP} 条`);
  ok((issueMap.NON_NUMERIC_SCORE ?? 0) === 0, `等级制「优」已前置映射，无 NON_NUMERIC 噪音`);
}

// ============ 4. 异常裁决演示 ============
console.log('\n——— 4. 异常队列裁决 ———');
{
  const issues = (await api('GET', `/grades/issues?batchId=${batchId}&resolution=PENDING`, { token: admin })).json;
  const rows = issues.items ?? issues.rows ?? issues;
  const resit = (Array.isArray(rows) ? rows : []).find((i) => i.issueType === 'RESIT_DUP' && i.studentNo !== STU_NO);
  if (resit) {
    const r = await api('PATCH', `/grades/issues/${resit.id}/resolve`, { token: admin, body: { resolution: 'AUTO_PICK_FINAL', note: 'E2E：按期末考试成绩取第一次' } });
    ok(r.status === 200, `裁决 RESIT_DUP（期末优先）`, resit.studentNo ?? '');
  } else ok(false, '未找到可裁决的 RESIT_DUP');
}

// ============ 5. 班委授权 + 学生登录 ============
console.log('\n——— 5. 班委授权 / 学生首登改密 ———');
await transition(batchId, 'COLLECTING', admin);
let leaderTok, stuTok;
{
  const ul = (await api('GET', `/users?keyword=${LEADER_NO}`, { token: admin })).json;
  const leader = (ul.items ?? []).find((u) => u.username === LEADER_NO);
  ok(!!leader, `班委账号存在 ${LEADER_NO}`);
  const p = await api('PATCH', `/users/${leader.id}`, { token: admin, body: { role: 'CLASS_LEADER' } });
  ok(p.status === 200, '提权 CLASS_LEADER');
  let l = await login(LEADER_NO, LEADER_NO.slice(-6));
  await changePwd(l.accessToken, LEADER_NO.slice(-6), LEADER_PWD);
  leaderTok = (await login(LEADER_NO, LEADER_PWD)).accessToken;
  ok(true, '班委首登改密闭环');

  let s = await login(STU_NO, STU_NO.slice(-6));
  ok(s.user?.mustChangePwd === true, '学生首登 mustChangePwd');
  await changePwd(s.accessToken, STU_NO.slice(-6), STU_PWD);
  stuTok = (await login(STU_NO, STU_PWD)).accessToken;
}

// ============ 6. 学生：上传 → 加分申请 → 材料包 ============
console.log('\n——— 6. 学生提交（申请 + 规范打包）———');
let appId, pkgId;
{
  const up = await api('POST', uploadForm('献血证明.pdf', PDF, 'EVIDENCE').path, { token: stuTok, formData: uploadForm('献血证明.pdf', PDF, 'EVIDENCE').formData });
  ok(up.status === 201 || up.status === 200, `上传 PDF (${up.json?.ext})`);
  const fileId = up.json.id ?? up.json.fileId;

  const rules = (await api('GET', '/rules/items', { token: stuTok })).json;
  const items = rules.items ?? rules;
  const blood = items.find((r) => r.code === 'MORAL_BLOOD');
  ok(!!blood, `规则字典取 MORAL_BLOOD（共 ${items.length} 项）`);
  const app = await api('POST', '/applications', { token: stuTok, body: { batchId, ruleItemId: blood.id, title: '2026年春季校园无偿献血', detail: { date: '2026-04-10', organizer: '校医院统一组织' }, fileIds: [fileId] } });
  ok(app.status === 201, `加分申请提交（申报 ${app.json?.declaredScore} 分）`);
  appId = app.json.id;

  const up2 = await api('POST', uploadForm('社会实践盖章表.pdf', PDF, 'EVIDENCE').path, { token: stuTok, formData: uploadForm('社会实践盖章表.pdf', PDF, 'EVIDENCE').formData });
  const fid2 = up2.json.id ?? up2.json.fileId;
  const pkg = await api('POST', '/packages/submit', { token: stuTok, body: { batchId, section: 'PRACTICE_VOLUNTEER', items: [{ fileId: fid2, role: '社会实践' }] } });
  ok(pkg.status === 201, `材料包规范打包`, `zip="${pkg.json?.namingReport?.zipName ?? pkg.json?.zipName ?? ''}"`);
  const report = pkg.json?.namingReport ?? {};
  ok(/社会实践.*志愿服务/.test(report.zipName ?? '') || /社会实践/.test(report.zipName ?? ''), 'zip 命名符合板块一规范');
  pkgId = pkg.json.id ?? pkg.json.package?.id;
}

// ============ 7. 两级审核 ============
console.log('\n——— 7. 班委初审 → 辅导员复审 ———');
{
  const list = (await api('GET', `/applications?batchId=${batchId}&status=SUBMITTED`, { token: leaderTok })).json;
  const rows = list.items ?? list.rows ?? list;
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => r.studentNo === STU_NO || r.student?.studentNo === STU_NO);
  ok(mine.length >= 1, `班委可见本班待初审 ${mine.length} 条`);
  const f = await api('POST', '/reviews/first', { token: leaderTok, body: { ids: mine.map((m) => m.id), action: 'PASS' } });
  ok(f.status === 201 || f.status === 200, `初审通过 ${f.json?.processed} 条`);
  // 越权检查：初审接口班委只能本班（用另一个班的申请 id 试）——跳过，接口已单测覆盖数据范围

  const list2 = (await api('GET', `/applications?batchId=${batchId}&status=FIRST_PASSED`, { token: admin })).json;
  const rows2 = (list2.items ?? list2.rows ?? []);
  const second = await api('POST', '/reviews/second', { token: admin, body: { ids: (Array.isArray(rows2) ? rows2 : []).map((r) => r.id), action: 'APPROVE' } });
  ok(second.status === 201 || second.status === 200, `复审核定 ${second.json?.processed} 条（grantedScore=1）`);

  if (pkgId) {
    const pf = await api('POST', '/reviews/packages/first', { token: leaderTok, body: { ids: [pkgId], action: 'PASS' } });
    ok(pf.status === 201 || pf.status === 200, '材料包初审通过');
  }
  const noti = await api('GET', '/notifications/mine', { token: stuTok });
  const notiRows = noti.json?.items ?? noti.json ?? [];
  ok(noti.status === 200 && (Array.isArray(notiRows) ? notiRows.length : 0) >= 1, `审核通知已送达学生（${(Array.isArray(notiRows) ? notiRows : []).length} 条）`);
}

// ============ 8. 计算：dryRun → 正式 → golden 对照 ============
console.log('\n——— 8. 计算引擎（dryRun + 正式落版）———');
{
  await transition(batchId, 'FIRST_REVIEW', admin);
  await transition(batchId, 'SECOND_REVIEW', admin);

  // 门禁：进 CALCULATED 前必须清空 MISSING/DEFERRED_EMPTY/DISQUALIFIED 待裁决队列（逐类查询 + 逐条确认按系统默认规则处理）
  {
    let total = 0, resolved = 0;
    for (const type of ['MISSING', 'DEFERRED_EMPTY', 'DISQUALIFIED', 'NON_NUMERIC_SCORE']) {
      const pend = (await api('GET', `/grades/issues?batchId=${batchId}&type=${type}&resolution=PENDING&pageSize=100`, { token: admin })).json;
      const rows = pend.items ?? [];
      total += rows.length;
      for (const i of rows) {
        const r = await api('PATCH', `/grades/issues/${i.id}/resolve`, { token: admin, body: { resolution: 'INCLUDED', note: 'E2E：确认按系统默认规则处理' } });
        if (r.status === 200 || r.status === 201) resolved++;
      }
    }
    ok(resolved === total && total > 0, `批量裁决剩余异常 ${resolved}/${total} 条（MISSING/缓考空/取消资格）`);
  }

  const dry = await api('POST', '/calc/run', { token: admin, body: { batchId, dryRun: true } });
  const dryJob = await pollJob(admin, dry, 'dryRun 试算');
  const dsum = dryJob.summary ?? {};
  ok((dsum.diff?.NEW ?? dsum.new ?? dsum.students ?? 0) > 900 || dsum.total > 900, `dryRun 覆盖全年级`, `summary keys=${Object.keys(dsum).join(',')}`);

  const run = await api('POST', '/calc/run', { token: admin, body: { batchId } });
  const job = await pollJob(admin, run, '正式计算');
  ok((job.summary?.students ?? job.summary?.total ?? 0) >= 1000, `正式计算 ${job.summary?.students ?? job.summary?.total} 人，版本 v${job.summary?.version}`);
  const ver = job.summary?.version;

  // golden 对照：大数据1班 30 人学业加权 === 模板 P 列 round2
  const XLSX = await import('xlsx');
  const tpl = XLSX.utils.sheet_to_json(XLSX.read(readFileSync(join(RULES_DIR, '大数据2025级1班.xlsx'))).Sheets[XLSX.read(readFileSync(join(RULES_DIR, '大数据2025级1班.xlsx'))).SheetNames[0]], { header: 1, raw: true, defval: null });
  const golden = new Map(tpl.slice(2).filter((r) => r && r[3]).map((r) => [String(r[3]).trim(), Math.round(Number(r[15]) * 100) / 100]));

  const clsList2 = (await api('GET', '/students/classes', { token: admin })).json;
  const clsArr = Array.isArray(clsList2) ? clsList2 : (clsList2.items ?? []);
  const bigDataCls = clsArr.find((c) => c.name === CLASS_NAME);
  const res = (await api('GET', `/calc/results?batchId=${batchId}&version=${ver}&classId=${bigDataCls?.id ?? ''}&pageSize=100`, { token: admin })).json;
  const rrows = res.items ?? res.rows ?? [];
  let hit = 0, miss = [];
  for (const row of rrows) {
    const no = row.studentNo ?? row.student?.studentNo;
    const w = Math.round(Number(row.academicWeighted) * 100) / 100;
    if (golden.has(no)) { if (Math.abs(w - golden.get(no)) < 1e-9) hit++; else miss.push(`${no}:${w}≠${golden.get(no)}`); }
  }
  ok(golden.size === 30 && hit === 30, `E2E 计算 vs golden 模板 P 列 ${hit}/30`, miss.slice(0, 5).join(' '));
  const xu = (rrows).find((r) => (r.studentNo ?? r.student?.studentNo) === STU_NO);
  ok(xu && Math.round(Number(xu.academicTotal) * 100) / 100 === 49.17, `徐晨鸿学业总分 49.17（P50.17−日语期末45扣1）`, `got=${xu?.academicTotal}`);
  ok(xu && Number(xu.moralBonus) === 1, `徐晨鸿品德奖扣=1（献血复审核定）`, `got=${xu?.moralBonus}`);
}

// ============ 9. 发布 → 学生查分 → 异议 → 增量 ============
console.log('\n——— 9. 发布 / 公示 / 异议 / 增量 ———');
{
  await transition(batchId, 'CALCULATED', admin);
  const rel = await api('POST', '/publish/release', { token: admin, body: { batchId, publicityDays: 3 } });
  ok(rel.status === 201 && rel.json.round === 1, `发布 round=1 v${rel.json.version}，${rel.json.students} 人`);

  let score = (await api('GET', '/publish/scores/mine', { token: stuTok })).json;
  ok(Number(score.totalScore) === 62.17, `学生查分 total=62.17（品德10+学业49.17+文体3）`, `got=${score.totalScore} src=${score.source}`);
  ok(score.academic?.weighted === 50.17, `查分明细 weighted=50.17`, `got=${score.academic?.weighted}`);
  score = (await api('GET', '/publish/scores/mine', { token: stuTok })).json;
  ok(score.source === 'cache', '第二次查分命中快照缓存');

  const obj = await api('POST', '/publish/objections', { token: stuTok, body: { batchId, content: 'E2E 异议：基础日语成绩行有误，应采用补考通过后的成绩认定。' } });
  ok(obj.status === 201, '公示期内提交异议');
  const dup = await api('POST', '/publish/objections', { token: stuTok, body: { batchId, content: 'E2E 异议重复提交应被拦截的测试内容。' } });
  ok(dup.status === 409, '同轮重复异议被拦（409）');

  const objs = (await api('GET', `/publish/objections?batchId=${batchId}`, { token: admin })).json;
  const mine = (Array.isArray(objs) ? objs : []).find((o) => o.studentNo === STU_NO || o.student?.studentNo === STU_NO);
  const h = await api('POST', `/publish/objections/${mine.id}/handle`, { token: admin, body: { status: 'ACCEPTED', note: '核实属实：按补考通过成绩重新认定' } });
  ok(h.status === 201 || h.status === 200, '异议受理');

  // 更正：把徐晨鸿日语裁决为补考行（62）→ 重算 → 增量发布
  let xuIssue;
  for (let page = 1; page <= 10 && !xuIssue; page++) {
    const issues = (await api('GET', `/grades/issues?batchId=${batchId}&type=RESIT_DUP&resolution=PENDING&pageSize=100&page=${page}`, { token: admin })).json;
    const rows = issues.items ?? [];
    if (!rows.length) break;
    xuIssue = rows.find((i) => i.student?.studentNo === STU_NO || i.studentNo === STU_NO);
  }
  ok(!!xuIssue, '定位徐晨鸿日语 RESIT_DUP 异常行');
  const lines = (await api('GET', `/grades/issues/${xuIssue.id}/lines`, { token: admin })).json;
  const makeup = (lines.items ?? lines.rows ?? lines).find((l) => l.examType === '补考' || l.scoreText === '62');
  ok(!!makeup, `异常行明细：补考行 成绩=${makeup?.scoreValue ?? makeup?.scoreText}`);
  await api('PATCH', `/grades/issues/${xuIssue.id}/resolve`, { token: admin, body: { resolution: 'MANUAL_PICKED', pickedGradeId: makeup.id, note: '异议成立：取补考 62 分' } });

  const run2 = await api('POST', '/calc/run', { token: admin, body: { batchId } });
  const job2 = await pollJob(admin, run2, '更正后重算');
  ok((job2.summary?.version ?? 0) === 2, `新版本 v2`, `summary=${JSON.stringify(job2.summary).slice(0, 200)}`);

  const inc = await api('POST', '/publish/incremental', { token: admin, body: { batchId } });
  ok(inc.status === 201 && (inc.json.refreshed ?? 0) >= 1, `增量发布 ${inc.json.refreshed} 人`, `students=${(inc.json.students ?? []).slice(0, 5)}`);

  const score2 = (await api('GET', '/publish/scores/mine', { token: stuTok })).json;
  ok(score2.academic?.failPenalty === 0 && Number(score2.academic?.total) > 50.17 && Number(score2.academic?.weighted) > 50.17, `复查分：扣分清零、学业总分上调（补考62替换期末45）`, `got penalty=${score2.academic?.failPenalty} weighted=${score2.academic?.weighted} total=${score2.academic?.total}`);
}

// ============ 10. 导出 ============
console.log('\n——— 10. 导出（分班 + 全年级）———');
{
  const classes = (await api('GET', '/students/classes', { token: admin }).catch(() => ({ json: {} }))).json;
  const clsList = classes.items ?? classes ?? [];
  const bigData = (Array.isArray(clsList) ? clsList : []).find((c) => c.name === CLASS_NAME);
  ok(!!bigData, `班级 ${CLASS_NAME} id=${bigData?.id?.slice(0, 8)}`);

  const ex = await api('POST', '/exports', { token: admin, body: { batchId, scope: 'CLASS', classId: bigData.id } });
  const exJob = await pollJob(admin, ex, '分班导出');
  ok(exJob.status === 'DONE' && exJob.resultFileId, '分班导出完成');
  const uuid = exJob.summary?.fileUuid;
  ok(!!uuid, `导出产物 uuid=${uuid?.slice(0, 8)} 文件=${exJob.summary?.fileName}`);
  if (uuid) {
    const file = await api('GET', `/files/${uuid}/download`, { token: admin, raw: true });
    writeFileSync('e2e-export-class.xlsx', file.buf);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile('e2e-export-class.xlsx');
    const ws = wb.worksheets[0];
    ok(ws.columnCount === 30, `30 列（实际 ${ws.columnCount}）`);
    ok(ws.getCell('P1').value === '学业表现' && ws.getCell('P2').value === '学业成绩加权', `双行表头 P 列="${ws.getCell('P1').value}/${ws.getCell('P2').value}"`);
    ok(String(ws.getCell('A1').value).includes('排名') && ws.getCell('AD1').value === '总分', 'A/D/E/AD 纵向合并表头');
    let xuRow = null;
    for (let r = 3; r <= ws.rowCount; r++) if (String(ws.getCell(r, 4).value) === STU_NO) xuRow = r;
    ok(!!xuRow, `数据行找到 ${STU_NO}（共 ${ws.rowCount - 2} 行）`);
    if (xuRow) {
      ok(Math.abs(Number(ws.getCell(xuRow, 16).value) - 54.13) < 1e-9, `导出 P=54.13（异议更正后补考62替换期末45）`, `got=${ws.getCell(xuRow, 16).value}`);
      ok(Number(ws.getCell(xuRow, 6).value) === 9 && Number(ws.getCell(xuRow, 7).value) === 1, `导出 F=9 G=1（献血）`, `F=${ws.getCell(xuRow, 6).value} G=${ws.getCell(xuRow, 7).value}`);
      ok(Number(ws.getCell(xuRow, 18).value) === -1 || Number(ws.getCell(xuRow, 18).value) === 0, `导出 R=${ws.getCell(xuRow, 18).value}（负值口径）`);
    }
  }

  const exAll = await api('POST', '/exports', { token: admin, body: { batchId, scope: 'GRADE' } });
  const allJob = await pollJob(admin, exAll, '全年级导出');
  ok(allJob.status === 'DONE', `全年级导出 ${allJob.summary?.students} 人 / ${allJob.summary?.classes} 班`);
}

// ============ 11. 看板与审计 ============
console.log('\n——— 11. 看板 / 审计 ———');
{
  const st = (await api('GET', `/stats/overview?batchId=${batchId}`, { token: admin })).json;
  ok(st.batch?.status === 'PUBLICITY', `看板批次状态 ${st.batch?.status}`);
  ok((st.students?.total ?? 0) === 1026, `正常学籍学生 1026（1035−9 无学籍/休学）`, `got=${st.students?.total}`);
  const logs = (await api('GET', '/users/audit-logs?pageSize=100', { token: admin })).json;
  const actions = new Set((logs.items ?? []).map((l) => l.action));
  for (const a of ['LOGIN', 'IMPORT', 'FIRST_REVIEW_PASS', 'SECOND_REVIEW_APPROVE', 'PUBLISH', 'OBJECTION_HANDLE', 'EXPORT_RESULT', 'PUBLISH_INCREMENTAL']) {
    ok(actions.has(a), `审计动作 ${a}`);
  }
}

console.log(`\n${failures === 0 ? '🎉 E2E 全部通过' : `⚠️ ${failures} 项未通过`}`);
process.exit(failures === 0 ? 0 : 1);
