import { get, post, http, setAccessToken } from './client';

export interface JwtUser {
  id: string;
  username: string;
  name: string;
  role: 'SUPER_ADMIN' | 'GRADE_ADMIN' | 'CLASS_LEADER' | 'STUDENT';
  mustChangePwd: boolean;
  classId?: string | null;
  className?: string | null;
  grade?: number | null;
}

export async function login(username: string, password: string) {
  const r = await post<{ accessToken: string; user: JwtUser }>('/auth/login', { username: username.trim(), password });
  setAccessToken(r.accessToken);
  return r.user;
}

export async function logout() {
  await post('/auth/logout').catch(() => undefined);
  setAccessToken('');
}

export async function changePassword(oldPassword: string, newPassword: string) {
  const r = await post<{ accessToken: string; user: JwtUser }>('/auth/change-password', { oldPassword, newPassword });
  setAccessToken(r.accessToken);
  return r.user;
}

/** 静默恢复会话（页面刷新后靠 refresh cookie 换新 access） */
export async function restore(): Promise<JwtUser | null> {
  const r = await http.post<any, { accessToken?: string }>('/auth/refresh', {}).catch(() => null);
  if (!r?.accessToken) return null;
  setAccessToken(r.accessToken);
  return (await get<JwtUser>('/auth/me').catch(() => null)) as JwtUser | null;
}
