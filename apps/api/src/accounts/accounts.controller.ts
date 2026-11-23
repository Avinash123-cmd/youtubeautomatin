import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentContext, Public, Roles } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { env } from '../common/env';
import { AccountsService } from './accounts.service';

const selectChannelSchema = z.object({ pendingToken: z.string().min(16), channelId: z.string().min(3).max(64) });
const accountListQuery = z.object({
  cursor: z.string().uuid().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

@ApiTags('accounts')
@Controller('api/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'List connected accounts (cursor-paginated; no credentials are returned)' })
  list(@CurrentContext() ctx: RequestContext, @Query() query: unknown) {
    return this.accounts.list(ctx, accountListQuery.parse(query));
  }

  @Roles('OWNER', 'ADMIN')
  @Post('youtube/connect')
  @RateLimit({ limit: 10, windowSeconds: 60, scope: 'account-connect' })
  startYouTube(@CurrentContext() ctx: RequestContext) {
    return this.accounts.startYouTube(ctx);
  }

  @Get('youtube/callback')
  @Public()
  @ApiOperation({ summary: 'YouTube OAuth callback — verifies state, returns channels for explicit selection' })
  async youtubeCallback(@Query('code') code: string, @Query('state') state: string, @Query('error') error: string | undefined, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (error) return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=authorization_denied`);
    if (!code || !state) return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=missing_code_or_state`);
    try {
      const result = await this.accounts.handleYouTubeCallback(code, state);
      const encoded = Buffer.from(JSON.stringify(result.channels)).toString('base64url');
      return res.redirect(`${env.APP_URL}/accounts?oauth=youtube_select&pending=${result.pendingToken}&channels=${encoded}`);
    } catch {
      // Provider/DB exceptions can contain tokens; never place them in URL history or referrers.
      return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=connection_failed`);
    }
  }

  @Roles('OWNER', 'ADMIN')
  @Post('youtube/select-channel')
  @ApiOperation({ summary: 'Confirm which authorized YouTube channel to publish to' })
  selectChannel(@Body() body: unknown, @CurrentContext() ctx: RequestContext) {
    const parsed = selectChannelSchema.parse(body);
    return this.accounts.completeYouTubeSelection(parsed.pendingToken, parsed.channelId, ctx);
  }

  @Roles('OWNER', 'ADMIN')
  @Post('instagram/connect')
  @RateLimit({ limit: 10, windowSeconds: 60, scope: 'account-connect' })
  startInstagram(@CurrentContext() ctx: RequestContext) {
    return this.accounts.startInstagram(ctx);
  }

  @Get('instagram/callback')
  @Public()
  @ApiOperation({ summary: 'Instagram OAuth callback (Instagram API with Instagram Login)' })
  async instagramCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string | undefined,
    @Query('error_description') description: string | undefined,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (error) return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=authorization_denied`);
    if (!code || !state) return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=missing_code_or_state`);
    try {
      const account = await this.accounts.handleInstagramCallback(code, state);
      return res.redirect(`${env.APP_URL}/accounts?oauth=instagram_connected&account=${account.id}`);
    } catch {
      // Provider/DB exceptions can contain tokens; never place them in URL history or referrers.
      return res.redirect(`${env.APP_URL}/accounts?oauth=error&reason=connection_failed`);
    }
  }

  @Roles('OWNER', 'ADMIN')
  @Post(':id/verify')
  @RateLimit({ limit: 30, windowSeconds: 60, scope: 'account-verify' })
  verify(@Param('id') id: string, @CurrentContext() ctx: RequestContext) {
    return this.accounts.verify(id, ctx);
  }

  @Roles('OWNER', 'ADMIN')
  @Delete(':id')
  disconnect(@Param('id') id: string, @CurrentContext() ctx: RequestContext) {
    return this.accounts.disconnect(id, ctx);
  }
}
