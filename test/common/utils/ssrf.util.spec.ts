import { BadRequestException } from '@nestjs/common';
import { assertPublicUrl } from 'src/common/utils/ssrf.util';
import { lookup } from 'node:dns/promises';

// mock DNS 解析，域名路径的测试不依赖真实网络
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));

const mockLookup = lookup as unknown as jest.Mock;

describe('assertPublicUrl（SSRF 防护）', () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  it('应拒绝回环地址', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:8080/api')).rejects.toThrow(BadRequestException);
    await expect(assertPublicUrl('http://127.0.0.1:8080/api')).rejects.toThrow(
      '禁止访问内网或保留地址',
    );
  });

  it('应拒绝 IPv6 回环地址', async () => {
    await expect(assertPublicUrl('http://[::1]:8080/')).rejects.toThrow(BadRequestException);
  });

  it('应拒绝私网地址（10/8、172.16/12、192.168/16）', async () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
      await expect(assertPublicUrl(`http://${ip}/`)).rejects.toThrow('禁止访问内网或保留地址');
    }
  });

  it('应拒绝云元数据地址（169.254.0.0/16）', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('应拒绝 localhost 域名', async () => {
    await expect(assertPublicUrl('http://localhost:3000/')).rejects.toThrow(BadRequestException);
  });

  it('应拒绝非 http/https 协议', async () => {
    await expect(assertPublicUrl('ftp://example.com/file')).rejects.toThrow(
      '仅支持 http/https 协议',
    );
  });

  it('应拒绝格式非法的 URL', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow(BadRequestException);
  });

  it('应放行公网 IP 字面量（无需 DNS）', async () => {
    const url = await assertPublicUrl('https://8.8.8.8/path');
    expect(url.hostname).toBe('8.8.8.8');
  });

  it('域名解析到私网地址时应拒绝', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(assertPublicUrl('https://evil.example.com/')).rejects.toThrow(
      '禁止访问内网或保留地址',
    );
  });

  it('域名解析到公网地址时应放行', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    const url = await assertPublicUrl('https://example.com/');
    expect(url.hostname).toBe('example.com');
  });

  it('域名解析失败时应抛出中文错误', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertPublicUrl('https://no-such-host.invalid/')).rejects.toThrow('域名解析失败');
  });
});
