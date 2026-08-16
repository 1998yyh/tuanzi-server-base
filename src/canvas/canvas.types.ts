// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/types/canvas.ts（裁剪为后端需要的文档核心类型；
// 选区/右键菜单/助手会话等纯 UI 态与附件类型不移植）

export type Position = {
  x: number;
  y: number;
};

export type ViewportTransform = {
  x: number;
  y: number;
  k: number;
};

export enum CanvasNodeType {
  Image = 'image',
  Text = 'text',
  Config = 'config',
  Video = 'video',
  Audio = 'audio',
  Group = 'group',
}

/** 节点类型为开放字符串：内置类型用 CanvasNodeType，扩展类型为任意字符串 */
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = 'idle' | 'success' | 'loading' | 'error';
export type CanvasGenerationMode = 'text' | 'image' | 'video' | 'audio';
export type CanvasImageGenerationType = 'generation' | 'edit';

export type CanvasNodeMetadata = {
  content?: string;
  composerContent?: string;
  prompt?: string;
  status?: CanvasNodeStatus;
  errorDetails?: string;
  fontSize?: number;
  generationMode?: CanvasGenerationMode;
  generationType?: CanvasImageGenerationType;
  model?: string;
  reasoningEffort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh';
  size?: string;
  quality?: string;
  background?: string;
  count?: number;
  seconds?: string;
  vquality?: string;
  generateAudio?: string;
  watermark?: string;
  audioVoice?: string;
  audioFormat?: string;
  audioSpeed?: string;
  audioInstructions?: string;
  references?: string[];
  naturalWidth?: number;
  naturalHeight?: number;
  freeResize?: boolean;
  isBatchRoot?: boolean;
  batchRootId?: string;
  batchChildIds?: string[];
  batchUsesReferenceImages?: boolean;
  primaryImageId?: string;
  imageBatchExpanded?: boolean;
  storageKey?: string;
  mimeType?: string;
  bytes?: number;
  durationMs?: number;
  groupId?: string;
  interactive?: boolean;
  /** 服务端扩展：生成任务 ID（异步生成回填用） */
  taskId?: string;
  /** 服务端扩展：节点内容对应的 media_files.id（作为生成参考素材用） */
  mediaId?: string;
};

export type CanvasNodeData = {
  id: string;
  type: CanvasNodeTypeId;
  title: string;
  position: Position;
  width: number;
  height: number;
  metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};

/** 画布文档：canvas_projects.document JSON 列的完整内容 */
export type CanvasDocument = {
  nodes: CanvasNodeData[];
  connections: CanvasConnection[];
  viewport?: ViewportTransform;
};

export const EMPTY_CANVAS_DOCUMENT: CanvasDocument = {
  nodes: [],
  connections: [],
};
