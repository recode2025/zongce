import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { strEnc } from './des';
import { env } from '../../../config/env';

/**
 * 数字大外统一身份认证（CAS）客户端。
 * 流程逐行对照参考实现（Desktop/dlufl/cas-login.ts，已用真实账号验证过）：
 *  1. GET /cas/login 取 JSESSIONIDCAS cookie + 表单 lt/execution
 *  2. POST /cas/login 提交 DES(strEnc) 加密的 rsa 表单 → 成功标志 CASTGC cookie
 *  3. GET /cas/login?service=... 用 CASTGC 换 ticket → POST /cas/proxyValidate 换用户属性
 * 使用原生 fetch（redirect: manual + headers.getSetCookie），不引 axios。
 */

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export interface CasUserInfo {
  user_id: string;
  user_name: string;
  unit_name: string;
  id_number: string;
  id_type: string;
  [key: string]: string;
}

export interface CasLoginResult {
  /** CAS 侧 cookie 串（含 CASTGC），当前仅用于换 ticket，不落地存储 */
  cookie: string;
  userInfo: CasUserInfo;
}

/** ["A=1; Path=/", "B=2"] → "A=1; B=2"（手工 Cookie 请求头） */
function cookiePairs(raws: string[]): string {
  return raws.map((r) => r.split(';')[0]).join('; ');
}

async function casFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
}

function xmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** 解析 proxyValidate 返回的 sso:attribute 列表（简单 XML，正则即可，免引 xml2js） */
function parseCasAttributes(xml: string): CasUserInfo {
  const info: Record<string, string> = {};
  // 兼容 sso:/cas: 前缀、name/value 任意顺序、换行、单双引号、自闭合与否
  const tagRe = /<(?:sso|cas):attribute\s+([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const attrs = m[1];
    const name = /name\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1];
    const value = /value\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1];
    if (name) info[xmlDecode(name)] = xmlDecode(value ?? '');
  }
  return info as CasUserInfo;
}

@Injectable()
export class CasService {
  /** 用学号+学校密码走 CAS，成功返回用户属性；失败抛 UnauthorizedException（文案来自 CAS 页面） */
  async login(username: string, password: string, serviceUrl = env.casService): Promise<CasLoginResult> {
    const base = env.casBase;

    // 1) 取登录页：lt / execution / JSESSIONIDCAS
    const initRes = await casFetch(`${base}/login?service=${encodeURIComponent(serviceUrl)}&renew=true&_=${Date.now()}`, {
      headers: REQUEST_HEADERS,
    });
    const initCookies = initRes.headers.getSetCookie();
    if (!initCookies.some((c) => c.startsWith('JSESSIONIDCAS'))) {
      throw new UnauthorizedException('学校认证系统异常（未下发会话），请稍后重试或改用本地账号登录');
    }
    const $ = cheerio.load(await initRes.text());
    const lt = String($('#lt').val() || '');
    const execution = String($('input[name="execution"]').val() || '');
    if (!lt || !execution) {
      throw new UnauthorizedException('学校认证登录页解析失败，学校认证系统可能已变更');
    }

    // 2) 提交登录：不跟随重定向，看响应 Set-Cookie 是否有 CASTGC
    const rsa = strEnc(`${username}${password}${lt}`, '1', '2', '3');
    const loginRes = await casFetch(`${base}/login?service=${encodeURIComponent(serviceUrl)}`, {
      method: 'POST',
      headers: { ...REQUEST_HEADERS, Cookie: cookiePairs(initCookies) },
      body: new URLSearchParams({
        rsa,
        ul: String(username.length),
        pl: String(password.length),
        lt,
        execution,
        _eventId: 'submit',
      }).toString(),
      redirect: 'manual',
    });
    const postCookies = loginRes.headers.getSetCookie();
    const loginHtml = await loginRes.text();
    if (!postCookies.some((c) => c.startsWith('CASTGC'))) {
      const $r = cheerio.load(loginHtml);
      const msg = $r('#errormsghide').text().trim() || $r('#msg').text().trim();
      throw new UnauthorizedException(msg || '学校统一认证账号或密码错误');
    }

    // 3) CASTGC 换 ticket
    const ticketRes = await casFetch(`${base}/login?service=${encodeURIComponent(serviceUrl)}`, {
      headers: { ...REQUEST_HEADERS, Cookie: cookiePairs(postCookies.filter((c) => !c.startsWith('Language'))) },
      redirect: 'manual',
    });
    const location = ticketRes.headers.get('location') || '';
    const ticket = /[?&]ticket=([^&#]*)/.exec(location)?.[1];
    if (!ticket) throw new UnauthorizedException('CAS 票据获取失败，请重试');

    // 4) ticket 换用户属性
    const validateRes = await casFetch(`${base}/proxyValidate`, {
      method: 'POST',
      headers: REQUEST_HEADERS,
      body: new URLSearchParams({ service: serviceUrl, ticket }).toString(),
    });
    const xml = await validateRes.text();
    if (!xml.includes('sso:authenticationSuccess')) {
      throw new UnauthorizedException('CAS 票据校验未通过，请重试');
    }
    const userInfo = parseCasAttributes(xml);
    const missing = ['user_id', 'user_name', 'unit_name', 'id_number', 'id_type'].filter((k) => !userInfo[k]);
    if (missing.length) {
      // 带上实际收到的字段与原始 XML 片段，便于定位学校侧返回格式变化
      const got = Object.keys(userInfo).join(',') || '（无）';
      console.error(`[cas] proxyValidate 缺字段 ${missing.join(',')}，实际收到: ${got}\n${xml.slice(0, 2000)}`);
      throw new UnauthorizedException(`学校认证返回信息不完整（缺 ${missing.join('、')}，收到: ${got}）`);
    }

    return { cookie: cookiePairs(postCookies), userInfo };
  }
}
