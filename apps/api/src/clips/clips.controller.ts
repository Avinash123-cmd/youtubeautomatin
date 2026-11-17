import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { clipListQuerySchema, updateClipMetadataSchema } from '@clipforge/validation';
import { CurrentContext } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { ClipsService } from './clips.service';

@ApiTags('clips')
@Controller('api/clips')
export class ClipsController {
  constructor(private readonly clips: ClipsService) {}

  @Get()
  list(@Query() query: unknown, @CurrentContext() ctx: RequestContext) {
    return this.clips.list(ctx, clipListQuerySchema.parse(query) as never);
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string, @CurrentContext() ctx: RequestContext) {
    return this.clips.get(id, ctx);
  }

  @Get(':id/preview')
  @ApiOperation({ summary: 'Preview URL for the rendered variant' })
  async preview(@Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string, @CurrentContext() ctx: RequestContext) {
    const clip = await this.clips.get(id, ctx);
    return { previews: clip.variants.map((v: { id: string; previewUrl: string | null; width: number; height: number; durationSeconds: number | null }) => ({ variantId: v.id, url: v.previewUrl, width: v.width, height: v.height, durationSeconds: v.durationSeconds })) };
  }

  @Get(':id/download')
  download(@Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string, @CurrentContext() ctx: RequestContext) {
    return this.clips.registerDownload(id, ctx);
  }

  @Get(':id/captions')
  @ApiOperation({ summary: 'Download the clip captions as SRT (default), VTT or plain text' })
  async captions(
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Query('format') format: string | undefined,
    @CurrentContext() ctx: RequestContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const requested = format === 'vtt' || format === 'txt' ? format : 'srt';
    const file = await this.clips.captions(id, ctx, requested);
    response.setHeader('content-type', file.contentType);
    // The filename is derived server-side from a sanitised title, so it is safe in the header.
    response.setHeader('content-disposition', `attachment; filename="${file.filename}"`);
    return file.body;
  }

  @Patch(':id/metadata')
  updateMetadata(@Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string, @Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    return this.clips.updateMetadata(id, updateClipMetadataSchema.parse(body), ctx);
  }
}
