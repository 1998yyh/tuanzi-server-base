import { Module } from '@nestjs/common';
import { StockMarketModule } from '../stock-market/stock-market.module';
import { StockScreeningModule } from '../stock-screening/stock-screening.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentsModule } from '../agents/agents.module';
import { ResearchConversation } from './research-conversation.entity';
import { ResearchWatch } from './research-watch.entity';
import { ResearchWatchService } from './research-watch.service';
import { StockResearchService } from './stock-research.service';
import { ResearchEvidenceService } from './research-evidence.service';
import { StockResearchController } from './stock-research.controller';
@Module({
  imports: [
    AgentsModule,
    StockMarketModule,
    StockScreeningModule,
    TypeOrmModule.forFeature([ResearchConversation, ResearchWatch]),
  ],
  providers: [StockResearchService, ResearchWatchService, ResearchEvidenceService],
  controllers: [StockResearchController],
})
export class StockResearchModule {}
