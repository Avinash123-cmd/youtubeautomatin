import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AppConfigService } from '../common/services/config.service';
import { PublishingController } from './publishing.controller';
import { PublishingService } from './publishing.service';

@Module({
  imports: [AccountsModule],
  controllers: [PublishingController],
  providers: [PublishingService, AppConfigService],
  exports: [PublishingService],
})
export class PublishingModule {}
