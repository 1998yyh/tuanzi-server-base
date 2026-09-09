/** 优先使用源标签归类，标题兜底；保留原标签，便于人工筛选后重新分类。 */
const RULES: [string, RegExp][] = [
  ['海报广告', /海报|广告|poster|advertis|banner/i],
  ['产品电商', /电商|产品|商品|包装|product|packag/i],
  ['标志与界面', /logo|标志|界面|ui\b|ux\b|网页|网站/i],
  ['信息图与演示', /信息图|ppt|演示|教育|文档|infographic|presentation|diagram/i],
  ['人物肖像', /人像|肖像|头像|写真|穿搭|portrait|fashion|headshot/i],
  ['插画动漫', /插画|动漫|漫画|绘本|illustrat|anime|comic/i],
  ['三维与潮玩', /3d|三维|手办|潮玩|玩偶|figurine|toy/i],
  ['建筑与风景', /建筑|风景|场景|装修|室内|旅游|landscape|architect|interior|scene/i],
  ['美食摄影', /美食|食物|food|cuisine/i],
  ['表情与趣味', /表情|趣味|搞笑|meme|sticker/i],
  ['图像编辑', /编辑|滤镜|风格迁移|修复|换脸|edit|filter|restor/i],
  ['摄影写实', /摄影|写实|photograph|realistic/i],
];

export function classifyPrompt(item: { title: string; tags: string[] }): string {
  for (const text of [item.tags.join(' '), item.title]) {
    const match = RULES.find(([, pattern]) => pattern.test(text));
    if (match) return match[0];
  }
  return '其他创意';
}
