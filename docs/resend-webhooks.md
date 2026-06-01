# Resend webhook setup

The application exposes one verified Resend webhook endpoint for both inbound receiving events and outbound sending events:

```text
/api/webhooks/resend
```

Use your deployed app origin to build the full endpoint URL. For example:

```text
https://your-app.example.com/api/webhooks/resend
```

## Required environment variables

Set these in your deployment provider and in `.env.local` for local testing:

```text
RESEND_API_KEY=your_resend_api_key
RESEND_WEBHOOK_SECRET=your_resend_webhook_signing_secret
```

`RESEND_WEBHOOK_SECRET` is required to verify that requests actually came from Resend. `RESEND_API_KEY` is required when the webhook handler fetches the full inbound email content from Resend's Received Emails API, because inbound `email.received` webhooks only include email metadata.

## Receiving email setup

1. Open the Resend dashboard and go to **Emails → Receiving**.
2. Copy your Resend-managed receiving address domain from the **Receiving address** action. It will look like `<id>.resend.app`.
3. Go to **Webhooks** and click **Add Webhook**.
4. Enter your endpoint URL, such as `https://your-app.example.com/api/webhooks/resend`.
5. Select the `email.received` event type for inbound emails.
6. Add the webhook, then copy the webhook signing secret and save it as `RESEND_WEBHOOK_SECRET`.
7. Send a test email to any address at your receiving domain, such as `support@<id>.resend.app`.

For custom domains, configure the receiving MX record in Resend first. Resend receives mail for any mailbox on that domain, so the application routes mail by inspecting the webhook `to` addresses.

## Sending event setup

There was not a separate sending-event webhook in the code before this setup. The existing `/api/webhooks/resend` endpoint now handles outbound sending events too.

1. Go to **Webhooks** in the Resend dashboard and click **Add Webhook**.
2. Enter the same endpoint URL: `https://your-app.example.com/api/webhooks/resend`.
3. Select the outbound email events you want to track:
   - `email.sent`
   - `email.scheduled`
   - `email.delivered`
   - `email.delivery_delayed`
   - `email.complained`
   - `email.bounced`
   - `email.opened`
   - `email.clicked`
   - `email.failed`
   - `email.suppressed`
4. You can also select `email.received` on the same webhook if you want one Resend webhook configuration for both inbound and outbound events.
5. Save the webhook, copy its signing secret, and set `RESEND_WEBHOOK_SECRET` to that value.
6. Send a test email through the app or Resend API to trigger `email.sent`, followed by delivery-related events such as `email.delivered`, `email.bounced`, or `email.failed` depending on the recipient.

If you create separate Resend webhook entries for receiving and sending, each entry has its own signing secret. This code reads one `RESEND_WEBHOOK_SECRET`, so configure both event groups on the same Resend webhook endpoint unless you add a second environment variable and endpoint.

## Local testing

For local development, expose the Next.js dev server with a public tunnel and use the tunnel URL in Resend:

```text
https://example123.ngrok.io/api/webhooks/resend
```

Then run the app locally with `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` configured.
