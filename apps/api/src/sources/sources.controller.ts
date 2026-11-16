import { BadRequestException, Body, Controller, Get, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import {
  completeUploadSchema,
  importUrlSchema,
  initiateUploadSchema,
  sourceListQuerySchema,
} from '@clipforge/validation';
import { CurrentContext } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { SourcesService } from './sources.service';
import { PrismaService } from '../common/prisma.service';

const MAX_PART_BYTES = 64 * 1024 * 1024;

@ApiTags('sources')
@Controller('api/sources')
export class SourcesController {
  constructor(private readonly sources: SourcesService, private readonly prisma: PrismaService) {}

  @Post('upload/initiate')
  @RateLimit({ limit: 20, windowSeconds: 60, scope: 'source-upload-initiate' })
  @ApiOperation({ summary: 'Start a resumable multipart upload session' })
  async initiate(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    return this.sources.initiate(initiateUploadSchema.parse(body), ctx);
  }

  @Post('upload/part')
  @RateLimit({ limit: 600, windowSeconds: 60, scope: 'source-upload-part' })
  @UseInterceptors(FileInterceptor('chunk', { storage: memoryStorage(), limits: { fileSize: MAX_PART_BYTES } }))
  @ApiOperation({ summary: 'Upload one part (local storage driver)' })
  async part(
    @Query('sourceVideoId') sourceVideoId: string,
    @Query('partNumber') partNumber: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentContext() ctx: RequestContext,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Missing multipart field "chunk"' });
    if (!sourceVideoId) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'sourceVideoId is required' });
    return this.sources.receivePart(sourceVideoId, Number(partNumber), file.buffer, ctx);
  }

  @Post('upload/complete')
  @RateLimit({ limit: 30, windowSeconds: 60, scope: 'source-upload-complete' })
  @ApiOperation({ summary: 'Finalize an upload, record the rights declaration and validate the media' })
  async complete(
    @Body() body: unknown,
    @CurrentContext() ctx: RequestContext,
  ) {
    const parsed = completeUploadSchema.parse(body);
    return this.sources.completeUpload(
      parsed.sourceVideoId,
      parsed.rightsDeclaration,
      ctx,
      parsed.parts ?? [],
      parsed.uploadId ?? null,
    );
  }

  @Post('import')
  @RateLimit({ limit: 10, windowSeconds: 60, scope: 'source-import' })
  @ApiOperation({ summary: 'Import an authorized direct-URL media file (SSRF-guarded)' })
  async import(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    return this.sources.importFromUrl(importUrlSchema.parse(body), ctx);
  }

  @Get()
  @ApiOperation({ summary: 'List source videos for the workspace' })
  async list(@Query() query: unknown, @CurrentContext() ctx: RequestContext) {
    return this.sources.list(ctx, sourceListQuerySchema.parse(query));
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentContext() ctx: RequestContext) {
    return this.sources.get(id, ctx);
  }
}
