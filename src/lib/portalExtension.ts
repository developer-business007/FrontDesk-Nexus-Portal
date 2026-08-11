import { PORTAL_BRIDGE_CHANNEL } from "@/lib/sessionBridge";

export type PortalExtensionResponse =
  | { ok: true; dbWarning?: string }
  | { ok: false; error: string };

type ChromeRuntimeApi = {
  runtime: {
    sendMessage: (
      extensionId: string,
      message: unknown,
      responseCallback?: (response: unknown) => void,
    ) => void;
    lastError?: { message?: string };
  };
};

function getChromeRuntime(): ChromeRuntimeApi | undefined {
  const g = globalThis as unknown as { chrome?: ChromeRuntimeApi };
  const cr = g.chrome;
  if (cr?.runtime?.sendMessage) return cr;
  return undefined;
}

export function getChromeExtensionId(): string | undefined {
  const id = import.meta.env.VITE_CHROME_EXTENSION_ID?.trim();
  return id || undefined;
}

/** Why the portal cannot message the extension (null = OK to try). */
export function portalExtensionBlockReason(): "missing_extension_id" | "not_chrome" | null {
  if (!getChromeExtensionId()) return "missing_extension_id";
  if (!getChromeRuntime()) return "not_chrome";
  return null;
}

/** True when `chrome.runtime.sendMessage` is available and extension ID is configured. */
export function canSendPortalExtensionMessages(): boolean {
  return portalExtensionBlockReason() === null;
}

export function sendPortalExtensionMessage(message: Record<string, unknown>): Promise<PortalExtensionResponse> {
  const extensionId = getChromeExtensionId();
  if (!extensionId) {
    return Promise.reject(new Error("Set VITE_CHROME_EXTENSION_ID in the portal .env to your extension ID."));
  }
  const cr = getChromeRuntime();
  if (!cr) {
    return Promise.reject(
      new Error(
        "Chrome extension API not available. Open the portal in Chrome with the FrontDesk extension installed.",
      ),
    );
  }

  return new Promise((resolve, reject) => {
    cr.runtime.sendMessage(extensionId, message, (response: unknown) => {
      const le = cr.runtime.lastError;
      if (le?.message) {
        reject(new Error(le.message));
        return;
      }
      if (!response || typeof response !== "object") {
        reject(new Error("No response from extension."));
        return;
      }
      resolve(response as PortalExtensionResponse);
    });
  });
}

export function sendPortalOpenHotelPolicy(): Promise<PortalExtensionResponse> {
  return sendPortalExtensionMessage({
    channel: PORTAL_BRIDGE_CHANNEL,
    type: "OPEN_HOTEL_POLICY",
  });
}

export function sendPortalAdminRfidMakeKey(payload: {
  roomNumber: string;
  checkinTime: string;
  checkoutTime: string;
  cardSerial: number;
  confirmationNumber: string;
  guestName: string | null;
}): Promise<PortalExtensionResponse> {
  return sendPortalExtensionMessage({
    channel: PORTAL_BRIDGE_CHANNEL,
    type: "RFID_MAKE_KEY",
    roomNumber: payload.roomNumber.trim(),
    checkinTime: payload.checkinTime,
    checkoutTime: payload.checkoutTime,
    cardSerial: payload.cardSerial,
    confirmationNumber: payload.confirmationNumber.trim(),
    guestName: payload.guestName,
    portalAdminEncode: true,
  });
}
