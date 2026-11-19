import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from '../src/modules/auth/auth.controller';
import { env } from '../src/config/env';

const ru = 'http://127.0.0.1:5173/cas/callback';

function response() {
  return {
    status: jest.fn().mockReturnThis(), send: jest.fn(), end: jest.fn(), cookie: jest.fn(),
    clearCookie: jest.fn(), append: jest.fn(), redirect: jest.fn(),
  };
}

function fixture() {
  const auth = {
    refresh: jest.fn(),
    casTicketLogin: jest.fn().mockResolvedValue({ refreshCookie: 'refresh', refreshToken: 'rt', accessToken: 'at', user: { name: 'n' } }),
  };
  const cache = { get: jest.fn(), del: jest.fn() };
  const states = { create: jest.fn(), consume: jest.fn() };
  const controller = new AuthController(auth as any, cache as any, states as any);
  return { auth, cache, states, controller };
}

describe('认证控制器', () => {
  test('没有刷新令牌时返回 401，不访问刷新服务', async () => {
    const { auth, controller } = fixture();
    await expect(controller.refresh({ cookies: {}, headers: {} } as any, {} as any, {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  test('浏览器在十分钟内完成回跳，使用授权时的 service 换票并签发会话', async () => {
    const { controller, auth, states } = fixture();
    const start = response();
    const before = Date.now();
    await controller.casAuthorize(ru, { method: 'GET' } as any, start as any);
    const [status, location] = start.redirect.mock.calls[0];
    expect(status).toBe(302);
    const login = new URL(location);
    expect(login.origin + login.pathname).toBe(env.casBase + '/login');
    const service = login.searchParams.get('service')!;
    const url = new URL(service);
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:5173/api/v1/auth/cas/callback');
    const state = url.searchParams.get('state')!;
    const [cookieName, secret, options] = start.cookie.mock.calls[0];
    expect(cookieName).toBe(`zc_cas_${state}`);
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: url.pathname, maxAge: 600_000 });
    const expiresAt = states.create.mock.calls[0][3];
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + options.maxAge);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + options.maxAge);
    expect(states.create).toHaveBeenCalledWith(state, secret, ru, expiresAt);

    states.consume.mockResolvedValue({ ru });
    const finish = response();
    await controller.casCallback('test-ticket', state, {
      method: 'GET', ip: '127.0.0.1', headers: {}, cookies: { [cookieName]: secret },
    } as any, finish as any);
    expect(states.consume).toHaveBeenCalledWith(state, secret);
    expect(auth.casTicketLogin).toHaveBeenCalledWith({ ticket: 'test-ticket', service, ip: '127.0.0.1', ua: '' });
    expect(finish.clearCookie).toHaveBeenCalledWith(cookieName, expect.objectContaining({ path: options.path }));
    expect(finish.append).toHaveBeenCalledWith('Set-Cookie', 'refresh');
    expect(finish.redirect).toHaveBeenCalledWith(302, ru + '#token=at&rt=rt&name=n');
  });

  test('伪造转发主机不能放行未配置的回调地址', async () => {
    const { controller, states } = fixture();
    const res = response();
    await controller.casAuthorize('http://untrusted.example/cas/callback', { headers: { 'x-forwarded-host': 'untrusted.example' } } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(states.create).not.toHaveBeenCalled();
  });

  const state = 'v2-' + 'a'.repeat(32);
  const secret = 'c'.repeat(64);
  test.each([
    ['缺少票据', '', state, secret],
    ['缺少浏览器 cookie', 'test-ticket', state, ''],
    ['状态格式错误', 'test-ticket', 'bad-state', secret],
  ])('%s 时返回前端重试页，保留待登录记录', async (_, ticket, queryState, cookie) => {
    const { controller, states, auth } = fixture();
    const res = response();
    await controller.casCallback(ticket, queryState, { cookies: { [`zc_cas_${queryState}`]: cookie } } as any, res as any);
    expect(states.consume).not.toHaveBeenCalled();
    expect(auth.casTicketLogin).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(302, expect.stringMatching(/^\/cas\/callback#error=/));
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  test('过期或已消费的回调允许重新登录，不换取会话', async () => {
    const { controller, states, auth } = fixture();
    states.consume.mockResolvedValue(null);
    const res = response();
    await controller.casCallback('test-ticket', state, { cookies: { [`zc_cas_${state}`]: secret } } as any, res as any);
    expect(states.consume).toHaveBeenCalledWith(state, secret);
    expect(auth.casTicketLogin).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(302, expect.stringMatching(/^\/cas\/callback#error=/));
  });

  test('HEAD 请求既不发起登录也不消耗状态', async () => {
    const { controller, auth, states } = fixture();
    const req = { method: 'HEAD', cookies: { [`zc_cas_${state}`]: secret } } as any;
    const res = response();
    await controller.casAuthorize(ru, req, res as any);
    await controller.casCallback('test-ticket', state, req, res as any);
    expect(res.end).toHaveBeenCalledTimes(2);
    expect(states.create).not.toHaveBeenCalled();
    expect(states.consume).not.toHaveBeenCalled();
    expect(auth.casTicketLogin).not.toHaveBeenCalled();
  });

  test('发版前已发起的登录仍可在原浏览器完成一次', async () => {
    const { controller, auth, cache } = fixture();
    const oldState = 'b'.repeat(32);
    const service = 'http://127.0.0.1:5173/api/v1/auth/cas/callback?state=' + oldState;
    cache.get.mockResolvedValue(JSON.stringify({ service, ru, browserSecret: secret }));
    cache.del.mockResolvedValueOnce(1).mockResolvedValue(0);
    const callback = (cookie: string) => controller.casCallback('test-ticket', oldState, {
      headers: {}, cookies: { [`zc_cas_${oldState}`]: cookie },
    } as any, response() as any);
    await callback('d'.repeat(64));
    expect(cache.del).not.toHaveBeenCalled();
    await Promise.all([callback(secret), callback(secret)]);
    expect(auth.casTicketLogin).toHaveBeenCalledTimes(1);
    expect(auth.casTicketLogin).toHaveBeenCalledWith(expect.objectContaining({ service }));
  });
});
