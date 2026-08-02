import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './users.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async create(email: string, username: string, password: string): Promise<User> {
    // 检查邮箱是否已存在
    const existingEmail = await this.usersRepository.findOne({
      where: { email },
    });
    if (existingEmail) {
      throw new ConflictException('邮箱已被注册');
    }

    // 检查用户名是否已存在
    const existingUsername = await this.usersRepository.findOne({
      where: { username },
    });
    if (existingUsername) {
      throw new ConflictException('用户名已被使用');
    }

    // 加密密码
    const hashedPassword = await bcrypt.hash(password, 10);

    // 创建用户
    const user = this.usersRepository.create({
      email,
      username,
      password: hashedPassword,
    });

    try {
      return await this.usersRepository.save(user);
    } catch (error) {
      // 兜底并发竞态：两个请求同时通过上方查重后，唯一索引会拦下后到的插入，
      // 将 MySQL 的 ER_DUP_ENTRY 转为业务冲突，避免泄漏 500
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string })?.code === 'ER_DUP_ENTRY'
      ) {
        throw new ConflictException('邮箱或用户名已被注册');
      }
      throw error;
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { username } });
  }

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async validatePassword(plainPassword: string, hashedPassword: string): Promise<boolean> {
    return bcrypt.compare(plainPassword, hashedPassword);
  }
}
