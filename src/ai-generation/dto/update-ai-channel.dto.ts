import { PartialType } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { CreateAiChannelDto } from './create-ai-channel.dto';

export class UpdateAiChannelDto extends PartialType(CreateAiChannelDto) {
  @ApiProperty({ required: false, description: '不传则保持原 API Key' })
  @IsString()
  @Length(1, 500)
  @IsOptional()
  apiKey?: string;
}
