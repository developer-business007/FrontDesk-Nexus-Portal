import { useEffect, useRef, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { decryptBinary, decryptJson, isEncryptedPayload } from "@/lib/encryption";
import { resolveDownloadUrl } from "@/lib/b2Storage";
import { createIdScanImageSignedUrl } from "@/lib/idScanStorage";
import { formatRoomChainForDisplay } from "@/lib/roomNumber";
import type { HotelSettings } from "@/lib/hotelSettings";
import type { GuestProfile, Reservation } from "@/types/database";
import {
  buildCashDepositReceiptPdf,
  buildChargebackEvidencePdf,
  buildGuestProfilePdf,
  buildPetPolicyPdf,
  buildPoliceReportPdf,
  buildRegistrationCardPdf,
  downloadPdfBytes,
  type HotelContact,
  type IdScanDetailGuru,
  type ParsedIdFields,
} from "@/lib/export-pdf";

type ExportType =
  | "reg-card"
  | "chargeback"
  | "pet-policy"
  | "police-report"
  | "cash-deposit"
  | "profile";

const EXPORT_OPTIONS: Array<{ id: ExportType; label: string; desc: string }> = [
  { id: "reg-card",      label: "Reg Card",      desc: "Registration card with T&C" },
  { id: "chargeback",    label: "Chargeback",    desc: "Dispute evidence package" },
  { id: "pet-policy",    label: "Pet Policy",    desc: "Pet acceptance agreement" },
  { id: "police-report", label: "Police Report", desc: "Guest ID record for LE" },
  { id: "cash-deposit",  label: "Cash Deposit",  desc: "Cash deposit receipt" },
  { id: "profile",       label: "Profile",       desc: "Full guest profile sheet" },
];

type DecryptedPii = {
  fullName?: string | null;
  dateOfBirth?: string | null;
  idNumber?: string | null;
  idType?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  address?: string | null;
  idGuru?: {
    firstName?: string | null;
    middleName?: string | null;
    lastName?: string | null;
    streetAddress?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    phone?: string | null;
    email?: string | null;
    phoneCountryCode?: string | null;
  } | null;
  documentDataSnapshot?: Record<string, unknown> | null;
};

function settingsToContact(s: HotelSettings): HotelContact {
  return {
    name:              s.hotelName,
    address:           s.hotelAddress,
    city:              s.hotelCity,
    state:             s.hotelState,
    zip:               s.hotelZip,
    phone:             s.hotelPhone,
    email:             s.hotelEmail,
    cashDepositAmount: s.cashDepositAmount,
  };
}

type ScanData = {
  idDetail: IdScanDetailGuru;
  parsed: ParsedIdFields;
  phone: string;
  email: string;
  scanTime: string | null;
  documentData: Record<string, unknown> | null;
  imageFrontPath: string | null;
  imageBackPath: string | null;
};

async function fetchScanData(confirmationNumber: string): Promise<ScanData> {
  const empty: ScanData = {
    idDetail: {}, parsed: {}, phone: "", email: "",
    scanTime: null, documentData: null,
    imageFrontPath: null, imageBackPath: null,
  };

  const { data } = await supabase
    .from("id_scans")
    .select("pii_encrypted, phone_encrypted, email_encrypted, scanned_at, image_front_path, image_back_path")
    .eq("confirmation_number", confirmationNumber)
    .order("scanned_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return empty;

  let idDetail: IdScanDetailGuru = {};
  let parsed: ParsedIdFields = {};
  let documentData: Record<string, unknown> | null = null;
  const row = data as Record<string, unknown>;

  if (isEncryptedPayload(row.pii_encrypted)) {
    try {
      const pii = await decryptJson<DecryptedPii>(row.pii_encrypted);
      idDetail = pii.idGuru ?? {};
      parsed = {
        fullName:    pii.fullName,
        idNumber:    pii.idNumber,
        idType:      pii.idType,
        dateOfBirth: pii.dateOfBirth,
        issueDate:   pii.issueDate,
        expiryDate:  pii.expiryDate,
        address:     pii.address,
      };
      documentData = pii.documentDataSnapshot ?? null;
    } catch { /* use empty */ }
  }

  let phone = "";
  let email = "";
  if (isEncryptedPayload(row.phone_encrypted)) {
    try { const o = await decryptJson<{ value?: string }>(row.phone_encrypted); phone = o.value?.trim() ?? ""; } catch { /* skip */ }
  }
  if (isEncryptedPayload(row.email_encrypted)) {
    try { const o = await decryptJson<{ value?: string }>(row.email_encrypted); email = o.value?.trim() ?? ""; } catch { /* skip */ }
  }

  return {
    idDetail, parsed, phone, email,
    scanTime:      (row.scanned_at as string | null) ?? null,
    documentData,
    imageFrontPath: (row.image_front_path as string | null) ?? null,
    imageBackPath:  (row.image_back_path  as string | null) ?? null,
  };
}

// Copied from extension/src/lib/signature-pdf.ts — same logic, portal supabase client
async function fetchLatestSignatureImagePath(confirmationNumber: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("signatures")
    .select("signature_image_path")
    .eq("confirmation_number", confirmationNumber)
    .not("signature_image_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return typeof row.signature_image_path === "string" ? row.signature_image_path : null;
}

async function fetchSignaturePng(imagePath: string): Promise<string> {
  const signedUrl = await resolveDownloadUrl({
    category: "guest-signatures",
    objectPath: imagePath,
    expiresIn: 3600,
  });
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`Signature PNG download failed (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  const decrypted = await decryptBinary(new Uint8Array(buf));
  let binary = "";
  for (let i = 0; i < decrypted.length; i++) binary += String.fromCharCode(decrypted[i]);
  return `data:image/png;base64,${btoa(binary)}`;
}

async function fetchLatestSignatureStoragePath(confirmationNumber: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("signatures")
    .select("storage_path")
    .eq("confirmation_number", confirmationNumber)
    .not("storage_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return typeof data.storage_path === "string" ? data.storage_path : null;
}

async function fetchDecryptSignaturePdf(storagePath: string): Promise<Uint8Array> {
  const signedUrl = await resolveDownloadUrl({
    category: "signature-pdfs",
    objectPath: storagePath,
    expiresIn: 3600,
  });
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  return decryptBinary(new Uint8Array(buf));
}

async function pathToBase64(storagePath: string | null): Promise<string | null> {
  if (!storagePath) return null;
  try {
    const url = await createIdScanImageSignedUrl(storagePath, 120);
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(",")[1] ?? "");
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function generatePdf(
  type: ExportType,
  res: Reservation,
  profile: GuestProfile,
  hotel: HotelSettings,
): Promise<void> {
  const scan = await fetchScanData(res.confirmation_number);
  const hotelContact = settingsToContact(hotel);
  const room = formatRoomChainForDisplay(res) ?? res.room_number ?? null;
  const conf = res.confirmation_number;

  const phone = scan.phone || profile.phone || "";
  const email = scan.email || profile.email || "";

  // Fall back to PMS guest name when no ID scan data
  if (!scan.idDetail.firstName && !scan.idDetail.lastName && res.guest_name) {
    const parts = res.guest_name.trim().split(/\s+/);
    scan.idDetail.firstName = parts[0] ?? "";
    scan.idDetail.lastName  = parts.slice(1).join(" ") || "";
  }
  if (!scan.parsed.fullName && res.guest_name) scan.parsed.fullName = res.guest_name;

  const safeName = (scan.idDetail.lastName || res.guest_name || "guest").replace(/\s+/g, "_");

  let bytes: Uint8Array;
  let filename: string;

  switch (type) {
    case "profile": {
      const frontB64 = await pathToBase64(scan.imageFrontPath);
      bytes = await buildGuestProfilePdf({
        idDetail:         scan.idDetail,
        parsed:           scan.parsed,
        phone, email,
        scanTime:         scan.scanTime,
        documentData:     scan.documentData,
        imageFrontBase64: frontB64,
        rotationDeg: 0, flipH: false,
        hotel: hotelContact,
      });
      filename = `profile_${safeName}_${conf}.pdf`;
      break;
    }
    case "cash-deposit":
      bytes = await buildCashDepositReceiptPdf({
        idDetail: scan.idDetail, parsed: scan.parsed,
        scanTime:           scan.scanTime ?? res.check_in_date,
        roomNumber:         room,
        confirmationNumber: conf,
        checkOutDate:       res.check_out_date,
        hotel:              hotelContact,
      });
      filename = `cash_deposit_${safeName}_${conf}.pdf`;
      break;

    case "police-report": {
      const frontB64 = await pathToBase64(scan.imageFrontPath);
      bytes = await buildPoliceReportPdf({
        idDetail: scan.idDetail, parsed: scan.parsed,
        documentData:       scan.documentData,
        imageFrontBase64:   frontB64,
        rotationDeg: 0, flipH: false,
        roomNumber:         room,
        confirmationNumber: conf,
        checkInDate:        res.check_in_date,
        checkOutDate:       res.check_out_date,
        hotel:              hotelContact,
      });
      filename = `police_report_${safeName}_${conf}.pdf`;
      break;
    }
    case "reg-card": {
      let signaturePngDataUrl: string | null = null;
      try {
        const imgPath = await fetchLatestSignatureImagePath(conf);
        if (imgPath) signaturePngDataUrl = await fetchSignaturePng(imgPath);
      } catch { /* proceed without signature */ }
      bytes = await buildRegistrationCardPdf({
        idDetail: scan.idDetail, parsed: scan.parsed,
        phone, email,
        roomNumber:          room,
        confirmationNumber:  conf,
        checkInDate:         res.check_in_date,
        checkOutDate:        res.check_out_date,
        hotel:               hotelContact,
        signaturePngDataUrl,
      });
      filename = `reg_card_${safeName}_${conf}.pdf`;
      break;
    }
    case "chargeback": {
      let signaturePngDataUrl: string | null = null;
      let regCardPdfBytes: Uint8Array | null = null;
      const [regCardResult, sigImgPath] = await Promise.allSettled([
        fetchLatestSignatureStoragePath(conf),
        fetchLatestSignatureImagePath(conf),
      ]);
      try {
        const storagePath = regCardResult.status === "fulfilled" ? regCardResult.value : null;
        if (storagePath) regCardPdfBytes = await fetchDecryptSignaturePdf(storagePath);
      } catch { /* proceed without reg card PDF */ }
      try {
        const imgPath = sigImgPath.status === "fulfilled" ? sigImgPath.value : null;
        if (imgPath) signaturePngDataUrl = await fetchSignaturePng(imgPath);
      } catch { /* proceed without signature PNG */ }
      const [frontB64, backB64] = await Promise.all([
        pathToBase64(scan.imageFrontPath),
        pathToBase64(scan.imageBackPath),
      ]);
      bytes = await buildChargebackEvidencePdf({
        idDetail: scan.idDetail, parsed: scan.parsed,
        imageFrontBase64:    frontB64,
        imageBackBase64:     backB64,
        rotationDeg: 0, flipH: false,
        roomNumber:          room,
        confirmationNumber:  conf,
        checkInDate:         res.check_in_date,
        checkOutDate:        res.check_out_date,
        scanTime:            scan.scanTime,
        hotel:               hotelContact,
        signaturePngDataUrl,
        regCardPdfBytes,
      });
      filename = `chargeback_${safeName}_${conf}.pdf`;
      break;
    }
    case "pet-policy": {
      let signaturePngDataUrl: string | null = null;
      try {
        const imgPath = await fetchLatestSignatureImagePath(conf);
        if (imgPath) signaturePngDataUrl = await fetchSignaturePng(imgPath);
      } catch { /* proceed without signature */ }
      bytes = await buildPetPolicyPdf({
        idDetail: scan.idDetail, parsed: scan.parsed,
        roomNumber:          room,
        confirmationNumber:  conf,
        checkInDate:         res.check_in_date,
        checkOutDate:        res.check_out_date,
        hotel:               hotelContact,
        signaturePngDataUrl,
      });
      filename = `pet_policy_${safeName}_${conf}.pdf`;
      break;
    }
  }

  downloadPdfBytes(bytes, filename);
}

type Props = {
  reservation: Reservation;
  profile: GuestProfile;
  hotel: HotelSettings;
};

export function ReservationExportDropdown({ reservation, profile, hotel }: Props) {
  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState<ExportType | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function handleSelect(type: ExportType) {
    setError(null);
    setLoading(type);
    try {
      await generatePdf(type, reservation, profile, hotel);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setLoading(null);
    }
  }

  const busy = loading !== null;

  return (
    <>
      <button
        type="button"
        onClick={() => { setError(null); setOpen(true); }}
        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--text-h)] transition-colors hover:bg-[var(--surface-3)]"
        title="Export reservation PDFs"
      >
        <Download className="h-3.5 w-3.5" aria-hidden />
        Export
      </button>

      {open && (
        // Fixed overlay — not clipped by any parent overflow
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Export reservation PDFs"
            className="w-full max-w-sm overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface-2)] px-5 py-4">
              <div>
                <p className="text-sm font-semibold text-[var(--text-h)]">Export PDF</p>
                <p className="mt-0.5 font-mono text-xs text-[var(--text-muted)]">
                  {reservation.confirmation_number}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-h)] disabled:opacity-40"
                aria-label="Close"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            {/* Options */}
            <div className="divide-y divide-[var(--border)]">
              {EXPORT_OPTIONS.map((opt) => {
                const isActive = loading === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void handleSelect(opt.id)}
                    className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-3)]">
                      {isActive
                        ? <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" aria-hidden />
                        : <Download className="h-4 w-4 text-[var(--accent)]" aria-hidden />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[var(--text-h)]">{opt.label}</p>
                      <p className="text-xs text-[var(--text-muted)]">{opt.desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Error banner */}
            {error && (
              <div className="border-t border-red-500/20 bg-red-950/40 px-5 py-3">
                <p className="text-xs text-red-400">{error}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
