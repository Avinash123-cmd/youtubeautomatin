import { Module } from '@nestjs/common';
import { AppConfigService } from '../common/services/config.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [JobsController],
  providers: [JobsService, AppConfigService],
  exports: [JobsService],
})
export class JobsModule {}
