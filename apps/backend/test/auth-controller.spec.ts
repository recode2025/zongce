import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from '../src/modules/auth/auth.controller';
import { env } from '../src/config/env';

describe('认证控制器', () => {
  test('没有刷新令牌时返回 401，不访问刷新服务', async () => {
    const auth = { refresh: jest.fn() };
    const controller = new AuthController(auth as any, {} as any);
    await expect(controller.refresh({ cookies: {}, headers: {} } as any, {} as any, {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  test('CAS 授权生成带一次性状态的回调并跳转学校认证页', async () => {
    const cache = { set: jest.fn().mockResolvedValue(undefined) };
    const controller = new AuthController({} as any, cache as any);
    const redirect = jest.fn();
    const append = jest.fn();
    const ru = 'http://127.0.0.1:5173/cas/callback';
    await controller.casAuthorize(ru, { protocol: 'http', headers: { host: '127.0.0.1:5173' } } as any, { redirect, append } as any);
    expect(redirect).toHaveBeenCalledWith(302, expect.stringMatching(/^https?:\/\//));
    const url = new URL(redirect.mock.calls[0][1]);
    expect(`${url.origin}${url.pathname}`).toBe(`${env.casBase}/login`);
    const service = new URL(url.searchParams.get('service')!);
    expect(service.origin + service.pathname).toBe('http://127.0.0.1:5173/api/v1/auth/cas/callback');
    const stored = JSON.parse(cache.set.mock.calls[0][1]);
    expect(cache.set).toHaveBeenCalledWith(`cas:state:${service.searchParams.get('state')}`, expect.any(String), 600);
    expect(stored).toMatchObject({ service: service.toString(), ru, browserSecret: expect.any(String) });
    expect(append).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining(`zc_cas_${service.searchParams.get('state')}=${stored.browserSecret}`));
  });

  test('伪造转发主机不能放行未配置的回调地址', async () => {
    const controller = new AuthController({} as any, { set: jest.fn() } as any);
    const send = jest.fn();
    const status = jest.fn().mockReturnValue({ send });
    await controller.casAuthorize('http://untrusted.example/cas/callback', { headers: { 'x-forwarded-host': 'untrusted.example', 'x-forwarded-proto': 'http', host: 'untrusted.example' } } as any, { status } as any);
    expect(status).toHaveBeenCalledWith(400);
  });

  test('CAS 回调必须带有发起浏览器的秘密 cookie', async () => {
    const cache = { get: jest.fn().mockResolvedValue(JSON.stringify({ service: 'https://a/service', ru: 'https://a/callback', browserSecret: 'secret' })), del: jest.fn() };
    const auth = { casTicketLogin: jest.fn() };
    const controller = new AuthController(auth as any, cache as any);
    const status = jest.fn().mockReturnValue({ send: jest.fn() });
    await controller.casCallback('ticket', 'state', { headers: {}, cookies: {} } as any, { status } as any);
    expect(status).toHaveBeenCalledWith(400);
    expect(auth.casTicketLogin).not.toHaveBeenCalled();
    expect(cache.del).not.toHaveBeenCalled();
  });

  test('CAS 回调验证 cookie 后消费 state 并签发会话', async () => {
    const cache = { get: jest.fn().mockResolvedValue(JSON.stringify({ service: 'https://a/service', ru: 'https://a/callback', browserSecret: 'secret' })), del: jest.fn() };
    const auth = { casTicketLogin: jest.fn().mockResolvedValue({ refreshCookie: 'refresh', refreshToken: 'rt', accessToken: 'at', user: { name: 'n' } }) };
    const controller = new AuthController(auth as any, cache as any);
    const res = { append: jest.fn(), redirect: jest.fn() };
    await controller.casCallback('ticket', 'state', { ip: '127.0.0.1', headers: {}, cookies: { zc_cas_state: 'secret' } } as any, res as any);
    expect(cache.del).toHaveBeenCalledWith('cas:state:state');
    expect(auth.casTicketLogin).toHaveBeenCalledWith(expect.objectContaining({ ticket: 'ticket', ip: '127.0.0.1' }));
    expect(res.append).toHaveBeenCalledWith('Set-Cookie', 'refresh');
    expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('token=at'));
  });
});
