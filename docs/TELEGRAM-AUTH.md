> **Historical authentication reference:** active authentication is Telegram Bot-only; OIDC, passwords and email recovery are retired. See [telegram-bot-only-auth.md](telegram-bot-only-auth.md) before configuring or migrating any account.

# Telegram sign-in and bot connection

ClipForge has two separate Telegram features:

- **Telegram sign-in** uses Telegram OpenID Connect Authorization Code Flow with PKCE. The API owns state, nonce, PKCE verification, token exchange, JWKS signature checks, account mapping, and creation of the normal ClipForge session cookie. A short-lived HttpOnly/SameSite=Lax cookie binds the returned state to the browser that started the flow.
- **Connect Telegram** associates a bot private chat with an already signed-in ClipForge account. The API stores only a hash of a random, single-use deep-link token. The webhook accepts updates only with Telegram's secret header and only links private chats whose sender ID matches the chat ID.

The OIDC Client ID and Client Secret are separate from `TELEGRAM_BOT_TOKEN`. The web app receives neither secret. A Telegram OIDC identity is matched by its immutable numeric subject; names and usernames are never used to merge accounts. New Telegram sign-ups are disabled until `TELEGRAM_LOGIN_ALLOW_NEW_USERS=true`.

## Environment

Set these on the API:

```dotenv
TELEGRAM_LOGIN_CLIENT_ID=123456789
TELEGRAM_LOGIN_CLIENT_SECRET=from-botfather-login-setup
TELEGRAM_LOGIN_REDIRECT_URI=https://clips.example.com/api/auth/telegram/callback
TELEGRAM_LOGIN_ALLOW_NEW_USERS=false

TELEGRAM_BOT_TOKEN=123456789:bot-api-token
TELEGRAM_BOT_USERNAME=ClipForgeBot
TELEGRAM_WEBHOOK_SECRET=long-random-base64url-secret
```

`TELEGRAM_LOGIN_REDIRECT_URI` must exactly match the redirect registered in BotFather. If it is omitted, ClipForge builds it from `APP_URL`. The callback must use the same public origin as the web app so the session cookie is set for the browser's app origin.

Telegram sign-up is separate from email registration. Keep `TELEGRAM_LOGIN_ALLOW_NEW_USERS=false` to allow Telegram only for identities already linked to ClipForge. Set it to `true` to create a workspace for a new Telegram identity. Telegram does not provide an email address, so the existing required email column gets a reserved `.invalid` alias; the dashboard labels it “Telegram account.” Such an account signs in with Telegram; email/password reset is unavailable because it has no email address. `ALLOW_SELF_REGISTRATION` continues to control email-and-password registration.

## BotFather setup

1. Create or select the ClipForge bot with `@BotFather` and copy its **Bot API token** into `TELEGRAM_BOT_TOKEN`.
2. In BotFather's Login Widget settings for that bot, register the app origin and the exact OIDC redirect URL. Copy the **Login Client ID** and **Login Client Secret** into the `TELEGRAM_LOGIN_*` variables. These credentials are not the Bot API token.
3. Set the bot command list to `start`, `help`, `status`, `connect`, and `disconnect`.
4. Set `TELEGRAM_BOT_USERNAME` without the leading `@` and set a random `TELEGRAM_WEBHOOK_SECRET` of at least 16 characters. The API checks Telegram's `X-Telegram-Bot-Api-Secret-Token` header with a constant-time comparison.
5. Sign in to ClipForge as a workspace owner/admin and open **Admin → Notifications**. Set the webhook URL to `https://clips.example.com/api/auth/telegram/webhook`, save it, then register the webhook. The existing Telegram client and admin panel handle registration; do not point the bot to a second webhook processor.
6. From **Settings → Telegram connection**, create a connection link and open it in Telegram. The token expires after 10 minutes, and creating a new link invalidates any earlier unused link for that account.

The bot commands use the linked private chat. `/disconnect` removes the bot connection and adjusts Telegram OTP mode if needed; Telegram OIDC sign-in remains linked independently.

## Local development

The checked-in example for local API origin validation is already correct:

```dotenv
APP_URL=http://localhost:3000
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
TELEGRAM_LOGIN_REDIRECT_URI=http://localhost:3000/api/auth/telegram/callback
```

Use the same hostname consistently in the browser and callback URI (`localhost` and `127.0.0.1` are different cookie origins). Add the callback URL to BotFather's allowed URLs. Telegram must reach the callback from the public internet; for a full Telegram login or bot-webhook test, use an HTTPS tunnel that forwards to the local web server, register the tunnel origin and callback in BotFather, and browse through that same tunnel origin. Telegram cannot deliver a webhook to a private `localhost` address.

The bot webhook URL must be publicly reachable over HTTPS. Use the public tunnel URL in Admin → Notifications while testing. `ALLOWED_ORIGINS` is an exact comma-separated allow-list with no trailing slash; include each browser origin you use.

## Database deployment

The migration only adds nullable Telegram user fields, unique indexes, and short-lived OIDC/connection-token tables. It does not delete or rewrite existing user rows or notification chat IDs.

```powershell
npm run db:generate
npm run db:deploy
```

Back up PostgreSQL before deployment as usual. Run `db:deploy` once after deploying the API code and before enabling the Telegram buttons.

## Production requirements

- Serve the app and OIDC callback over HTTPS and register the exact public callback URI with BotFather.
- Store the Login Client Secret, Bot API token, webhook secret, `SESSION_SECRET`, and `CREDENTIAL_ENCRYPTION_KEY` in the API secret manager only.
- Set `ALLOWED_ORIGINS` to the exact production web origin(s); do not add a wildcard for production.
- Register one webhook at `/api/auth/telegram/webhook` with the existing admin panel and use a strong webhook secret.
- Keep `TELEGRAM_LOGIN_ALLOW_NEW_USERS=false` unless self-provisioning by Telegram is intended.
- Deploy the Prisma migration before routing callbacks or bot updates to the new API.

Telegram's official OIDC documentation describes the authorization endpoint, code exchange, JWKS endpoint, `iss`/`aud`/`exp` checks, and PKCE S256: [Log In With Telegram](https://core.telegram.org/bots/telegram-login).
