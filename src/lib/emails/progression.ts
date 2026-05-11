import { renderTemplate, sendEmailSafely } from "./base";
export const sendProgressionEmail = (user: any, level: number) =>
  sendEmailSafely({
    user,
    type: "progression",
    subject: `You reached Level ${level}`,
    html: renderTemplate(
      `Level ${level} reached`,
      `<p>New rewards and game access are now unlocked.</p>`,
    ),
  });
