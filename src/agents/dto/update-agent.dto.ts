import { PartialType } from '@nestjs/swagger';
import { CreateAgentDto } from './create-agent.dto';

/** apiKey 不传则保持原值，传了才重新加密 */
export class UpdateAgentDto extends PartialType(CreateAgentDto) {}
