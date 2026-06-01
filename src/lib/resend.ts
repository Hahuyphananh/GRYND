import { Resend } from "resend";

let resendClient: Resend | null = null;

function getResendClient() {
  if (resendClient) return resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  resendClient = new Resend(apiKey);
  return resendClient;
}

export const resend = {
  emails: {
    send: async (...args: Parameters<Resend["emails"]["send"]>) => {
      const client = getResendClient();
      if (!client) {
        return {
          data: null,
          error: {
            name: "MissingApiKey",
            message: "RESEND_API_KEY is not configured",
          },
        } as any;
      }
      return client.emails.send(...args);
    },
    receiving: {
      get: async (...args: Parameters<Resend["emails"]["receiving"]["get"]>) => {
        const client = getResendClient();
        if (!client) {
          return {
            data: null,
            error: {
              name: "MissingApiKey",
              message: "RESEND_API_KEY is not configured",
            },
          } as any;
        }
        return client.emails.receiving.get(...args);
      },
    },
  },
  webhooks: {
    verify: (...args: Parameters<Resend["webhooks"]["verify"]>) => {
      const client = resendClient ?? new Resend(process.env.RESEND_API_KEY || "missing-api-key");
      return client.webhooks.verify(...args);
    },
  },
};
