import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/** 周目标表（对应 src/weekly-goals/weekly-goals.entity.ts） */
export class CreateWeeklyGoals1754558400000 implements MigrationInterface {
  name = 'CreateWeeklyGoals1754558400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'weekly_goals',
        columns: [
          { name: 'id', type: 'varchar', length: '36', isPrimary: true },
          { name: 'user_id', type: 'varchar', length: '255' },
          { name: 'title', type: 'varchar', length: '100' },
          { name: 'note', type: 'text', isNullable: true },
          { name: 'due_date', type: 'datetime' },
          { name: 'completed_at', type: 'datetime', isNullable: true },
          {
            name: 'created_at',
            type: 'datetime',
            precision: 6,
            default: 'CURRENT_TIMESTAMP(6)',
          },
          {
            name: 'updated_at',
            type: 'datetime',
            precision: 6,
            default: 'CURRENT_TIMESTAMP(6)',
            onUpdate: 'CURRENT_TIMESTAMP(6)',
          },
          { name: 'deleted_at', type: 'datetime', precision: 6, isNullable: true },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'weekly_goals',
      new TableIndex({
        name: 'IDX_weekly_goals_user_id',
        columnNames: ['user_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('weekly_goals');
  }
}
