import { PartialType } from '@nestjs/swagger';
import { CreateAgentDto } from './create-agent.dto';

/** 部分更新；channelId/modelName 传其一时按合并后的组合校验 */
export class UpdateAgentDto extends PartialType(CreateAgentDto) {}
