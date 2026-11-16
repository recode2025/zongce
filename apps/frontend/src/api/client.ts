import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import { publicErrorText } from '@zc/shared';

/**
 * API 客户端：access token 仅存内存（刷新页即失效，走 httpOnly refresh cookie 续期）。
 * 401 时自动用 refresh cookie 轮换新 access 并重放原请求（仅一次，防死循环）。
 */
export const http = axios.create({ baseURL: '/api/v1', timeout: 60_000 });

let accessToken = '';
export const setAccessToken = (t: string) => (accessToken = t);
export const hasToken = () => !!accessToken;

// CAS 跳转登录带回的 refresh token（仅内存；优先走 httpOnly cookie，此值作兜底）
let refreshTokenMem = '';
export const setRefreshToken = (t: string) => (refreshTokenMem = t ?? '');

http.interceptors.request.use((cfg) => {
  if (accessToken) cfg.headers.Authorization = `Bearer ${accessToken}`;
  return cfg;
});

let refreshing: Promise<string | null> | null = null;

export async function refreshAccessToken(): Promise<string | null> {
  refreshing ??= axios
    .post('/api/v1/auth/refresh', refreshTokenMem ? { refreshToken: refreshTokenMem } : {}, { timeout: 10_000 })
    .then((r) => {
      const t: string | undefined = r.data?.accessToken;
      if (t) setAccessToken(t);
      if (r.data?.refreshToken) setRefreshToken(r.data.refreshToken);
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
    if (typeof d?.message === 'string' || Array.isArray(d?.message)) return publicErrorText(d.message);
    if (e.message === 'Network Error') return '网络连接失败';
    return publicErrorText(undefined);
  }
  return publicErrorText(e instanceof Error ? e.message : e);
}

/** 列表响应形状归一：{rows}|{items}|数组 → 数组 */
export function asArray<T = any>(res: any): T[] {
  if (Array.isArray(res)) return res as T[];
  if (Array.isArray(res?.rows)) return res.rows as T[];
  if (Array.isArray(res?.items)) return res.items as T[];
  return [];
}

/** GET 在途去重：同一 url+params 的并发请求共享同一 Promise。
 *  StrictMode 双挂载、多组件同帧取同一字典（active 批次 / 规则项等）只发一次网络请求；
 *  请求落地即出表、不缓存结果，之后的调用仍取最新数据（无陈旧值问题）。 */
const inflightGets = new Map<string, Promise<any>>();
export const get = <T = any>(url: string, params?: any): Promise<T> => {
  const key = url + '?' + JSON.stringify(params ?? null);
  const hit = inflightGets.get(key);
  if (hit) return hit as Promise<T>;
  const p = http
    .get(url, { params })
    .then((r) => r.data as T)
    .finally(() => inflightGets.delete(key));
  inflightGets.set(key, p);
  return p;
};
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
