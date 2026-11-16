import 'reflect-metadata';
import { BadGatewayException, BadRequestException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApplyType, Role } from '@zc/shared';
import { env } from '../src/config/env';
import { AiDraftService } from '../src/modules/applications/ai-draft.service';
import { ApplicationsController } from '../src/modules/applications/applications.module';

describe('AI 申报草稿', () => {
  const originalKey = env.deepseekApiKey;
  const originalFetch = global.fetch;
  const findUnique = jest.fn();
  const consumeDailyQuota = jest.fn();
  const acquireAiSlot = jest.fn();
  const releaseAiSlot = jest.fn();
  const service = new AiDraftService({ ruleItem: { findUnique } } as any, { consumeDailyQuota, acquireAiSlot, releaseAiSlot } as any);
  const schema = [
    { field: 'level', label: '级别', type: 'select', options: [{ value: 'school', label: '校级' }] },
    { field: 'count', label: '次数', type: 'number' },
    { field: 'date', label: '日期', type: 'date' },
    { field: 'description', label: '说明', type: 'textarea' },
    { field: 'confirmed', label: '确认', type: 'boolean' },
  ];
  const rule = { id: 'rule-1', name: '活动', isActive: true, applyType: ApplyType.SELF, detailSchema: schema };
  const response = (content: unknown) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) });

  beforeEach(() => {
    jest.clearAllMocks();
    env.deepseekApiKey = 'test-key';
    findUnique.mockResolvedValue(rule);
    consumeDailyQuota.mockResolvedValue('ok');
    acquireAiSlot.mockResolvedValue(true);
    releaseAiSlot.mockResolvedValue(undefined);
    global.fetch = jest.fn().mockResolvedValue(response({ title: '活动', detail: {} })) as any;
  });
  afterAll(() => { env.deepseekApiKey = originalKey; global.fetch = originalFetch; });

  test('仅返回规则定义且类型和选项合法的字段', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(response({ title: ' 校运动会 ', detail: {
      level: 'school', count: 2, date: '2026-04-01', description: ' 参加比赛 ', confirmed: true, score: 100,
    } }));
    const draft = await service.generate('rule-1', '参加校运动会', 'student-1');
    expect(draft).toEqual({ title: '校运动会', detail: { level: 'school', count: 2, date: '2026-04-01', description: '参加比赛', confirmed: true } });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[1].content).toContain('参加校运动会');
  });

  test('仅携带当前规则的有限说明和字段，不携带其他规则或学生信息', async () => {
    findUnique.mockResolvedValueOnce({ ...rule, description: `  ${'规则'.repeat(250)}  `, otherRules: ['不应发送'], students: ['不应发送'] });
    await service.generate('rule-1', '事实', 'student-1');
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    const context = JSON.parse(body.messages[1].content);
    expect(context.description).toHaveLength(400);
    expect(Object.keys(context).sort()).toEqual(['description', 'facts', 'fields', 'rule']);
    expect(body.messages[0].content).toContain('不推断或评定分数、资格或赛事目录命中');
  });

  test('文字和图片合并为一次受额度保护的模型请求', async () => {
    await service.generate('rule-1', '真实事实', 'student-1', [{ mimeType: 'image/png', base64: 'YWJj' }]);
    expect(consumeDailyQuota).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(JSON.parse(body.messages[1].content[0].text).facts).toBe('真实事实');
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } });
    expect(JSON.stringify(body)).not.toContain('student-1');
  });

  test('丢弃无效选项、类型、日期及未知字段', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(response({ title: 123, detail: {
      level: 'national', count: '2', date: '昨天', description: 'x'.repeat(501), confirmed: 'true', score: 100,
    } }));
    expect(await service.generate('rule-1', '事实', 'student-1')).toEqual({ detail: {} });
  });

  test('拒绝空信息及不存在、停用或统一加分规则', async () => {
    await expect(service.generate('rule-1', '  ', 'student-1')).rejects.toBeInstanceOf(BadRequestException);
    for (const invalid of [null, { ...rule, isActive: false }, { ...rule, applyType: ApplyType.UNIFIED }]) {
      findUnique.mockResolvedValueOnce(invalid);
      await expect(service.generate('rule-1', '事实', 'student-1')).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('未配置密钥时不请求上游', async () => {
    env.deepseekApiKey = '';
    await expect(service.generate('rule-1', '事实', 'student-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('上游错误、无效 JSON 和错误的顶层结构均返回受控错误', async () => {
    for (const result of [{ ok: false }, { ok: true, json: async () => ({ choices: [{ message: { content: ' ' } }] }) }, response([])]) {
      (global.fetch as jest.Mock).mockResolvedValueOnce(result);
      await expect(service.generate('rule-1', '事实', 'student-1')).rejects.toBeInstanceOf(BadGatewayException);
    }
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network'));
    await expect(service.generate('rule-1', '事实', 'student-1')).rejects.toBeInstanceOf(BadGatewayException);
  });

  test('个人或全局额度耗尽，以及额度存储异常时，不请求模型', async () => {
    for (const reason of ['user', 'global']) {
      consumeDailyQuota.mockResolvedValueOnce(reason);
      await expect(service.generate('rule-1', '事实', 'student-1')).rejects.toMatchObject({ status: 429 });
    }
    consumeDailyQuota.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(service.generate('rule-1', '事实', 'student-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('在发起请求前扣额度，上游失败不退还', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network'));
    await expect(service.generate('rule-1', '事实', 'student-1')).rejects.toBeInstanceOf(BadGatewayException);
    expect(consumeDailyQuota).toHaveBeenCalledWith('student-1', env.aiDailyUserLimit, env.aiDailyGlobalLimit);
    expect(consumeDailyQuota.mock.invocationCallOrder[0]).toBeLessThan((global.fetch as jest.Mock).mock.invocationCallOrder[0]);
  });

  test('全局并发已满或 Redis 异常时拒绝且不扣日额度', async () => {
    acquireAiSlot.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('redis'));
    await expect(service.generate('rule-1', '事实', 'student-1')).rejects.toMatchObject({ status: 429 });
    await expect(service.generate('rule-1', '事实', 'student-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(consumeDailyQuota).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(releaseAiSlot).not.toHaveBeenCalled();
  });

  test('成功或上游失败均释放获得的并发槽', async () => {
    await service.generate('rule-1', '事实', 'student-1');
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network'));
    await expect(service.generate('rule-1', '事实', 'student-1')).rejects.toBeInstanceOf(BadGatewayException);
    expect(releaseAiSlot).toHaveBeenCalledTimes(2);
    expect(releaseAiSlot.mock.calls[0][0]).toEqual(acquireAiSlot.mock.calls[0][0]);
    expect(releaseAiSlot.mock.calls[1][0]).toEqual(acquireAiSlot.mock.calls[1][0]);
  });

  test('请求验证限制字段类型和长度', async () => {
    const dto = Reflect.getMetadata('design:paramtypes', ApplicationsController.prototype, 'draft')[0];
    expect(await validate(plainToInstance(dto, { ruleItemId: 'rule-1', text: '事实' }))).toHaveLength(0);
    expect((await validate(plainToInstance(dto, { ruleItemId: 123, text: 'x'.repeat(3001) }))).length).toBeGreaterThan(0);
  });

  test('按用户限流，超限时不调用模型', async () => {
    const cache = { incrWithWindow: jest.fn().mockResolvedValue(11) };
    const generate = jest.fn();
    const controller = new ApplicationsController({} as any, {} as any, cache as any, {} as any, { generate } as any);
    await expect(controller.draft({ ruleItemId: 'rule-1', text: '事实' }, { id: 'student-1', role: Role.STUDENT } as any)).rejects.toBeInstanceOf(HttpException);
    expect(cache.incrWithWindow).toHaveBeenCalledWith(expect.stringContaining('student-1'), 60);
    expect(generate).not.toHaveBeenCalled();
  });

  test('超管等非学生角色不能使用计费接口', async () => {
    const cache = { incrWithWindow: jest.fn() };
    const generate = jest.fn();
    const controller = new ApplicationsController({} as any, {} as any, cache as any, {} as any, { generate } as any);
    await expect(controller.draft({ ruleItemId: 'rule-1', text: '事实' }, { id: 'admin', role: Role.SUPER_ADMIN } as any)).rejects.toMatchObject({ status: 403 });
    expect(cache.incrWithWindow).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
