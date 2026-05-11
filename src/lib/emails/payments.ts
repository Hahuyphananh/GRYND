import { renderTemplate, sendEmailSafely } from "./base";
export const sendDepositProcessingEmail = (user: any, amount: number) =>
  sendEmailSafely({
    user,
    type: "deposit_processing",
    category: "transactional",
    subject: "Deposit is processing",
    html: renderTemplate(
      "Deposit Processing",
      `<p>Your deposit of ${amount} tokens is being processed.</p>`,
    ),
  });
export const sendDepositSuccessEmail = (user: any, amount: number) =>
  sendEmailSafely({
    user,
    type: "deposit_success",
    category: "transactional",
    subject: "Deposit complete",
    html: renderTemplate(
      "Deposit Success",
      `<p>Your deposit of ${amount} tokens has completed.</p>`,
    ),
  });
export const sendWithdrawalRequestedEmail = (user: any, amount: number) =>
  sendEmailSafely({
    user,
    type: "withdrawal_requested",
    category: "transactional",
    subject: "Withdrawal requested",
    html: renderTemplate(
      "Withdrawal Requested",
      `<p>We received your withdrawal request for ${amount} tokens.</p>`,
    ),
  });
export const sendWithdrawalDelayEmail = (user: any) =>
  sendEmailSafely({
    user,
    type: "withdrawal_delay",
    category: "transactional",
    subject: "Withdrawal delay update",
    html: renderTemplate(
      "Delay Notice",
      "<p>Your withdrawal is delayed. We are actively resolving it.</p>",
    ),
  });
