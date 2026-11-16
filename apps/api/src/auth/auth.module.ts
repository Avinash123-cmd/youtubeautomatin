import { EmailService } from '../common/services/email.service';
import { OtpService } from './otp.service';
import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { BotAuthController } from './bot-auth.controller';
import { BotSecurityController } from './bot-security.controller';
import { SessionService } from './session.service';
import { TelegramAccountService } from './telegram-account.service';
import { TelegramBotLoginService } from './telegram-bot-login.service';

/** Legacy controllers/services remain in source for migration history but are not registered.
 * No password, Firebase, OIDC, email recovery or recovery-code path can issue a new session.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [BotAuthController, BotSecurityController],
  providers: [SessionService, TelegramAccountService, TelegramBotLoginService, OtpService, { provide: EmailService, useValue: new EmailService() }],
  exports: [SessionService, TelegramAccountService],
})
export class AuthModule {}
