import { get, post, patch, http, download as dl } from './client';
export * from './auth';

// ---------- 批次 ----------
export interface Batch {
  id: string;
  semesterKey: string;
  name: string;
  status: string;
  phases?: { phase: string; start?: string; end?: string }[];
  currentCalcVersion: number;
  createdAt: string;
  counts?: Record<string, number>;
}
export const fetchBatches = () => get<Batch[]>('/batches');
export const fetchActiveBatch = () => get<Batch | null>('/batches/active');
export const createBatch = (data: { semesterKey: string; name: string }) => post('/batches', data);
export const transitionBatch = (id: string, to: string) => post(`/batches/${id}/transition`, { to });
export const activateRulesSnapshot = (id: string) => post<{ count: number }>(`/batches/${id}/activate-rules`);

// ---------- 通知 / 公告 ----------
export const fetchNotifications = (unreadOnly = false) => get<any[]>('/notifications/mine', { unreadOnly: String(unreadOnly) });
export const markNotificationRead = (id: string) => patch(`/notifications/${id}/read`);
export const fetchAnnouncements = (batchId?: string) => get<any[]>('/announcements', batchId ? { batchId } : undefined);
export const createAnnouncement = (data: { title: string; content: string; batchId?: string; pinned?: boolean }) => post('/announcements', data);
export const deleteAnnouncement = (id: string) => post(`/announcements/${id}`);

// ---------- 规则字典 / 白名单 ----------
export interface RuleItem {
  id: string;
  code: string;
  category: 'MORAL' | 'ACADEMIC' | 'SPORTS';
  name: string;
  description?: string | null;
  detailSchema: { field: string; label: string; type: string; required?: boolean; options?: { value: string; label: string; score?: number }[]; placeholder?: string }[];
  defaultScore: number | null;
  levelScoreMap: Record<string, number> | null;
  caps: { perTermMax?: number; itemCountMax?: number; takeHighest?: boolean } & Record<string, any>;
  whitelistType?: string | null;
  evidence: { label: string; required?: boolean }[];
  exportSlot?: string | null;
  isActive: boolean;
  overridden?: boolean;
}
export const fetchRuleItems = (params?: { category?: string; batchId?: string }) => get<RuleItem[]>('/rules/items', params);
export const fetchWhitelists = (params?: { type?: string; q?: string; limit?: number }) => get<any[]>('/rules/whitelists', params);
export const updateRuleItem = (id: string, body: any) => http.put<any, any>(`/rules/items/${id}`, body);
export const addWhitelist = (body: { type: string; year?: number; names: string[] }) => post('/rules/whitelists', body);
export const removeWhitelist = (id: string) => post(`/rules/whitelists/${id}/delete`);

// ---------- 学生 / 班级 ----------
export const fetchStudents = (params: any) => get<{ items: any[]; total: number }>('/students', params);
export const patchStudent = (id: string, data: { enrollStatus?: string; name?: string }) => patch(`/students/${id}`, data);
export interface ClassInfo {
  id: string;
  name: string;
  grade: number;
  studentCount: number;
  leaderInfo: { id: string; name: string; username: string } | null;
}
export const fetchClasses = (grade?: number) => get<ClassInfo[]>('/students/classes', grade ? { grade } : undefined);
export const bindClassLeader = (classId: string, data: { studentNo?: string; userId?: string }) => post(`/students/classes/${classId}/leader`, data);

// ---------- 导入（两阶段 + 任务） ----------
export interface ImportPreview {
  token: string;
  kind: 'STUDENT' | 'GRADE';
  headers: string[];
  mapping: { target: string; label: string; required?: boolean; source?: string }[];
  sampleRows: Record<string, any>[];
  totalRows: number;
  termKeys?: string[];
  fileName: string;
}
export const previewImport = (kind: 'STUDENT' | 'GRADE', file: File): Promise<ImportPreview> => {
  const fd = new FormData();
  fd.append('file', file);
  return http.post(`/imports/preview?kind=${kind}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data as ImportPreview);
};
export const confirmImport = (data: { token: string; kind: 'STUDENT' | 'GRADE'; mapping: any[]; batchId?: string; termKey?: string; options?: any }) =>
  post<{ jobId: string }>('/imports/confirm', data);
export interface ImportJob {
  id: string;
  kind: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  progress: number;
  summary: any;
  resultFileId?: string | null;
  error?: string | null;
  createdAt: string;
}
export const fetchJob = (id: string) => get<ImportJob>(`/imports/jobs/${id}`);
export const fetchJobs = (params?: { kind?: string; batchId?: string }) => get<ImportJob[]>('/imports/jobs', params);

// ---------- 成绩异常 ----------
export interface GradeIssue {
  id: string;
  batchId: string;
  studentId: string;
  issueType: string;
  resolution: string;
  note?: string | null;
  pickedGradeId?: string | null;
  createdAt: string;
  student: { studentNo: string; name: string; className: string };
  courseGrade: any;
}
export const fetchIssues = (params: { batchId: string; type?: string; resolution?: string; page?: number; pageSize?: number }) =>
  get<{ items: GradeIssue[]; total: number; typeCounts: { issueType: string; resolution: string; _count: { _all: number } }[] }>('/grades/issues', params);
export const fetchIssueLines = (id: string) => get<any[]>(`/grades/issues/${id}/lines`);
export const resolveIssue = (id: string, data: { resolution: string; pickedGradeId?: string; note?: string }) => patch(`/grades/issues/${id}/resolve`, data);
export const fetchStudentGrades = (studentId: string, batchId: string) => get<any[]>(`/grades/students/${studentId}`, { batchId });

// ---------- 申请 / 材料包 ----------
export const submitApplication = (dto: any, idemKey: string) =>
  http.post('/applications', dto, { headers: { 'idempotency-key': idemKey } }).then((r) => r.data);
export const fetchMyApplications = (batchId?: string) => get<any[]>('/applications/mine', batchId ? { batchId } : undefined);
export const withdrawApplication = (id: string) => post(`/applications/${id}/withdraw`);
export const fetchApplications = (params: any) => get<{ rows: any[]; total: number; page: number; pageSize: number }>('/applications', params);
export const fetchApplicationDetail = (id: string) => get<any>(`/applications/${id}`);
export const submitPackage = (dto: any, idemKey: string) =>
  http.post('/packages/submit', dto, { headers: { 'idempotency-key': idemKey } }).then((r) => r.data);
export const rebuildPackage = (id: string) => post(`/packages/${id}/rebuild`);
export const fetchMyPackages = (batchId?: string) => get<any[]>('/packages/mine', batchId ? { batchId } : undefined);
export const fetchPackages = (params: any) => get<{ rows: any[]; total: number; page: number; pageSize: number }>('/packages', params);

// ---------- 审核 ----------
export const firstReview = (dto: { ids: string[]; action: 'PASS' | 'REJECT'; comment?: string }) => post<{ processed: number; status: string }>('/reviews/first', dto);
export const secondReview = (dto: { ids: string[]; action: 'APPROVE' | 'REJECT'; comment?: string; grantedScores?: Record<string, number> }) =>
  post<{ processed: number; status: string }>('/reviews/second', dto);
export const packageFirstReview = (dto: { ids: string[]; action: 'PASS' | 'REJECT'; comment?: string }) => post<{ processed: number }>('/reviews/packages/first', dto);
export const fetchReviewStats = (batchId: string) => get<{ applications: Record<string, number>; packages: Record<string, number> }>('/reviews/stats', { batchId });

// ---------- 文件 ----------
export const uploadMaterial = (file: File): Promise<any> => {
  const fd = new FormData();
  fd.append('file', file);
  return http.post('/files/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data);
};
export const fetchZipEntries = (uuid: string) => get<{ path: string; name: string; size: number; previewable: boolean; status: string }[]>(`/files/${uuid}/zip/entries`);
export const fetchZipPreviewBlobUrl = async (uuid: string, entryPath: string) => {
  const res = await http.get(`/files/${uuid}/zip/preview`, { params: { path: entryPath }, responseType: 'blob' });
  return URL.createObjectURL(new Blob([res.data]));
};
export const downloadFile = (uuid: string, fileName: string) => dl(`/files/${uuid}/download`, fileName);
/** 鉴权取 blob 后新窗口打开（附件在线预览） */
export const openFileOnline = async (uuid: string, ext: string) => {
  const res = await http.get(`/files/${uuid}/download`, { responseType: 'blob' });
  const url = URL.createObjectURL(new Blob([res.data], { type: previewMime(ext) }));
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
function previewMime(ext: string): string {
  const e = ext?.toLowerCase().replace('.', '');
  if (e === 'pdf') return 'application/pdf';
  if (e === 'png') return 'image/png';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'webp') return 'image/webp';
  return 'application/octet-stream';
}

// ---------- 计算引擎 ----------
export const runCalc = (batchId: string, dryRun: boolean) => post<{ jobId: string }>('/calc/run', { batchId, dryRun });
export const fetchCalcVersions = (batchId: string) => get<{ version: number; status: string; _count: { _all: number }; _max: { totalScore: number } }[]>('/calc/versions', { batchId });
export const fetchCalcResults = (params: { batchId: string; version?: string; classId?: string; q?: string; page?: number; pageSize?: number }) =>
  get<{ rows: any[]; total: number; page: number; pageSize: number }>('/calc/results', params);
export const fetchCalcDetail = (studentId: string, batchId: string, version?: string) => get<any>(`/calc/results/${studentId}`, { batchId, version });

// ---------- 发布 / 公示 / 异议 ----------
export const releasePublish = (dto: { batchId: string; publicityDays?: number; publicityEnd?: string }) =>
  post<{ round: number; version: number; students: number; publicityEnd: string }>('/publish/release', dto);
export const incrementalPublish = (batchId: string) => post<{ refreshed: number; students?: string[]; note?: string }>('/publish/incremental', { batchId });
export const fetchMyScore = (batchId?: string) => get<any>('/publish/scores/mine', batchId ? { batchId } : undefined);
export const fetchRounds = (batchId: string) => get<any[]>('/publish/rounds', { batchId });
export const submitObjection = (dto: { batchId: string; content: string; targetApplicationId?: string }) => post('/publish/objections', dto);
export const fetchMyObjections = (batchId?: string) => get<any[]>('/publish/objections/mine', batchId ? { batchId } : undefined);
export const fetchObjections = (batchId: string, status?: string) => get<any[]>('/publish/objections', { batchId, status });
export const handleObjection = (id: string, dto: { status: 'ACCEPTED' | 'REJECTED'; note?: string }) => post(`/publish/objections/${id}/handle`, dto);

// ---------- 导出 ----------
export const createExport = (dto: { batchId: string; scope: 'CLASS' | 'GRADE'; classId?: string; version?: number }) => post<{ jobId: string }>('/exports', dto);
export const fetchExportHistory = (batchId?: string) => get<any[]>('/exports/history', batchId ? { batchId } : undefined);

// ---------- 看板 / 系统 ----------
export const fetchOverview = (batchId: string) => get<any>('/stats/overview', { batchId });
export const fetchUsers = (params: any) => get<{ items: any[]; total: number }>('/users', params);
export const createUser = (dto: { username: string; name: string; role: string; password?: string; grade?: number }) => post('/users', dto);
export const updateUser = (id: string, dto: any) => patch(`/users/${id}`, dto);
export const resetPwdBatch = (ids: string[]) => post<{ count: number }>('/users/reset-password-batch', { ids });
export const fetchAuditLogs = (params: any) => get<{ items: any[]; total: number }>('/users/audit-logs', params);
