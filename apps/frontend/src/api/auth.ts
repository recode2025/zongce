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

export interface Captcha {
  captchaId: string;
  svg: string;
}

/** 图形验证码：5 分钟有效、一次性 */
export function fetchCaptcha() {
  return get<Captcha>('/auth/captcha');
}

export async function login(username: string, password: string, captcha?: { captchaId: string; captchaCode: string }) {
  const r = await post<{ accessToken: string; user: JwtUser }>('/auth/login', {
    username: username.trim(),
    password,
    captchaId: captcha?.captchaId,
    captchaCode: captcha?.captchaCode,
  });
  setAccessToken(r.accessToken);
  return r.user;
}

/** 数字大外统一身份认证（CAS）：学号 + 学校密码 */
export async function casLogin(username: string, password: string, captcha?: { captchaId: string; captchaCode: string }) {
  const r = await post<{ accessToken: string; user: JwtUser }>('/auth/cas-login', {
    username: username.trim(),
    password,
    captchaId: captcha?.captchaId,
    captchaCode: captcha?.captchaCode,
  });
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
  const r = await http.post<{ accessToken?: string }>('/auth/refresh', {}).then((x) => x.data).catch(() => null);
  if (!r?.accessToken) return null;
  setAccessToken(r.accessToken);
  return (await get<JwtUser>('/auth/me').catch(() => null)) as JwtUser | null;
}
