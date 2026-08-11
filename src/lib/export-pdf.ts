import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
  type PDFImage,
  type PDFEmbeddedPage,
} from 'pdf-lib'
import { formatStayDate } from '@/lib/calendarDate'

// ── Inlined types (mirror extension shared/pms-types + shared/protocol) ──────

export type HotelContact = {
  name: string
  address: string
  city: string
  state: string
  zip: string
  phone: string
  email: string
  cashDepositAmount: number
}

export type IdScanDetailGuru = {
  firstName?: string | null
  middleName?: string | null
  lastName?: string | null
  streetAddress?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
  phone?: string | null
  email?: string | null
  phoneCountryCode?: string | null
}

export type ParsedIdFields = {
  fullName?: string | null
  idNumber?: string | null
  idType?: string | null
  dateOfBirth?: string | null
  issueDate?: string | null
  expiryDate?: string | null
  address?: string | null
}

// ── Inlined helpers ───────────────────────────────────────────────────────────

function ageYearsFromDobString(dob: string | null | undefined): number | null {
  if (!dob?.trim()) return null
  const trimmed = dob.trim()
  let d: Date | null = null
  const t = Date.parse(trimmed)
  if (!isNaN(t)) d = new Date(t)
  if (!d) {
    const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (us) d = new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]))
  }
  if (!d) {
    const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (iso) d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  }
  if (!d || isNaN(d.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - d.getFullYear()
  const m = now.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--
  return age
}

function guessImageMimeFromBase64(b64: string): 'image/jpeg' | 'image/png' | 'image/bmp' {
  try {
    const raw = atob(b64.slice(0, 32))
    const u = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i)
    if (u.length >= 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'image/jpeg'
    if (u.length >= 4 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return 'image/png'
    if (u.length >= 2 && u[0] === 0x42 && u[1] === 0x4d) return 'image/bmp'
  } catch { /* invalid base64 */ }
  return 'image/png'
}

// Portal always passes rotationDeg=0 and flipH=false so this path is never hit.
function transformBase64ImageSync(b64: string, _deg: number, _flip: boolean): Promise<string> {
  return Promise.resolve(b64)
}

// ── Colors ──────────────────────────────────────────────────────────────────
const BLACK = rgb(0, 0, 0)
const GRAY  = rgb(0.45, 0.45, 0.45)
const LIGHT = rgb(0.75, 0.75, 0.75)

const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6,
  0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
])

function pdfSafe(s: string | null | undefined): string {
  if (!s) return ''
  return s.replace(/[^\x00-\xFF]/g, (c) => {
    const cp = c.codePointAt(0)!
    if (WIN_ANSI_EXTRAS.has(cp)) return c
    const map: Record<number, string> = {
      0x2192: '->', 0x2190: '<-', 0x2191: '^', 0x2193: 'v',
      0x21d2: '=>', 0x21d0: '<=', 0x2194: '<->',
      0x00b7: '.', 0x2212: '-', 0x00d7: 'x', 0x00f7: '/',
    }
    return map[cp] ?? ''
  })
}

function sanitizeHotel(h: HotelContact): HotelContact {
  return {
    ...h,
    name:    pdfSafe(h.name),
    address: pdfSafe(h.address),
    city:    pdfSafe(h.city),
    state:   pdfSafe(h.state),
    zip:     pdfSafe(h.zip),
    phone:   pdfSafe(h.phone),
    email:   pdfSafe(h.email),
  }
}

// ── Page geometry ─────────────────────────────────────────────────────────────
const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 50
const COL_W  = PAGE_W - MARGIN * 2

// ── Drawing helpers ───────────────────────────────────────────────────────────

function text(page: PDFPage, str: string, x: number, y: number, size: number, font: PDFFont, color = BLACK) {
  const s = pdfSafe(str)
  if (!s?.trim()) return
  page.drawText(s, { x, y, size, font, color })
}

function centeredText(page: PDFPage, str: string, y: number, size: number, font: PDFFont, color = BLACK) {
  const s = pdfSafe(str)
  if (!s?.trim()) return
  const w = font.widthOfTextAtSize(s, size)
  page.drawText(s, { x: (PAGE_W - w) / 2, y, size, font, color })
}

function hRule(page: PDFPage, y: number, color = LIGHT) {
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color })
}

function sectionHeader(page: PDFPage, label: string, y: number, bold: PDFFont): number {
  const size = 9
  page.drawText(label, { x: MARGIN, y, size, font: bold, color: BLACK })
  const w = bold.widthOfTextAtSize(label, size)
  page.drawLine({ start: { x: MARGIN, y: y - 1.5 }, end: { x: MARGIN + w, y: y - 1.5 }, thickness: 0.75, color: BLACK })
  return y - 14
}

function field(page: PDFPage, label: string, value: string | null | undefined, y: number, regular: PDFFont, size = 9): number {
  const v = pdfSafe(value?.trim())
  if (!v) return y
  page.drawText(`${label}: ${v}`, { x: MARGIN, y, size, font: regular, color: BLACK })
  return y - 13
}

// ── Date helpers ──────────────────────────────────────────────────────────────

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function formatDobDisplay(dob: string | null | undefined): string {
  if (!dob?.trim()) return ''
  const iso = dob.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) {
    const m = parseInt(iso[2]!, 10) - 1
    return `${String(parseInt(iso[3]!, 10)).padStart(2, '0')}-${MONTH_ABBR[m] ?? ''}-${iso[1]}`
  }
  const us = dob.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (us) {
    const m = parseInt(us[1]!, 10) - 1
    return `${String(parseInt(us[2]!, 10)).padStart(2, '0')}-${MONTH_ABBR[m] ?? ''}-${us[3]}`
  }
  return dob.trim()
}

function formatCheckInDisplay(iso: string | null | undefined): string {
  if (!iso?.trim()) return new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso!.trim()
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function formatFooterTimestamp(): string {
  const d = new Date()
  const day = String(d.getDate()).padStart(2, '0')
  const m = MONTH_ABBR[d.getMonth()] ?? ''
  const year = d.getFullYear()
  const time = d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day}-${m}-${year} ${time}`
}

function formatDateDisplay(iso: string | null | undefined): string {
  if (!iso?.trim()) return ''
  const formatted = formatStayDate(iso)
  return formatted === '—' ? iso.trim() : formatted
}

function normalizeGender(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  const g = raw.trim()
  if (g.toLowerCase() === 'm' || g.toLowerCase() === 'male') return 'Male'
  if (g.toLowerCase() === 'f' || g.toLowerCase() === 'female') return 'Female'
  return g
}

// ── Guest Profile PDF ─────────────────────────────────────────────────────────

export type GuestProfileInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  phone: string
  email: string
  scanTime: string | null
  documentData: Record<string, unknown> | null
  imageFrontBase64: string | null
  rotationDeg: number
  flipH: boolean
  hotel: HotelContact
}

export async function buildGuestProfilePdf(input: GuestProfileInput): Promise<Uint8Array> {
  const { idDetail, parsed, phone, email, scanTime, documentData } = input
  const hotel = sanitizeHotel(input.hotel)

  const pdfDoc = await PDFDocument.create()
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const page    = pdfDoc.addPage([PAGE_W, PAGE_H])

  const nameParts = [idDetail.firstName, idDetail.middleName, idDetail.lastName]
    .map(p => p?.trim()).filter(Boolean)
  const guestName = nameParts.length > 0
    ? nameParts.join(' ').toUpperCase()
    : (parsed.fullName?.trim().toUpperCase() ?? 'GUEST')

  let y = PAGE_H - MARGIN

  const nameSize = 16
  const nameW = bold.widthOfTextAtSize(guestName, nameSize)
  text(page, guestName, (PAGE_W - nameW) / 2, y, nameSize, bold)
  y -= 22

  const checkInStr = `Check-In at ${formatCheckInDisplay(scanTime)}`
  centeredText(page, checkInStr, y, 10, regular, GRAY)
  y -= 18

  hRule(page, y)
  y -= 18

  y = sectionHeader(page, 'CONTACT INFORMATION', y, bold)
  y -= 4

  const address = idDetail.streetAddress?.trim() || parsed.address?.trim()
  y = field(page, 'Address', address, y, regular)
  y = field(page, 'City',    idDetail.city,  y, regular)
  y = field(page, 'State',   idDetail.state, y, regular)

  if (idDetail.city?.trim() || idDetail.state?.trim()) y -= 4

  const phoneDisplay = phone.trim() || idDetail.phone?.trim()
  if (phoneDisplay) {
    const countryCode = idDetail.phoneCountryCode?.trim() || '+1'
    text(page, `Phone # ${countryCode} ${phoneDisplay}`, MARGIN, y, 9, regular)
    y -= 13
  }

  const emailDisplay = email.trim() || idDetail.email?.trim()
  y = field(page, 'Email', emailDisplay, y, regular)
  y -= 10

  hRule(page, y)
  y -= 18

  y = sectionHeader(page, 'ID INFORMATION', y, bold)
  y -= 4

  y = field(page, 'Type',        parsed.idType,     y, regular)
  y = field(page, 'Number',      parsed.idNumber,   y, regular)
  y = field(page, 'Issue Date',  parsed.issueDate,  y, regular)
  y = field(page, 'Expire Date', parsed.expiryDate, y, regular)
  y -= 10

  hRule(page, y)
  y -= 18

  y = sectionHeader(page, 'PERSONAL INFORMATION', y, bold)
  y -= 4

  const gender = normalizeGender(documentData?.gender ?? documentData?.sex)
  y = field(page, 'Gender', gender, y, regular)
  y = field(page, 'DOB', formatDobDisplay(parsed.dateOfBirth), y, regular)

  const ageYears = ageYearsFromDobString(parsed.dateOfBirth)
  if (ageYears !== null) {
    text(page, `Age: ${ageYears} Year(s)`, MARGIN, y, 9, regular)
    y -= 13
  }

  y -= 12

  if (input.imageFrontBase64?.trim()) {
    try {
      const transformed = (input.rotationDeg !== 0 || input.flipH)
        ? await transformBase64ImageSync(input.imageFrontBase64, input.rotationDeg, input.flipH)
        : input.imageFrontBase64
      const mime = guessImageMimeFromBase64(transformed)
      let embeddedImage: PDFImage
      if (mime === 'image/jpeg') embeddedImage = await pdfDoc.embedJpg(transformed)
      else if (mime === 'image/png') embeddedImage = await pdfDoc.embedPng(transformed)
      else { const pngB64 = await transformBase64ImageSync(transformed, 0, false); embeddedImage = await pdfDoc.embedPng(pngB64) }
      const maxW = 250; const maxH = 170
      const { width: iw, height: ih } = embeddedImage
      const scale = Math.min(maxW / iw, maxH / ih)
      const drawW = iw * scale; const drawH = ih * scale
      page.drawImage(embeddedImage, { x: (PAGE_W - drawW) / 2, y: y - drawH, width: drawW, height: drawH })
      y = y - drawH - 10
    } catch { /* continue without image */ }
  }

  const footerY1 = 36; const footerY2 = 22
  if (hotel.name || hotel.city || hotel.state) {
    const footerParts = [hotel.name, hotel.city, hotel.state].filter(Boolean)
    centeredText(page, footerParts.join(' • '), footerY1, 9, regular, GRAY)
  }
  centeredText(page, formatFooterTimestamp(), footerY2, 9, regular, GRAY)
  page.drawLine({ start: { x: MARGIN, y: footerY1 + 14 }, end: { x: PAGE_W - MARGIN, y: footerY1 + 14 }, thickness: 0.5, color: LIGHT })

  return pdfDoc.save()
}

// ── Mixed-segment text helper ────────────────────────────────────────────────

type Seg = { text: string; bold?: boolean; ul?: boolean }

function drawSegs(page: PDFPage, segs: Seg[], x0: number, y: number, size: number, reg: PDFFont, bld: PDFFont, maxW: number, lineH: number): number {
  const tokens: Array<{ word: string; bold: boolean; ul: boolean }> = []
  for (const seg of segs) {
    for (const w of pdfSafe(seg.text).split(/\s+/).filter(Boolean)) {
      tokens.push({ word: w, bold: !!seg.bold, ul: !!seg.ul })
    }
  }
  let x = x0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    const font = tok.bold ? bld : reg
    const ww = font.widthOfTextAtSize(tok.word, size)
    if (x > x0 && x + ww > x0 + maxW) { y -= lineH; x = x0 }
    page.drawText(tok.word, { x, y, size, font, color: BLACK })
    if (tok.ul) page.drawLine({ start: { x, y: y - 1.5 }, end: { x: x + ww, y: y - 1.5 }, thickness: 0.5, color: BLACK })
    x += ww
    if (i < tokens.length - 1) x += reg.widthOfTextAtSize(' ', size)
  }
  return y
}

function gridRow(page: PDFPage, leftLabel: string, leftValue: string | null, rightLabel: string, rightValue: string | null, y: number, reg: PDFFont, bld: PDFFont): number {
  const LS = 8; const VS = 9
  const LVX = 153; const LVE = 295
  const RLX = 315; const RVX = 430; const RVE = 562
  page.drawText(leftLabel,  { x: MARGIN, y, size: LS, font: reg, color: GRAY })
  const lv = pdfSafe(leftValue?.trim())
  if (lv) page.drawText(lv, { x: LVX, y, size: VS, font: bld, color: BLACK })
  page.drawLine({ start: { x: LVX, y: y - 2 }, end: { x: LVE, y: y - 2 }, thickness: 0.5, color: BLACK })
  page.drawText(rightLabel, { x: RLX, y, size: LS, font: reg, color: GRAY })
  const rv = pdfSafe(rightValue?.trim())
  if (rv) page.drawText(rv, { x: RVX, y, size: VS, font: bld, color: BLACK })
  page.drawLine({ start: { x: RVX, y: y - 2 }, end: { x: RVE, y: y - 2 }, thickness: 0.5, color: BLACK })
  return y - 28
}

function receiptSigRow(page: PDFPage, leftLabel: string, leftValue: string | null, rightLabel: string, rightValue: string | null, y: number, reg: PDFFont, bld: PDFFont): void {
  const LS = 8; const VS = 9
  const llw = reg.widthOfTextAtSize(leftLabel, LS)
  const rlw = reg.widthOfTextAtSize(rightLabel, LS)
  const LVX = MARGIN + llw + 8; const LVE = 292
  const RLX = 310; const RVX = RLX + rlw + 8; const RVE = PAGE_W - MARGIN
  page.drawText(leftLabel,  { x: MARGIN, y, size: LS, font: reg, color: GRAY })
  const slv = pdfSafe(leftValue?.trim())
  if (slv) page.drawText(slv, { x: LVX, y, size: VS, font: bld, color: BLACK })
  page.drawLine({ start: { x: LVX, y: y - 2 }, end: { x: LVE, y: y - 2 }, thickness: 0.5, color: BLACK })
  page.drawText(rightLabel, { x: RLX, y, size: LS, font: reg, color: GRAY })
  const srv = pdfSafe(rightValue?.trim())
  if (srv) page.drawText(srv, { x: RVX, y, size: VS, font: bld, color: BLACK })
  else page.drawLine({ start: { x: RVX, y: y - 2 }, end: { x: RVE, y: y - 2 }, thickness: 0.5, color: BLACK })
}

// ── Cash Deposit Receipt ──────────────────────────────────────────────────────

export type CashDepositInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  scanTime: string | null
  roomNumber: string | null
  confirmationNumber: string | null
  checkOutDate: string | null
  hotel: HotelContact
}

export async function buildCashDepositReceiptPdf(input: CashDepositInput): Promise<Uint8Array> {
  const { idDetail, parsed, scanTime, roomNumber, confirmationNumber, checkOutDate } = input
  const hotel = sanitizeHotel(input.hotel)
  const pdfDoc = await PDFDocument.create()
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bld = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const page = pdfDoc.addPage([PAGE_W, PAGE_H])
  const LH = 13

  let y = PAGE_H - MARGIN

  if (hotel.name?.trim()) {
    const nw = bld.widthOfTextAtSize(hotel.name, 14)
    page.drawText(hotel.name, { x: (PAGE_W - nw) / 2, y, size: 14, font: bld, color: BLACK })
    y -= 20
  }
  if (hotel.address?.trim())     { centeredText(page, hotel.address, y, 9, reg, GRAY); y -= LH }
  const hCityLine = [hotel.city, hotel.state, hotel.zip].filter(Boolean).join(', ')
  if (hCityLine)                 { centeredText(page, hCityLine, y, 9, reg, GRAY); y -= LH }
  if (hotel.phone?.trim())       { centeredText(page, hotel.phone, y, 9, reg, GRAY); y -= LH }
  if (hotel.email?.trim())       { centeredText(page, hotel.email, y, 9, reg, GRAY); y -= LH }
  y -= 14

  const nameParts = [idDetail.lastName, idDetail.firstName, idDetail.middleName]
    .map(p => p?.trim().toUpperCase()).filter(Boolean)
  const guestName = nameParts.join(' ')

  y = gridRow(page, 'CHECK IN DATE',  formatCheckInDisplay(scanTime),              'CHECK OUT DATE', formatDateDisplay(checkOutDate) || null, y, reg, bld)
  y = gridRow(page, 'GUEST NAME',     guestName || null,                            'ROOM NUMBER',   roomNumber,                              y, reg, bld)
  y = gridRow(page, 'ID NUMBER',      parsed.idNumber?.trim() || null,              'FOLIO NUMBER',  confirmationNumber?.trim() || null,      y, reg, bld)
  y -= 18

  const amt = `$${hotel.cashDepositAmount.toFixed(2)}`
  y = drawSegs(page, [
    { text: 'A ' },
    { text: amt, bold: true, ul: true },
    { text: ' CASH DEPOSIT IS REQUIRED FOR ALL GUESTS PAYING CASH WITHOUT AN AUTHORIZED CREDIT/DEBIT CARD.' },
  ], MARGIN, y, 9, reg, bld, COL_W, LH)
  y -= LH + 10

  page.drawText('CASH DEPOSIT WILL BE RETURNED AT CHECK OUT AFTER:', { x: MARGIN, y, size: 12, font: bld, color: BLACK })
  y -= 22

  const B = '•'; const bw = reg.widthOfTextAtSize(B, 9) + 6
  const drawBullet = (segs: Seg[]) => {
    page.drawText(B, { x: MARGIN, y, size: 9, font: reg, color: BLACK })
    y = drawSegs(page, segs, MARGIN + bw, y, 9, reg, bld, COL_W - bw, LH)
    y -= LH
  }

  drawBullet([{ text: 'THE ROOM IS VACANT' }])
  drawBullet([{ text: `A ${hotel.name?.trim() || 'HOTEL'} TEAM MEMBER CHECKS THE ROOM` }])
  drawBullet([{ text: 'THERE HAS BEEN ' }, { text: "NO EXCESSIVE DIRTY ROOM, NO DAMAGES, NO MISSING ITEMS, AND NO VIOLATION OF THE ROOM'S SMOKING POLICY", bold: true }])
  drawBullet([{ text: 'SIGNED CASH DEPOSIT RECEIPT IS PRESENT', bold: true }])
  y -= 6

  y = drawSegs(page, [
    { text: 'Unless a Front Desk Agent is notified in advance and in writing, another person may not pick up the deposit; only the ' },
    { text: 'registered guests with ID', bold: true },
    { text: ' may. ' },
    { text: 'All cash deposits must be picked up by 12:00 pm the day of departure, or they will be forfeited.', bold: true },
  ], MARGIN, y, 9, reg, bld, COL_W, LH)
  y -= LH + 30

  centeredText(page, 'CASH DEPOSIT RECEIVED', y, 11, bld)
  y -= 16
  hRule(page, y, BLACK)
  y -= 22

  receiptSigRow(page, 'GUEST SIGNATURE', null,                               'DATE',               formatFooterTimestamp(), y, reg, bld)
  y -= 28
  receiptSigRow(page, 'AMOUNT',          hotel.cashDepositAmount.toFixed(2), 'EMPLOYEE SIGNATURE', null,                    y, reg, bld)
  y -= 38

  centeredText(page, 'CASH DEPOSIT RETURNED TO GUEST', y, 11, bld)
  y -= 16
  hRule(page, y, BLACK)
  y -= 22

  receiptSigRow(page, 'AMOUNT', null, 'EMPLOYEE SIGNATURE', null, y, reg, bld)
  y -= 28

  page.drawText('GUEST SIGNATURE', { x: MARGIN, y, size: 8, font: reg, color: GRAY })
  const gsw = reg.widthOfTextAtSize('GUEST SIGNATURE', 8)
  page.drawLine({ start: { x: MARGIN + gsw + 8, y: y - 2 }, end: { x: PAGE_W - MARGIN, y: y - 2 }, thickness: 0.5, color: BLACK })

  return pdfDoc.save()
}

// ── Wrapped-text helper ──────────────────────────────────────────────────────

function drawWrappedText(page: PDFPage, str: string, x: number, y: number, size: number, font: PDFFont, maxW: number, lineH: number, color = BLACK): number {
  const words = pdfSafe(str).split(/\s+/).filter(Boolean)
  let cx = x
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const ww = font.widthOfTextAtSize(w, size)
    if (cx > x && cx + ww > x + maxW) { y -= lineH; cx = x }
    page.drawText(w, { x: cx, y, size, font, color })
    cx += ww
    if (i < words.length - 1) cx += font.widthOfTextAtSize(' ', size)
  }
  return y
}

// ── Police Report PDF ─────────────────────────────────────────────────────────

export type PoliceReportInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  documentData: Record<string, unknown> | null
  imageFrontBase64: string | null
  rotationDeg: number
  flipH: boolean
  roomNumber: string | null
  confirmationNumber: string | null
  checkInDate: string | null
  checkOutDate: string | null
  hotel: HotelContact
}

export async function buildPoliceReportPdf(input: PoliceReportInput): Promise<Uint8Array> {
  const { idDetail, parsed } = input
  const hotel = sanitizeHotel(input.hotel)
  const pdfDoc = await PDFDocument.create()
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bld = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const page = pdfDoc.addPage([PAGE_W, PAGE_H])
  const LH = 14
  const BLUE = rgb(0.08, 0.28, 0.56)

  let y = PAGE_H - MARGIN

  const title = `${hotel.name?.trim() || 'Hotel'} - Guest Identification Record`
  page.drawText(title, { x: MARGIN, y, size: 11, font: bld, color: BLUE })
  y -= LH + 4

  const now = new Date()
  const datePart = now.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).replace(',', '')
  const timePart = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  page.drawText(`Date: ${datePart} ${timePart}`, { x: MARGIN, y, size: 10, font: reg, color: BLUE })
  y -= LH + 10

  page.drawText('Guest Information:', { x: MARGIN, y, size: 11, font: bld })
  y -= LH + 4

  const nameParts = [idDetail.firstName, idDetail.middleName, idDetail.lastName].map(p => p?.trim()).filter(Boolean)
  const guestName = pdfSafe(nameParts.join(' ') || parsed.fullName?.trim() || '')
  const addr = [
    idDetail.streetAddress?.trim() || parsed.address?.trim(),
    idDetail.city?.trim(),
    idDetail.state?.trim(),
  ].filter(Boolean).join(', ')

  const infoRows: [string, string][] = [
    ['1. Guest Full Name',    guestName || '—'],
    ['2. Guest Date of Birth', formatDobDisplay(parsed.dateOfBirth) || '—'],
    ['3. Address',            addr || '—'],
    ['4. ID Type',            parsed.idType?.trim() || '—'],
    ['5. ID Number',          parsed.idNumber?.trim() || '—'],
    ['6. Date of Issue',      parsed.issueDate?.trim() || '—'],
    ['7. Date of Expiry',     parsed.expiryDate?.trim() || '—'],
    ['8. Check-in Date',      formatDateDisplay(input.checkInDate) || '—'],
    ['9. Check-out Date',     formatDateDisplay(input.checkOutDate) || '—'],
    ['10. Room Number',       input.roomNumber?.trim() || '—'],
  ]

  for (const [label, value] of infoRows) {
    const lw = bld.widthOfTextAtSize(`${label}: `, 10)
    page.drawText(`${label}: `, { x: MARGIN, y, size: 10, font: bld })
    page.drawText(pdfSafe(value), { x: MARGIN + lw, y, size: 10, font: reg })
    y -= LH
  }
  y -= 10

  if (input.imageFrontBase64?.trim() && y > 200) {
    try {
      const src = (input.rotationDeg !== 0 || input.flipH)
        ? await transformBase64ImageSync(input.imageFrontBase64, input.rotationDeg, input.flipH)
        : input.imageFrontBase64
      const mime = guessImageMimeFromBase64(src)
      let img: PDFImage
      if (mime === 'image/jpeg')     img = await pdfDoc.embedJpg(src)
      else if (mime === 'image/png') img = await pdfDoc.embedPng(src)
      else                           img = await pdfDoc.embedPng(await transformBase64ImageSync(src, 0, false))
      const maxW = 290; const maxH = 190
      const scale = Math.min(maxW / img.width, maxH / img.height)
      const dw = img.width * scale; const dh = img.height * scale
      page.drawImage(img, { x: (PAGE_W - dw) / 2, y: y - dh, width: dw, height: dh })
      y = y - dh - 16
    } catch { /* continue without image */ }
  }

  if (y > 100) {
    page.drawText('Purpose of Request:', { x: MARGIN, y, size: 10, font: bld }); y -= LH
    y = drawWrappedText(page, 'The guest identification information is being provided to law enforcement authorities in accordance with legal requirements for security and safety purposes.', MARGIN, y, 9.5, reg, COL_W, 13)
    y -= 18
  }

  if (y > 80) {
    page.drawText('Important Note:', { x: MARGIN, y, size: 10, font: bld }); y -= LH
    y = drawWrappedText(page, 'This document is intended for official use only and should be handled in accordance with applicable privacy and data protection laws.', MARGIN, y, 9.5, reg, COL_W, 13)
    y -= 18
  }

  if (y > 60) {
    page.drawText('Hotel Contact Information:', { x: MARGIN, y, size: 10, font: bld }); y -= LH
    const contactLines = [
      hotel.name?.trim(),
      [hotel.address, hotel.city, hotel.state, hotel.zip].filter(Boolean).join(', '),
      [hotel.phone, hotel.email].filter(Boolean).join(', '),
    ].filter(Boolean) as string[]
    for (const line of contactLines) {
      page.drawText(line, { x: MARGIN, y, size: 9.5, font: reg }); y -= 13
    }
  }

  return pdfDoc.save()
}

// ── Registration Card PDF ─────────────────────────────────────────────────────

export type RegistrationCardInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  phone: string
  email: string
  roomNumber: string | null
  confirmationNumber: string | null
  checkInDate: string | null
  checkOutDate: string | null
  hotel: HotelContact
  signaturePngDataUrl: string | null
}

const REG_CARD_TC_ITEMS: Array<{ label: string; body: string }> = [
  { label: 'Check-In and Check-Out:', body: 'Our standard check-in time is at 3 p.m., and check-out time is at 11 a.m. If you require early check-in or late check-out, please inquire at the front desk, and we will do our best to accommodate your request, subject to availability and additional charges.' },
  { label: 'Rates and Taxes:', body: 'Please note that room rates are subject to change without prior notice and may vary depending on room type and availability. All applicable taxes and fees will be added to your room rate.' },
  { label: 'Identification:', body: 'For the safety and security of all our guests, we require valid government-issued photo identification from all guests during the check-in process, including minors. Foreign guests must present a valid passport and visa (if applicable).' },
  { label: 'Smoking Policy:', body: '%%HOTEL%% is a smoke-free property. Smoking is strictly prohibited in all guest rooms and public areas. Violating this policy may result in fines.' },
  { label: 'Pets:', body: '$25 pet fee per night up to 2 pets. ADA animals are always welcome free of charge.' },
  { label: 'Damages and Losses:', body: 'Guests are financially responsible for any damages or losses incurred during their stay. Any such charges will be applied to the credit card on file.' },
  { label: 'Liability:', body: 'The hotel shall not be held liable for accidents, injuries, or illnesses that occur on the premises.' },
]

export async function buildRegistrationCardPdf(input: RegistrationCardInput): Promise<Uint8Array> {
  const { idDetail, parsed, phone, email } = input
  const hotel = sanitizeHotel(input.hotel)
  const pdfDoc = await PDFDocument.create()
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bld = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const page = pdfDoc.addPage([PAGE_W, PAGE_H])
  const BLUE = rgb(0.08, 0.28, 0.56)
  const TC_S = 8.5; const TC_LH = 12

  let y = PAGE_H - MARGIN

  if (hotel.name?.trim()) {
    const nw = bld.widthOfTextAtSize(hotel.name, 14)
    page.drawText(hotel.name, { x: (PAGE_W - nw) / 2, y, size: 14, font: bld }); y -= 18
  }
  const cityLine = [hotel.city, hotel.state, hotel.zip].filter(Boolean).join(', ')
  if (cityLine) { centeredText(page, cityLine, y, 9, reg, BLUE); y -= 12 }
  const contactLine = [hotel.phone, hotel.email].filter(Boolean).join(' • ')
  if (contactLine) { centeredText(page, contactLine, y, 9, reg, BLUE); y -= 12 }
  y -= 8

  const boxH = 30; const midX = MARGIN + COL_W / 2
  page.drawRectangle({ x: MARGIN, y: y - boxH, width: COL_W, height: boxH, borderColor: BLACK, borderWidth: 0.5 })
  page.drawLine({ start: { x: midX, y }, end: { x: midX, y: y - boxH }, thickness: 0.5, color: BLACK })
  page.drawText('Registration', { x: MARGIN + 6, y: y - 20, size: 14, font: bld })
  y -= boxH

  const nameParts = [idDetail.firstName, idDetail.middleName, idDetail.lastName].map(p => p?.trim()).filter(Boolean)
  const guestName = pdfSafe(nameParts.join(' ') || parsed.fullName?.trim() || '')
  const fullAddr = pdfSafe(parsed.address?.trim() || [idDetail.streetAddress, idDetail.city, idDetail.state].filter(Boolean).map(s => s?.trim()).join(', '))
  const phoneVal = pdfSafe(phone.trim() || idDetail.phone?.trim() || '')
  const emailVal = pdfSafe(email.trim() || idDetail.email?.trim() || '')
  const idVal    = pdfSafe([parsed.idType, parsed.idNumber].filter(Boolean).join(' | '))
  const ciDate   = formatDateDisplay(input.checkInDate) || ''
  const coDate   = formatDateDisplay(input.checkOutDate) || ''
  const ROW = 18

  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: BLACK })

  const drawRow = (topY: number, h: number, leftLabel: string, leftVal: string, splitCol: boolean, rightLabel?: string, rightVal?: string) => {
    page.drawLine({ start: { x: MARGIN,          y: topY },     end: { x: MARGIN,          y: topY - h }, thickness: 0.5, color: BLACK })
    page.drawLine({ start: { x: PAGE_W - MARGIN, y: topY },     end: { x: PAGE_W - MARGIN, y: topY - h }, thickness: 0.5, color: BLACK })
    page.drawLine({ start: { x: MARGIN,          y: topY - h }, end: { x: PAGE_W - MARGIN, y: topY - h }, thickness: 0.5, color: BLACK })
    const ty = topY - h + 5
    if (leftLabel) {
      const llw = bld.widthOfTextAtSize(`${leftLabel} `, 8)
      page.drawText(`${leftLabel} `, { x: MARGIN + 4, y: ty, size: 8, font: bld })
      const slv = pdfSafe(leftVal); if (slv) page.drawText(slv, { x: MARGIN + 4 + llw, y: ty, size: 9, font: reg })
    }
    if (splitCol && rightLabel !== undefined) {
      page.drawLine({ start: { x: midX, y: topY }, end: { x: midX, y: topY - h }, thickness: 0.5, color: BLACK })
      const rlw = bld.widthOfTextAtSize(`${rightLabel} `, 8)
      page.drawText(`${rightLabel} `, { x: midX + 4, y: ty, size: 8, font: bld })
      const srv = pdfSafe(rightVal); if (srv) page.drawText(srv, { x: midX + 4 + rlw, y: ty, size: 9, font: reg })
    }
  }

  drawRow(y, ROW, 'Arrival:', ciDate, true, 'Departure:', coDate); y -= ROW
  drawRow(y, ROW, 'Guest:',   guestName, false);                    y -= ROW
  drawRow(y, ROW, 'Address:', fullAddr,  false);                    y -= ROW
  drawRow(y, ROW, 'Phone #:', phoneVal,  true, 'Email:', emailVal); y -= ROW
  drawRow(y, ROW, 'ID:',      idVal,     false);                    y -= ROW
  drawRow(y, 16, '', '', false);                                     y -= 16
  drawRow(y, 16, '', '', false);                                     y -= 16
  y -= 12

  const tcHdr = 'Terms & Conditions'
  const hw = bld.widthOfTextAtSize(tcHdr, 10); const hx = (PAGE_W - hw) / 2
  page.drawText(tcHdr, { x: hx, y, size: 10, font: bld })
  page.drawLine({ start: { x: hx, y: y - 1.5 }, end: { x: hx + hw, y: y - 1.5 }, thickness: 0.75, color: BLACK })
  y -= 14

  const hotelShort = hotel.name?.trim() || 'This hotel'
  y = drawWrappedText(page, `Welcome to ${hotelShort}. Before you check-in, we kindly request that you carefully review and acknowledge the following terms and conditions:`, MARGIN, y, TC_S, reg, COL_W, TC_LH)
  y -= TC_LH + 2

  for (const item of REG_CARD_TC_ITEMS) {
    if (y < 90) break
    const body = item.body.replace('%%HOTEL%%', hotelShort)
    y = drawSegs(page, [{ text: item.label, bold: true, ul: true }, { text: ' ' + body }], MARGIN, y, TC_S, reg, bld, COL_W, TC_LH)
    y -= TC_LH + 1
  }

  y -= 4
  y = drawWrappedText(page, `By signing below or proceeding with check-in, you acknowledge and agree to abide by these terms and conditions. ${hotelShort} reserves the right to refuse service or evict guests who do not comply with these policies.`, MARGIN, y, TC_S, reg, COL_W, TC_LH)
  y -= TC_LH + 10

  page.drawText('Signature:', { x: MARGIN, y, size: 9, font: reg })
  const sw = reg.widthOfTextAtSize('Signature:', 9)
  const slX = MARGIN + sw + 8
  if (input.signaturePngDataUrl) {
    try {
      const sigImg = await pdfDoc.embedPng(input.signaturePngDataUrl)
      const sigH = 28; const sigW = Math.min(sigImg.width * (28 / sigImg.height), 180)
      page.drawImage(sigImg, { x: slX, y: y - 4, width: sigW, height: sigH })
    } catch { /* blank line */ }
  }
  page.drawLine({ start: { x: slX, y: y - 2 }, end: { x: slX + 180, y: y - 2 }, thickness: 0.5, color: BLACK })

  return pdfDoc.save()
}

// ── Chargeback Evidence PDF ───────────────────────────────────────────────────

export type ChargebackEvidenceInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  imageFrontBase64: string | null
  imageBackBase64: string | null
  rotationDeg: number
  flipH: boolean
  roomNumber: string | null
  confirmationNumber: string | null
  checkInDate: string | null
  checkOutDate: string | null
  scanTime: string | null
  hotel: HotelContact
  signaturePngDataUrl: string | null
  regCardPdfBytes?: Uint8Array | null
}

export async function buildChargebackEvidencePdf(input: ChargebackEvidenceInput): Promise<Uint8Array> {
  const { idDetail, parsed } = input
  const hotel = sanitizeHotel(input.hotel)
  const pdfDoc = await PDFDocument.create()
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bld = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const LH = 13
  const BLUE = rgb(0.08, 0.28, 0.56)
  const conf = input.confirmationNumber?.trim() || 'N/A'

  const nameParts = [idDetail.firstName, idDetail.middleName, idDetail.lastName].map(p => p?.trim()).filter(Boolean)
  const guestName = nameParts.join(' ') || parsed.fullName?.trim() || ''

  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  // Page 1: Cover letter
  const pg1 = pdfDoc.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN

  if (hotel.name?.trim()) { pg1.drawText(hotel.name, { x: MARGIN, y, size: 12, font: bld }); y -= 16 }
  const cityLine = [hotel.city, hotel.state, hotel.zip].filter(Boolean).join(', ')
  if (hotel.address?.trim()) { pg1.drawText(hotel.address, { x: MARGIN, y, size: 9, font: reg, color: GRAY }); y -= LH }
  if (cityLine)              { pg1.drawText(cityLine,      { x: MARGIN, y, size: 9, font: reg, color: GRAY }); y -= LH }
  if (hotel.phone?.trim())   { pg1.drawText(hotel.phone,   { x: MARGIN, y, size: 9, font: reg, color: GRAY }); y -= LH }
  y -= 14

  const dateW = reg.widthOfTextAtSize(dateStr, 9)
  pg1.drawText(dateStr, { x: PAGE_W - MARGIN - dateW, y, size: 9, font: reg }); y -= LH + 10
  pg1.drawText('To Whom It May Concern,', { x: MARGIN, y, size: 10, font: reg }); y -= LH + 6
  pg1.drawText(`Re: Chargeback Dispute — Confirmation No. ${conf}`, { x: MARGIN, y, size: 10, font: bld }); y -= LH + 10

  y = drawWrappedText(pg1, 'We are writing in response to a chargeback dispute filed against our hotel for the above-referenced reservation. We respectfully submit the following evidence to demonstrate that the guest was physically present at our property and agreed to the terms and conditions of their stay.', MARGIN, y, 9.5, reg, COL_W, LH)
  y -= LH + 6
  pg1.drawText('The following exhibits are provided in support of this response:', { x: MARGIN, y, size: 9.5, font: reg }); y -= LH + 4

  const exhibits = [
    { letter: 'A', title: 'Guest Physically Present Identification Evidence', desc: "A copy of the guest's government-issued photo identification collected at the time of check-in, confirming their physical presence at the property." },
    { letter: 'B', title: 'Guest Signed Registration Card with Legal Terms', desc: 'The signed registration card acknowledging the terms and conditions of the stay, including cancellation policy, no-show policy, and room charges.' },
  ]
  for (let i = 0; i < exhibits.length; i++) {
    const ex = exhibits[i]!
    const numStr = `${i + 1}. `
    const nw = bld.widthOfTextAtSize(numStr, 9.5)
    pg1.drawText(numStr, { x: MARGIN + 10, y, size: 9.5, font: bld })
    const label = `Exhibit ${ex.letter} — ${ex.title}: `
    const lw = bld.widthOfTextAtSize(label, 9.5)
    const indentX = MARGIN + 10 + nw
    if (indentX + lw > PAGE_W - MARGIN) {
      pg1.drawText(`Exhibit ${ex.letter} — ${ex.title}:`, { x: indentX, y, size: 9.5, font: bld }); y -= LH
    } else {
      pg1.drawText(label, { x: indentX, y, size: 9.5, font: bld }); y -= LH
    }
    y = drawWrappedText(pg1, ex.desc, MARGIN + 20, y, 9, reg, COL_W - 20, LH); y -= LH + 2
  }
  y -= 6

  y = drawWrappedText(pg1, 'We trust that the enclosed documentation provides sufficient evidence to resolve this dispute in our favor. Should you require any additional information or documentation, please do not hesitate to contact us.', MARGIN, y, 9.5, reg, COL_W, LH)
  y -= LH + 20
  pg1.drawText('Yours sincerely,', { x: MARGIN, y, size: 9.5, font: reg }); y -= LH + 30
  pg1.drawLine({ start: { x: MARGIN, y: y - 2 }, end: { x: MARGIN + 200, y: y - 2 }, thickness: 0.5, color: BLACK })
  if (hotel.name?.trim()) pg1.drawText(hotel.name, { x: MARGIN, y, size: 9, font: bld })
  y -= 14
  pg1.drawText('Authorized Representative', { x: MARGIN, y, size: 8, font: reg, color: GRAY }); y -= LH
  pg1.drawText(`Date: ${dateStr}`, { x: MARGIN, y, size: 9, font: reg })

  // Page 2: Exhibit A — ID images (or note)
  const pg2 = pdfDoc.addPage([PAGE_W, PAGE_H])
  y = PAGE_H - MARGIN
  centeredText(pg2, 'Exhibits: A', y, 22, bld); y -= 34
  centeredText(pg2, 'Guest Physically Present Identification Evidence', y, 11, bld); y -= 26

  const tryEmbed = async (b64: string, rd: number, fh: boolean): Promise<PDFImage | null> => {
    try {
      const src = (rd !== 0 || fh) ? await transformBase64ImageSync(b64, rd, fh) : b64
      const mime = guessImageMimeFromBase64(src)
      if (mime === 'image/jpeg') return pdfDoc.embedJpg(src)
      if (mime === 'image/png')  return pdfDoc.embedPng(src)
      return pdfDoc.embedPng(await transformBase64ImageSync(src, 0, false))
    } catch { return null }
  }

  const frontImg = input.imageFrontBase64?.trim() ? await tryEmbed(input.imageFrontBase64, input.rotationDeg, input.flipH) : null
  const backImg  = input.imageBackBase64?.trim()  ? await tryEmbed(input.imageBackBase64, 0, false) : null

  if (frontImg) {
    const maxW = COL_W; const maxH = 200
    const scale = Math.min(maxW / frontImg.width, maxH / frontImg.height)
    const dw = frontImg.width * scale; const dh = frontImg.height * scale
    pg2.drawImage(frontImg, { x: (PAGE_W - dw) / 2, y: y - dh, width: dw, height: dh })
    y = y - dh - 16
  } else {
    pg2.drawText('[ ID images not available from portal — see original scan record ]', { x: MARGIN, y, size: 9, font: reg, color: GRAY }); y -= 16
  }

  if (backImg) {
    const maxW = COL_W; const maxH = 200
    const scale = Math.min(maxW / backImg.width, maxH / backImg.height)
    const dw = backImg.width * scale; const dh = backImg.height * scale
    pg2.drawImage(backImg, { x: (PAGE_W - dw) / 2, y: y - dh, width: dw, height: dh })
    y = y - dh - 16
  }

  if (y > 55) {
    const scanLabel = `Scan Time: ${input.scanTime ? formatCheckInDisplay(input.scanTime) : formatFooterTimestamp()}`
    pg2.drawText(scanLabel, { x: MARGIN, y, size: 9, font: bld, color: BLUE })
  }

  // Page 3: Exhibit B — Reg card
  const pg3 = pdfDoc.addPage([PAGE_W, PAGE_H])
  y = PAGE_H - MARGIN
  centeredText(pg3, 'Exhibits: B', y, 22, bld); y -= 34
  centeredText(pg3, 'Guest Signed Registration Card with Legal Terms', y, 11, bld); y -= 16

  if (input.regCardPdfBytes && input.regCardPdfBytes.length > 0) {
    try {
      const embeddedPages: PDFEmbeddedPage[] = await pdfDoc.embedPdf(input.regCardPdfBytes)
      if (embeddedPages.length > 0) {
        const ep0 = embeddedPages[0]!
        const availW = COL_W; const availH = y - MARGIN
        const scale = Math.min(availW / ep0.width, availH / ep0.height)
        pg3.drawPage(ep0, { x: (PAGE_W - ep0.width * scale) / 2, y: y - ep0.height * scale, width: ep0.width * scale, height: ep0.height * scale })
        for (let i = 1; i < embeddedPages.length; i++) {
          const ep = embeddedPages[i]!
          const extraPg = pdfDoc.addPage([PAGE_W, PAGE_H])
          const s = Math.min((PAGE_W - 2 * MARGIN) / ep.width, (PAGE_H - 2 * MARGIN) / ep.height)
          extraPg.drawPage(ep, { x: (PAGE_W - ep.width * s) / 2, y: (PAGE_H - ep.height * s) / 2, width: ep.width * s, height: ep.height * s })
        }
      }
    } catch { centeredText(pg3, '[Registration card PDF could not be loaded]', y, 9, reg, GRAY) }
  } else {
    const TC_S = 8; const TC_LH = 11
    y -= 8
    y = gridRow(pg3, 'GUEST NAME',    guestName || null,                     'ROOM NUMBER',    input.roomNumber,                              y, reg, bld)
    y = gridRow(pg3, 'CHECK-IN DATE', formatDateDisplay(input.checkInDate),  'CHECK-OUT DATE', formatDateDisplay(input.checkOutDate) || null, y, reg, bld)
    y = gridRow(pg3, 'ID NUMBER',     parsed.idNumber?.trim() || null,       'CONFIRMATION #', conf,                                          y, reg, bld)
    y -= 10
    hRule(pg3, y); y -= 12

    const tcHdr = 'Terms & Conditions'
    const thw = bld.widthOfTextAtSize(tcHdr, 9.5); const thx = (PAGE_W - thw) / 2
    pg3.drawText(tcHdr, { x: thx, y, size: 9.5, font: bld })
    pg3.drawLine({ start: { x: thx, y: y - 1.5 }, end: { x: thx + thw, y: y - 1.5 }, thickness: 0.75, color: BLACK })
    y -= TC_LH + 4

    const hotelShort = hotel.name?.trim() || 'This hotel'
    for (const item of REG_CARD_TC_ITEMS) {
      if (y < 90) break
      const body = item.body.replace('%%HOTEL%%', hotelShort)
      y = drawSegs(pg3, [{ text: item.label, bold: true, ul: true }, { text: ' ' + body }], MARGIN, y, TC_S, reg, bld, COL_W, TC_LH)
      y -= TC_LH + 1
    }
    y -= 4
    y = drawWrappedText(pg3, 'By signing below, the guest confirms agreement to the above Terms and Conditions and authorizes all charges associated with their stay.', MARGIN, y, TC_S, reg, COL_W, TC_LH)
    y -= TC_LH + 10

    pg3.drawText('Signature:', { x: MARGIN, y, size: 9, font: reg })
    const sw4 = reg.widthOfTextAtSize('Signature:', 9)
    const slX4 = MARGIN + sw4 + 8
    if (input.signaturePngDataUrl) {
      try {
        const sigImg = await pdfDoc.embedPng(input.signaturePngDataUrl)
        const sigH = 30; const sigW = Math.min(sigImg.width * (30 / sigImg.height), 180)
        pg3.drawImage(sigImg, { x: slX4, y: y - 4, width: sigW, height: sigH })
      } catch { /* blank line */ }
    }
    pg3.drawLine({ start: { x: slX4, y: y - 2 }, end: { x: slX4 + 180, y: y - 2 }, thickness: 0.5, color: BLACK })
  }

  return pdfDoc.save()
}

// ── Pet Policy PDF ────────────────────────────────────────────────────────────

export type PetPolicyInput = {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  roomNumber: string | null
  confirmationNumber: string | null
  checkInDate: string | null
  checkOutDate: string | null
  hotel: HotelContact
  signaturePngDataUrl: string | null
}

export async function buildPetPolicyPdf(input: PetPolicyInput): Promise<Uint8Array> {
  const { idDetail, parsed } = input
  const hotel = sanitizeHotel(input.hotel)
  const pdfDoc = await PDFDocument.create()
  const reg = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bld = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const page = pdfDoc.addPage([PAGE_W, PAGE_H])
  const LH = 13
  const hotelName = hotel.name?.trim() || 'The Hotel'

  const nameParts = [idDetail.firstName, idDetail.middleName, idDetail.lastName].map(p => p?.trim()).filter(Boolean)
  const guestName = pdfSafe(nameParts.join(' ') || parsed.fullName?.trim() || '')

  let y = PAGE_H - MARGIN

  centeredText(page, 'PET ACCEPTANCE', y, 18, bld); y -= 24
  centeredText(page, 'AGREEMENT', y, 18, bld); y -= 24
  hRule(page, y); y -= 14

  y = drawWrappedText(page, `Welcome to the ${hotelName}! We look forward to providing a memorable stay for you and your pet. To ensure the comfort and enjoyment of our guests, the following policies apply to your pet's stay.`, MARGIN, y, 9.5, reg, COL_W, LH)
  y -= LH + 6

  const sections = [
    { heading: 'Pet Fee', body: `Pet fee is $25.00 per night, per pet. If an unregistered pet is discovered, a fee of $250.00 will be charged. If fumigation is required due to the pet's presence, an additional fee of $100.00 will be charged.` },
    { heading: 'Acceptable Pets', body: `Pets must be well-mannered and under control at all times. A maximum of 2 pets per room is permitted. ${hotelName} reserves the right to ask guests to remove pets that exhibit dangerous or disruptive behavior.` },
    { heading: 'Pet-Friendly Areas', body: `Pets are welcome in guest rooms, the parking lot, and the dog park. Pets are not permitted in any area where food and beverages are served or in other designated pet-free areas.` },
    { heading: 'Pet Control / Containment in Public Areas', body: `Pets must be on a leash or in a carrier/cage at all times when in public areas of the hotel, including the PetWalk area. Guests are fully responsible for the behavior and safety of their pet at all times.` },
    { heading: 'Housekeeping', body: `Housekeeping service will only enter the room under the following conditions: (a) the pet is not present in the room, (b) the guest is present and agrees to monitor the pet on a leash during service, or (c) the pet is secured in a cage or kennel.` },
    { heading: 'Damage to Guest Rooms and Common Areas', body: `Guests will be held financially responsible for any damage to guest rooms or common areas caused by their pet. Charges for repair or replacement will be applied to the credit card on file.` },
  ]

  for (const sec of sections) {
    if (y < 120) break
    page.drawText(sec.heading, { x: MARGIN, y, size: 9.5, font: bld }); y -= LH
    y = drawWrappedText(page, sec.body, MARGIN, y, 9, reg, COL_W, LH); y -= LH + 2
  }

  y -= 4
  if (y > 100) {
    y = drawWrappedText(page, `The guest agrees to release, defend, and indemnify ${hotelName} from all claims or damages related to your pet or your pet's stay at the ${hotelName}, including any claims by third parties.`, MARGIN, y, 9, reg, COL_W, LH)
    y -= LH + 8
  }

  if (y > 90) { page.drawText('Agreed and accepted by:', { x: MARGIN, y, size: 9.5, font: bld }); y -= LH + 6 }

  const ROW_H = 32
  const tableTop = y
  const tableRows = [
    { label: "Guest's Printed Name:", value: guestName, isSignature: false },
    { label: "Guest's Room #:",       value: input.roomNumber?.trim() || '', isSignature: false },
    { label: 'Guest Signature:',      value: '', isSignature: true },
  ]

  for (let i = 0; i < tableRows.length; i++) {
    const row = tableRows[i]!
    const rowTop = tableTop - i * ROW_H; const rowBot = rowTop - ROW_H
    page.drawLine({ start: { x: MARGIN, y: rowTop }, end: { x: PAGE_W - MARGIN, y: rowTop }, thickness: 0.5, color: BLACK })
    page.drawLine({ start: { x: MARGIN, y: rowBot }, end: { x: PAGE_W - MARGIN, y: rowBot }, thickness: 0.5, color: BLACK })
    page.drawLine({ start: { x: MARGIN, y: rowTop }, end: { x: MARGIN, y: rowBot }, thickness: 0.5, color: BLACK })
    page.drawLine({ start: { x: PAGE_W - MARGIN, y: rowTop }, end: { x: PAGE_W - MARGIN, y: rowBot }, thickness: 0.5, color: BLACK })
    const textY = rowTop - ROW_H / 2 - 3
    const safeLabel = pdfSafe(row.label)
    const lw = bld.widthOfTextAtSize(safeLabel, 8.5)
    page.drawText(safeLabel, { x: MARGIN + 6, y: textY, size: 8.5, font: bld })
    if (row.isSignature && input.signaturePngDataUrl) {
      try {
        const sigImg = await pdfDoc.embedPng(input.signaturePngDataUrl)
        const maxSigH = ROW_H - 6; const maxSigW = COL_W - lw - 20
        const sigScale = Math.min(maxSigW / sigImg.width, maxSigH / sigImg.height)
        page.drawImage(sigImg, { x: MARGIN + 6 + lw + 8, y: rowTop - ROW_H / 2 - (sigImg.height * sigScale) / 2, width: sigImg.width * sigScale, height: sigImg.height * sigScale })
      } catch { /* no signature */ }
    } else if (row.value) {
      page.drawText(pdfSafe(row.value), { x: MARGIN + 6 + lw + 8, y: textY, size: 9, font: reg })
    }
  }

  const fy1 = 36; const fy2 = 22
  page.drawLine({ start: { x: MARGIN, y: fy1 + 14 }, end: { x: PAGE_W - MARGIN, y: fy1 + 14 }, thickness: 0.5, color: LIGHT })
  const footerParts = [hotel.name, hotel.address, hotel.phone].filter(Boolean) as string[]
  if (footerParts.length) centeredText(page, footerParts.join(' • '), fy1, 8.5, reg, GRAY)
  centeredText(page, `Generated: ${formatFooterTimestamp()}`, fy2, 8.5, reg, GRAY)

  return pdfDoc.save()
}

// ── Download helper ───────────────────────────────────────────────────────────

export function downloadPdfBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
