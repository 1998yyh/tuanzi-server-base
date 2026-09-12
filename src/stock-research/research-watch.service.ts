import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ResearchWatch } from './research-watch.entity';
import { CreateWatchDto } from './dto/research.dto';
@Injectable()
export class ResearchWatchService {
  constructor(@InjectRepository(ResearchWatch) private readonly repo: Repository<ResearchWatch>) {}
  async list(userId: string) {
    return { items: await this.repo.find({ where: { userId }, order: { updatedAt: 'DESC' } }) };
  }
  async create(userId: string, dto: CreateWatchDto) {
    try {
      return await this.repo.save(
        this.repo.create({ userId, code: dto.code, name: dto.name, reason: dto.reason ?? '' }),
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ER_DUP_ENTRY'
      )
        throw new ConflictException('该股票已在观察池中');
      throw error;
    }
  }
  async remove(userId: string, id: string) {
    const result = await this.repo.delete({ id, userId });
    if (!result.affected) throw new NotFoundException('观察记录不存在');
  }
}
