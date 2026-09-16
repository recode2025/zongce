import axios, { AxiosError, AxiosRequestConfig } from 'axios';

/**
 * API 客户端：access token 仅存内存（刷新页即失效，走 httpOnly refresh cookie 续期）。
 * 401 时自动用 refresh cookie 轮换新 access 并重放原请求（仅一次，防死循环）。
 */
export const http = axios.create({ baseURL: '/api/v1', timeout: 60_000 });

let accessToken = '';
export const setAccessToken = (t: string) => (accessToken = t);
export const hasToken = () => !!accessToken;

http.interceptors.request.use((cfg) => {
  if (accessToken) cfg.headers.Authorization = `Bearer ${accessToken}`;
  return cfg;
});

let refreshing: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  refreshing ??= axios
    .post('/api/v1/auth/refresh', {}, { timeout: 10_000 })
    .then((r) => {
      const t: string | undefined = r.data?.accessToken;
      if (t) setAccessToken(t);
      return t ?? null;
    })
    .catch(() => null)
    .finally(() => (refreshing = null));
  return refreshing;
}

http.interceptors.response.use(
  (res) => res,
  async (err: AxiosError) => {
    const cfg = err.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;
    const status = err.response?.status;
    const path = cfg?.url ?? '';
    const isAuthPath = path.startsWith('/auth/login') || path.startsWith('/auth/refresh');
    if (status === 401 && cfg && !cfg._retried && !isAuthPath && hasToken()) {
      cfg._retried = true;
      const t = await refreshAccessToken();
      if (t) {
        cfg.headers = { ...cfg.headers, Authorization: `Bearer ${t}` };
        return http.request(cfg);
      }
      window.dispatchEvent(new CustomEvent('zc:logout'));
    }
    return Promise.reject(err);
  },
);

/** 统一错误信息提取（后端 {message} 或网络错误） */
export function errMsg(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const d = e.response?.data as any;
    if (typeof d?.message === 'string') return d.message;
    if (Array.isArray(d?.message) && d.message[0]) return String(d.message[0]);
    return e.message === 'Network Error' ? '网络连接失败' : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** 列表响应形状归一：{rows}|{items}|数组 → 数组 */
export function asArray<T = any>(res: any): T[] {
  if (Array.isArray(res)) return res as T[];
  if (Array.isArray(res?.rows)) return res.rows as T[];
  if (Array.isArray(res?.items)) return res.items as T[];
  return [];
}

/** GET/POST/PATCH 快捷封装（解包 axios 响应，直接返回 data） */
export const get = <T = any>(url: string, params?: any) => http.get(url, { params }).then((r) => r.data as T);
export const post = <T = any>(url: string, body?: any) => http.post(url, body).then((r) => r.data as T);
export const patch = <T = any>(url: string, body?: any) => http.patch(url, body).then((r) => r.data as T);

/** 上传（multipart，白名单/限额由后端校验） */
export function uploadFile<T = any>(url: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append('file', file);
  return http.post(url, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data as T);
}

/** 鉴权下载（blob 落地） */
export async function download(url: string, fileName: string) {
  const res = await http.get(url, { responseType: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([res.data]));
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}
