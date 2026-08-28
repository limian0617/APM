import { createEmailDeliveryHandler } from "@/modules/notifications/application/email-delivery-handler";
import { createMailAdapterFromEnvironment } from "@/modules/notifications/infrastructure/nodemailer-adapter";
import type { JobHandler } from "@/modules/governance/contracts/jobs";

export function createNotificationJobHandlers(): Readonly<Record<string, JobHandler>> {
  return {
    "notification.email.requested": createEmailDeliveryHandler(createMailAdapterFromEnvironment())
  };
}
