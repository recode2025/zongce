import { http } from './client';

export interface HistoricalScorePreview {
  semesterKey: string;
  fileSha256: string;
  totalRows: number;
  matchedRows: number;
  canCommit: boolean;
  warnings: string[];
  issues: { row: number; code: string; message: string }[];
  sample: { row: number; studentNo: string; name: string; className: string; systemClassName: string; totalScore: number | string; rankGrade: number | null }[];
}

export interface HistoricalScoreResult {
  batchId: string;
  semesterKey: string;
  count: number;
  version: number;
  status: string;
}

export interface HistoricalScholarshipSummary {
  sheets: number;
  rows: number;
  matched: number;
  unmatched: number;
  nameMismatches: number;
  pending: number;
}

export interface HistoricalScholarshipPreview {
  academicYear: string;
  fileHash: string;
  previewToken: string;
  summary: HistoricalScholarshipSummary;
  sheets: { name: string; rows: number; matched: number; unmatched: number; nameMismatches: number; pending: number }[];
  issues: { sheet: string; row: number; studentNo: string; sourceName: string; reason: string }[];
}

export interface HistoricalScholarshipResult {
  academicYear: string;
  fileHash: string;
  summary: HistoricalScholarshipSummary;
  inserted: number;
  duplicates: number;
}

export interface HistoricalScholarshipRecord {
  id: string;
  academicYear: string;
  studentNo: string;
  sourceName: string;
  sourceSheet: string;
  sourceRow: number;
  projectName: string | null;
  rawAward: string | null;
  note: string | null;
  isPending: boolean;
}

export interface HistoricalScholarshipSummaryRow {
  studentId: string;
  studentNo: string;
  name: string;
  awardStatus: 'RECORDED' | 'NONE_RECORDED';
  hasAward: boolean;
  awards: { name: string; sources: { sourceSheet: string; sourceRow: number; sourceFileName: string }[] }[];
  projects: { name: string; sources: { sourceSheet: string; sourceRow: number; sourceFileName: string }[] }[];
}

function upload<T>(url: string, file: File, fields: Record<string, string>): Promise<T> {
  const data = new FormData();
  data.append('file', file);
  Object.entries(fields).forEach(([key, value]) => data.append(key, value));
  return http.post<T>(url, data).then((response) => response.data);
}

export const previewHistoricalScores = (file: File, semesterKey: string) =>
  upload<HistoricalScorePreview>('/historical-import/scores/preview', file, { semesterKey });

export const commitHistoricalScores = (file: File, semesterKey: string, expectedSha256: string) =>
  upload<HistoricalScoreResult>('/historical-import/scores/commit', file, { semesterKey, expectedSha256 });

export const previewHistoricalScholarships = (file: File, academicYear: string) =>
  upload<HistoricalScholarshipPreview>('/historical-import/scholarships/preview', file, { academicYear });

export const commitHistoricalScholarships = (file: File, academicYear: string, expectedFileHash: string, expectedPreviewToken: string) =>
  upload<HistoricalScholarshipResult>('/historical-import/scholarships/commit', file, { academicYear, expectedFileHash, expectedPreviewToken });

export const fetchHistoricalScholarships = (academicYear: string, page = 1, pageSize = 50) =>
  http.get<{ items: HistoricalScholarshipRecord[]; total: number; page: number; pageSize: number }>(
    '/historical-import/scholarships', { params: { academicYear, page, pageSize } },
  ).then((response) => response.data);

export const fetchHistoricalScholarshipSummary = (academicYear: string, page = 1, pageSize = 50) =>
  http.get<{ items: HistoricalScholarshipSummaryRow[]; total: number; page: number; pageSize: number }>(
    '/historical-import/scholarships/summary', { params: { academicYear, page, pageSize } },
  ).then((response) => response.data);
