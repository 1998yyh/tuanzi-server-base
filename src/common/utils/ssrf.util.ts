import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * 服务端出站请求的 SSRF 防护（2026-08-15 代码审查新增）。
 *
 * 所有「由用户/远端内容提供 URL、服务端主动 fetch」的入口都应先调用 assertPublicUrl：
 * - assets.service.fetchImage（图片导入）
 * - prompts.prompt-normalize（提示词源抓取）
 * - ai-generation 结果 URL 下载（图片/视频/音频）
 * - mcp-servers 的 sse / streamable-http 类型 Server URL（建连前校验）
 *
 * 校验内容：协议仅 http/https；host 为字面 IP 时直接查黑名单；
 * 为域名时解析全部 A/AAAA 记录逐一比对（防 DNS rebinding 的尽力而为手段）。
 * 黑名单覆盖：回环、私网、链路本地、CGNAT、云元数据（169.254.0.0/16）、
 * 组播/保留段。
 *
 * ⚠️ 实现注意：Node 的 BlockList.check 在含 IPv6 规则时会把 IPv4 地址归一化为
 * `::ffff:x.x.x.x` 再比对，因此不能添加 `::ffff:0:0/96` 之类的映射段条目
 * （会误杀全部公网 IPv4）；v4-mapped 地址在此处显式提取内嵌 IPv4 后走 IPv4 规则。
 */

const BLOCKED = new BlockList();
BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4'); // 本机通配地址
BLOCKED.addSubnet('10.0.0.0', 8, 'ipv4'); // 私网
BLOCKED.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT 共享地址
BLOCKED.addSubnet('127.0.0.0', 8, 'ipv4'); // 回环
BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4'); // 链路本地 / 云元数据
BLOCKED.addSubnet('172.16.0.0', 12, 'ipv4'); // 私网
BLOCKED.addSubnet('192.168.0.0', 16, 'ipv4'); // 私网
BLOCKED.addSubnet('198.18.0.0', 15, 'ipv4'); // 基准测试网段
BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4'); // 组播
BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4'); // 保留
BLOCKED.addSubnet('::1', 128, 'ipv6'); // 回环
BLOCKED.addSubnet('fc00::', 7, 'ipv6'); // 唯一本地地址（ULA）
BLOCKED.addSubnet('fe80::', 10, 'ipv6'); // 链路本地

/** IPv4 映射的 IPv6 地址（::ffff:a.b.c.d）提取内嵌 IPv4，统一走 IPv4 规则 */
function normalizeForCheck(address: string, family: 'ipv4' | 'ipv6') {
  if (family === 'ipv6' && address.toLowerCase().startsWith('::ffff:')) {
    const embedded = address.slice(7);
    if (isIP(embedded) === 4) return { address: embedded, family: 'ipv4' as const };
  }
  return { address, family };
}

function assertNotBlocked(address: string, family: 'ipv4' | 'ipv6'): void {
  const { address: addr, family: fam } = normalizeForCheck(address, family);
  if (BLOCKED.check(addr, fam)) {
    throw new BadRequestException('禁止访问内网或保留地址');
  }
}

/**
 * 校验 URL 允许服务端抓取，返回规范化后的 URL。
 * 非法时抛 BadRequestException（中文消息），调用方无需再包一层。
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('URL 格式非法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('仅支持 http/https 协议');
  }
  // URL.hostname 对 IPv6 字面量会带方括号（如 [::1]），先去掉
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new BadRequestException('URL 缺少主机名');

  const literalFamily = isIP(hostname);
  if (literalFamily === 4) {
    assertNotBlocked(hostname, 'ipv4');
    return url;
  }
  if (literalFamily === 6) {
    assertNotBlocked(hostname, 'ipv6');
    return url;
  }
  if (hostname.toLowerCase() === 'localhost') {
    throw new BadRequestException('禁止访问本机地址');
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new BadRequestException('域名解析失败，请检查地址是否可访问');
  }
  for (const { address } of addresses) {
    const fam = isIP(address);
    if (fam === 0) continue;
    assertNotBlocked(address, fam === 4 ? 'ipv4' : 'ipv6');
  }
  return url;
}
