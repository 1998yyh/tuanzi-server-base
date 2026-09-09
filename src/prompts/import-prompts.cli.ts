/** 一次性导入：先 snapshot 在可访问源的机器下载，再在服务器 import。不会启动业务定时器。
 * pnpm exec ts-node src/prompts/import-prompts.cli.ts snapshot [--images]
 * pnpm exec ts-node src/prompts/import-prompts.cli.ts import [--owner 用户UUID]
 * 默认快照目录 uploads/prompt-import，图片目录 uploads/prompts；生产可执行编译后的 JS。
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ConfigModule } from '@nestjs/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { User, UserRole } from '../users/users.entity';
import { PromptSource } from './prompt-source.entity';
import { PromptItem } from './prompt-item.entity';
import { PromptsService } from './prompts.service';
import { DEFAULT_PROMPT_SOURCES } from './lib/prompt-presets';
import { RawPrompt, runPromptSource } from './lib/prompt-normalize';
import { mirrorPromptImage } from './lib/prompt-image-mirror';

const directory = join(process.cwd(), 'uploads', 'prompt-import');
type Snapshot = { url: string; name: string; items: RawPrompt[] }[];

async function snapshot(): Promise<void> {
  await mkdir(directory, { recursive: true });
  const sources: Snapshot = [];
  for (const source of DEFAULT_PROMPT_SOURCES) {
    const items = await runPromptSource(
      { ...source, id: source.name, isBuiltin: true },
      { signal: AbortSignal.timeout(30_000) },
    );
    sources.push({ url: source.url, name: source.name, items });
    console.log(`${source.name}: ${items.length} 条`);
  }
  await writeFile(join(directory, 'sources.json'), JSON.stringify(sources));
  if (!process.argv.includes('--images')) return;
  const urls = [
    ...new Set(
      sources.flatMap((s) =>
        s.items.flatMap((p) => [p.coverUrl, ...p.referenceImageUrls]).filter(Boolean),
      ),
    ),
  ];
  const mapping = new Map<string, string>();
  const failures: { url: string; error: string }[] = [];
  let next = 0;
  let complete = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const url = urls[next++];
        if (!url) break;
        try {
          mapping.set(url, await mirrorPromptImage(url, join(process.cwd(), 'uploads', 'prompts')));
        } catch (error) {
          failures.push({ url, error: error instanceof Error ? error.message : '下载失败' });
        }
        complete++;
        if (complete % 50 === 0)
          console.log(`图片 ${complete}/${urls.length}，失败 ${failures.length}`);
      }
    }),
  );
  for (const source of sources)
    for (const item of source.items) {
      item.coverUrl = mapping.get(item.coverUrl) || item.coverUrl;
      item.referenceImageUrls = item.referenceImageUrls.map((url) => mapping.get(url) || url);
    }
  await writeFile(join(directory, 'sources.json'), JSON.stringify(sources));
  await writeFile(join(directory, 'image-failures.json'), JSON.stringify(failures, null, 2));
  console.log(
    JSON.stringify({
      prompts: sources.reduce((n, s) => n + s.items.length, 0),
      images: urls.length,
      saved: mapping.size,
      failures: failures.length,
    }),
  );
}

async function importSnapshot(): Promise<void> {
  await ConfigModule.forRoot({ envFilePath: ['.env.local', '.env'] });
  const ds = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    username: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'tuanzi_server',
    entities: [User, PromptSource, PromptItem],
    synchronize: false,
  });
  await ds.initialize();
  try {
    const userRepo = ds.getRepository(User);
    const ownerOption = process.argv.indexOf('--owner');
    let owner =
      ownerOption >= 0
        ? await userRepo.findOneBy({ id: process.argv[ownerOption + 1] ?? '' })
        : await userRepo.findOneBy({ role: UserRole.ADMIN });
    if (!owner && ownerOption < 0 && (await userRepo.count()) === 1)
      owner = (await userRepo.find({ take: 1 }))[0];
    if (!owner) throw new Error('请通过 --owner 用户UUID 指定词库维护者');
    const service = new PromptsService(
      ds.getRepository(PromptSource),
      ds.getRepository(PromptItem),
    );
    await service.onApplicationBootstrap();
    const sources = await service.listSources(owner);
    const snapshots: Snapshot = JSON.parse(await readFile(join(directory, 'sources.json'), 'utf8'));
    for (const data of snapshots) {
      const source = sources.find((s) => s.userId === null && s.url === data.url);
      if (!source) throw new Error(`找不到源：${data.name}`);
      console.log(
        JSON.stringify(await service.importBuiltinSnapshot(owner, source.id, data.items)),
      );
    }
    const listing = await service.fetchPrompts(owner, { page: 1, pageSize: 1 });
    console.log(`导入完成，数据库查询验证通过，共 ${listing.total} 条`);
    const groups = await ds
      .getRepository(PromptItem)
      .createQueryBuilder('p')
      .select('p.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .groupBy('p.category')
      .getRawMany();
    console.log(JSON.stringify(groups));
  } finally {
    await ds.destroy();
  }
}

const command = process.argv[2];
(command === 'snapshot'
  ? snapshot()
  : command === 'import'
    ? importSnapshot()
    : Promise.reject(new Error('用法：import-prompts.cli.ts snapshot [--images] | import'))
).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
