import { Module } from '@nestjs/common';
import { AppConfigService } from '../common/services/config.service';
import { MediaValidationService } from '../media/media-validation.service';
import { StorageModule } from '../storage/storage.module';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';
import { YoutubeImportService } from './youtube/youtube-import.service';

@Module({
  imports: [StorageModule],
  controllers: [SourcesController],
  providers: [SourcesService, MediaValidationService, AppConfigService, YoutubeImportService],
  exports: [SourcesService],
})
export class SourcesModule {}
