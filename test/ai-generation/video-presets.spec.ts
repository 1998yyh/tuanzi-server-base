import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChannelModelDto } from 'src/ai-generation/dto/create-ai-channel.dto';
import { ApiFormat, ModelCapability } from 'src/ai-generation/entities/ai-channel.entity';
import {
  getVideoPresets,
  resolveVideoModelConfig,
  validateVideoModelConfig,
} from 'src/ai-generation/video-presets';
import { AiChannelsService } from 'src/ai-generation/ai-channels.service';

const config = { template: 'image', requestFormat: 'json', minImages: 1, maxImages: 9 };
const model = (videoConfig: unknown, capability = ModelCapability.VIDEO) => ({
  name: 'custom',
  capability,
  videoConfig,
});
const checkModel = (value: unknown) =>
  validate(plainToInstance(ChannelModelDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('视频模型配置', () => {
  it('DTO 接受嵌套视频规则', async () => {
    expect(await checkModel(model(config))).toEqual([]);
  });
  it.each([
    { ...config, fields: { images: 'nested.url' } },
    { ...config, fields: { images: 'model' } },
    { ...config, fields: { images: 'constructor' } },
    { ...config, fields: { other: 'test' } },
    { ...config, maxImages: -1 },
    { ...config, maxImages: null },
    { ...config, fields: null },
    { ...config, fields: { images: null } },
    { ...config, unknown: true },
  ])('DTO 拒绝非法字段配置 %#', async (value) => {
    expect((await checkModel(model(value))).length).toBeGreaterThan(0);
  });
  it.each([
    model(config, ModelCapability.IMAGE),
    model({ ...config, minImages: 4, maxImages: 2 }),
    model({ ...config, template: 'first_last', minImages: 1, maxImages: 3 }),
    model({ ...config, template: 'text' }),
    model({ ...config, fields: { seconds: 'input_reference' } }),
  ])('业务层拒绝无效或冲突规则 %#', (value) => {
    const service = new AiChannelsService(null as never, null as never, '');
    expect(() => (service as any).validateModels(ApiFormat.OPENAI, [value])).toThrow();
  });
});

describe('渠道预设', () => {
  it('提供八个可直接保存的模型规则和四个素材模板', () => {
    const { presets, templates } = getVideoPresets();
    expect(presets[0]).toMatchObject({ id: '939593-video', baseUrl: 'https://ai.939593.xyz' });
    expect(presets[0].models).toHaveLength(8);
    expect(templates).toHaveLength(4);
    for (const model of presets[0].models) {
      expect(() => validateVideoModelConfig(model.videoConfig!)).not.toThrow();
    }
    expect(presets[0]).not.toHaveProperty('apiKey');
  });
  it('旧渠道只对确切域名和模型补预设，显式配置优先', () => {
    expect(
      resolveVideoModelConfig('https://ai.939593.xyz/v1', 'minimax_h3_first_last'),
    ).toMatchObject({ template: 'first_last', minImages: 2, maxImages: 2 });
    expect(
      resolveVideoModelConfig('https://ai.939593.xyz.attacker.com', 'minimax_h3_first_last'),
    ).toBeUndefined();
    expect(resolveVideoModelConfig('https://ai.939593.xyz', 'other-model')).toBeUndefined();
    const explicit = { template: 'text', requestFormat: 'multipart' } as const;
    expect(
      resolveVideoModelConfig('https://ai.939593.xyz', 'minimax_h3_first_last', explicit),
    ).toEqual(explicit);
  });
  it('预设和解析结果可修改而不污染其他渠道', () => {
    const first = getVideoPresets();
    first.presets[0].models[0].videoConfig!.fields!.seconds = 'duration';
    expect(getVideoPresets().presets[0].models[0].videoConfig!.fields!.seconds).toBe('seconds');
    const config = resolveVideoModelConfig('https://ai.939593.xyz', 'minimax_h3_i2v')!;
    config.maxImages = 0;
    expect(resolveVideoModelConfig('https://ai.939593.xyz', 'minimax_h3_i2v')!.maxImages).toBe(9);
  });
});
