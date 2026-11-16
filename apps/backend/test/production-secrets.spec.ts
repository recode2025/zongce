import { validateProductionSecrets } from '../src/config/env';

describe('生产密钥检查', () => {
  const valid = {
    jwtAccessSecret: 'a-unique-production-jwt-secret-long-enough',
    aesKeyHex: 'a1'.repeat(32),
    initialAdminPassword: 'unique-admin-password-2026',
  };

  test('接受明确配置的有效密钥', () => {
    expect(() => validateProductionSecrets(valid)).not.toThrow();
  });

  test.each([
    { jwtAccessSecret: '' },
    { jwtAccessSecret: 'ChangeMe_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c' },
    { aesKeyHex: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff' },
    { aesKeyHex: 'invalid' },
    { initialAdminPassword: 'Admin@Zc2026' },
    { initialAdminPassword: '' },
  ])('拒绝缺失或公开的生产配置 %#', (overrides) => {
    expect(() => validateProductionSecrets({ ...valid, ...overrides })).toThrow();
  });
});
