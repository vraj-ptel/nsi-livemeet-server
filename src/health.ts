// When the server last heard from Zoom (since this process started).
let lastWebhookAt: Date | null = null;

export function markWebhookReceived(at: Date = new Date()): Date {
  lastWebhookAt = at;
  return at;
}

export function getLastWebhookAt(): Date | null {
  return lastWebhookAt;
}
