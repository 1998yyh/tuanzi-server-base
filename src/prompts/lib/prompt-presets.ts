// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/services/api/prompt-source-presets.ts。改造点：nanoid → 固定 slug（入库种子需幂等）
export const PROMPT_REGISTRY_HOMEPAGE = 'https://github.com/yukkcat/image-prompts';
const PROMPT_REGISTRY_SOURCE_BASE =
  'https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources';

export interface BuiltinPromptSource {
  /** 固定 slug，作为幂等种子的去重键 */
  slug: string;
  name: string;
  url: string;
  homepage: string;
}

export const DEFAULT_PROMPT_SOURCES: BuiltinPromptSource[] = [
  registrySource(
    'banana-prompt-quicker',
    'Banana Prompt Quicker',
    'https://glidea.github.io/banana-prompt-quicker/',
  ),
  registrySource(
    'davidwu-gpt-image2-prompts',
    'DavidWu GPT Image 2',
    'https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts',
  ),
  registrySource(
    'awesome-gpt-image',
    'Awesome GPT Image',
    'https://github.com/ZeroLu/awesome-gpt-image',
  ),
  registrySource(
    'awesome-gpt4o-image-prompts',
    'Awesome GPT-4o',
    'https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts',
  ),
  registrySource(
    'youmind-gpt-image-2',
    'YouMind GPT Image 2',
    'https://github.com/YouMind-OpenLab/awesome-gpt-image-2',
  ),
  registrySource(
    'youmind-nano-banana-pro',
    'YouMind Nano Banana Pro',
    'https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts',
  ),
];

function registrySource(slug: string, name: string, homepage: string): BuiltinPromptSource {
  return { slug, name, url: `${PROMPT_REGISTRY_SOURCE_BASE}/${slug}.json`, homepage };
}
